import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState, type ChangeSet, type Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo, undoDepth } from '@codemirror/commands'
import { installHtmlMcpBridge } from '../src/renderer/mcp-bridge'
import { External } from '../src/renderer/source/cm-setup'
import type { McpCommandMessage } from '../src/shared/ipc'

interface Reply {
  requestId: string
  ok: boolean
  result?: { text?: string; summary?: string; output?: string; mutated?: boolean }
  error?: string
}

function bridge(doc: string) {
  const transactions: Transaction[] = []
  // SourceEditor's own dispatch pipeline: a doc change without External is what
  // drives onChange (and so the dirty flag)
  const committed = vi.fn()
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
      ],
    }),
    parent: document.body,
    dispatchTransactions: (trs, v) => {
      v.update(trs)
      if (trs.some((tr) => tr.docChanged)) committed(v.state.doc.toString())
    },
  })
  const replies: Reply[] = []
  let readySignals = 0
  let handler: ((message: McpCommandMessage) => void) | null = null
  ;(window as unknown as { htmlApi: unknown }).htmlApi = {
    onMcpCommand: (h: (message: McpCommandMessage) => void) => {
      handler = h
      return () => {
        handler = null
      }
    },
    reportMcpResult: (result: Reply) => replies.push(result),
    signalMcpReady: () => {
      readySignals += 1
    },
  }
  const dispose = installHtmlMcpBridge({ getView: () => view })
  let seq = 0
  const send = async (command: string, payload: unknown): Promise<Reply> => {
    const requestId = `r${++seq}`
    handler!({ requestId, command, payload } as McpCommandMessage)
    for (let i = 0; i < 50 && !replies.some((r) => r.requestId === requestId); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const reply = replies.find((r) => r.requestId === requestId)
    if (!reply) throw new Error(`no reply for ${command}`)
    return reply
  }
  return {
    view,
    send,
    dispose,
    transactions,
    committed,
    text: () => view.state.doc.toString(),
    readySignals: () => readySignals,
  }
}

const open: Array<{ dispose: () => void; view: EditorView }> = []

function setup(doc: string) {
  const b = bridge(doc)
  open.push(b)
  return b
}

afterEach(() => {
  for (const b of open.splice(0)) {
    b.dispose()
    b.view.destroy()
  }
  delete (window as unknown as { htmlApi?: unknown }).htmlApi
})

