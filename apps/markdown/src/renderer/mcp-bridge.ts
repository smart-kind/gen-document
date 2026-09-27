import type { Editor } from '@tiptap/core'
import type { McpCommandMessage } from '../shared/ipc'
import { executeTool, markDocSeen } from './ai/tools'
import { clearAiHighlights } from './editor/aiHighlight'
import { parseMarkdownToNodes, type MdOp } from './editor/ops'

/**
 * Renderer half of the MCP → markdown-editor bridge.
 *
 * The shell main process pushes one command at a time (`markdown:mcp-command`);
 * each command runs against the *live* Tiptap editor through the same op
 * pipeline the built-in AI uses (`executeTool` → `runOps`), so external edits
 * are undoable, rewrite only the addressed blocks and dirty the document
 * exactly like a user edit — the file on disk is untouched until a save.
 * Results go back correlated by requestId (`markdown:mcp-result`), and once the
 * document is loaded the bridge announces `markdown:mcp-ready`.
 *
 * Commands are serialized so a read never interleaves with a write, and the
 * bridge is a no-op when the preload lacks its channels (standalone/dev builds).
 */

const READY_POLL_MS = 50
/** after the fast window the poll backs off instead of stopping (see below) */
const READY_SLOW_POLL_MS = 1_000
const READY_FAST_WINDOW_MS = 20_000

export interface MarkdownMcpContext {
  editor: Editor
  /** the source a save would write: live edits, frontmatter included */
  readDocument: () => string
}

export interface MarkdownMcpDeps {
  /** live editor context, null until the document is mounted and loaded */
  getContext: () => MarkdownMcpContext | null
}

function parseOp(raw: unknown, index: number): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`ops[${index}] must be an object`)
  }
  return raw as Record<string, unknown>
}

function requireText(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} requires "text"`)
  return value
}

/**
 * `afterBlockIndex` is the 0-based top-level block to insert after; a value at
 * or past the end appends, and an omitted one appends too. Unlike the AI path's
 * `after` there is no -1-for-document-start form, so a negative index is a
 * caller mistake rather than an anchor.
 */
function insertAnchor(raw: unknown, blockCount: number, where: string): number {
  if (raw === undefined || raw === null) return blockCount - 1
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new Error(`${where}: afterBlockIndex must be an integer (got ${String(raw)})`)
  }
  if (raw < 0) throw new Error(`${where}: afterBlockIndex must be >= 0 (got ${raw})`)
  return Math.min(raw, blockCount - 1)
}

function blockIndex(raw: unknown, field: string, blockCount: number, where: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new Error(`${where}: ${field} must be an integer (got ${String(raw)})`)
  }
  if (raw < 0 || raw > blockCount - 1) {
    throw new Error(`${where}: ${field} ${raw} is out of range (valid: 0..${blockCount - 1})`)
  }
  return raw
}

/** blocks the markdown parses to; a parse failure is the caller's to fix */
function parsedBlocks(editor: Editor, markdown: string, where: string): number {
  let nodes: ReturnType<typeof parseMarkdownToNodes>
  try {
    nodes = parseMarkdownToNodes(editor, markdown)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${where}: text could not be parsed (${reason})`, { cause: error })
  }
  return nodes.length
}

interface PlannedOp {
  op: MdOp
  summary: string
}

function planOp(editor: Editor, raw: unknown, index: number): PlannedOp {
  const item = parseOp(raw, index)
  const name = String(item.op)
  const where = `ops[${index}] ${name}`
  const blockCount = editor.state.doc.childCount
  switch (item.op) {
    case 'insert_content': {
      const text = requireText(item.text, where)
      const after = insertAnchor(item.afterBlockIndex, blockCount, where)
      const blocks = parsedBlocks(editor, text, where)
      if (blocks === 0) throw new Error(`${where}: text parsed to no content`)
      return {
        op: { op: 'insertContent', after, markdown: text },
        summary: `insert ${blocks} block(s) after block ${after}`,
      }
    }
    case 'replace_blocks': {
      const text = requireText(item.text, where)
      const start = blockIndex(item.startBlockIndex, 'startBlockIndex', blockCount, where)
      const end = blockIndex(item.endBlockIndex, 'endBlockIndex', blockCount, where)
      if (end < start) {
        throw new Error(`${where}: endBlockIndex ${end} must be >= startBlockIndex ${start}`)
      }
      const blocks = parsedBlocks(editor, text, where)
      return {
        op: { op: 'replaceBlocks', target: { start, end }, markdown: text },
        summary:
          blocks === 0
            ? `delete blocks ${start}-${end}`
            : `replace blocks ${start}-${end} with ${blocks} block(s)`,
      }
    }
    default:
      throw new Error(`ops[${index}]: unknown op "${name}"`)
  }
}

