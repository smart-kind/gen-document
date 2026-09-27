import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { BrowserWindow, app } from 'electron'
import { installNavigationGuard, installRendererProtocol } from '@genoffice/electron-utils'
import {
  addDocument,
  ensureDemoWorkspace,
  WorkspaceStore,
  type WorkspaceHandle,
} from '@genoffice/workspace-harness'
import {
  configureDocsRuntime,
  registerAiIpc,
  registerDocsIpc,
  registerProjectIpc,
} from '../../../docs/src/main/docs-main'
import { configureHtmlRuntime, registerPrivilegedSchemes } from '../../../html/src/main/html-main'
import { configureMarkdownRuntime } from '../../../markdown/src/main/markdown-main'
import { configurePdfRuntime } from '../../../pdf/src/main/pdf-main'
import { configureSheetsRuntime, setSheetsShellWindow } from '../../../sheets/src/main/sheets-main'
import { configureSlidesRuntime, setSlidesShellWindow } from '../../../slides/src/main/slides-main'
import { WORKSPACE_CHANNELS } from '../shared/api'
import { AgentService } from './agent-service'
import { Appearance } from './appearance'
import { createShellBridge, createVersionBridge } from './bridges'
import { createDocumentEditBridge, installEditorBridges } from './docs-bridge'
import { EditorHost } from './editor-host'
import { broadcastToAllWebContents, registerWorkspaceIpc } from './ipc'
import { WorkspaceService } from './workspace-service'

/**
 * GenOffice Workspace Shell: the business shell of a goal-driven document
 * workspace.
 *
 * One window: a renderer-owned sidebar and top bar, and an editor area made of
 * the existing editor apps' WebContentsViews, inset so they never paint over
 * the sidebar. The agent drives both through harness tools whose effects reach
 * the renderer as plain events.
 *
 * This is a new app rather than a mode of apps/shell on purpose: the unified
 * shell is built around a tab strip, a launcher and per-module menus, and
 * retrofitting a workspace model into it would put two competing layouts in one
 * window.
 */

// ANY unpacked run must not share the installed app's userData or its
// single-instance lock, or a dev run would silently forward its argv there.
if (!app.isPackaged) {
  app.setPath(
    'userData',
    process.env.GENOFFICE_USER_DATA ?? join(app.getPath('appData'), 'GenOffice Workspace Dev'),
  )
}

/** Monorepo root when unpacked; a packaged build would carry module output as resources. */
const APPS_ROOT = join(app.getAppPath(), '..')

function moduleDir(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'modules', name)
    : join(APPS_ROOT, name, 'out')
}

const DOCS_OUT = moduleDir('docs')
const SHEETS_OUT = moduleDir('sheets')
const SLIDES_OUT = moduleDir('slides')
const PDF_OUT = moduleDir('pdf')
const MARKDOWN_OUT = moduleDir('markdown')
const HTML_OUT = moduleDir('html')

const SIDECAR_EXE = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
const SIDECAR_BIN = app.isPackaged
  ? join(process.resourcesPath, 'native', SIDECAR_EXE)
  : join(APPS_ROOT, 'sheets', 'native', 'xlsx-engine', 'target', 'release', SIDECAR_EXE)

