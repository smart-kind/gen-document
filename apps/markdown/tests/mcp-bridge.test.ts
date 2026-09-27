import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { installMarkdownMcpBridge, type MarkdownMcpContext } from '../src/renderer/mcp-bridge'

/**
 * The MCP bridge is the boundary an external agent edits through. These cover
 * the required command→result contract (indexes, append semantics, dryRun) on a
 * real editor, so a broken translation cannot silently land blocks in the wrong
 * place.
 */

type CommandListener = (message: { requestId: string; command: string; payload: unknown }) => void

let commandListener: CommandListener | undefined
const reportMcpResult = vi.fn()
const signalMcpReady = vi.fn()

const editors: Editor[] = []
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy()
})

function stubApi(): void {
  ;(window as unknown as { markdownApi: unknown }).markdownApi = {
    onMcpCommand: (listener: CommandListener) => {
      commandListener = listener
      return () => {}
    },
    reportMcpResult,
    signalMcpReady,
  }
}

beforeEach(() => {
  commandListener = undefined
  reportMcpResult.mockReset()
  signalMcpReady.mockReset()
  stubApi()
})

function createEditor(md = ''): Editor {
  const editor = new Editor({
    extensions: buildExtensions({
      slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
      slashItems: () => [],
    }),
    content: '',
  })
  if (md) editor.commands.setContent(md, { contentType: 'markdown' })
  editors.push(editor)
  return editor
}

function install(editor: Editor | null): () => void {
  const context: MarkdownMcpContext | null = editor
    ? { editor, readDocument: () => editor.getMarkdown() }
    : null
  return installMarkdownMcpBridge({ getContext: () => context })
}

interface Reply {
  ok: boolean
  result?: { summary?: string; output?: string; mutated?: boolean; text?: string }
  error?: string
}

async function command(editor: Editor | null, name: string, payload: unknown = {}): Promise<Reply> {
  const uninstall = install(editor)
  commandListener!({ requestId: 'r1', command: name, payload })
  uninstall()
  await vi.waitFor(() => expect(reportMcpResult).toHaveBeenCalledTimes(1))
  return reportMcpResult.mock.calls[0]![0] as Reply
}

describe('mcp bridge read_document', () => {
  it('returns the live document source', async () => {
    const editor = createEditor('# Title\n\nBody.')
    const reply = await command(editor, 'read_document')
    expect(reply.ok).toBe(true)
    expect(reply.result?.text).toContain('# Title')
    expect(reply.result?.text).toContain('Body.')
  })

  it('reflects edits made after the file was opened', async () => {
    const editor = createEditor('# Title')
    editor.commands.setContent('# Title\n\nunsaved', { contentType: 'markdown' })
    const reply = await command(editor, 'read_document')
    expect(reply.result?.text).toContain('unsaved')
  })
})

