import { ChangeSet, type Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { McpCommandMessage } from '../shared/ipc'

/**
 * Renderer half of the MCP → html source bridge.
 *
 * The shell main process pushes one command at a time (`html:mcp-command`); each
 * one runs against the live CodeMirror source through `EditorView.dispatch`, so
 * an external edit is undoable, touches only the region it names and marks the
 * document dirty exactly like a user edit. Results go back correlated by
 * requestId (`html:mcp-result`), and once the document is mounted the bridge
 * announces `html:mcp-ready` — the shell waits for it before accepting a session.
 *
 * Line numbers are 1-based, counted on the source text `read_document` returns.
 *
 * No-op when the preload lacks the bridge channels (standalone/dev builds
 * without MCP wiring).
 */

const READY_POLL_MS = 50
/** after the fast window the poll backs off instead of stopping (see below) */
const READY_SLOW_POLL_MS = 1_000
const READY_FAST_WINDOW_MS = 20_000

export interface HtmlMcpHandlers {
  /** live source editor; null until the document is loaded and mounted */
  getView: () => EditorView | null
}

type LineEdit =
  | { op: 'insert_text'; text: string; afterLine?: number }
  | { op: 'replace_lines'; startLine: number; endLine: number; text: string }

/** one region replacement in the coordinates of the document it was computed against */
interface LineChange {
  from: number
  to: number
  insert: string
}

interface EditOutcome {
  changed: boolean
  linesAfter: number
  /** one human line per op, in application order */
  notes: string[]
}

export function installHtmlMcpBridge(handlers: HtmlMcpHandlers): () => void {
  // window.htmlApi is absent in standalone/dev builds that ship no preload
  if (typeof window.htmlApi?.onMcpCommand !== 'function') return () => {}
  const api = window.htmlApi

  /** one command at a time, in arrival order — two edits must not interleave */
  let queue: Promise<void> = Promise.resolve()
  let disposed = false

  // Announce readiness as soon as the editor and its document are mounted, then
  // stop polling. The poll must never give up permanently: a cold start can take
  // longer than the fast window, and a tab that stopped trying would look
  // perfectly normal in the UI yet stay unaddressable over MCP for the rest of
  // its life. Back off instead.
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  const mountedAt = performance.now()
  const announceWhenMounted = (): void => {
    readyTimer = null
    if (disposed) return
    if (handlers.getView()) {
      api.signalMcpReady()
      return
    }
    const slow = performance.now() - mountedAt > READY_FAST_WINDOW_MS
    readyTimer = setTimeout(announceWhenMounted, slow ? READY_SLOW_POLL_MS : READY_POLL_MS)
  }
  readyTimer = setTimeout(announceWhenMounted, READY_POLL_MS)

  const off = api.onMcpCommand((message: McpCommandMessage) => {
    queue = queue.then(() => runCommand(message)).catch(() => undefined)
  })

  return () => {
    disposed = true
    if (readyTimer !== null) clearTimeout(readyTimer)
    off()
  }

  async function runCommand(message: McpCommandMessage): Promise<void> {
    const reply = (ok: boolean, result?: unknown, error?: string): void => {
      api.reportMcpResult({
        requestId: message.requestId,
        ok,
        ...(result !== undefined ? { result } : {}),
        ...(error !== undefined ? { error } : {}),
      })
    }
    try {
      const view = handlers.getView()
      if (!view) throw new Error('the html document is not open in the editor')
      const payload = (message.payload ?? {}) as Record<string, unknown>
      switch (message.command) {
        case 'read_document': {
          reply(true, { text: view.state.doc.toString() })
          return
        }
        case 'insert_content': {
          if (typeof payload.text !== 'string') throw new Error('insert_content requires "text"')
          const afterLine = readOptionalLine(payload.afterLine, 'afterLine')
          const outcome = applyLineEdits(
            view,
            [
              {
                op: 'insert_text',
                text: payload.text,
                ...(afterLine === undefined ? {} : { afterLine }),
              },
            ],
            false,
          )
          reply(true, { summary: outcome.notes[0], mutated: outcome.changed })
          return
        }
        case 'replace_blocks': {
          if (typeof payload.text !== 'string') throw new Error('replace_blocks requires "text"')
          const startLine = readLine(payload.startLine, 'startLine', 'replace_blocks')
          const endLine = readLine(payload.endLine, 'endLine', 'replace_blocks')
          const outcome = applyLineEdits(
            view,
            [{ op: 'replace_lines', startLine, endLine, text: payload.text }],
            false,
          )
          reply(true, { summary: outcome.notes[0], mutated: outcome.changed })
          return
        }
        case 'apply_ops': {
          const raw = Array.isArray(payload.ops) ? payload.ops : []
          if (raw.length === 0) throw new Error('ops must be a non-empty array')
          const ops = raw.map(parseLineEdit)
          const dryRun = payload.dryRun === true
          const outcome = applyLineEdits(view, ops, dryRun)
          const count = `${ops.length} op${ops.length === 1 ? '' : 's'}`
          reply(true, {
            summary: dryRun
              ? `dry run: ${count} valid; the source would be ${outcome.linesAfter} lines`
              : `${count} applied; the source is now ${outcome.linesAfter} lines`,
            output: outcome.notes.join('\n'),
            mutated: dryRun ? false : outcome.changed,
          })
          return
        }
        default: {
          const unreachable: never = message.command
          reply(false, undefined, `unknown command: ${String(unreachable)}`)
        }
      }
    } catch (error: unknown) {
      reply(false, undefined, error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * Apply every edit as one undoable transaction, positions recomputed against the
 * document each op leaves behind. The ops are validated against a simulated
 * document first, so a batch that fails halfway changes nothing.
 */
function applyLineEdits(
  view: EditorView,
  edits: readonly LineEdit[],
  dryRun: boolean,
): EditOutcome {
  let virtual = view.state.doc
  let change: ChangeSet | null = null
  const notes: string[] = []
  let changed = false
  for (const edit of edits) {
    const brk = lineBreakOf(virtual)
    const block = lineBlockOf(edit.text, brk)
    const spec =
      edit.op === 'insert_text'
        ? insertChange(virtual, edit.afterLine, block, brk)
        : replaceChange(virtual, edit.startLine, edit.endLine, block)
    const step = ChangeSet.of(spec, virtual.length)
    change = change ? change.compose(step) : step
    if (!step.empty) changed = true
    virtual = step.apply(virtual)
    const added = blockCount(block, brk)
    if (edit.op === 'insert_text') {
      notes.push(
        edit.afterLine === undefined
          ? `appended ${added} line${added === 1 ? '' : 's'} at the end; the source is now ${virtual.lines} lines`
          : `inserted ${added} line${added === 1 ? '' : 's'} after line ${edit.afterLine}; the source is now ${virtual.lines} lines`,
      )
    } else {
      notes.push(
        `replaced lines ${edit.startLine}-${edit.endLine} with ${added} line${added === 1 ? '' : 's'}; the source is now ${virtual.lines} lines`,
      )
    }
  }
  if (changed && !dryRun && change) view.dispatch({ changes: change })
  return { changed, linesAfter: virtual.lines, notes }
}

/** the document's own line break, so inserted blocks keep the file's EOLs */
function lineBreakOf(doc: Text): string {
  return doc.lines > 1 ? doc.sliceString(doc.line(1).to, doc.line(2).from) : '\n'
}

/**
 * Text as a run of document lines: its breaks take the file's own, and a
 * trailing break is dropped — the caller supplies its own separator, so keeping
 * it would open a blank line.
 */
function lineBlockOf(text: string, brk: string): string {
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines.join(brk)
}

function blockCount(block: string, brk: string): number {
  return block === '' ? 0 : block.split(brk).length
}

/** insert a block after `afterLine` (1-based), or after the last line when omitted */
function insertChange(
  doc: Text,
  afterLine: number | undefined,
  block: string,
  brk: string,
): LineChange {
  const last = doc.lines
  const line = afterLine ?? last
  if (line < 1 || line > last) {
    throw new Error(
      `afterLine ${line} is out of range (document lines: 1-${last}); call read_document for fresh line numbers`,
    )
  }
  if (block === '') return { from: 0, to: 0, insert: '' }
  if (line < last) {
    const at = doc.line(line + 1).from
    return { from: at, to: at, insert: block + brk }
  }
  const at = doc.length
  // a document that already ends with a break gives the block its empty last
  // line, so appending must not open a blank one first
  const endsWithBreak = doc.line(last).from === doc.length
  return { from: at, to: at, insert: endsWithBreak ? block : brk + block }
}

function replaceChange(doc: Text, startLine: number, endLine: number, block: string): LineChange {
  const last = doc.lines
  if (startLine < 1 || endLine > last || startLine > endLine) {
    throw new Error(
      `lines ${startLine}-${endLine} are out of range (document lines: 1-${last}); call read_document for fresh line numbers`,
    )
  }
  return { from: doc.line(startLine).from, to: doc.line(endLine).to, insert: block }
}

function parseLineEdit(raw: unknown, index: number): LineEdit {
  const record = (raw ?? {}) as Record<string, unknown>
  const op = record.op
  if (op === 'insert_text') {
    if (typeof record.text !== 'string')
      throw new Error(`op #${index} (insert_text) requires a string "text"`)
    const afterLine = readOptionalLine(record.afterLine, 'afterLine', `op #${index} (insert_text)`)
    return { op, text: record.text, ...(afterLine === undefined ? {} : { afterLine }) }
  }
  if (op === 'replace_lines') {
    if (typeof record.text !== 'string')
      throw new Error(`op #${index} (replace_lines) requires a string "text"`)
    return {
      op,
      startLine: readLine(record.startLine, 'startLine', `op #${index} (replace_lines)`),
      endLine: readLine(record.endLine, 'endLine', `op #${index} (replace_lines)`),
      text: record.text,
    }
  }
  throw new Error(
    `op #${index} has unsupported "op" ${JSON.stringify(op ?? null)}; supported: insert_text, replace_lines`,
  )
}

/** a line number the caller may omit; its range is checked against the document later */
function readOptionalLine(value: unknown, field: string, where?: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new Error(`${where ? `${where}: ` : ''}"${field}" must be an integer`)
  return value
}

function readLine(value: unknown, field: string, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new Error(`${where} requires an integer "${field}"`)
  return value
}