configureDocsRuntime({
  preloadPath: join(DOCS_OUT, 'preload', 'index.js'),
  rendererUrl: process.env.DOCS_RENDERER_URL,
  rendererFile: join(DOCS_OUT, 'renderer', 'index.html'),
})
configureSheetsRuntime({
  preloadPath: join(SHEETS_OUT, 'preload', 'index.js'),
  rendererUrl: process.env.SHEETS_RENDERER_URL,
  rendererFile: join(SHEETS_OUT, 'renderer', 'index.html'),
  sidecarPath: SIDECAR_BIN,
  openGeneratedPath,
  createDocument: createWorkspaceDocument,
})
configureSlidesRuntime({
  preloadPath: join(SLIDES_OUT, 'preload', 'index.js'),
  rendererDevUrl: process.env.SLIDES_RENDERER_URL,
  rendererFilePath: join(SLIDES_OUT, 'renderer', 'index.html'),
  openGeneratedPath,
})
configurePdfRuntime({
  preloadPath: join(PDF_OUT, 'preload', 'index.js'),
  rendererUrl: process.env.PDF_RENDERER_URL,
  rendererFile: join(PDF_OUT, 'renderer', 'index.html'),
  openGeneratedPath,
  createDocument: createWorkspaceDocument,
})
configureMarkdownRuntime({
  preloadPath: join(MARKDOWN_OUT, 'preload', 'index.js'),
  rendererUrl: process.env.MARKDOWN_RENDERER_URL,
  rendererFile: join(MARKDOWN_OUT, 'renderer', 'index.html'),
  openGeneratedPath,
})
configureHtmlRuntime({
  preloadPath: join(HTML_OUT, 'preload', 'index.js'),
  rendererUrl: process.env.HTML_RENDERER_URL,
  rendererFile: join(HTML_OUT, 'renderer', 'index.html'),
  openGeneratedPath,
})

// privileged-scheme registration is only legal before app ready
registerPrivilegedSchemes()

let shellWindow: BrowserWindow | null = null
let editors: EditorHost | null = null
let service: WorkspaceService | null = null
let agents: AgentService | null = null

function createShellWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: 'GenOffice Workspace',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : { titleBarStyle: 'hidden' as const, autoHideMenuBar: true }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once('closed', () => {
    shellWindow = null
  })
  return win
}

/** Build the services and IPC handlers around a live window. */
function wireShell(win: BrowserWindow): void {
  // A re-wire (window closed on macOS, dock icon clicked) replaces the whole
  // service graph; the previous graph's agent runs must not keep going.
  agents?.stopAll()

  const userData = app.getPath('userData')
  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  const appearance = new Appearance({
    settingsFile: join(userData, 'app-settings.json'),
    broadcastAll: broadcastToAllWebContents,
    broadcastShell: send,
  })

  const editorHost: EditorHost = new EditorHost({
    window: win,
    workspaceDir: () => workspaceService.current()?.dir ?? null,
    workspace: () => workspaceService.current(),
    onChanged: () => send(WORKSPACE_CHANNELS.shellEvent, { type: 'document.changed' }),
  })

  const docEditBridge = createDocumentEditBridge(() => editorHost.tabInfos())

  const workspaceService: WorkspaceService = new WorkspaceService({
    root: join(userData, 'workspaces'),
    activeIdFile: join(userData, 'active-workspace.json'),
    bridges: () => ({
      ui: appearance.ui(),
      shell: createShellBridge({
        editors: editorHost,
        openWorkspace: (id) => openWorkspace(id),
      }),
      vcs: createVersionBridge(() => workspaceService.current()?.manifest.vcs.enabled ?? false),
    }),
    activeDocument: () => editorHost.activeDocument(),
    onEvent: (event) => send(WORKSPACE_CHANNELS.shellEvent, event),
    docEditBridge,
  })

  const agentService = new AgentService({
    userDataPath: userData,
    store: workspaceService.registry,
    currentWorkspace: () => workspaceService.current(),
    buildContext: () => workspaceService.buildContext(),
    onEvent: (event) => send(WORKSPACE_CHANNELS.agentEvent, event),
  })

  const openWorkspace = (id: string): void => {
    editorHost.closeAll()
    workspaceService.open(id)
    send(WORKSPACE_CHANNELS.shellEvent, { type: 'workspace.changed' })
  }

  editors = editorHost
  service = workspaceService
  agents = agentService

  // The editor modules parent their dialogs to the window that hosts them.
  setSheetsShellWindow(win)
  setSlidesShellWindow(win)

  registerWorkspaceIpc({
    service: workspaceService,
    editors: editorHost,
    agents: agentService,
    appearance,
    docEditBridge,
    userDataPath: userData,
    send,
    sendAll: broadcastToAllWebContents,
  })
}

// The shared AI IPC answers every editor view's panel; each editor module
// registers its own only in standalone mode, so the shell-mode set is
// registered once here — before any window exists, and never per window.
registerAiIpc()
registerProjectIpc()
registerDocsIpc()
installEditorBridges()

