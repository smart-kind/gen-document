import { homedir } from 'node:os'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'

/** Directory (workspace-relative) holding harness bookkeeping. */
export const META_DIR = '.workspace'

/** Absolute path of the harness bookkeeping directory. */
export function metaDir(workspaceDir: string): string {
  return join(workspaceDir, META_DIR)
}

/** Normalize a workspace-relative path to POSIX form without a leading `./`. */
export function normalizeRel(relPath: string): string {
  const posix = relPath.replace(/\\/g, '/').replace(/^\.\/+/, '')
  return normalize(posix).replace(/\\/g, '/')
}

/**
 * Resolve a workspace-relative path against the workspace root, rejecting
 * anything that escapes it. `'.'` resolves to the root itself.
 */
export function resolveInside(workspaceDir: string, relPath: string): string {
  const root = resolve(workspaceDir)
  const abs = resolve(root, relPath)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path "${relPath}" escapes the workspace root`)
  }
  return abs
}

/** Workspace-relative POSIX path for an absolute path inside the workspace. */
export function toWorkspaceRel(workspaceDir: string, absPath: string): string {
  return relative(resolve(workspaceDir), resolve(absPath)).replace(/\\/g, '/')
}

/** Expand a leading `~` to the home directory; other paths pass through unchanged. */
export function expandUserPath(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return join(homedir(), input.slice(2))
  return input
}

/**
 * A mounted entry becomes a single directory entry inside a zone, so its name
 * must stay a plain file name: no separators, no traversal.
 */
export function assertSafeEntryName(name: string, label: string): void {
  if (!name || name === '.' || name === '..') {
    throw new Error(`Invalid ${label} "${name}"`)
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`Invalid ${label} "${name}": must not contain path separators`)
  }
}
