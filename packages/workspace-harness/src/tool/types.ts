import type { TSchema } from 'typebox'
import type { ReferenceStore } from '../workspace/references.js'
import type { DocumentEntry, DocumentType, ThemeMode, WorkspaceHandle } from '../workspace/types.js'

/**
 * Tool side-effect class.
 *
 * The harness dispatches UI synchronisation from this declaration, so no tool
 * carries a "render" / "refresh" step: repainting is a framework effect, not a
 * model decision.
 */
export type ToolEffect =
  /** Pure read, no side effect. */
  | 'query'
  /** Changes document content; the framework repaints the owning editor. */
  | 'mutation'
  /** Changes application UI state; the framework applies it to the shell. */
  | 'ui_control'
  /** Changes workspace structure; the framework refreshes the file tree. */
  | 'workspace'

export type ToolSetId =
  'workspace' | 'filesystem' | 'document' | 'document-edit' | 'slide-edit' | 'ui' | 'version'

/**
 * Bridge to live document editors for incremental (non-flashing) edits.
 *
 * Each open tab exposes its kind and webContents id. The bridge dispatches
 * commands to the correct editor — docs/markdown via renderer IPC, slides via
 * main-process session — so the visible document updates in place without
 * flicker.
 */
export type DocEditKind = 'docs' | 'slides' | 'markdown' | 'sheets' | 'html'

export interface DocumentEditBridge {
  /** Send an editor command to a specific tab by its webContents id. */
  runCommand(wcId: number, command: string, payload: unknown): Promise<unknown>
  /** Find an open tab by its workspace-relative path. */
  findTabByPath(relPath: string): { wcId: number; kind: DocEditKind } | undefined
  /** List all open editable tabs with their paths, webContents ids, and kinds. */
  listOpenTabs(): Array<{ path: string; wcId: number; kind: DocEditKind }>
}

/** UI-only side channel. Never enters the LLM context. */
export type DisplayPayload =
  | { kind: 'text'; text: string }
  | { kind: 'links'; links: { label: string; href: string }[] }
  | { kind: 'images'; images: { url: string; alt?: string }[] }
  | { kind: 'confirm'; confirm: { prompt: string; token: string } }

export interface ToolResult {
  /** Text fed back to the model. */
  output: string
  /** Failures are fed back too, so the model can correct itself. */
  isError?: boolean
  /** True when persisted state changed. */
  mutated?: boolean
  /** Activity-bar label, UI only. */
  summary?: string
  /** UI-only side channel; never enters the LLM context. */
  display?: DisplayPayload
  /**
   * Structured summary of the state after the change, fed to the model.
   *
   * A mutation tool must return enough here that the model can keep deciding
   * without following up with a read call.
   */
  postState?: unknown
}

export interface UiBridge {
  getLanguage(): Promise<string>
  setLanguage(locale: string): Promise<void>
  getTheme(): Promise<ThemeMode>
  setTheme(mode: ThemeMode): Promise<void>
  togglePanel(panel: string, visible: boolean): Promise<void>
  notify(message: string, level: 'info' | 'warn' | 'error'): Promise<void>
}

export interface OpenDocument {
  id: string
  /** Workspace-relative POSIX path. */
  path: string
  type: DocumentType
  title: string
  active: boolean
  readOnly: boolean
  /** True when the editor holds unsaved changes. */
  dirty?: boolean
}

export interface ShellBridge {
  openDocument(path: string, options?: { readOnly?: boolean }): Promise<OpenDocument>
  closeDocument(id: string, options?: { save?: boolean }): Promise<void>
  activateDocument(id: string): Promise<void>
  listOpenDocuments(): Promise<OpenDocument[]>
  /** Switch the app to another workspace, rebuilding the shell views. */
  openWorkspace(id: string): Promise<void>
}

/** Version-control bridge. Reserved for v2; the v1-a skeleton only reads state. */
export interface VersionBridge {
  enabled(): boolean
}

export interface HarnessEvent {
  type: 'document.changed' | 'ui.changed' | 'workspace.changed'
  payload?: unknown
}

/** Per-call execution context. Resolved fresh on every call so it tracks the active tab. */
export interface ToolContext {
  workspace: WorkspaceHandle
  /** Document of the active editor tab, if any. */
  activeDocument?: DocumentEntry
  /** Resolve a document by id or workspace-relative path. */
  resolveDocument(ref: string): DocumentEntry | undefined
  /** Persist the current workspace manifest (and refresh its registry entry). */
  saveWorkspace(): void
  /** Read-only reference mounts of the current workspace. */
  references: ReferenceStore
  ui: UiBridge
  shell: ShellBridge
  vcs: VersionBridge
  /** Live bridge to document editors for incremental updates; present when any editable tab is open. */
  docEditBridge?: DocumentEditBridge
  emit(event: HarnessEvent): void
}

export interface HarnessTool<TParams = any> {
  /** Globally unique, `<set>_<verb>_<object>` in lower snake case. */
  name: string
  /** Human-readable label for the activity bar. */
  label: string
  /** Model-facing description; this is the heaviest prompt-engineering surface. */
  description: string
  parameters: TSchema
  set: ToolSetId
  effect: ToolEffect
  execute(ctx: ToolContext, params: TParams, signal?: AbortSignal): Promise<ToolResult>
}

/** A tool as held in a heterogeneous registry. */
export type AnyHarnessTool = HarnessTool<any>
