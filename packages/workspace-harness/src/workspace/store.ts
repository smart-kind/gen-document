import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { nowIso } from '../time.js'
import { newId } from './ids.js'
import { readJsonFile, writeJsonFile } from './json-file.js'
import { createManifest, manifestPath, readManifest, writeManifest } from './manifest.js'
import { expandUserPath, metaDir } from './paths.js'
import {
  MANIFEST_SCHEMA_VERSION,
  type WorkspaceHandle,
  type WorkspaceIndex,
  type WorkspaceIndexEntry,
  type WorkspaceSummary,
} from './types.js'
import { ZONE_ORDER, zonePath } from './zones.js'

/**
 * Versioned content only: the transient search index and OS junk are ignored.
 * Sessions under `.workspace/sessions/` are deliberately tracked.
 */
const WORKSPACE_GITIGNORE = [
  '# Transient workspace scratch',
  '.workspace/index.db',
  '.DS_Store',
  '',
].join('\n')

export interface CreateWorkspaceInput {
  goal: string
  name?: string
  /** Parent directory for the new folder; defaults to the store's workspaces root. */
  parentDir?: string
  /** True for the built-in demo workspace, which serves no goal and may start empty. */
  demo?: boolean
}

/**
 * Workspace registry backed by a plain directory tree.
 *
 * Layout: `<root>/index.json` lists every workspace and where its folder lives;
 * each folder carries its own `.workspace/manifest.json` as the source of truth.
 * The caller injects the root (usually `<userData>/workspaces`), so this class
 * stays free of Electron.
 */
export class WorkspaceStore {
  constructor(private readonly root: string) {}

  /** Directory holding store-created workspaces by default. */
  get workspacesRoot(): string {
    return this.root
  }

  create(input: CreateWorkspaceInput): WorkspaceHandle {
    const demo = input.demo === true
    const goal = input.goal?.trim() ?? ''
    // The demo workspace serves no goal, so an empty goal is allowed for it only.
    if (!goal && !demo) throw new Error('workspace goal must be a non-empty string')
    const id = newId('ws')
    const name = input.name?.trim() || goal.slice(0, 60) || 'Demo'
    const parent = resolve(input.parentDir ? expandUserPath(input.parentDir) : this.root)
    const dir = join(parent, id)
    if (existsSync(dir)) throw new Error(`workspace directory already exists: ${dir}`)

    mkdirSync(metaDir(dir), { recursive: true })
    for (const zone of ZONE_ORDER) mkdirSync(zonePath(dir, zone), { recursive: true })
    writeFileSync(join(dir, '.gitignore'), WORKSPACE_GITIGNORE, 'utf8')

    const now = nowIso()
    const manifest = createManifest({ id, name, goal, now, demo })
    writeManifest(dir, manifest)
    this.upsertIndex({
      id,
      name,
      goal,
      dir,
      createdAt: now,
      updatedAt: now,
      ...(demo ? { demo: true } : {}),
    })

    return { id, name, goal, dir, manifest }
  }

  list(): WorkspaceSummary[] {
    return this.readIndex().workspaces.map((entry) => ({
      ...entry,
      available: existsSync(manifestPath(entry.dir)),
    }))
  }

  open(id: string): WorkspaceHandle | undefined {
    const entry = this.readIndex().workspaces.find((w) => w.id === id)
    if (!entry) return undefined
    const manifest = readManifest(entry.dir)
    if (!manifest) return undefined
    return {
      id: manifest.id,
      name: manifest.name,
      goal: manifest.goal,
      dir: entry.dir,
      manifest,
    }
  }

  /** Absolute folder of a registered workspace, even when its manifest is unreadable. */
  dirFor(id: string): string | undefined {
    return this.readIndex().workspaces.find((w) => w.id === id)?.dir
  }

  update(id: string, patch: { goal?: string; name?: string }): WorkspaceHandle {
    const handle = this.open(id)
    if (!handle) throw new Error(`unknown workspace: ${id}`)
    if (patch.goal !== undefined) {
      const goal = patch.goal.trim()
      if (!goal) throw new Error('workspace goal must be a non-empty string')
      handle.manifest.goal = goal
    }
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) throw new Error('workspace name must be a non-empty string')
      handle.manifest.name = name
    }
    this.save(handle)
    return handle
  }

  /** Persist a handle's manifest and refresh its index entry. */
  save(handle: WorkspaceHandle): void {
    handle.manifest.updatedAt = nowIso()
    writeManifest(handle.dir, handle.manifest)
    handle.name = handle.manifest.name
    handle.goal = handle.manifest.goal
    this.upsertIndex({
      id: handle.manifest.id,
      name: handle.manifest.name,
      goal: handle.manifest.goal,
      dir: handle.dir,
      createdAt: handle.manifest.createdAt,
      updatedAt: handle.manifest.updatedAt,
      ...(handle.manifest.demo ? { demo: true } : {}),
    })
  }

  /**
   * Remove a workspace and its folder.
   *
   * The folder is only deleted when it still reads as a workspace, so a moved or
   * hand-edited index entry can never take unrelated files with it.
   */
  remove(id: string): WorkspaceIndexEntry {
    const index = this.readIndex()
    const entry = index.workspaces.find((w) => w.id === id)
    if (!entry) throw new Error(`unknown workspace: ${id}`)
    if (readManifest(entry.dir)) rmSync(entry.dir, { recursive: true, force: true })
    this.writeIndex({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      workspaces: index.workspaces.filter((w) => w.id !== id),
    })
    return entry
  }

  private indexPath(): string {
    return join(this.root, 'index.json')
  }

  private readIndex(): WorkspaceIndex {
    const raw = readJsonFile<WorkspaceIndex>(this.indexPath())
    const workspaces = Array.isArray(raw?.workspaces) ? raw.workspaces : []
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, workspaces }
  }

  private writeIndex(index: WorkspaceIndex): void {
    writeJsonFile(this.indexPath(), index)
  }

  private upsertIndex(entry: WorkspaceIndexEntry): void {
    const index = this.readIndex()
    const rest = index.workspaces.filter((w) => w.id !== entry.id)
    this.writeIndex({ schemaVersion: MANIFEST_SCHEMA_VERSION, workspaces: [...rest, entry] })
  }
}