/**
 * Cross-app document creation routes into the open workspace, so a file made
 * from an embedded editor's AI panel lands where the agent can see it.
 *
 * docx and pdf are refused rather than written elsewhere: a real docx needs the
 * docs renderer's HTML conversion and a real pdf needs a print pass, and
 * quietly dropping either file outside the workspace would break the model's
 * picture of what exists.
 */
async function createWorkspaceDocument(request: {
  type: 'docx' | 'pdf' | 'md' | 'html'
  title: string
  content: string
}): Promise<{ ok: boolean; path?: string; error?: string }> {
  const workspace = service?.current()
  if (!workspace) return { ok: false, error: 'no workspace is open' }
  if (request.type === 'docx' || request.type === 'pdf') {
    return {
      ok: false,
      error: `creating a ${request.type} file from chat is not available in the workspace shell; use the workspace tools instead`,
    }
  }
  const content = String(request.content ?? '')
  if (!content.trim()) return { ok: false, error: 'content must not be empty' }
  const name = uniqueWorkspaceName(workspace, sanitizeFileBase(request.title), request.type)
  const abs = resolve(workspace.dir, name)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  addDocument(workspace, { path: name, source: { kind: 'new' } })
  service?.saveWorkspace()
  editors?.open(name)
  return { ok: true, path: abs }
}

/** Open a file another module just wrote, when it landed inside the workspace. */
function openGeneratedPath(absPath: string): boolean {
  const workspace = service?.current()
  if (!workspace || !existsSync(absPath)) return false
  const rel = relative(resolve(workspace.dir), resolve(absPath)).replace(/\\/g, '/')
  if (rel.startsWith('..')) return false
  try {
    editors?.open(rel)
    return true
  } catch {
    return false
  }
}

function sanitizeFileBase(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '').trim()
  return cleaned || 'untitled'
}

function uniqueWorkspaceName(workspace: WorkspaceHandle, base: string, ext: string): string {
  const existingExt = extname(base)
  const stem = existingExt ? base.slice(0, -existingExt.length) : base
  const suffix = existingExt || `.${ext}`
  let candidate = `${stem}${suffix}`
  let index = 2
  while (existsSync(resolve(workspace.dir, candidate))) {
    candidate = `${stem}-${index}${suffix}`
    index += 1
  }
  return candidate
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!shellWindow) return
    if (shellWindow.isMinimized()) shellWindow.restore()
    shellWindow.focus()
  })

  void app.whenReady().then(async () => {
    installNavigationGuard(app)
    installRendererProtocol({
      docs: join(DOCS_OUT, 'renderer'),
      sheets: join(SHEETS_OUT, 'renderer'),
      slides: join(SLIDES_OUT, 'renderer'),
      pdf: join(PDF_OUT, 'renderer'),
      markdown: join(MARKDOWN_OUT, 'renderer'),
      html: join(HTML_OUT, 'renderer'),
    })

    // The demo workspace is part of the product, not a fixture: it is provisioned
    // before the window opens so the list screen always has something openable in
    // it, and it is idempotent, so a later launch reuses the user's own edits.
    const userData = app.getPath('userData')
    try {
      await ensureDemoWorkspace(
        new WorkspaceStore(join(userData, 'workspaces')),
        join(userData, 'library'),
      )
    } catch (error) {
      // A demo that cannot be built must not keep the app from starting; the
      // list screen simply shows the workspaces that do exist.
      console.error('[workspace-shell] could not provision the demo workspace:', error)
    }

    const win = createShellWindow()
    shellWindow = win
    wireShell(win)

    // No workspace is activated here on purpose: the list is the landing screen.
    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
    else void win.loadFile(join(__dirname, '../renderer/index.html'))

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length > 0) return
      const next = createShellWindow()
      shellWindow = next
      wireShell(next)
      if (process.env.ELECTRON_RENDERER_URL) void next.loadURL(process.env.ELECTRON_RENDERER_URL)
      else void next.loadFile(join(__dirname, '../renderer/index.html'))
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    agents?.stopAll()
    try {
      service?.saveWorkspace()
    } catch {
      // No workspace open, or its folder moved: nothing to flush.
    }
  })
}
