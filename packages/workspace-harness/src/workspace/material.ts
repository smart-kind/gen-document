import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { assertSafeEntryName, expandUserPath } from './paths.js'
import { listZone, ZONE_DIRS, zonePath, type ZoneEntry } from './zones.js'

/**
 * The project-exclusive read-only material of a workspace (`资料/`).
 *
 * Unlike `引用/`, these are copies rather than links. Owner requirements and
 * validation rules belong to this project alone, so copying makes the workspace
 * self-contained and portable, and it means a validation run compares against
 * the rules as they were when they were brought in rather than against a file
 * someone may have edited meanwhile.
 *
 * Material is an input: the tool layer refuses to write to this zone, so adding
 * or removing it is a deliberate user action through this store. There is no
 * manifest index — the filesystem under `资料/` is the inventory.
 */
export class MaterialStore {
  constructor(private readonly workspaceDir: string) {}

  list(): ZoneEntry[] {
    return listZone(this.workspaceDir, 'material')
  }

  /** Copy an external file or folder into `资料/`. */
  add(externalPath: string, as?: string): ZoneEntry {
    const source = resolve(expandUserPath(externalPath))
    if (!existsSync(source)) throw new Error(`material source does not exist: ${source}`)

    const name = as?.trim() || basename(source)
    assertSafeEntryName(name, 'material name')
    const dir = zonePath(this.workspaceDir, 'material')
    const abs = join(dir, name)
    if (existsSync(abs)) {
      throw new Error(`material named "${name}" already exists in ${ZONE_DIRS.material}/`)
    }

    mkdirSync(dir, { recursive: true })
    const isDir = statSync(source).isDirectory()
    cpSync(source, abs, { recursive: isDir })
    return {
      name,
      path: `${ZONE_DIRS.material}/${name}`,
      kind: isDir ? 'dir' : 'file',
      readOnly: true,
    }
  }

  /** Remove a copied item. It is a copy, so the source is never touched. */
  remove(nameOrPath: string): string {
    const name = basename(nameOrPath.trim().replace(/\\/g, '/'))
    assertSafeEntryName(name, 'material name')
    const abs = join(zonePath(this.workspaceDir, 'material'), name)
    if (!existsSync(abs)) throw new Error(`no such material: ${nameOrPath}`)
    rmSync(abs, { recursive: true, force: true })
    return `${ZONE_DIRS.material}/${name}`
  }
}
