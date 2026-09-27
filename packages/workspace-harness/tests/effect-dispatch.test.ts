import type { AfterToolCallContext } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessDetails } from '../src/agent/adapt.js'
import { createEffectDispatcher } from '../src/agent/effect-dispatch.js'
import type { AnyHarnessTool, HarnessEvent } from '../src/tool/types.js'

function tool(name: string, effect: AnyHarnessTool['effect']): AnyHarnessTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object' } as AnyHarnessTool['parameters'],
    set: 'workspace',
    effect,
    execute: async () => ({ output: 'ok' }),
  }
}

function afterCall(
  name: string,
  details: HarnessDetails,
  signalAborted = false,
): [AfterToolCallContext, AbortSignal] {
  const context = {
    assistantMessage: { role: 'assistant' },
    toolCall: { type: 'toolCall', id: 'call-1', name, arguments: {} },
    args: {},
    result: { content: [], details },
    isError: false,
    context: { messages: [] },
  } as unknown as AfterToolCallContext
  return [context, signalAborted ? AbortSignal.abort() : new AbortController().signal]
}

let emitted: HarnessEvent[]
const tools = [
  tool('doc_insert_content', 'mutation'),
  tool('ui_set_theme', 'ui_control'),
  tool('fs_list', 'query'),
]

function dispatcher(debounceMs = 100) {
  return createEffectDispatcher({
    toolFor: (name) => tools.find((t) => t.name === name),
    emit: (event) => emitted.push(event),
    debounceMs,
  })
}

beforeEach(() => {
  emitted = []
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('effect dispatch', () => {
  it('emits document.changed for a mutation which touched a document', async () => {
    const d = dispatcher()
    const [context, signal] = afterCall('doc_insert_content', {
      effect: 'mutation',
      postState: {
        document: { id: 'doc-7' },
        insertedRange: { startBlockIndex: 13, endBlockIndex: 15 },
      },
    })

    await d.afterToolCall(context, signal)
    expect(emitted).toEqual([]) // still inside the debounce window

    vi.advanceTimersByTime(100)
    expect(emitted).toEqual([
      {
        type: 'document.changed',
        payload: {
          toolName: 'doc_insert_content',
          documentId: 'doc-7',
          postState: {
            document: { id: 'doc-7' },
            insertedRange: { startBlockIndex: 13, endBlockIndex: 15 },
          },
        },
      },
    ])
  })

  it('emits ui.changed for a ui_control tool', async () => {
    const d = dispatcher()
    const [context, signal] = afterCall('ui_set_theme', {
      effect: 'ui_control',
      postState: { theme: 'dark' },
    })

    await d.afterToolCall(context, signal)
    vi.advanceTimersByTime(100)

    expect(emitted).toEqual([
      { type: 'ui.changed', payload: { what: 'ui_set_theme', value: { theme: 'dark' } } },
    ])
  })

  it('emits workspace.changed for a structural change', async () => {
    const d = dispatcher()
    const [context, signal] = afterCall('fs_add_reference', {
      effect: 'workspace',
      postState: { reference: { name: '公司资质' } },
    })

    await d.afterToolCall(context, signal)
    vi.advanceTimersByTime(100)

    expect(emitted[0]?.type).toBe('workspace.changed')
    expect((emitted[0]?.payload as { kind: string }).kind).toBe('fs_add_reference')
  })

  it('emits nothing for a query', async () => {
    const d = dispatcher()
    const [context, signal] = afterCall('fs_list', { effect: 'query' })

    await d.afterToolCall(context, signal)
    vi.advanceTimersByTime(1_000)

    expect(emitted).toEqual([])
  })

  it('coalesces a burst of structured changes into one event', async () => {
    const d = dispatcher()
    for (let i = 0; i < 5; i += 1) {
      const [context, signal] = afterCall('fs_add_reference', {
        effect: 'workspace',
        postState: { reference: { name: `ref-${i}` } },
      })
      await d.afterToolCall(context, signal)
    }
    vi.advanceTimersByTime(100)

    expect(emitted).toHaveLength(1)
    const payload = emitted[0]?.payload as unknown[]
    expect(Array.isArray(payload)).toBe(true)
    expect(payload).toHaveLength(5)
  })

  it('keeps event types separate inside one window', async () => {
    const d = dispatcher()
    const [a, sa] = afterCall('doc_insert_content', { effect: 'mutation', postState: {} })
    const [b, sb] = afterCall('ui_set_theme', { effect: 'ui_control', postState: {} })
    await d.afterToolCall(a, sa)
    await d.afterToolCall(b, sb)
    vi.advanceTimersByTime(100)

    expect(emitted.map((e) => e.type).sort()).toEqual(['document.changed', 'ui.changed'])
  })

  it('surfaces a harness failure as a pi-agent tool error', async () => {
    const d = dispatcher()
    const [context, signal] = afterCall('fs_delete', { effect: 'workspace', isError: true })

    await expect(d.afterToolCall(context, signal)).resolves.toEqual({ isError: true })
  })

  it('returns nothing to override on success', async () => {
    const d = dispatcher()
    const [context, signal] = afterCall('fs_list', { effect: 'query' })
    await expect(d.afterToolCall(context, signal)).resolves.toBeUndefined()
  })

  it('delivers immediately when the run was aborted', async () => {
    const d = dispatcher()
    const [context, signal] = afterCall('ui_set_theme', { effect: 'ui_control' }, true)

    await d.afterToolCall(context, signal)

    expect(emitted).toHaveLength(1)
  })
})
