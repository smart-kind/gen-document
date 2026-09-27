import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type TextContent,
  type ToolCall,
} from '@earendil-works/pi-ai'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentHost } from '../src/agent/host.js'
import type { StreamFn } from '../src/agent/stream-fn.js'
import { composeToolSets } from '../src/tool/registry.js'
import type { AnyHarnessTool, HarnessEvent } from '../src/tool/types.js'
import { createFileSystemToolSet } from '../src/tools/filesystem.js'
import { createUiToolSet } from '../src/tools/ui.js'
import { WorkspaceStore } from '../src/workspace/store.js'
import { createFakeContext, type FakeContext } from './helpers/fake-context.js'

let root: string
let store: WorkspaceStore
let ctx: FakeContext

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-harness-host-'))
  store = new WorkspaceStore(join(root, 'workspaces'))
  ctx = createFakeContext(store, '写标书')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function baseMessage(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'genoffice',
    provider: 'test',
    model: 'test-model',
    usage: USAGE,
    stopReason: 'pending',
    timestamp: Date.now(),
  }
}

type Step = (stream: AssistantMessageEventStream) => void

/** A reply that only talks, which ends the run. */
function textReply(text: string): Step {
  return (stream) => {
    const base = baseMessage()
    const content: TextContent[] = [{ type: 'text', text }]
    stream.push({ type: 'start', partial: base })
    stream.push({
      type: 'text_start',
      contentIndex: 0,
      partial: { ...base, content: [{ type: 'text', text: '' }] },
    })
    stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: { ...base, content } })
    stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: { ...base, content } })
    const message: AssistantMessage = { ...base, content, stopReason: 'stop' }
    stream.push({ type: 'done', reason: 'stop', message })
    stream.end(message)
  }
}

/** A reply that asks for a tool, which keeps the run going. */
function toolReply(id: string, name: string, args: Record<string, unknown>): Step {
  return (stream) => {
    const base = baseMessage()
    const toolCall: ToolCall = {
      type: 'toolCall',
      id,
      name,
      arguments: args as ToolCall['arguments'],
    }
    const content = [toolCall]
    stream.push({ type: 'start', partial: base })
    stream.push({ type: 'toolcall_start', contentIndex: 0, partial: { ...base, content } })
    stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: { ...base, content } })
    const message: AssistantMessage = { ...base, content, stopReason: 'toolUse' }
    stream.push({ type: 'done', reason: 'toolUse', message })
    stream.end(message)
  }
}

/** Play back a fixed script, repeating the last step; record each request's transcript. */
function scriptedStreamFn(steps: Step[], seen: unknown[][]): StreamFn {
  let call = 0
  return (_model, context) => {
    seen.push(context.messages)
    const step = steps[Math.min(call, steps.length - 1)]!
    call += 1
    const stream = createAssistantMessageEventStream()
    // The contract requires a synchronous return, so the script fills the
    // stream on the next microtask.
    queueMicrotask(() => step(stream))
    return stream
  }
}

function makeHost(options: {
  streamFn: StreamFn
  tools: AnyHarnessTool[]
  emit: (event: HarnessEvent) => void
  maxTurns?: number
}): AgentHost {
  return new AgentHost({
    context: () => ctx,
    tools: () => options.tools,
    // The scripted stream function bypasses provider routing entirely.
    resolveRouting: () => undefined,
    systemPrompt: 'You are a document workspace assistant.',
    streamFn: options.streamFn,
    emit: options.emit,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
  })
}

describe('AgentHost', () => {
  it('runs a tool through the pi-agent loop and feeds postState back to the model', async () => {
    const tools = composeToolSets(ctx, [createFileSystemToolSet(), createUiToolSet()])
    const requests: unknown[][] = []
    const emitted: HarnessEvent[] = []

    const host = makeHost({
      streamFn: scriptedStreamFn(
        [
          toolReply('c1', 'fs_add_document', { type: 'md', name: '技术方案.md' }),
          textReply('已创建。'),
        ],
        requests,
      ),
      tools,
      emit: (event) => emitted.push(event),
    })

    await host.prompt('在空间里新建一份技术方案')
    await host.waitForIdle()
    host.flushEffects()

    // The tool really ran, in the output zone.
    expect(existsSync(join(ctx.workspace.dir, '产出', '技术方案.md'))).toBe(true)
    expect(ctx.workspace.manifest.documents.map((d) => d.path)).toEqual(['产出/技术方案.md'])

    // Two provider requests: the tool request, then the follow-up answer.
    expect(requests).toHaveLength(2)

    // postState must be visible to the model — that is what removes the need for
    // a follow-up read call.
    const followUp = JSON.stringify(requests[1])
    expect(followUp).toContain('postState:')
    expect(followUp).toContain('技术方案.md')

    // The declared effect reached the framework rather than the model.
    expect(emitted.map((e) => e.type)).toContain('workspace.changed')

    expect(host.agent.state.messages.at(-1)?.role).toBe('assistant')
  })

  it('surfaces a refused read-only write to the model instead of failing the run', async () => {
    const tools = composeToolSets(ctx, [createFileSystemToolSet()])
    const requests: unknown[][] = []

    const host = makeHost({
      streamFn: scriptedStreamFn(
        [
          toolReply('c1', 'fs_add_document', { type: 'md', name: 'x.md', dir: '引用' }),
          textReply('That path is read-only; I will use a writable directory.'),
        ],
        requests,
      ),
      tools,
      emit: () => {},
    })

    await host.prompt('把文件写到 引用 里')
    await host.waitForIdle()

    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1])).toContain('read-only input zone')
    expect(existsSync(join(ctx.workspace.dir, '引用', 'x.md'))).toBe(false)
  })

  it('stops a runaway tool loop at the turn cap', async () => {
    const tools = composeToolSets(ctx, [createFileSystemToolSet()])
    const requests: unknown[][] = []

    const host = makeHost({
      // Always asks for another tool call, so only the cap can end the run.
      streamFn: scriptedStreamFn([toolReply('c1', 'fs_list', {})], requests),
      tools,
      emit: () => {},
      maxTurns: 3,
    })

    await host.prompt('loop forever')
    await host.waitForIdle()

    expect(requests.length).toBeGreaterThan(0)
    expect(requests.length).toBeLessThanOrEqual(5)
  })

  it('recomputes and keeps the tool list across prompts', async () => {
    const tools = composeToolSets(ctx, [createFileSystemToolSet()])
    const requests: unknown[][] = []

    const host = makeHost({
      streamFn: scriptedStreamFn([textReply('ok')], requests),
      tools,
      emit: () => {},
    })

    await host.prompt('first')
    await host.waitForIdle()
    await host.prompt('second')
    await host.waitForIdle()

    expect(host.agent.state.tools).toHaveLength(tools.length)
    expect(requests).toHaveLength(2)
  })
})
