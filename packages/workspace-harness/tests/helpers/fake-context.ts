import { WorkspaceStore } from '../../src/workspace/store.js'
import { ReferenceStore } from '../../src/workspace/references.js'
import type {
  HarnessEvent,
  OpenDocument,
  ShellBridge,
  ToolContext,
  UiBridge,
  VersionBridge,
} from '../../src/tool/types.js'
import type { DocumentEntry, ThemeMode } from '../../src/workspace/types.js'

export interface FakeUi extends UiBridge {
  language: string
  theme: ThemeMode
  panels: Map<string, boolean>
  notifications: { message: string; level: string }[]
}

export interface FakeShell extends ShellBridge {
  documents: OpenDocument[]
  openedWorkspaces: string[]
}

export interface FakeContext extends ToolContext {
  events: HarnessEvent[]
  ui: FakeUi
  shell: FakeShell
}

/**
 * Build a ToolContext over a real workspace folder with in-memory UI and shell
 * bridges, so tool behaviour is tested without Electron.
 */
export function createFakeContext(store: WorkspaceStore, goal = 'test goal'): FakeContext {
  const workspace = store.create({ goal })
  const events: HarnessEvent[] = []

  const panels = new Map<string, boolean>()
  const notifications: { message: string; level: string }[] = []
  const ui: FakeUi = {
    language: 'zh-CN',
    theme: 'light',
    panels,
    notifications,
    getLanguage: async () => ui.language,
    setLanguage: async (locale) => {
      ui.language = locale
    },
    getTheme: async () => ui.theme,
    setTheme: async (mode) => {
      ui.theme = mode
    },
    togglePanel: async (panel, visible) => {
      panels.set(panel, visible)
    },
    notify: async (message, level) => {
      notifications.push({ message, level })
    },
  }

  const shell: FakeShell = {
    documents: [],
    openedWorkspaces: [],
    openDocument: async (path, options) => {
      const existing = shell.documents.find((d) => d.path === path)
      if (existing) {
        existing.active = true
        for (const doc of shell.documents) if (doc !== existing) doc.active = false
        return existing
      }
      const opened: OpenDocument = {
        id: `tab-${shell.documents.length + 1}`,
        path,
        // The real shell picks the editor from the extension; the fake does not
        // need a full type table for the assertions it supports.
        type: path.endsWith('.pptx') ? 'pptx' : path.endsWith('.md') ? 'md' : 'docx',
        title: path,
        active: true,
        readOnly: options?.readOnly ?? false,
      }
      for (const doc of shell.documents) doc.active = false
      shell.documents.push(opened)
      return opened
    },
    closeDocument: async (id) => {
      shell.documents = shell.documents.filter((d) => d.id !== id)
    },
    activateDocument: async (id) => {
      for (const doc of shell.documents) doc.active = doc.id === id
    },
    listOpenDocuments: async () => shell.documents.map((doc) => ({ ...doc })),
    openWorkspace: async (id) => {
      shell.openedWorkspaces.push(id)
    },
  }

  const vcs: VersionBridge = { enabled: () => workspace.manifest.vcs.enabled }

  const resolveDocument = (ref: string): DocumentEntry | undefined =>
    workspace.manifest.documents.find((d) => d.id === ref || d.path === ref)

  return {
    workspace,
    references: new ReferenceStore(workspace, (ws) => store.save(ws)),
    ui,
    shell,
    vcs,
    events,
    resolveDocument,
    saveWorkspace: () => store.save(workspace),
    emit: (event) => {
      events.push(event)
    },
  }
}
