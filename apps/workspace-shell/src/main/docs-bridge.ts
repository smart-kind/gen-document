import { ipcMain, webContents } from 'electron'
import type { DocumentEditBridge, DocEditKind } from '@genoffice/workspace-harness'
import { elementDurableId, slideDurableId, type SlideElement } from '@genoffice/pptx-engine'
import { applySessionTxn } from '../../../slides/src/main/slides-main'
import { attachedIds, sessions } from '../../../slides/src/main/session-state'

/**
 * Workspace-shell document-edit bridge: the main-process half of the
 * incremental-edit pipeline.
 *
 * Routes commands to the correct editor backend based on tab kind:
 * - docs / sheets / markdown / html: renderer IPC via the editor's own
 *   `*:mcp-ready` / `*:mcp-command` / `*:mcp-result` trio — the document state
 *   lives in the renderer, so the command has to cross into that tab.
 * - slides: main-process session via `applySessionTxn` (deck push for render).
 *
 * The renderer trio is registered for every kind up front; a kind whose editor
 * has not implemented its half yet simply never announces ready, and commands
 * against it fail on the ready timeout rather than silently doing nothing.
 */

const READY_TIMEOUT_MS = 24_000
const COMMAND_TIMEOUT_MS = 120_000

interface PendingCommand {
  wcId: number
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const readyIds = new Set<number>()
const readyWaiters = new Map<
  number,
  Array<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>
>()
const watchedIds = new Set<number>()
const pending = new Map<string, PendingCommand>()
let requestSeq = 0
let installed = false

function markReady(wcId: number): void {
  readyIds.add(wcId)
  const waiters = readyWaiters.get(wcId) ?? []
  readyWaiters.delete(wcId)
  for (const w of waiters) {
    clearTimeout(w.timer)
    w.resolve()
  }
}

function watchDestroyed(wcId: number): void {
  if (watchedIds.has(wcId)) return
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) return
  watchedIds.add(wcId)
  wc.once('destroyed', () => {
    watchedIds.delete(wcId)
    readyIds.delete(wcId)
    const closed = new Error('the document tab was closed')
    for (const w of readyWaiters.get(wcId) ?? []) {
      clearTimeout(w.timer)
      w.reject(closed)
    }
    readyWaiters.delete(wcId)
    for (const [requestId, entry] of pending) {
      if (entry.wcId !== wcId) continue
      pending.delete(requestId)
      clearTimeout(entry.timer)
      entry.reject(closed)
    }
  })
}

function waitForReady(wcId: number): Promise<void> {
  if (readyIds.has(wcId)) return Promise.resolve()
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) return Promise.reject(new Error('the document tab was closed'))
  watchDestroyed(wcId)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const list = readyWaiters.get(wcId)
      if (list) {
        const at = list.indexOf(waiter)
        if (at >= 0) list.splice(at, 1)
        if (list.length === 0) readyWaiters.delete(wcId)
      }
      reject(new Error(`the document did not become ready within ${READY_TIMEOUT_MS}ms`))
    }, READY_TIMEOUT_MS)
    const waiter = {
      resolve: () => {
        clearTimeout(timer)
        resolve()
      },
      reject: (e: Error) => {
        clearTimeout(timer)
        reject(e)
      },
      timer,
    }
    const list = readyWaiters.get(wcId) ?? []
    list.push(waiter)
    readyWaiters.set(wcId, list)
  })
}

/**
 * The renderer command channel trio for each kind whose editor keeps its state
 * in the renderer. Slides is absent on purpose: its deck lives in the main
 * process, so it needs no IPC handshake.
 */
const RENDERER_CHANNELS: Partial<
  Record<DocEditKind, { ready: string; command: string; result: string }>
> = {
  docs: { ready: 'docs:mcp-ready', command: 'docs:mcp-command', result: 'docs:mcp-result' },
  sheets: {
    ready: 'sheets:mcp-ready',
    command: 'sheets:mcp-command',
    result: 'sheets:mcp-result',
  },
  markdown: {
    ready: 'markdown:mcp-ready',
    command: 'markdown:mcp-command',
    result: 'markdown:mcp-result',
  },
  html: { ready: 'html:mcp-ready', command: 'html:mcp-command', result: 'html:mcp-result' },
}

