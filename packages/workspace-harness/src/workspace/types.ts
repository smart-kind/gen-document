/**
 * Workspace on-disk model.
 *
 * A workspace is a folder on disk: the goal, the documents, the read-only
 * reference mounts and the per-workspace settings all live inside it. There is
 * no central database; `manifest.json` inside the folder is the source of truth.
 */

/** Bumped when the on-disk manifest shape changes incompatibly. */
export const MANIFEST_SCHEMA_VERSION = 1

export type ThemeMode = 'light' | 'dark' | 'system'

export type DocumentType = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'md' | 'html' | 'txt'

/** Where a document came from: created in place, or imported as a writable copy. */
export type DocumentSource = { kind: 'new' } | { kind: 'imported'; from: string }

export interface DocumentEntry {
  id: string
  /** Workspace-relative POSIX path. */
  path: string
  type: DocumentType
  /** Free-text purpose note written by the user or the agent; not a controlled vocabulary. */
  note?: string
  addedAt: string
  source: DocumentSource
}

/**
 * A read-only mount: `引用/<name>` is a symlink to an external path.
 * Never copied, so the linked source stays authoritative across all workspaces.
 */
export interface ReferenceEntry {
  name: string
  /** Workspace-relative POSIX link path, always under `引用/`. */
  link: string
  /** Absolute path of the linked source. */
  target: string
  readOnly: true
}

export interface WorkspaceSettings {
  language?: string
  theme?: ThemeMode
  autoSave?: boolean
  /**
   * Model this workspace's conversations use. Only the provider and model id are
   * stored; the API key and base URL stay in the shared `ai-settings.json`, so
   * credentials are never copied into every workspace.
   */
  agentModel?: { provider: string; model: string }
}

export interface VcsConfig {
  enabled: boolean
  remote: string | null
  branch: string
}

export interface WorkspaceManifest {
  schemaVersion: number
  id: string
  name: string
  goal: string
  createdAt: string
  updatedAt: string
  references: ReferenceEntry[]
  documents: DocumentEntry[]
  settings: WorkspaceSettings
  vcs: VcsConfig
  /** True for the built-in demo workspace, which always exists and cannot be deleted. */
  demo?: boolean
}

/**
 * Conversation index entry. The transcript itself lives in
 * `.workspace/sessions/<id>.jsonl` and never enters the manifest.
 */
export interface ConversationEntry {
  id: string
  title: string
  /** Document ids this conversation touches; a conversation may span several. */
  scope: string[]
  createdAt: string
}

export interface ConversationsFile {
  schemaVersion: number
  conversations: ConversationEntry[]
}

/** A workspace as recorded in the store index, before its manifest is read. */
export interface WorkspaceIndexEntry {
  id: string
  name: string
  goal: string
  /** Absolute path of the workspace folder. */
  dir: string
  createdAt: string
  updatedAt: string
  /**
   * Mirrors `WorkspaceManifest.demo` so the list can find and mark the demo
   * workspace without reading every manifest.
   */
  demo?: boolean
}

export interface WorkspaceIndex {
  schemaVersion: number
  workspaces: WorkspaceIndexEntry[]
}

export interface WorkspaceSummary extends WorkspaceIndexEntry {
  /** False when the folder was moved or deleted outside the app. */
  available: boolean
}

/** An opened workspace: its folder on disk plus the parsed manifest. */
export interface WorkspaceHandle {
  id: string
  name: string
  goal: string
  /** Absolute path of the workspace folder. */
  dir: string
  manifest: WorkspaceManifest
}
