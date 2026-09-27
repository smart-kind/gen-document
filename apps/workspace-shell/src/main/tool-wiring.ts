import {
  createDocumentEditToolSet,
  createDocumentToolSet,
  createFileSystemToolSet,
  createSlideEditToolSet,
  createUiToolSet,
  createWorkspaceToolSet,
  type ToolSet,
  type WorkspaceStore,
} from '@genoffice/workspace-harness'

/**
 * The tool sets every conversation's agent runs with.
 *
 * Kept out of `AgentService` so the exact composition is testable without
 * booting the agent host — the wiring is the part that silently rots. A set
 * declares its own `set:` id, so the four domains stay disjoint and a duplicate
 * tool name here would be a bug the registry already fails on.
 */
export function createAgentToolSets(store: WorkspaceStore): ToolSet[] {
  return [
    createWorkspaceToolSet({ store }),
    createFileSystemToolSet(),
    createDocumentToolSet(),
    createDocumentEditToolSet(),
    createSlideEditToolSet(),
    createUiToolSet(),
  ]
}
