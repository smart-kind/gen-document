import type { ShellBridge, VersionBridge } from '@genoffice/workspace-harness'
import type { EditorHost } from './editor-host'

/** Bridges the harness tools drive to reach the running shell. */

export interface ShellBridgeDeps {
  editors: EditorHost
  /** Switch the whole shell to another workspace (the file tree is rebuilt). */
  openWorkspace: (id: string) => void
}

export function createShellBridge(deps: ShellBridgeDeps): ShellBridge {
  return {
    openDocument: async (path, options) =>
      deps.editors.open(path, { ...(options?.readOnly ? { readOnly: true } : {}) }),
    closeDocument: async (id, options) => deps.editors.close(id, options),
    activateDocument: async (id) => {
      deps.editors.activate(id)
    },
    listOpenDocuments: async () => deps.editors.list(),
    openWorkspace: async (id) => {
      deps.openWorkspace(id)
    },
  }
}

/** Version control is read-only in this build: the manifest carries the config, tools come later. */
export function createVersionBridge(enabled: () => boolean): VersionBridge {
  return { enabled }
}
