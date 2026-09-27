import { normalizeContext, type AssistantMessageEvent, type Model } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStreamFn, type StreamFnDeps } from '../src/agent/stream-fn.js'
import type { ProviderRouting } from '../src/agent/settings.js'

/**
 * The stream function is the seam where pi-agent meets the repo's own provider
 * layer, so the test drives a fake provider callback and asserts the exact
 * event protocol pi-agent expects.
 */
const harness = vi.hoisted(() => ({
  calls: [] as unknown[][],
  behaviour: async (_callbacks: unknown): Promise<void> => {},
}))

vi.mock('@genoffice/ai-provider', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    streamForProvider: async (...args: unknown[]) => {
      harness.calls.push(args)
      await harness.behaviour(args[6])
    },
  }
})

const model = {
  id: 'test-model',
  name: 'Test',
  api: 'genoffice',
  provider: 'test',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
} as Model<any>

const routing: ProviderRouting = {
  provider: 'openai',
  config: { apiKey: 'k', model: 'test-model' },
  maxTokens: 100,
}

const context = normalizeContext({
  systemPrompt: 'You write bid documents.',
  messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
  tools: [{ name: 'workspace_create', description: 'create', parameters: Type.Object({}) }],
})

function deps(resolveRouting: StreamFnDeps['resolveRouting']): StreamFnDeps {
  return { resolveRouting }
}

async function collect(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

beforeEach(() => {
  harness.calls = []
  harness.behaviour = async () => {}
})

describe('createStreamFn', () => {
  it('streams text as start/text_start/text_delta/text_end/done', async () => {
    harness.behaviour = async (callbacks) => {
      const cb = callbacks as {
        onDelta(text: string): void
        onStopReason(reason: string): void
      }
      cb.onDelta('Hello ')
      cb.onDelta('world')
      cb.onStopReason('stop')
    }
    const stream = createStreamFn(deps(() => routing))(model, context)
    const events = await collect(stream)

    expect(events.map((e) => e.type)).toEqual([
      'start',
      'text_start',
      'text_delta',
      'text_delta',
      'text_end',
      'done',
    ])
    const done = events.at(-1)
    expect(done?.type).toBe('done')
    if (done?.type !== 'done') throw new Error('expected done')
    expect(done.reason).toBe('stop')
    expect(done.message.content).toEqual([{ type: 'text', text: 'Hello world' }])
    // The accumulated stream text is also what the stream resolves to.
    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'stop' })
    expect(harness.calls).toHaveLength(1)
  })

  it('forwards the system prompt, messages and tool schemas to the provider layer', async () => {
    const stream = createStreamFn(deps(() => routing))(model, context)
    await collect(stream)

    const [provider, config, system, messages, tools] = harness.calls[0] as [
      string,
      { model: string },
      string,
      { role: string; text: string }[],
      { name: string; inputSchema: unknown }[],
    ]
    expect(provider).toBe('openai')
    expect(config.model).toBe('test-model')
    expect(system).toBe('You write bid documents.')
    expect(messages).toEqual([{ role: 'user', text: 'hi' }])
    expect(tools).toEqual([
      { name: 'workspace_create', description: 'create', inputSchema: expect.any(Object) },
    ])
  })

  it('reports a tool call and finishes with toolUse', async () => {
    harness.behaviour = async (callbacks) => {
      const cb = callbacks as { onToolCall(call: unknown): void }
      cb.onToolCall({ id: 'call-1', name: 'workspace_create', input: { goal: '写标书' } })
    }
    const events = await collect(createStreamFn(deps(() => routing))(model, context))

    expect(events.map((e) => e.type)).toEqual(['start', 'toolcall_start', 'toolcall_end', 'done'])
    const done = events.at(-1)
    if (done?.type !== 'done') throw new Error('expected done')
    expect(done.reason).toBe('toolUse')
    expect(done.message.content).toEqual([
      { type: 'toolCall', id: 'call-1', name: 'workspace_create', arguments: { goal: '写标书' } },
    ])
  })

  it('maps a max_tokens stop to length', async () => {
    harness.behaviour = async (callbacks) => {
      const cb = callbacks as { onDelta(text: string): void; onStopReason(reason: string): void }
      cb.onDelta('truncated…')
      cb.onStopReason('max_tokens')
    }
    const events = await collect(createStreamFn(deps(() => routing))(model, context))
    const done = events.at(-1)
    if (done?.type !== 'done') throw new Error('expected done')
    expect(done.reason).toBe('length')
  })

  it('encodes a missing provider as an error event instead of throwing', async () => {
    const stream = createStreamFn(deps(() => undefined))(model, context)
    const events = await collect(stream)

    expect(events.map((e) => e.type)).toEqual(['error'])
    const failure = events[0]
    if (failure?.type !== 'error') throw new Error('expected error')
    expect(failure.reason).toBe('error')
    expect(failure.error.errorMessage).toMatch(/No AI provider is configured/)
    expect(harness.calls).toEqual([])
  })

  it('encodes a provider failure as an error event', async () => {
    harness.behaviour = async () => {
      throw new Error('401 unauthorized')
    }
    const events = await collect(createStreamFn(deps(() => routing))(model, context))

    const failure = events.at(-1)
    if (failure?.type !== 'error') throw new Error('expected error')
    expect(failure.error.errorMessage).toBe('401 unauthorized')
  })

  it('emits thinking deltas before the answer text', async () => {
    harness.behaviour = async (callbacks) => {
      const cb = callbacks as {
        onReasoningDelta(text: string): void
        onDelta(text: string): void
      }
      cb.onReasoningDelta('weighing options')
      cb.onDelta('answer')
    }
    const events = await collect(createStreamFn(deps(() => routing))(model, context))

    expect(events.map((e) => e.type)).toEqual([
      'start',
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'text_end',
      'done',
    ])
  })
})
