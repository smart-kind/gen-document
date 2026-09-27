import type {
  ConversationEntry,
  DocumentEntry,
  DocumentType,
  OpenDocument,
  ReferenceInfo,
  ThemeMode,
  WorkspaceHandle,
  WorkspaceSummary,
  ZoneEntry,
  ZoneId,
} from '@genoffice/workspace-harness'
import type { Lang } from '@genoffice/i18n'

/** One row of a zone's listing. Paths are workspace-relative POSIX. */
export interface TreeEntry {
  name: string
  path: string
  kind: 'file' | 'dir'
  /** True for everything under the read-only zones (`引用/`, `资料/`). */
  readOnly: boolean
  type?: DocumentType
  size?: number
  /** True when an editor tab already has this path open. */
  open?: boolean
}

/**
 * One zone with its top-level entries, in harness display order.
 *
 * The grouping is resolved by the main process rather than by the renderer: the
 * zone definition lives in the harness, whose modules are Node-only, so the
 * renderer receives the order and the read-only flags instead of importing them.
 */
export interface ZoneGroup {
  zone: ZoneId
  readOnly: boolean
  /** The zone directory itself, for labels and prompts. */
  dir: string
  entries: TreeEntry[]
}

/** A workspace as the list screen paints it: registry entry plus its counts. */
export interface WorkspaceRow extends WorkspaceSummary {
  /** Registered documents in the manifest. */
  documents: number
  /** Mounted read-only references. */
  references: number
}

/** Everything the renderer needs to paint one workspace. */
export interface WorkspaceSnapshot {
  workspace: WorkspaceHandle
  conversations: ConversationEntry[]
  references: ReferenceInfo[]
}

export interface CreateWorkspaceInput {
  goal: string
  name?: string
  parentDir?: string
}

/** Result of the wizard's live path check. */
export interface InspectPathResult {
  exists: boolean
  /** Present only for an existing path. */
  kind?: 'file' | 'dir'
  /** Final path segment, so the wizard can label an entry it has not added yet. */
  name: string
  /** Number of direct children, present only for an existing directory. */
  entries?: number
}

/** Editable workspace settings. `null` clears the field back to the app default. */
export interface WorkspaceSettingsPatch {
  goal?: string
  name?: string
  /** Concrete UI language, or null to follow the system locale again. */
  language?: Lang | null
  /** Workspace model override, or null to follow the global routing again. */
  agentModel?: { provider: string; model: string } | null
}

/** One provider of the model picker. */
export interface ModelOption {
  id: string
  label: string
  models: string[]
  defaultModel: string
}

export interface ModelCatalogue {
  providers: ModelOption[]
  /** Provider ids the shared settings hold a usable config for. */
  configured: string[]
  /** What a conversation without a workspace override would use, when anything is usable. */
  global: { provider: string; model: string } | null
}

/** Renderer-facing projection of the pi-agent event stream for one conversation. */
export type AgentStreamEvent =
  | { conversationId: string; kind: 'turn_start' }
  | { conversationId: string; kind: 'text_delta'; text: string }
  | {
      conversationId: string
      kind: 'tool'
      toolName: string
      summary?: string
      isError?: boolean
    }
  | { conversationId: string; kind: 'turn_end' }
  | { conversationId: string; kind: 'error'; message: string }

/** The two workflows a workspace exists for, as the buttons name them. */
export type WorkflowKind = 'validate' | 'summarize'

/**
 * The first user message a workflow button sends.
 *
 * Built in the main process from the workspace's actual zone contents, so the
 * renderer never has to know what is in `资料/`, `产出/` or `意见/`.
 */
export interface WorkflowInstruction {
  kind: WorkflowKind
  /** Workspace-relative file the workflow writes its conclusion to. */
  outputPath: string
  instruction: string
}

/** One line of a persisted transcript. */
export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool'
  text: string
  at: string
}

export interface NotifyPayload {
  message: string
  level: 'info' | 'warn' | 'error'
}

/** Harness effect broadcast; the renderer refetches whatever the type implies. */
export interface ShellEvent {
  type: 'document.changed' | 'ui.changed' | 'workspace.changed'
  payload?: unknown
}

/**
 * One open editor tab, as the debug panel sees it.
 *
 * The debug panel short-circuits the agent entirely: it resolves the active tab
 * here and drives the harness document-edit bridge directly, so the tab's
 * `kind` and `wcId` — the bridge's own addressing — must cross to the renderer.
 */
export interface BridgeTab {
  /** Workspace-relative POSIX path. */
  path: string
  title: string
  /** webContents id of the tab's view; the key `bridgeRunCommand` takes. */
  wcId: number
  /** Editor kind (`docs` | `slides` | `sheets` | `markdown` | `html` | `pdf`). */
  kind: string
  active: boolean
  readOnly: boolean
}

