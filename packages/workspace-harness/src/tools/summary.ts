import type { OpenDocument } from '../tool/types.js'
import type { DocumentEntry, WorkspaceHandle } from '../workspace/types.js'
import { countZoneFiles } from '../workspace/zones.js'

/** Compact document summary for listings and postState payloads. */
export function describeDocument(entry: DocumentEntry, open?: OpenDocument) {
  return {
    id: entry.id,
    path: entry.path,
    type: entry.type,
    ...(entry.note ? { note: entry.note } : {}),
    ...(open ? { open: true, dirty: open.dirty ?? false } : {}),
  }
}

export function describeDocuments(workspace: WorkspaceHandle) {
  return workspace.manifest.documents.map((entry) => describeDocument(entry))
}

/**
 * Workspace summary rich enough for the model to keep deciding without a
 * follow-up read: identity, settings, the per-zone file counts, and the full
 * document and reference inventory.
 */
export function describeWorkspace(workspace: WorkspaceHandle, extra?: { conversations?: number }) {
  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      goal: workspace.goal,
      dir: workspace.dir,
      documents: describeDocuments(workspace),
      zones: {
        library: countZoneFiles(workspace.dir, 'library'),
        material: countZoneFiles(workspace.dir, 'material'),
        output: countZoneFiles(workspace.dir, 'output'),
        feedback: countZoneFiles(workspace.dir, 'feedback'),
      },
      references: workspace.manifest.references.map((ref) => ({
        name: ref.name,
        link: ref.link,
        target: ref.target,
        readOnly: true as const,
      })),
      settings: workspace.manifest.settings,
      ...(extra?.conversations !== undefined ? { conversations: extra.conversations } : {}),
    },
  }
}
