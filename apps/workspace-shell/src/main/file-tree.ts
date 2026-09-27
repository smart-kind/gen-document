import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { documentTypeFor, normalizeRel, resolveInside } from '@genoffice/workspace-harness'
import type { TreeEntry } from '../shared/api'
import { isReadOnlyPath } from './editor-tabs'

/**
 * One directory of the workspace file tree.
 *
 * The listing rules are the harness `fs_list` tool's, on purpose: the agent and
 * the tree must agree about what exists, or the model will see entries the user
 * cannot. `references/` is listed but every entry under it is marked read-only.
 */

/** Bookkeeping directories neither the agent nor the tree shows. */
const HIDDEN_DIRS = new Set(['.workspace', '.git'])

export function listTreeEntries(
  workspaceDir: string,
  relDir = '.',
  openPaths: readonly string[] = [],
): TreeEntry[] {
  const rel = normalizeRel(relDir)
  const abs = resolveInside(workspaceDir, rel)
  if (!statSync(abs).isDirectory()) throw new Error(`${rel} is not a directory`)

  const open = new Set(openPaths.map((path) => normalizeRel(path)))

  return readdirSync(abs, { withFileTypes: true })
    .filter((entry) => !HIDDEN_DIRS.has(entry.name))
    .map((entry) => {
      const childRel = rel === '.' ? entry.name : `${rel}/${entry.name}`
      const type = documentTypeFor(entry.name)
      let kind: TreeEntry['kind'] = entry.isDirectory() ? 'dir' : 'file'
      let size: number | undefined
      try {
        const stat = statSync(join(abs, entry.name))
        kind = stat.isDirectory() ? 'dir' : 'file'
        size = stat.isFile() ? stat.size : undefined
      } catch {
        // A reference symlink whose target moved still lists; it just has no size.
      }
      return {
        name: entry.name,
        path: childRel,
        kind,
        readOnly: isReadOnlyPath(childRel),
        ...(type ? { type } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(open.has(childRel) ? { open: true } : {}),
      }
    })
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
}

/** Workspace-relative path of an absolute path inside the workspace. */
export function relativeToWorkspace(workspaceDir: string, absPath: string): string {
  return relative(workspaceDir, absPath).replace(/\\/g, '/')
}
