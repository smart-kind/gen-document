import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { ipcMain, webContents } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { AI_PROVIDERS } from '@genoffice/ai-provider'
import { isLang, type Lang } from '@genoffice/i18n'
import {
  expandUserPath,
  readAiSettings,
  readConversations,
  READ_ONLY_ZONES,
  resolveRouting,
  ZONE_DIRS,
  ZONE_ORDER,
  type DocumentEditBridge,
  type ThemeMode,
  type WorkspaceHandle,
} from '@genoffice/workspace-harness'
import { normalizeAiPanelPrefs, type AiPanelPrefs } from '@genoffice/ui/ai-panel-prefs'
import type {
  CreateWorkspaceInput,
  InspectPathResult,
  ModelCatalogue,
  TreeEntry,
  WorkflowInstruction,
  WorkflowKind,
  WorkspaceSettingsPatch,
  WorkspaceSnapshot,
  ZoneGroup,
} from '../shared/api'
import { WORKSPACE_CHANNELS } from '../shared/api'
import type { AgentService } from './agent-service'
import type { Appearance } from './appearance'
import type { EditorHost } from './editor-host'
import { listTreeEntries } from './file-tree'
import { isProviderConfigured } from './model-routing'
import { buildWorkflowInstruction } from './workflows'
import type { WorkspaceService } from './workspace-service'

/**
 * Every renderer-reachable operation.
 *
 * Handlers stay thin: they translate between the renderer's serializable shape
 * and the services, and let errors propagate — the renderer's promise rejection
 * is what the wizard, the settings dialog and the tree show.
 */
export interface IpcDeps {
  service: WorkspaceService
  editors: EditorHost
  agents: AgentService
  appearance: Appearance
  /** The same document-edit bridge the agent's tools use, exposed to the debug panel. */
  docEditBridge: DocumentEditBridge
  /** `<userData>`, where the shared `ai-settings.json` lives. */
  userDataPath: string
  /** Send to the workspace shell's own renderer. */
  send: (channel: string, payload: unknown) => void
  /** Send to every webContents, editor views included. */
  sendAll: (channel: string, payload: unknown) => void
}

/**
 * Top-level entries of one zone directory.
 *
 * A zone directory can be absent (a workspace folder assembled by hand), which
 * is an empty zone rather than an error: the rail still shows all four groups,
 * so a missing one is visible instead of silently omitted.
 */
function listZoneEntries(
  workspace: WorkspaceHandle,
  dir: string,
  open: readonly string[],
): TreeEntry[] {
  try {
    return listTreeEntries(workspace.dir, dir, open)
  } catch {
    return []
  }
}

/**
 * Register one handler, replacing any previous one.
 *
 * The renderer's window can be recreated (closing every window on macOS and
 * clicking the dock icon), which re-wires the services; a plain `ipcMain.handle`
 * would throw "second handler" on the second pass.
 */
function handle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, listener)
}