/**
 * Validate and translate the MCP ops into the editor's own ops. Indexes resolve
 * against the block list as it stands now, which is the same document the
 * `runOps` batch addresses, so no mapping is lost in translation.
 */
function planOps(editor: Editor, raw: unknown): PlannedOp[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('ops must be a non-empty array')
  return raw.map((op, index) => planOp(editor, op, index))
}

interface EditOutcome {
  summary: string
  output?: string
  mutated: boolean
}

/** Run a batch through the AI tool executor: same validation, atomicity and stale-index guard */
async function runEditOps(editor: Editor, raw: unknown, dryRun: boolean): Promise<EditOutcome> {
  const planned = planOps(editor, raw)
  if (dryRun) {
    return { summary: planned.map((p) => p.summary).join('\n'), mutated: false }
  }
  // Routing through executeTool rather than runOps keeps the staleness guard
  // that refuses an index-addressed batch after the user edited the document,
  // so an external agent cannot clobber edits it never saw.
  const outcome = await executeTool(editor, {
    id: 'mcp',
    name: 'apply_ops',
    input: { ops: planned.map((p) => p.op) },
  })
  if (outcome.isError) throw new Error(outcome.output)
  // source 'ai' paints the transient change highlight; an external edit is
  // already accepted, so drop the wash the moment it lands (docs parity).
  clearAiHighlights(editor)
  return {
    summary: outcome.summary,
    output: outcome.output,
    mutated: outcome.mutated === true,
  }
}

function readDocument(ctx: MarkdownMcpContext): { text: string } {
  const text = ctx.readDocument()
  // the caller now holds a fresh block map, so a following index-addressed
  // write must not trip the stale-index guard
  markDocSeen(ctx.editor)
  return { text }
}

async function runCommand(deps: MarkdownMcpDeps, message: McpCommandMessage): Promise<unknown> {
  const ctx = deps.getContext()
  if (!ctx) throw new Error('the document is not ready')
  const payload = (message.payload ?? {}) as Record<string, unknown>
  switch (message.command) {
    case 'read_document':
      return readDocument(ctx)

    case 'insert_content': {
      const result = await runEditOps(
        ctx.editor,
        [
          {
            op: 'insert_content',
            text: payload.text,
            ...(payload.afterBlockIndex === undefined
              ? {}
              : { afterBlockIndex: payload.afterBlockIndex }),
          },
        ],
        false,
      )
      return { summary: result.summary, mutated: true }
    }

    case 'replace_blocks': {
      const result = await runEditOps(
        ctx.editor,
        [
          {
            op: 'replace_blocks',
            startBlockIndex: payload.startBlockIndex,
            endBlockIndex: payload.endBlockIndex,
            text: payload.text,
          },
        ],
        false,
      )
      return { summary: result.summary, mutated: true }
    }

    case 'apply_ops': {
      const result = await runEditOps(ctx.editor, payload.ops, payload.dryRun === true)
      return {
        summary: result.summary,
        ...(result.output === undefined ? {} : { output: result.output }),
        mutated: result.mutated,
      }
    }

    default:
      throw new Error(`unknown command: ${String(message.command)}`)
  }
}

/** Subscribe the live editor to MCP commands. Returns the unsubscribe function. */
export function installMarkdownMcpBridge(deps: MarkdownMcpDeps): () => void {
  const api = window.markdownApi
  if (typeof api?.onMcpCommand !== 'function') return () => {}

  /** one command at a time, in arrival order — a read must not interleave with a write */
  let queue: Promise<void> = Promise.resolve()
  let disposed = false

  // Announce readiness once the editor *and* its document are mounted: a tab
  // still loading its file would wipe an early edit when setContent lands.
  //
  // The poll backs off instead of giving up — readiness is announced exactly
  // once and never re-derived, so a timer stopped during a slow dev boot would
  // leave the tab looking normal yet unaddressable over MCP for the rest of its
  // life.
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  const mountedAt = performance.now()
  const announceWhenLoaded = (): void => {
    readyTimer = null
    if (disposed) return
    if (deps.getContext()) {
      api.signalMcpReady()
      return
    }
    const slow = performance.now() - mountedAt > READY_FAST_WINDOW_MS
    readyTimer = setTimeout(announceWhenLoaded, slow ? READY_SLOW_POLL_MS : READY_POLL_MS)
  }
  readyTimer = setTimeout(announceWhenLoaded, READY_POLL_MS)

  const off = api.onMcpCommand((message: McpCommandMessage) => {
    if (!message || typeof message.requestId !== 'string') return
    queue = queue
      .then(async () => {
        try {
          api.reportMcpResult({
            requestId: message.requestId,
            ok: true,
            result: await runCommand(deps, message),
          })
        } catch (error: unknown) {
          api.reportMcpResult({
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
      .catch(() => undefined)
  })

  return () => {
    disposed = true
    if (readyTimer !== null) clearTimeout(readyTimer)
    off()
  }
}
