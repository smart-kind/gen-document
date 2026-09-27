import type { Model } from '@earendil-works/pi-ai'
import {
  Agent,
  estimateContextTokens,
  estimateTokens,
  type AgentEvent,
  type AgentMessage,
} from '@earendil-works/pi-agent-core'
import { getProviderAdapter } from '@genoffice/ai-provider'
import type { AnyHarnessTool, HarnessEvent, ToolContext } from '../tool/types.js'
import { toAgentTools } from './adapt.js'
import { createEffectDispatcher, type EffectDispatcher } from './effect-dispatch.js'
import type { ProviderRouting } from './settings.js'
import { createStreamFn, type StreamFn } from './stream-fn.js'

/** Provider turns allowed per prompt before the run is stopped. */
export const DEFAULT_MAX_TURNS = 40
/** Transcript token budget; the oldest turns are dropped once it is exceeded. */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 120_000

export interface AgentHostOptions {
  /** Resolved per call so the context tracks the active tab. */
  context: () => ToolContext
  /** Recomputed per prompt so a tool set can follow runtime capabilities. */
  tools: () => AnyHarnessTool[]
  resolveRouting: () => ProviderRouting | undefined
  systemPrompt: string
  maxTurns?: number
  contextBudgetTokens?: number
  onEvent?: (event: AgentEvent) => void
  /** Overrides for tests. */
  streamFn?: StreamFn
  emit?: (event: HarnessEvent) => void
}

/**
 * One agent per conversation.
 *
 * Separate conversations are separate tasks with separate context, so sharing
 * one transcript would let them contaminate each other. The instance itself is
 * cheap — the weight is the model context, and an idle conversation holds no
 * connection.
 */
export class AgentHost {
  readonly agent: Agent
  private readonly options: AgentHostOptions
  private readonly dispatcher: EffectDispatcher
  private turns = 0

  constructor(options: AgentHostOptions) {
    this.options = options
    const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
    const budget = options.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS

    this.dispatcher = createEffectDispatcher({
      toolFor: (name) => options.tools().find((tool) => tool.name === name),
      emit: options.emit ?? ((event) => options.context().emit(event)),
    })

    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: modelForRouting(options.resolveRouting()),
        tools: toAgentTools(options.tools(), options.context),
      },
      streamFn: options.streamFn ?? createStreamFn({ resolveRouting: options.resolveRouting }),
      transformContext: async (messages) => pruneTranscript(messages, budget),
      finishTurn: () => {
        this.turns += 1
        return this.turns >= maxTurns ? { action: 'end' } : undefined
      },
      afterToolCall: this.dispatcher.afterToolCall,
    })

    if (options.onEvent) this.agent.subscribe((event) => options.onEvent?.(event))
  }

  /** Start a new prompt, resetting the per-run turn budget and tool list. */
  async prompt(text: string): Promise<void> {
    this.turns = 0
    this.refreshTools()
    await this.agent.prompt(text)
  }

  /** Queue an instruction to be injected after the current turn finishes. */
  steer(text: string): void {
    this.agent.steer({ role: 'user', content: text, timestamp: Date.now() })
  }

  abort(): void {
    this.agent.abort()
  }

  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle()
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    return this.agent.subscribe(listener)
  }

  /** Deliver coalesced effect events now instead of waiting out the debounce. */
  flushEffects(): void {
    this.dispatcher.flush()
  }

  private refreshTools(): void {
    this.agent.state.tools = toAgentTools(this.options.tools(), this.options.context)
  }
}

/**
 * Stand-in model used before a provider is configured.
 *
 * `AgentState.model` is required, and the stream function reports the
 * configuration problem itself, so the host starts either way and the user sees
 * one clear message instead of a crash.
 */
const UNCONFIGURED_MODEL: Model<any> = {
  id: 'unconfigured',
  name: 'Unconfigured',
  api: 'genoffice',
  provider: 'unconfigured',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4_096,
}

function modelForRouting(routing: ProviderRouting | undefined): Model<any> {
  if (!routing) return UNCONFIGURED_MODEL
  return {
    id: routing.config.model,
    name: routing.config.model,
    api: protocolOf(routing),
    provider: routing.provider,
    baseUrl: routing.config.baseUrl ?? '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: routing.maxTokens,
  }
}

/** The protocol the provider adapter will actually speak, used as the model's `api` label. */
function protocolOf(routing: ProviderRouting): string {
  try {
    return getProviderAdapter(routing.provider).resolveEndpoint(routing.config).protocol
  } catch {
    // A half-configured custom endpoint must not stop the host from starting;
    // the request itself reports the real problem.
    return 'openai-compatible'
  }
}

/**
 * Bound the transcript by dropping the oldest turns.
 *
 * pi-agent also ships a summarising compactor, but it is built on pi-ai's
 * `Models`/`ProviderAuth` runtime, which this harness deliberately does not
 * adopt. Pruning keeps the loop bounded without that bridge; swapping in real
 * summarisation is a follow-up, and a threshold either way is a tuning figure
 * rather than a structural decision.
 */
export function pruneTranscript(messages: AgentMessage[], budgetTokens: number): AgentMessage[] {
  if (estimateContextTokens(messages).tokens <= budgetTokens) return messages

  const head = messages.filter((message) => message.role === 'system')
  const rest = messages.filter((message) => message.role !== 'system')

  let keepFrom = rest.length
  let tokens = 0
  while (keepFrom > 0) {
    const next = estimateTokens(rest[keepFrom - 1]!)
    if (tokens + next > budgetTokens) break
    tokens += next
    keepFrom -= 1
  }

  // The kept tail must not open with a tool result whose tool call was dropped:
  // providers reject an unmatched tool result.
  while (keepFrom < rest.length - 1 && rest[keepFrom]?.role === 'toolResult') keepFrom += 1

  return [...head, ...rest.slice(keepFrom)]
}