describe('mcp bridge insert_content', () => {
  it('appends at the end when afterBlockIndex is omitted', async () => {
    const editor = createEditor('# A\n\nfirst')
    const reply = await command(editor, 'insert_content', { text: '## B\n\nsecond' })
    expect(reply.ok).toBe(true)
    expect(reply.result?.mutated).toBe(true)
    expect(editor.state.doc.childCount).toBe(4)
    const md = editor.getMarkdown()
    expect(md.indexOf('## B')).toBeGreaterThan(md.indexOf('first'))
  })

  it('inserts after the addressed block', async () => {
    const editor = createEditor('# A\n\nfirst\n\nlast')
    const reply = await command(editor, 'insert_content', { text: 'inserted', afterBlockIndex: 0 })
    expect(reply.ok).toBe(true)
    const md = editor.getMarkdown()
    expect(md.indexOf('inserted')).toBeGreaterThan(md.indexOf('# A'))
    expect(md.indexOf('inserted')).toBeLessThan(md.indexOf('first'))
  })

  it('treats an index past the end as append', async () => {
    const editor = createEditor('# A\n\nfirst')
    const reply = await command(editor, 'insert_content', { text: 'tail', afterBlockIndex: 99 })
    expect(reply.ok).toBe(true)
    expect(editor.getMarkdown().trimEnd().endsWith('tail')).toBe(true)
  })

  it('rejects a negative afterBlockIndex without touching the document', async () => {
    const editor = createEditor('# A\n\nfirst')
    const before = editor.getMarkdown()
    const reply = await command(editor, 'insert_content', { text: 'x', afterBlockIndex: -1 })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('afterBlockIndex')
    expect(editor.getMarkdown()).toBe(before)
  })

  it('rejects empty text', async () => {
    const editor = createEditor('# A')
    const reply = await command(editor, 'insert_content', { text: '' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('no content')
  })
})

describe('mcp bridge replace_blocks', () => {
  it('replaces an inclusive top-level block range', async () => {
    const editor = createEditor('# A\n\nfirst\n\nlast')
    const reply = await command(editor, 'replace_blocks', {
      startBlockIndex: 1,
      endBlockIndex: 2,
      text: 'replaced',
    })
    expect(reply.ok).toBe(true)
    expect(reply.result?.mutated).toBe(true)
    const md = editor.getMarkdown()
    expect(md).toContain('# A')
    expect(md).toContain('replaced')
    expect(md).not.toContain('first')
    expect(md).not.toContain('last')
    expect(editor.state.doc.childCount).toBe(2)
  })

  it('rejects an out-of-range end without touching the document', async () => {
    const editor = createEditor('# A\n\nfirst')
    const before = editor.getMarkdown()
    const reply = await command(editor, 'replace_blocks', {
      startBlockIndex: 0,
      endBlockIndex: 5,
      text: 'x',
    })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('endBlockIndex')
    expect(editor.getMarkdown()).toBe(before)
  })

  it('rejects an inverted range', async () => {
    const editor = createEditor('# A\n\nfirst\n\nlast')
    const reply = await command(editor, 'replace_blocks', {
      startBlockIndex: 2,
      endBlockIndex: 1,
      text: 'x',
    })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('endBlockIndex')
  })

  it('deletes the addressed blocks when the replacement text is empty', async () => {
    const editor = createEditor('# A\n\nfirst\n\nlast')
    const reply = await command(editor, 'replace_blocks', {
      startBlockIndex: 1,
      endBlockIndex: 2,
      text: '',
    })
    expect(reply.ok).toBe(true)
    expect(reply.result?.mutated).toBe(true)
    const md = editor.getMarkdown()
    expect(md).toContain('# A')
    expect(md).not.toContain('first')
    expect(md).not.toContain('last')
  })
})

describe('mcp bridge apply_ops', () => {
  it('applies a mixed batch', async () => {
    const editor = createEditor('# A\n\nfirst\n\nlast')
    const reply = await command(editor, 'apply_ops', {
      ops: [
        { op: 'insert_content', text: 'added', afterBlockIndex: 0 },
        { op: 'replace_blocks', startBlockIndex: 2, endBlockIndex: 2, text: 'swapped' },
      ],
    })
    expect(reply.ok).toBe(true)
    expect(reply.result?.mutated).toBe(true)
    const md = editor.getMarkdown()
    expect(md).toContain('added')
    expect(md).toContain('swapped')
    expect(md).not.toContain('last')
  })

  it('validates and summarises a dry run without mutating', async () => {
    const editor = createEditor('# A\n\nfirst')
    const before = editor.getMarkdown()
    const reply = await command(editor, 'apply_ops', {
      ops: [{ op: 'insert_content', text: 'x', afterBlockIndex: 0 }],
      dryRun: true,
    })
    expect(reply.ok).toBe(true)
    expect(reply.result?.mutated).toBe(false)
    expect(reply.result?.summary).toContain('insert')
    expect(editor.getMarkdown()).toBe(before)
  })

  it('rejects an unknown op before mutating', async () => {
    const editor = createEditor('# A\n\nfirst')
    const before = editor.getMarkdown()
    const reply = await command(editor, 'apply_ops', { ops: [{ op: 'set_cell' }] })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('unknown op')
    expect(editor.getMarkdown()).toBe(before)
  })

  it('rejects an empty ops array', async () => {
    const editor = createEditor('# A')
    const reply = await command(editor, 'apply_ops', { ops: [] })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('non-empty')
  })
})

describe('mcp bridge signalling', () => {
  it('announces readiness once the document is loaded', async () => {
    const editor = createEditor('# A')
    const uninstall = install(editor)
    await vi.waitFor(() => expect(signalMcpReady).toHaveBeenCalledTimes(1))
    uninstall()
  })

  it('errors a command that lands before the document is ready', async () => {
    const reply = await command(null, 'read_document')
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('not ready')
  })

  it('reports an unknown command', async () => {
    const editor = createEditor('# A')
    const reply = await command(editor, 'save_document')
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('unknown command')
  })

  it('is a no-op when the preload lacks the channels', () => {
    ;(window as unknown as { markdownApi: unknown }).markdownApi = {}
    const uninstall = installMarkdownMcpBridge({ getContext: () => null })
    expect(() => uninstall()).not.toThrow()
  })
})