export const WORKSPACE_CHANNELS = {
  listWorkspaces: 'workspace:list',
  createWorkspace: 'workspace:create',
  openWorkspace: 'workspace:open',
  closeWorkspace: 'workspace:close',
  lastActiveWorkspace: 'workspace:last-active',
  describeWorkspace: 'workspace:describe',
  setWorkspaceSettings: 'workspace:set-settings',
  deleteWorkspace: 'workspace:delete',
  defaultParentDir: 'workspace:default-parent-dir',
  listTree: 'workspace:tree',
  listZones: 'workspace:zones',
  listReferences: 'workspace:references',
  addReference: 'workspace:add-reference',
  removeReference: 'workspace:remove-reference',
  addMaterial: 'workspace:add-material',
  removeMaterial: 'workspace:remove-material',
  inspectPath: 'workspace:inspect-path',
  listModels: 'workspace:list-models',
  setLayoutInsets: 'workspace:set-layout-insets',
  getLayoutInsets: 'workspace:get-layout-insets',
  openDocument: 'workspace:open-document',
  closeDocument: 'workspace:close-document',
  activateDocument: 'workspace:activate-document',
  listOpenDocuments: 'workspace:list-open-documents',
  activeDocument: 'workspace:active-document',
  bridgeTabs: 'workspace:bridge-tabs',
  bridgeRunCommand: 'workspace:bridge-run-command',
  listConversations: 'workspace:list-conversations',
  createConversation: 'workspace:create-conversation',
  deleteConversation: 'workspace:delete-conversation',
  transcript: 'workspace:transcript',
  workflowInstruction: 'workspace:workflow-instruction',
  prompt: 'workspace:prompt',
  steer: 'workspace:steer',
  abort: 'workspace:abort',
  getLanguage: 'workspace:get-language',
  setLanguage: 'workspace:set-language',
  getTheme: 'workspace:get-theme',
  setTheme: 'workspace:set-theme',
  agentEvent: 'workspace:agent-event',
  shellEvent: 'workspace:shell-event',
  notify: 'workspace:notify',
  languageChanged: 'app:language-changed',
  themeChanged: 'app:theme-changed',
} as const

/** The `contextBridge` global the renderer sees. */
export interface WorkspaceShellApi {
  listWorkspaces(): Promise<WorkspaceRow[]>
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceHandle>
  openWorkspace(id: string): Promise<WorkspaceSnapshot | null>
  closeWorkspace(): Promise<void>
  /** Id of the workspace opened last, for the list to mark it. */
  lastActiveWorkspace(): Promise<string | null>
  describeWorkspace(): Promise<WorkspaceSnapshot | null>
  setWorkspaceSettings(patch: WorkspaceSettingsPatch): Promise<WorkspaceHandle>
  deleteWorkspace(id: string): Promise<void>
  /** Folder new workspaces default to (`<userData>/workspaces`). */
  defaultParentDir(): Promise<string>

  listTree(dir?: string): Promise<TreeEntry[]>
  /** All four zones with their top-level entries, in display order. */
  listZones(): Promise<ZoneGroup[]>
  listReferences(): Promise<ReferenceInfo[]>
  addReference(externalPath: string, as?: string): Promise<ReferenceInfo>
  removeReference(nameOrPath: string): Promise<void>
  addMaterial(externalPath: string, as?: string): Promise<ZoneEntry>
  removeMaterial(nameOrPath: string): Promise<void>

  inspectPath(path: string): Promise<InspectPathResult>
  listModels(): Promise<ModelCatalogue>

  setLayoutInsets(insets: { left: number; right: number; top: number }): Promise<void>
  getLayoutInsets(): Promise<{ left: number; right: number; top: number }>

  openDocument(path: string, options?: { readOnly?: boolean }): Promise<OpenDocument>
  closeDocument(id: string, options?: { save?: boolean }): Promise<void>
  activateDocument(id: string): Promise<void>
  listOpenDocuments(): Promise<OpenDocument[]>
  activeDocument(): Promise<DocumentEntry | null>

  /** Open editor tabs with their kinds, for the debug panel. */
  bridgeTabs(): Promise<BridgeTab[]>
  /** Run one raw document-edit bridge command against a tab, bypassing the agent. */
  bridgeRunCommand(wcId: number, command: string, payload: unknown): Promise<unknown>

  listConversations(): Promise<ConversationEntry[]>
  createConversation(title: string): Promise<ConversationEntry>
  deleteConversation(id: string): Promise<void>
  transcript(id: string): Promise<TranscriptEntry[]>
  /** First user message for one of the two workflows, built from the live zone contents. */
  workflowInstruction(kind: WorkflowKind): Promise<WorkflowInstruction>
  prompt(conversationId: string, text: string): Promise<void>
  steer(conversationId: string, text: string): void
  abort(conversationId: string): void

  getLanguage(): Promise<Lang>
  setLanguage(lang: Lang): Promise<void>
  getTheme(): Promise<ThemeMode>
  setTheme(mode: ThemeMode): Promise<void>

  onAgentEvent(listener: (event: AgentStreamEvent) => void): () => void
  onShellEvent(listener: (event: ShellEvent) => void): () => void
  onNotify(listener: (payload: NotifyPayload) => void): () => void
  onLanguageChanged(listener: (lang: Lang) => void): () => void
  onThemeChanged(listener: (mode: ThemeMode) => void): () => void
}
