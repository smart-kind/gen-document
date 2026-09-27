import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type TranscriptContext,
  type Usage,
} from '@earendil-works/pi-ai'
import { streamForProvider } from '@genoffice/ai-provider'
import { toProviderMessages, toToolDefs } from './convert.js'
import type { ProviderRouting } from './settings.js'

/** How pi-agent asks for one model response. Satisfies pi-agent's `StreamFn`. */
export type StreamFn = (
  model: Model<any>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream

export interface StreamFnDeps {
  /** Resolved per request, so a settings change applies from the next turn on. */
  resolveRouting: () => ProviderRouting | undefined
}

/**
 * Token usage the repo's provider layer does not report.
 *
 * `streamForProvider` yields text, tool calls and a stop reason, but no usage or
 * cost, so these stay zero. pi-agent's compaction falls back to estimating the
 * context itself, which is what keeps long conversations bounded.
 */
const UNREPORTED_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/**
 * Run pi-agent's loop against the repo's own provider layer.
 *
 * This is the whole reason the harness does not adopt pi-ai's provider
 * catalogue: the app keeps the providers the user already configured, needs no
 * extra provider SDK, and only the OpenAI-compatible path (plus the protocols
 * already implemented in-repo) is ever loaded.
 */
export function createStreamFn(deps: StreamFnDeps): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream()
    // The contract requires a synchronous return; failures are encoded in the
    // stream as protocol events and never thrown.
    void runTurn(stream, model, context, options, deps)
    return stream
  }
}

async function runTurn(
  stream: AssistantMessageEventStream,
  model: Model<any>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  deps: StreamFnDeps,
): Promise<void> {
  const base: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: UNREPORTED_USAGE,
    stopReason: 'pending',
    timestamp: Date.now(),
  }

  const routing = deps.resolveRouting()
  if (!routing) {
    const failed: AssistantMessage = {
      ...base,
      stopReason: 'error',
      errorMessage: 'No AI provider is configured. Add a provider and API key in settings first.',
    }
    // A setup failure before generation may terminate with `error` directly.
    stream.push({ type: 'error', reason: 'error', error: failed })
    stream.end(failed)
    return
  }

  const signal = options?.signal
  const content: (TextContent | ThinkingContent | ToolCall)[] = []

  // Each event carries its own copy of the partial message, so a later mutation
  // cannot rewrite an event a consumer has already seen.
  const snapshot = (): AssistantMessage => ({
    ...base,
    content: content.map((block) => ({ ...block })),
  })

  const fail = (stopReason: 'aborted' | 'error', errorMessage: string): void => {
    const failed: AssistantMessage = { ...base, content, stopReason, errorMessage }
    stream.push({ type: 'error', reason: stopReason, error: failed })
    stream.end(failed)
  }

  if (signal?.aborted) {
    fail('aborted', 'Request was aborted')
    return
  }

  stream.push({ type: 'start', partial: snapshot() })

  let open: { kind: 'text' | 'thinking'; index: number } | undefined
  let reportedStopReason: string | undefined

  const closeBlock = (): void => {
    if (!open) return
    const index = open.index
    if (open.kind === 'text') {
      const block = content[index] as TextContent
      stream.push({
        type: 'text_end',
        contentIndex: index,
        content: block.text,
        partial: snapshot(),
      })
    } else {
      const block = content[index] as ThinkingContent
      stream.push({
        type: 'thinking_end',
        contentIndex: index,
        content: block.thinking,
        partial: snapshot(),
      })
    }
    open = undefined
  }

  try {
    await streamForProvider(
      routing.provider,
      routing.config,
      getCurrentSystemPrompt(context.messages),
      toProviderMessages(context.messages),
      toToolDefs(getCurrentTools(context.messages)),
      routing.maxTokens,
      {
        signal: signal ?? new AbortController().signal,
        onStopReason: (reason) => {
          reportedStopReason = reason
        },
        onDelta: (text) => {
          if (open?.kind !== 'text') {
            closeBlock()
            content.push({ type: 'text', text: '' })
            open = { kind: 'text', index: content.length - 1 }
            stream.push({ type: 'text_start', contentIndex: open.index, partial: snapshot() })
          }
          const block = content[open.index] as TextContent
          block.text += text
          stream.push({
            type: 'text_delta',
            contentIndex: open.index,
            delta: text,
            partial: snapshot(),
          })
        },
        onReasoningDelta: (text) => {
          if (open?.kind !== 'thinking') {
            closeBlock()
            content.push({ type: 'thinking', thinking: '' })
            open = { kind: 'thinking', index: content.length - 1 }
            stream.push({ type: 'thinking_start', contentIndex: open.index, partial: snapshot() })
          }
          const block = content[open.index] as ThinkingContent
          block.thinking += text
          stream.push({
            type: 'thinking_delta',
            contentIndex: open.index,
            delta: text,
            partial: snapshot(),
          })
        },
        onToolCall: (call) => {
          closeBlock()
          const toolCall: ToolCall = {
            type: 'toolCall',
            id: call.id,
            name: call.name,
            // Tool arguments arrive as parsed JSON, so this narrows rather than converts.
            arguments: (call.input ?? {}) as unknown as ToolCall['arguments'],
          }
          content.push(toolCall)
          const index = content.length - 1
          stream.push({ type: 'toolcall_start', contentIndex: index, partial: snapshot() })
          stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: snapshot() })
        },
      },
    )
  } catch (error) {
    fail(
      signal?.aborted ? 'aborted' : 'error',
      error instanceof Error ? error.message : String(error),
    )
    return
  }

  if (signal?.aborted) {
    fail('aborted', 'Request was aborted')
    return
  }

  closeBlock()

  const hasToolCalls = content.some((block) => block.type === 'toolCall')
  const reason = finalStopReason(reportedStopReason, hasToolCalls)
  const message: AssistantMessage = { ...base, content, stopReason: reason }
  stream.push({ type: 'done', reason, message })
  stream.end(message)
}

/** Normalize the provider's stop reason into the three the loop reasons about. */
function finalStopReason(
  reported: string | undefined,
  hasToolCalls: boolean,
): 'stop' | 'length' | 'toolUse' {
  if (reported === 'max_tokens' || reported === 'length') return 'length'
  if (hasToolCalls) return 'toolUse'
  return 'stop'
}
