import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { META_DIR, normalizeRel } from './paths.js'

/**
 * Zones of a workspace.
 *
 * A workspace is not one writable folder: it holds four kinds of content with
 * different provenance and different write rules. Which zone a path belongs to
 * is derived from its top-level directory, so the path stays the single source
 * of truth and no manifest field can drift away from the filesystem.
 */
export type ZoneId = 'library' | 'material' | 'output' | 'feedback'

/** Directory name per zone, relative to the workspace root. */
export const ZONE_DIRS: Record<ZoneId, string> = {
  /** Read-only: linked shared material, shared by every workspace that mounts it. */
  library: '引用',
  /** Read-only: project-exclusive copies, such as owner requirements and validation rules. */
  material: '资料',
  /** Writable: the documents this workspace produces. */
  output: '产出',
  /** Writable: piecemeal feedback from whoever reviews the produced documents. */
  feedback: '意见',
}

/** Display order: the inputs first, then the working zones. */
export const ZONE_ORDER: readonly ZoneId[] = ['library', 'material', 'output', 'feedback']

/** Zones no tool may write to. */
export const READ_ONLY_ZONES: readonly ZoneId[] = ['library', 'material']

export function zoneDir(id: ZoneId): string {
  return ZONE_DIRS[id]
}

export function zonePath(workspaceDir: string, id: ZoneId): string {
  return join(workspaceDir, ZONE_DIRS[id])
}

/** Zone a workspace-relative path belongs to, or undefined outside the four zones. */
export function zoneOf(relPath: string): ZoneId | undefined {
  const head = normalizeRel(relPath).split('/')[0]
  if (!head) return undefined
  return ZONE_ORDER.find((id) => ZONE_DIRS[id] === head)
}

/** Harness bookkeeping: writable, but not a zone and hidden from the tree. */
export function isMetaPath(relPath: string): boolean {
  const norm = normalizeRel(relPath)
  return norm === META_DIR || norm.startsWith(`${META_DIR}/`)
}

/** True for the read-only input zones. */
export function isReadOnlyPath(relPath: string): boolean {
  const zone = zoneOf(relPath)
  return zone !== undefined && READ_ONLY_ZONES.includes(zone)
}

/**
 * Hard data boundary: only the writable zones and harness bookkeeping accept writes.
 *
 * Every File System write tool goes through this. The read-only zones hold
 * material the workspace does not own — linked company assets other workspaces
 * also see, and this project's authoritative inputs — so writing through them
 * would either corrupt someone else's data or quietly change what a validation
 * run compares against.
 *
 * Mounting into a read-only zone is a deliberate user action in the UI, not a
 * tool write, so it does not pass through here.
 */
export function assertWritable(relPath: string): void {
  const norm = normalizeRel(relPath)
  const zone = zoneOf(norm)
  if (zone) {
    if (READ_ONLY_ZONES.includes(zone)) {
      throw new Error(
        `Refusing to modify "${relPath}": ${ZONE_DIRS[zone]}/ is a read-only input zone`,
      )
    }
    return
  }
  if (isMetaPath(norm)) return
  throw new Error(
    `Refusing to write "${relPath}": documents live in ${ZONE_DIRS.output}/ or ${ZONE_DIRS.feedback}/, ` +
      `while ${ZONE_DIRS.library}/ and ${ZONE_DIRS.material}/ are read-only inputs`,
  )
}

export interface ZoneEntry {
  name: string
  /** Workspace-relative POSIX path. */
  path: string
  kind: 'file' | 'dir' | 'missing'
  size?: number
  readOnly: boolean
}

/** Top-level entries of one zone, empty when the zone directory is absent. */
export function listZone(workspaceDir: string, zone: ZoneId): ZoneEntry[] {
  const dir = zonePath(workspaceDir, zone)
  if (!existsSync(dir)) return []
  let dirents: Dirent[]
  try {
    dirents = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return dirents.map((entry) => {
    let kind: ZoneEntry['kind']
    let size: number | undefined
    try {
      // Follows symlinks, so a mount reports the kind and size of its target.
      const stat = statSync(join(dir, entry.name))
      kind = stat.isDirectory() ? 'dir' : 'file'
      size = stat.isFile() ? stat.size : undefined
    } catch {
      kind = 'missing'
    }
    return {
      name: entry.name,
      path: `${ZONE_DIRS[zone]}/${entry.name}`,
      kind,
      readOnly: READ_ONLY_ZONES.includes(zone),
      ...(size !== undefined ? { size } : {}),
    }
  })
}

/** Number of files in a zone, bounded so a pathological tree cannot stall a listing. */
export function countZoneFiles(workspaceDir: string, zone: ZoneId, maxEntries = 2_000): number {
  let count = 0
  const walk = (dir: string): void => {
    if (count >= maxEntries) return
    let dirents: Dirent[]
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of dirents) {
      if (count >= maxEntries) return
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else if (entry.isFile()) count += 1
    }
  }
  walk(zonePath(workspaceDir, zone))
  return count
}
