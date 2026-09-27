import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import {
  AgentHost,
  addConversation,
  composeToolSets,
  metaDir,
  newId,
  nowIso,
  readAiSettings,
  readConversations,
  removeConversation,
  type AnyHarnessTool,
  type ConversationEntry,
  type ProviderRouting,
  type ToolContext,
  type WorkspaceHandle,
  type WorkspaceStore,
} from '@genoffice/workspace-harness'
import type { AgentStreamEvent, TranscriptEntry } from '../shared/api'
import { resolveWorkspaceRouting } from './model-routing'
import { createAgentToolSets } from './tool-wiring'

/**
 * One agent per conversation, plus the transcript each one leaves behind.
 *
 * Separating conversations is the point: they are separate tasks with separate
 * model context, so a shared transcript would let them contaminate each other.
 * Hosts are created lazily and kept idle between prompts.
 */

export interface AgentServiceOptions {
  /** Directory of the shared `ai-settings.json`. */
  userDataPath: string
  /** Registry backing the workspace tool set. */
  store: WorkspaceStore
  /** The open workspace, read fresh so a settings edit applies to the next turn. */
  currentWorkspace: () => WorkspaceHandle | null
  /** Built fresh for every prompt and every tool call. */
  buildContext: () => ToolContext
  /** Renderer sink for the projected event stream. */
  onEvent: (event: AgentStreamEvent) => void
}

/** Sessions live beside the manifest: `.workspace/sessions/<id>.jsonl`. */
export function sessionPath(workspaceDir: string, conversationId: string): string {
  return join(metaDir(workspaceDir), 'sessions', `${conversationId}.jsonl`)
}

/**
 * Append one transcript line.
 *
 * JSONL with one `appendFileSync` per line is crash-tolerant by construction:
 * an interrupted write can damage at most the last line, and the reader skips
 * lines it cannot parse rather than failing the whole conversation.
 */
export function appendTranscript(
  workspaceDir: string,
  conversationId: string,
  entry: TranscriptEntry,
): void {
  try {
    const file = sessionPath(workspaceDir, conversationId)
    mkdirSync(join(metaDir(workspaceDir), 'sessions'), { recursive: true })
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // A transcript is a convenience; losing a line must never break a run.
  }
}

/** Read back a conversation transcript, skipping unparseable lines. */
export function readTranscript(workspaceDir: string, conversationId: string): TranscriptEntry[] {
  const file = sessionPath(workspaceDir, conversationId)
  if (!existsSync(file)) return []
  const out: TranscriptEntry[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as TranscriptEntry
      if (parsed && typeof parsed.text === 'string' && typeof parsed.role === 'string')
        out.push(parsed)
    } catch {
      // Half-written tail line from an interrupted append.
    }
  }
  return out
}

/** Model-facing preamble: the goal the workspace exists for. */
export function defaultSystemPrompt(workspace: WorkspaceHandle): string {
  return [
    'You are the agent of a goal-driven document workspace.',
    `Workspace: ${workspace.name}`,
    `Goal: ${workspace.goal}`,
    `Folder: ${workspace.dir}`,
    '',
    'Work through tools: create documents, mount read-only references, and open or close',
    'editor tabs. The interface follows your tool calls automatically — never ask the user to',
    'refresh anything, and never describe a change you have not made with a tool.',
    '',
    'When editing a document that is open in the editor, use the incremental edit tools',
    '(doc_insert_content, doc_replace_blocks, doc_apply_ops) instead of fs_write_text.',
    'These tools update the visible editor without flicker. Use doc_read_live to read the',
    'current editor state before editing. The document must be open first via ui_open_document.',
    '',
    'When editing a presentation, use slide_read_deck and slide_apply_ops instead of',
    'fs_write_text. These update the visible deck without flicker.',
    'Reply in the same language as the user message.',
  ].join('\n')
}

export class AgentService {
  private readonly hosts = new Map<string, AgentHost>()

  constructor(private readonly options: AgentServiceOptions) {}

  listConversations(workspaceDir: string): ConversationEntry[] {
    return readConversations(workspaceDir)
  }