export function registerWorkspaceIpc(deps: IpcDeps): void {
  const { service, editors, agents, appearance } = deps

  handle(WORKSPACE_CHANNELS.listWorkspaces, () => service.listRows())

  handle(WORKSPACE_CHANNELS.createWorkspace, (_event, input: CreateWorkspaceInput) => {
    const workspace = service.create(input)
    broadcastWorkspaceChanged(deps)
    return workspace
  })

  handle(WORKSPACE_CHANNELS.openWorkspace, (_event, id: string) => {
    editors.closeAll()
    service.open(id)
    broadcastWorkspaceChanged(deps)
    return snapshot(deps)
  })

  handle(WORKSPACE_CHANNELS.closeWorkspace, () => {
    editors.closeAll()
    service.close()
    broadcastWorkspaceChanged(deps)
  })

  handle(WORKSPACE_CHANNELS.lastActiveWorkspace, () => service.lastActiveId())

  handle(WORKSPACE_CHANNELS.describeWorkspace, () => snapshot(deps))

  handle(WORKSPACE_CHANNELS.setWorkspaceSettings, (_event, patch: WorkspaceSettingsPatch) => {
    const workspace = service.setSettings(patch)
    if (patch.language !== undefined) {
      // The workspace's language is the app's language: the editor views and
      // the renderer's own `document.lang` follow the same switch.
      appearance.setLanguage(isLang(patch.language) ? patch.language : appearance.getLanguage())
    }
    broadcastWorkspaceChanged(deps)
    return workspace
  })

  handle(WORKSPACE_CHANNELS.deleteWorkspace, (_event, id: string) => {
    if (service.current()?.id === id) editors.closeAll()
    service.remove(id)
    broadcastWorkspaceChanged(deps)
  })

  handle(WORKSPACE_CHANNELS.defaultParentDir, () => service.registry.workspacesRoot)

  handle(WORKSPACE_CHANNELS.listTree, (_event, dir?: string) => {
    const workspace = requireWorkspace(service)
    return listTreeEntries(workspace.dir, dir ?? '.', editors.openPaths())
  })

  handle(WORKSPACE_CHANNELS.listZones, (): ZoneGroup[] => {
    const workspace = requireWorkspace(service)
    const open = editors.openPaths()
    return ZONE_ORDER.map((zone) => ({
      zone,
      readOnly: READ_ONLY_ZONES.includes(zone),
      dir: ZONE_DIRS[zone],
      entries: listZoneEntries(workspace, ZONE_DIRS[zone], open),
    }))
  })

  handle(WORKSPACE_CHANNELS.listReferences, () => service.referenceStore().list())
  handle(WORKSPACE_CHANNELS.addReference, (_event, externalPath: string, as?: string) =>
    service.referenceStore().add(externalPath, as),
  )
  handle(WORKSPACE_CHANNELS.removeReference, (_event, nameOrPath: string) => {
    service.referenceStore().remove(nameOrPath)
  })

  handle(WORKSPACE_CHANNELS.addMaterial, (_event, externalPath: string, as?: string) =>
    service.materialStore().add(externalPath, as),
  )
  handle(WORKSPACE_CHANNELS.removeMaterial, (_event, nameOrPath: string) => {
    service.materialStore().remove(nameOrPath)
  })

  handle(WORKSPACE_CHANNELS.inspectPath, (_event, target: string) => inspectPath(target))
  handle(WORKSPACE_CHANNELS.listModels, () => modelCatalogue(deps.userDataPath))

  handle(WORKSPACE_CHANNELS.setLayoutInsets, (_event, insets: unknown) => {
    editors.setInsets(insets)
  })
  handle(WORKSPACE_CHANNELS.getLayoutInsets, () => editors.layoutInsets())

  handle(
    WORKSPACE_CHANNELS.openDocument,
    (_event, path: string, options?: { readOnly?: boolean }) => editors.open(path, options),
  )
  handle(
    WORKSPACE_CHANNELS.closeDocument,
    async (_event, id: string, options?: { save?: boolean }) => {
      await editors.close(id, options)
    },
  )
  handle(WORKSPACE_CHANNELS.activateDocument, (_event, id: string) => {
    editors.activate(id)
  })
  handle(WORKSPACE_CHANNELS.listOpenDocuments, () => editors.list())
  handle(WORKSPACE_CHANNELS.activeDocument, () => editors.activeDocument() ?? null)

  // The debug panel's short circuit: it lists the open tabs and drives the
  // document-edit bridge directly, so an operation can be exercised — and its
  // incremental render observed — without an agent or an LLM in the loop.
  handle(WORKSPACE_CHANNELS.bridgeTabs, () => editors.bridgeTabs())
  handle(
    WORKSPACE_CHANNELS.bridgeRunCommand,
    (_event, wcId: number, command: string, payload: unknown) =>
      deps.docEditBridge.runCommand(wcId, command, payload),
  )

  handle(WORKSPACE_CHANNELS.listConversations, () =>
    agents.listConversations(requireWorkspace(service).dir),
  )
  handle(WORKSPACE_CHANNELS.createConversation, (_event, title: string) => {
    const entry = agents.createConversation(requireWorkspace(service).dir, title)
    broadcastWorkspaceChanged(deps)
    return entry
  })
  handle(WORKSPACE_CHANNELS.deleteConversation, (_event, id: string) => {
    agents.deleteConversation(requireWorkspace(service).dir, id)
    broadcastWorkspaceChanged(deps)
  })
  handle(WORKSPACE_CHANNELS.transcript, (_event, id: string) =>
    agents.transcript(requireWorkspace(service).dir, id),
  )
  handle(
    WORKSPACE_CHANNELS.workflowInstruction,
    (_event, kind: WorkflowKind): WorkflowInstruction =>
      buildWorkflowInstruction(
        requireWorkspace(service),
        kind === 'summarize' ? 'summarize' : 'validate',
      ),
  )

  handle(WORKSPACE_CHANNELS.prompt, async (_event, conversationId: string, text: string) => {
    try {
      await agents.prompt(requireWorkspace(service).dir, conversationId, text)
    } catch (error) {
      // The renderer paints errors from the stream, so a failed prompt is an
      // event rather than a rejection it has to catch itself.
      deps.send(WORKSPACE_CHANNELS.agentEvent, {
        conversationId,
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })
  handle(WORKSPACE_CHANNELS.steer, (_event, conversationId: string, text: string) => {
    agents.steer(conversationId, text)
  })
  handle(WORKSPACE_CHANNELS.abort, (_event, conversationId: string) => {
    agents.abort(conversationId)
  })

  handle(WORKSPACE_CHANNELS.getLanguage, (): Lang => appearance.getLanguage())
  handle(WORKSPACE_CHANNELS.setLanguage, (_event, lang: unknown) => {
    if (!isLang(lang)) return
    appearance.setLanguage(lang)
  })
  handle(WORKSPACE_CHANNELS.getTheme, (): ThemeMode => appearance.getTheme())
  handle(WORKSPACE_CHANNELS.setTheme, (_event, mode: unknown) => {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return
    appearance.setTheme(mode)
  })

  // The embedded editor views read the app-wide language and theme channels.
  // Their own modules register `app:get-language` too, against the same
  // process-wide i18n holder, but only the host can answer `app:get-theme`;
  // registering both here with the remove-first helper keeps the pair
  // consistent whichever module registered last.
  handle('app:get-language', (): Lang => appearance.getLanguage())
  handle('app:get-theme', (): ThemeMode => appearance.getTheme())

  // The embedded editors read auto-save and AI-panel prefs at boot; without
  // these handlers the preload invoke() rejects and the editor may fail to
  // initialise.  The workspace shell does not yet persist either preference —
  // auto-save is off and AI-panel prefs use the package defaults.
  handle('app:get-auto-save-default', () => ({ on: false, updatedAt: 0 }))

  handle('app:get-ai-panel-prefs', (): AiPanelPrefs => normalizeAiPanelPrefs({}))
  handle('app:set-ai-panel-prefs', (): AiPanelPrefs => normalizeAiPanelPrefs({}))
}

/** Current workspace plus everything the renderer paints from it. */
export function snapshot(deps: IpcDeps): WorkspaceSnapshot | null {
  const workspace = deps.service.current()
  if (!workspace) return null
  return {
    workspace,
    conversations: readConversations(workspace.dir),
    references: deps.service.referenceStore().list(),
  }
}

/**
 * What the wizard's live check shows for a typed path.
 *
 * `~` is expanded here because the user types it, not a shell; a path that does
 * not exist is a normal answer rather than an error, since that is exactly what
 * the check is for.
 */
export function inspectPath(input: string): InspectPathResult {
  const target = resolve(expandUserPath(String(input ?? '').trim()))
  const name = basename(target) || target
  try {
    const stat = statSync(target)
    if (stat.isDirectory()) {
      let entries = 0
      try {
        entries = readdirSync(target).length
      } catch {
        // An unreadable directory still exists; the count is just unavailable.
      }
      return { exists: true, kind: 'dir', name, entries }
    }
    return { exists: true, kind: 'file', name }
  } catch {
    return { exists: existsSync(target), name }
  }
}

/** Provider catalogue for the model picker, plus what the global settings resolve to. */
export function modelCatalogue(userDataPath: string): ModelCatalogue {
  const settings = readAiSettings(userDataPath)
  const routing = resolveRouting(settings)
  return {
    providers: AI_PROVIDERS.map((meta) => ({
      id: meta.id,
      label: meta.label,
      models: [...meta.models],
      defaultModel: meta.defaultModel,
    })),
    configured: AI_PROVIDERS.map((meta) => meta.id).filter((id) =>
      isProviderConfigured(settings, id),
    ),
    global: routing ? { provider: routing.provider, model: routing.config.model } : null,
  }
}

/** Tell the renderer to re-read the workspace after any structural change. */
function broadcastWorkspaceChanged(deps: IpcDeps): void {
  deps.send(WORKSPACE_CHANNELS.shellEvent, { type: 'workspace.changed' })
}

function requireWorkspace(service: WorkspaceService): WorkspaceHandle {
  const handle = service.current()
  if (!handle) throw new Error('no workspace is open')
  return handle
}

/** Fan a value out to every renderer process, the editor views included. */
export function broadcastToAllWebContents(channel: string, payload: unknown): void {
  for (const contents of webContents.getAllWebContents()) contents.send(channel, payload)
}
