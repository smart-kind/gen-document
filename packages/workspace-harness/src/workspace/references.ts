import { existsSync, lstatSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { assertSafeEntryName, expandUserPath } from './paths.js'
import type { ReferenceEntry, WorkspaceHandle } from './types.js'
import { ZONE_DIRS } from './zones.js'

export interface ReferenceInfo extends ReferenceEntry {
  available: boolean
  kind: 'file' | 'dir' | 'missing'
  /** Size in bytes, present only for available files. */
  size?: number
}

/**
 * The read-only `引用/` mount of a workspace.
 *
 * References are symlinks into a shared library, never copies: updating the
 * source updates every workspace that mounts it. That is exactly why the mount
 * is read-only — writing through it would corrupt material other workspaces
 * depend on. Project-exclusive material, which this workspace alone owns, is
 * copied instead; see `MaterialStore`.
 */
export class ReferenceStore {
  constructor(
    private readonly workspace: WorkspaceHandle,
    private readonly persist: (workspace: WorkspaceHandle) => void,
  ) {}

  /** Mount an external path as `引用/<name>`. */
  add(externalPath: string, as?: string): ReferenceInfo {
    const target = resolve(expandUserPath(externalPath))
    if (!existsSync(target)) throw new Error(`reference source does not exist: ${target}`)

    const name = as?.trim() || basename(target)
    assertSafeEntryName(name, 'reference name')
    const link = `${ZONE_DIRS.library}/${name}`
    const linkAbs = join(this.workspace.dir, ZONE_DIRS.library, name)
    if (existsSync(linkAbs) || isSymlink(linkAbs)) {
      throw new Error(`a reference named "${name}" is already mounted at ${link}`)
    }

    const isDir = statSync(target).isDirectory()
    symlinkSync(target, linkAbs, isDir ? 'dir' : 'file')

    const entry: ReferenceEntry = { name, link, target, readOnly: true }
    this.workspace.manifest.references = [
      ...this.workspace.manifest.references.filter((r) => r.link !== link),
      entry,
    ]
    this.persist(this.workspace)
    return { ...entry, available: true, kind: isDir ? 'dir' : 'file' }
  }

  list(): ReferenceInfo[] {
    return this.workspace.manifest.references.map((entry) => {
      const linkAbs = join(this.workspace.dir, entry.link)
      try {
        const stat = statSync(linkAbs)
        const kind = stat.isDirectory() ? 'dir' : 'file'
        return {
          ...entry,
          available: true,
          kind,
          ...(kind === 'file' ? { size: stat.size } : {}),
        }
      } catch {
        // A symlink whose target moved still resolves to a broken link, and
        // `statSync` follows links, so both cases land here.
        return { ...entry, available: false, kind: 'missing' }
      }
    })
  }

  /** Unmount a reference. The linked source file is never touched. */
  remove(nameOrPath: string): ReferenceEntry {
    const needle = nameOrPath.trim()
    const entry = this.workspace.manifest.references.find(
      (r) => r.name === needle || r.link === needle || r.link === `${ZONE_DIRS.library}/${needle}`,
    )
    if (!entry) throw new Error(`no such reference: ${nameOrPath}`)

    const linkAbs = join(this.workspace.dir, entry.link)
    if (isSymlink(linkAbs)) {
      unlinkSync(linkAbs)
    } else if (existsSync(linkAbs)) {
      throw new Error(
        `refusing to remove "${entry.link}": it is not a symlink, so removing it would delete real content`,
      )
    }

    this.workspace.manifest.references = this.workspace.manifest.references.filter(
      (r) => r.link !== entry.link,
    )
    this.persist(this.workspace)
    return entry
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
