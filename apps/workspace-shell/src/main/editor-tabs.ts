import { basename } from 'node:path'
import { isReadOnlyPath as isReadOnlyZonePath } from '@genoffice/workspace-harness'

/**
 * Pure editor-tab rules: which editor app serves a path and whether it is
 * read-only.
 *
 * These live apart from `editor-host.ts` because that module imports Electron
 * and every editor app's main process; the rules here are plain functions the
 * unit tests can import on their own. Where a view may paint is a layout
 * question, so it lives in `shared/layout.ts` with the renderer's own numbers.
 */

/** The editor apps a workspace tab can be served by. */
export type EditorKind = 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html'

export const EDITOR_KINDS: readonly EditorKind[] = [
  'docs',
  'sheets',
  'slides',
  'pdf',
  'markdown',
  'html',
]

const KIND_BY_EXTENSION: Record<string, EditorKind> = {
  '.docx': 'docs',
  '.xlsx': 'sheets',
  '.xls': 'sheets',
  '.csv': 'sheets',
  '.pptx': 'slides',
  '.pdf': 'pdf',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.txt': 'markdown',
}

/** The editor app that can render this path, or null for an unsupported type. */
export function editorKindForPath(path: string): EditorKind | null {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  return KIND_BY_EXTENSION[path.slice(dot).toLowerCase()] ?? null
}

/** Read-only is forced by the read-only zones and can only be added to, never removed. */
export function isReadOnlyPath(relPath: string, requested?: boolean): boolean {
  return requested === true || isReadOnlyZonePath(relPath)
}

/** Tab title for a workspace-relative path. */
export function tabTitleFor(relPath: string): string {
  return basename(relPath)
}