/** Register the renderer reply channels for every kind. Safe to call more than once. */
export function installEditorBridges(): void {
  if (installed) return
  installed = true
  for (const channels of Object.values(RENDERER_CHANNELS)) {
    if (!channels) continue
    ipcMain.on(channels.ready, (event) => {
      const wcId = event.sender.id
      markReady(wcId)
      watchDestroyed(wcId)
    })
    ipcMain.on(channels.result, (event, result: unknown) => {
      const payload = result as {
        requestId?: unknown
        ok?: unknown
        result?: unknown
        error?: unknown
      }
      if (!payload || typeof payload.requestId !== 'string') return
      const entry = pending.get(payload.requestId)
      if (!entry) return
      // requestIds are guessable, so only the tab a command targeted may answer it
      if (entry.wcId !== event.sender.id) return
      pending.delete(payload.requestId)
      clearTimeout(entry.timer)
      if (payload.ok === true) entry.resolve(payload.result)
      else
        entry.reject(
          new Error(typeof payload.error === 'string' ? payload.error : 'command failed'),
        )
    })
  }
}

export interface TabInfo {
  /** Workspace-relative POSIX path. */
  path: string
  /** webContents id of the tab's view. */
  wcId: number
  /** Document kind — determines how commands are dispatched. */
  kind: string
}

function isSupportedKind(kind: string): kind is DocEditKind {
  return (
    kind === 'docs' ||
    kind === 'slides' ||
    kind === 'markdown' ||
    kind === 'sheets' ||
    kind === 'html'
  )
}

// ── Slides helpers ─────────────────────────────────────────────────────────

const SLIDES_READY_TIMEOUT_MS = 20_000
const MAX_TEXT_CHARS = 300
const MAX_TABLE_ROWS = 3