  createConversation(workspaceDir: string, title: string): ConversationEntry {
    const entry: ConversationEntry = {
      id: newId('conv'),
      title: title.trim() || nowIso(),
      scope: [],
      createdAt: nowIso(),
    }
    addConversation(workspaceDir, entry)
    return entry
  }

  deleteConversation(workspaceDir: string, id: string): void {
    removeConversation(workspaceDir, id)
    this.hosts.get(id)?.abort()
    this.hosts.delete(id)
  }

  transcript(workspaceDir: string, id: string): TranscriptEntry[] {
    return readTranscript(workspaceDir, id)
  }

  /** Send a prompt, creating the conversation's host on first use. */
  async prompt(workspaceDir: string, conversationId: string, text: string): Promise<void> {
    const ctx = this.options.buildContext()
    appendTranscript(workspaceDir, conversationId, { role: 'user', text, at: nowIso() })
    const host = this.hostFor(workspaceDir, conversationId, ctx)
    await host.prompt(text)
  }

  steer(conversationId: string, text: string): void {
    this.hosts.get(conversationId)?.steer(text)
  }

  abort(conversationId: string): void {
    this.hosts.get(conversationId)?.abort()
  }

  stopAll(): void {
    for (const host of this.hosts.values()) host.abort()
  }

  private hostFor(workspaceDir: string, conversationId: string, ctx: ToolContext): AgentHost {
    const existing = this.hosts.get(conversationId)
    if (existing) return existing

    const host = new AgentHost({
      // Resolved per tool call, so `activeDocument` follows the user's tabs.
      context: () => this.options.buildContext(),
      // Recomputed per prompt: a set may withhold tools this runtime cannot serve.
      tools: () => this.tools(),
      resolveRouting: () => this.routing(),
      systemPrompt: defaultSystemPrompt(ctx.workspace),
      onEvent: (event) => this.relay(workspaceDir, conversationId, event),
    })
    this.hosts.set(conversationId, host)
    return host
  }

  /**
   * Routing for the next turn: the workspace's own provider+model when it is
   * configured in the shared settings, otherwise the global active provider.
   */
  private routing(): ProviderRouting | undefined {
    const settings = readAiSettings(this.options.userDataPath)
    const override = this.options.currentWorkspace()?.manifest.settings.agentModel
    return resolveWorkspaceRouting(settings, override).routing
  }

  private tools(): AnyHarnessTool[] {
    return composeToolSets(this.options.buildContext(), createAgentToolSets(this.options.store))
  }

  /** Project a pi-agent event onto the small shape the renderer paints. */
  private relay(workspaceDir: string, conversationId: string, event: AgentEvent): void {
    const emit = this.options.onEvent
    switch (event.type) {
      case 'agent_start':
        emit({ conversationId, kind: 'turn_start' })
        return
      case 'agent_end':
        emit({ conversationId, kind: 'turn_end' })
        return
      case 'message_update': {
        const update = event.assistantMessageEvent
        if (update.type === 'text_delta') {
          emit({ conversationId, kind: 'text_delta', text: update.delta })
        }
        return
      }
      case 'message_end': {
        const text = assistantText(event.message)
        if (text)
          appendTranscript(workspaceDir, conversationId, { role: 'assistant', text, at: nowIso() })
        const error = errorOf(event.message)
        if (error) emit({ conversationId, kind: 'error', message: error })
        return
      }
      case 'tool_execution_end': {
        const details = event.result?.details as { summary?: string } | undefined
        emit({
          conversationId,
          kind: 'tool',
          toolName: event.toolName,
          ...(details?.summary ? { summary: details.summary } : {}),
          ...(event.isError ? { isError: true } : {}),
        })
        if (details?.summary) {
          appendTranscript(workspaceDir, conversationId, {
            role: 'tool',
            text: details.summary,
            at: nowIso(),
          })
        }
        return
      }
      default:
        return
    }
  }
}

/** Plain text of an assistant message, ignoring thinking blocks and tool calls. */
function assistantText(message: AgentMessage): string {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** The provider's failure message, when the turn ended in an error. */
function errorOf(message: AgentMessage): string | null {
  if (message.role !== 'assistant') return null
  const failed = message as { stopReason?: string; errorMessage?: string }
  return failed.stopReason === 'error' && failed.errorMessage ? failed.errorMessage : null
}