describe('installHtmlMcpBridge', () => {
  it('announces ready once the editor is mounted', async () => {
    const b = setup('<p>hi</p>')
    await vi.waitFor(() => expect(b.readySignals()).toBe(1))
  })

  it('is a no-op without the preload channels', () => {
    delete (window as unknown as { htmlApi?: unknown }).htmlApi
    const dispose = installHtmlMcpBridge({ getView: () => null })
    expect(dispose).toBeTypeOf('function')
    dispose()
  })

  it('reads the live source text', async () => {
    const b = setup('<h1>One</h1>\n<p>Two</p>')
    const reply = await b.send('read_document', {})
    expect(reply.ok).toBe(true)
    expect(reply.result).toEqual({ text: '<h1>One</h1>\n<p>Two</p>' })
  })

  it('appends at the end without a leading blank line', async () => {
    const b = setup('<p>a</p>\n')
    const reply = await b.send('insert_content', { text: '<p>b</p>' })
    expect(reply.ok).toBe(true)
    expect(reply.result?.mutated).toBe(true)
    expect(b.text()).toBe('<p>a</p>\n<p>b</p>')
  })

  it('inserts after the given line and touches only that region', async () => {
    const b = setup('l1\nl2\nl3')
    const dispatch = vi.spyOn(b.view, 'dispatch')
    const reply = await b.send('insert_content', { text: 'new1\nnew2', afterLine: 1 })
    expect(reply.ok).toBe(true)
    expect(b.text()).toBe('l1\nnew1\nnew2\nl2\nl3')

    const spec = dispatch.mock.calls.at(-1)?.[0] as { changes: ChangeSet }
    const ranges: Array<[number, number, string]> = []
    spec.changes.iterChanges((from, to, _fromB, _toB, inserted) =>
      ranges.push([from, to, inserted.toString()]),
    )
    expect(ranges).toEqual([[3, 3, 'new1\nnew2\n']])
  })

  it('rejects a negative afterLine without changing the document', async () => {
    const b = setup('l1\nl2')
    const reply = await b.send('insert_content', { text: 'x', afterLine: -1 })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('afterLine')
    expect(b.text()).toBe('l1\nl2')
  })

  it('replaces a 1-based inclusive line range', async () => {
    const b = setup('l1\nl2\nl3\nl4')
    const reply = await b.send('replace_blocks', { startLine: 2, endLine: 3, text: 'mid' })
    expect(reply.ok).toBe(true)
    expect(reply.result?.mutated).toBe(true)
    expect(b.text()).toBe('l1\nmid\nl4')
  })

  it('rejects an out-of-range replace without changing the document', async () => {
    const b = setup('l1\nl2')
    const reply = await b.send('replace_blocks', { startLine: 1, endLine: 9, text: 'x' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('out of range')
    expect(b.text()).toBe('l1\nl2')
  })

  it('applies a batch with positions recomputed as the document changes', async () => {
    const b = setup('a\nb\nc')
    const reply = await b.send('apply_ops', {
      ops: [
        { op: 'insert_text', text: 'head', afterLine: 1 },
        { op: 'replace_lines', startLine: 3, endLine: 3, text: 'B' },
        { op: 'insert_text', text: 'tail' },
      ],
    })
    expect(reply.ok).toBe(true)
    expect(reply.result?.mutated).toBe(true)
    // "head" lands on line 2, which shifts the old line 3 ("b") down to line 4
    expect(b.text()).toBe('a\nhead\nB\nc\ntail')
    expect(reply.result?.output?.split('\n')).toHaveLength(3)
  })

  it('applies a batch as one undoable step', async () => {
    const b = setup('a\nb')
    await b.send('apply_ops', {
      ops: [
        { op: 'insert_text', text: 'x', afterLine: 1 },
        { op: 'replace_lines', startLine: 2, endLine: 2, text: 'y' },
      ],
    })
    expect(undoDepth(b.view.state)).toBe(1)
    undo(b.view)
    expect(b.text()).toBe('a\nb')
  })

  it('treats the dispatched edit as a user edit (docChanged, not External)', async () => {
    const b = setup('a')
    await b.send('insert_content', { text: 'b' })
    const last = b.transactions.at(-1)!
    expect(last.docChanged).toBe(true)
    expect(last.annotation(External)).toBeUndefined()
    expect(b.committed).toHaveBeenCalledWith('a\nb')
  })

  it('leaves the committed text alone on a dry run', async () => {
    const b = setup('a\nb')
    await b.send('apply_ops', { ops: [{ op: 'insert_text', text: 'x' }], dryRun: true })
    expect(b.committed).not.toHaveBeenCalled()
  })

  it('validates a dry run without mutating', async () => {
    const b = setup('a\nb')
    const reply = await b.send('apply_ops', {
      ops: [{ op: 'replace_lines', startLine: 2, endLine: 2, text: 'B' }],
      dryRun: true,
    })
    expect(reply.ok).toBe(true)
    expect(reply.result?.mutated).toBe(false)
    expect(b.text()).toBe('a\nb')
  })

  it('changes nothing when a later op in the batch is invalid', async () => {
    const b = setup('a\nb')
    const reply = await b.send('apply_ops', {
      ops: [
        { op: 'insert_text', text: 'x', afterLine: 1 },
        { op: 'replace_lines', startLine: 9, endLine: 9, text: 'y' },
      ],
    })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('out of range')
    expect(b.text()).toBe('a\nb')
    expect(undoDepth(b.view.state)).toBe(0)
  })

  it('names the offending op', async () => {
    const b = setup('a')
    const reply = await b.send('apply_ops', { ops: [{ op: 'set_style' }] })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('op #0')
    expect(reply.error).toContain('insert_text')
  })

  it('reports an unknown command', async () => {
    const b = setup('a')
    const reply = await b.send('rewrite_everything', {})
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('unknown command')
  })

  it('keeps one line ending throughout (the editor model is LF)', async () => {
    // a CRLF file is opened normalized by CodeMirror, so the inserted block follows
    const b = setup('<p>a</p>\r\n<p>b</p>')
    await b.send('insert_content', { text: '<p>x</p>\n<p>y</p>', afterLine: 1 })
    expect(b.text()).toBe('<p>a</p>\n<p>x</p>\n<p>y</p>\n<p>b</p>')
  })

  it('writes into an empty document', async () => {
    const b = setup('')
    const reply = await b.send('insert_content', { text: '<p>first</p>' })
    expect(reply.result?.mutated).toBe(true)
    expect(b.text()).toBe('<p>first</p>')
  })
})