function clip(text: string, max = MAX_TEXT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function elementInfo(el: SlideElement): Record<string, unknown> {
  const t = el.transform?.offset ?? { x: 0, y: 0, cx: 0, cy: 0 }
  const info: Record<string, unknown> = {
    id: elementDurableId(el) ?? el.id,
    type: el.type,
    x: t.x,
    y: t.y,
    w: t.cx,
    h: t.cy,
  }
  if (el.type === 'text' || el.type === 'shape') {
    const paragraphs = el.text?.paragraphs ?? []
    if (paragraphs.length) {
      const full = paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n')
      info.text = clip(full)
      if (full.length > MAX_TEXT_CHARS) info.textTruncated = true
    }
  } else if (el.type === 'table') {
    const rows = el.rows
    const totalRows = rows.length
    const body = rows
      .slice(0, MAX_TABLE_ROWS)
      .map((row) =>
        row
          .map((cell) =>
            (cell.text?.paragraphs ?? []).map((p) => p.runs.map((r) => r.text).join('')).join(''),
          )
          .join(' | '),
      )
      .join('\n')
    info.text = clip(body)
    if (totalRows > MAX_TABLE_ROWS) {
      info.textTruncated = true
      info.rows = totalRows
    }
  } else if (el.type === 'group') {
    info.children = el.children.map((child) => ({
      ...elementInfo(child),
      coordinates: 'local-to-group',
    }))
  }
  return info
}

async function waitSlidesSession(wcId: number): Promise<void> {
  const deadline = Date.now() + SLIDES_READY_TIMEOUT_MS
  for (;;) {
    if (sessions.has(wcId)) return
    const wc = webContents.fromId(wcId)
    if (!wc || wc.isDestroyed()) throw new Error('the presentation tab was closed')
    if (Date.now() > deadline) {
      throw new Error(`the presentation did not become ready within ${SLIDES_READY_TIMEOUT_MS}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function runSlidesCommand(wcId: number, command: string, payload: unknown): Promise<unknown> {
  const session = sessions.get(wcId)
  if (!session) throw new Error('the deck session is not available — the tab may have been closed')

  switch (command) {
    case 'read_deck': {
      const deck = session.opened.deck
      const EMU_PER_PX = 9525
      return {
        emuPerPx: EMU_PER_PX,
        note: 'x/y/w/h are EMU in slide space; elements inside a group use the group-local frame (marked coordinates:"local-to-group").',
        slideSize: {
          widthPx: Math.round(deck.size.cx / EMU_PER_PX),
          heightPx: Math.round(deck.size.cy / EMU_PER_PX),
        },
        slides: deck.slides.map((slide, index) => ({
          index,
          id: slideDurableId(slide),
          elements: slide.elements.map(elementInfo),
        })),
      }
    }
    case 'apply_ops': {
      const { ops, dryRun } = payload as { ops: unknown[]; dryRun?: boolean }
      const result = applySessionTxn(session, { ops, dryRun })
      if (!result) throw new Error('the deck session is gone')
      // Push the fresh render to the tab — MCP runs in main process, so the
      // tab would never hear about the change otherwise.
      if (result.applied && result.slides) {
        const ids = attachedIds(session)
        if (ids.length < 2) {
          const deckPayload = {
            slides: result.slides,
            size: { cx: session.opened.deck.size.cx, cy: session.opened.deck.size.cy },
          }
          for (const id of ids) webContents.fromId(id)?.send('slides:deck-changed', deckPayload)
        }
      }
      const { slides: _renderTree, ...summary } = result
      return summary
    }
    default:
      throw new Error(`unknown slides command: ${command}`)
  }
}

// ── Renderer IPC command runner ─────────────────────────────────────────────

function runRendererCommand(
  wcId: number,
  channels: { command: string },
  command: string,
  payload: unknown,
): Promise<unknown> {
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) {
    return Promise.reject(new Error('the document tab was closed'))
  }
  const requestId = `ws-${++requestSeq}`
  const result = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`the document command timed out after ${COMMAND_TIMEOUT_MS}ms`))
    }, COMMAND_TIMEOUT_MS)
    pending.set(requestId, { wcId, resolve, reject, timer })
  })
  wc.send(channels.command, { requestId, command, payload })
  return result
}

// ── Public factory ──────────────────────────────────────────────────────────

/**
 * Create a DocumentEditBridge backed by the given tab list resolver.
 *
 * The resolver is called on every command, so it always reflects the current
 * tab set — tabs open and close asynchronously.
 */
export function createDocumentEditBridge(getTabs: () => TabInfo[]): DocumentEditBridge {
  const runCommand = async (wcId: number, command: string, payload: unknown): Promise<unknown> => {
    const tab = getTabs().find((t) => t.wcId === wcId)
    if (!tab) throw new Error('the target document is no longer open')

    const kind = tab.kind as DocEditKind
    switch (kind) {
      case 'slides':
        await waitSlidesSession(wcId)
        return runSlidesCommand(wcId, command, payload)
      case 'docs':
      case 'sheets':
      case 'markdown':
      case 'html': {
        const channels = RENDERER_CHANNELS[kind]
        if (!channels) throw new Error(`no renderer command channel for ${kind}`)
        await waitForReady(wcId)
        return runRendererCommand(wcId, channels, command, payload)
      }
      default:
        throw new Error(
          `document editing is not yet supported for ${tab.kind} files in the workspace shell`,
        )
    }
  }

  return {
    runCommand,
    findTabByPath(relPath: string) {
      const tab = getTabs().find((t) => t.path === relPath && isSupportedKind(t.kind))
      if (!tab) return undefined
      return { wcId: tab.wcId, kind: tab.kind as DocEditKind }
    },
    listOpenTabs() {
      return getTabs()
        .filter((t) => isSupportedKind(t.kind))
        .map((t) => ({ path: t.path, wcId: t.wcId, kind: t.kind as DocEditKind }))
    },
  }
}
