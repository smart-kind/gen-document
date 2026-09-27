import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  MaterialStore,
  ReferenceStore,
  WorkspaceStore,
  type DocumentEditBridge,
  type DocumentEntry,
  type HarnessEvent,
  type ShellBridge,
  type ToolContext,
  type UiBridge,
  type VersionBridge,
  type WorkspaceHandle,
  type WorkspaceSummary,
} from '@genoffice/workspace-harness'
import type { CreateWorkspaceInput, WorkspaceRow, WorkspaceSettingsPatch } from '../shared/api'

/**
 * Bridges the running shell supplies to every tool call.
 *
 * Injected rather than imported so this service stays Electron-free and the
 * unit tests can drive it with fakes.
 */
export interface ShellBridges {
  ui: UiBridge
  shell: ShellBridge
  vcs: VersionBridge
}

export interface WorkspaceServiceOptions {
  /** Root of the workspace registry, normally `<userData>/workspaces`. */
  root: string
  /** File remembering the last opened workspace id across restarts. */
  activeIdFile: string
  bridges: () => ShellBridges
  /** Document of the active editor tab; resolved fresh on every tool call. */
  activeDocument?: () => DocumentEntry | undefined
  /** Harness effect sink; the IPC layer forwards these to the renderer. */
  onEvent?: (event: HarnessEvent) => void
  /** Live document-edit bridge for incremental (non-flickering) edits. */
  docEditBridge?: DocumentEditBridge
}

interface ActiveIdFile {
  workspaceId: string | null
}

/**
 * Owns the workspace registry and the one workspace currently open.
 *
 * The store is the harness's plain-Node registry; what this adds is "the open
 * workspace", which is process state, plus the tool context every agent call is
 * built from. Opening is always an explicit user action — the workspace list is
 * the landing screen, so nothing here restores a workspace on its own; the id
 * file only records what to mark as "last opened".
 */
export class WorkspaceService {
  private readonly store: WorkspaceStore
  private handle: WorkspaceHandle | null = null
  private references: ReferenceStore | null = null
  private material: MaterialStore | null = null

  constructor(private readonly options: WorkspaceServiceOptions) {
    this.store = new WorkspaceStore(options.root)
  }

  /** The registry, for the workspace tool set and the IPC layer. */
  get registry(): WorkspaceStore {
    return this.store
  }

  list(): WorkspaceSummary[] {
    return this.store.list()
  }

  /** Rows for the list screen: registry entries plus the counts each row shows. */
  listRows(): WorkspaceRow[] {
    return this.store.list().map((entry) => {
      const handle = entry.available ? this.store.open(entry.id) : undefined
      return {
        ...entry,
        documents: handle?.manifest.documents.length ?? 0,
        references: handle?.manifest.references.length ?? 0,
      }
    })
  }

  current(): WorkspaceHandle | null {
    return this.handle
  }

  /** Create and open a workspace; it becomes the active one. */
  create(input: CreateWorkspaceInput): WorkspaceHandle {
    return this.activate(this.store.create(input))
  }

  /** Open a registered workspace by id. Throws when the id is unknown. */
  open(id: string): WorkspaceHandle {
    const handle = this.store.open(id)
    if (!handle) throw new Error(`unknown workspace: ${id}`)
    return this.activate(handle)
  }

  /**
   * Drop the open workspace without touching its folder.
   *
   * The active-id file is deliberately left alone: it is the "last opened"
   * marker the list screen shows, not a request to reopen anything.
   */
  close(): void {
    this.handle = null
    this.references = null
    this.material = null
  }

  /** The id of the workspace opened last, for the list to mark it. */
  lastActiveId(): string | null {
    return this.readActiveId()
  }

  /** Delete a workspace and its folder; clears the open workspace if it was the one. */
  remove(id: string): void {
    this.store.remove(id)
    if (this.handle?.id === id) {
      this.close()
      this.writeActiveId(null)
    }
  }

  /**
   * Apply an edit from the settings dialog.
   *
   * Goal and name go through the store so its index follows and an empty value
   * is refused; the rest is workspace settings, which only the manifest carries.
   * Re-activating the handle after the store update matters: the reference and
   * material stores hold the handle they were built from, and they would
   * otherwise persist a stale manifest over the new one.
   */
  setSettings(patch: WorkspaceSettingsPatch): WorkspaceHandle {
    const current = this.requireWorkspace()
    if (patch.goal !== undefined || patch.name !== undefined) {
      this.activate(
        this.store.update(current.id, {
          ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
          ...(patch.name !== undefined ? { name: patch.name } : {}),
        }),
      )
    }
    const handle = this.requireWorkspace()
    if (patch.language !== undefined) {
      if (patch.language === null) delete handle.manifest.settings.language
      else handle.manifest.settings.language = patch.language
    }
    if (patch.agentModel !== undefined) {
      if (patch.agentModel === null) delete handle.manifest.settings.agentModel
      else handle.manifest.settings.agentModel = patch.agentModel
    }
    this.store.save(handle)
    return handle
  }

  /** Read-only reference mounts of the open workspace. */
  referenceStore(): ReferenceStore {
    if (!this.references) throw new Error('no workspace is open')
    return this.references
  }

  /** Project-exclusive read-only copies of the open workspace (`资料/`). */
  materialStore(): MaterialStore {
    if (!this.material) throw new Error('no workspace is open')
    return this.material
  }

  /** Persist the open workspace manifest and refresh its registry entry. */
  saveWorkspace(): void {
    const handle = this.requireWorkspace()
    this.store.save(handle)
  }

  /**
   * Build the per-call tool context.
   *
   * Resolved fresh for every tool call so `activeDocument` follows the user's
   * tab switches instead of freezing at the start of the run.
   */
  buildContext(): ToolContext {
    const handle = this.requireWorkspace()
    const bridges = this.options.bridges()
    const emit = this.options.onEvent ?? ((): void => {})
    const activeDocument = this.options.activeDocument?.()
    return {
      workspace: handle,
      ...(activeDocument ? { activeDocument } : {}),
      resolveDocument: (ref: string) =>
        handle.manifest.documents.find(
          (doc) => doc.id === ref.trim() || doc.path === ref.trim().replace(/^\.\/+/, ''),
        ),
      saveWorkspace: () => this.saveWorkspace(),
      references: this.referenceStore(),
      ui: bridges.ui,
      shell: bridges.shell,
      vcs: bridges.vcs,
      ...(this.options.docEditBridge ? { docEditBridge: this.options.docEditBridge } : {}),
      emit,
    }
  }

  private activate(handle: WorkspaceHandle): WorkspaceHandle {
    this.handle = handle
    this.references = new ReferenceStore(handle, (next) => this.store.save(next))
    this.material = new MaterialStore(handle.dir)
    this.writeActiveId(handle.id)
    return handle
  }

  private requireWorkspace(): WorkspaceHandle {
    if (!this.handle) throw new Error('no workspace is open')
    return this.handle
  }

  private readActiveId(): string | null {
    const file = this.options.activeIdFile
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as ActiveIdFile
      return typeof parsed.workspaceId === 'string' ? parsed.workspaceId : null
    } catch {
      // A corrupted pointer is not worth failing startup over: it only costs the
      // "last opened" mark on one row.
      return null
    }
  }

  private writeActiveId(workspaceId: string | null): void {
    const file = this.options.activeIdFile
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ workspaceId }, null, 2), 'utf8')
    } catch {
      // Losing the pointer only costs the user one reselect on next launch.
    }
  }
}
