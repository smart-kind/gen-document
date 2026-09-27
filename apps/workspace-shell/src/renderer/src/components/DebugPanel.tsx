import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BridgeTab } from '../../../shared/api'

/**
 * The document-edit bridge's test bench.
 *
 * It short-circuits the agent: instead of an LLM choosing tools, a button (or a
 * hand-written command) is pushed straight into the same
 * `DocumentEditBridge.runCommand` the agent's tools call. The panel follows the
 * active tab and offers that kind's operations, so the incremental render each
 * command produces can be watched in the editor without a conversation in the
 * loop — and without the model being the thing under test.
 */

interface DebugAction {
  label: string
  command: string
  payload: unknown
  /** Read-only commands are marked so a glance separates a read from an edit. */
  query?: boolean
}

const DOC_ACTIONS: DebugAction[] = [
  { label: 'Read document', command: 'read_document', payload: {}, query: true },
  {
    label: 'Insert paragraph at end',
    command: 'insert_content',
    payload: { html: '<p>Inserted by the debug panel.</p>' },
  },
  {
    label: 'Insert paragraph after block 0',
    command: 'insert_content',
    payload: { html: '<p>Inserted after the first block.</p>', afterBlockIndex: 0 },
  },
  {
    label: 'Replace block 0 with a heading',
    command: 'replace_blocks',
    payload: { startBlockIndex: 0, endBlockIndex: 0, html: '<h1>Replaced by the debug panel</h1>' },
  },
  {
    label: 'Heading block 0 (dry run)',
    command: 'apply_ops',
    payload: {
      ops: [{ op: 'setHeadingLevel', target: { blockIndexes: [0] }, level: 1 }],
      dryRun: true,
    },
  },
  {
    label: 'Heading block 0',
    command: 'apply_ops',
    payload: { ops: [{ op: 'setHeadingLevel', target: { blockIndexes: [0] }, level: 1 }] },
  },
  {
    label: 'Block 0 as bullet item',
    command: 'apply_ops',
    payload: { ops: [{ op: 'setList', target: { blockIndexes: [0] }, kind: 'bullet' }] },
  },
  {
    label: 'Clear list on block 0',
    command: 'apply_ops',
    payload: { ops: [{ op: 'clearList', target: { blockIndexes: [0] } }] },
  },
  {
    label: 'Delete block 0 (dry run)',
    command: 'apply_ops',
    payload: { ops: [{ op: 'deleteBlocks', target: { blockIndexes: [0] } }], dryRun: true },
  },
]

const SLIDE_ACTIONS: DebugAction[] = [
  { label: 'Read deck', command: 'read_deck', payload: {}, query: true },
  {
    label: 'Add blank slide after 0',
    command: 'apply_ops',
    payload: { ops: [{ op: 'addBlankSlide', target: { slide: 0 } }] },
  },
  {
    label: 'Set slide 0 background',
    command: 'apply_ops',
    payload: {
      ops: [{ op: 'setBackground', target: { slide: 0 }, kind: 'solid', color: '#FFEEDD' }],
    },
  },
  {
    label: 'Delete slide 0 (dry run)',
    command: 'apply_ops',
    payload: { ops: [{ op: 'deleteSlide', target: { slide: 0 } }], dryRun: true },
  },
]

const SHEET_ACTIONS: DebugAction[] = [
  { label: 'Read sheet (context)', command: 'read_sheet', payload: {}, query: true },
  { label: 'Read A1', command: 'read_sheet', payload: { addresses: ['A1'] }, query: true },
]

const MARKDOWN_ACTIONS: DebugAction[] = [
  { label: 'Read document', command: 'read_document', payload: {}, query: true },
  {
    label: 'Append paragraph',
    command: 'insert_content',
    payload: { text: 'Inserted by the debug panel.' },
  },
  {
    label: 'Insert after block 0',
    command: 'insert_content',
    payload: { text: 'Inserted after the first block.', afterBlockIndex: 0 },
  },
  {
    label: 'Replace block 0 with a heading',
    command: 'replace_blocks',
    payload: { startBlockIndex: 0, endBlockIndex: 0, text: '# Replaced by the debug panel' },
  },
]

const HTML_ACTIONS: DebugAction[] = [
  { label: 'Read document', command: 'read_document', payload: {}, query: true },
  {
    label: 'Append line',
    command: 'insert_content',
    payload: { text: '<!-- inserted by the debug panel -->' },
  },
  {
    label: 'Insert after line 1',
    command: 'insert_content',
    payload: { text: '<!-- inserted after line 1 -->', afterLine: 1 },
  },
  {
    label: 'Replace line 1',
    command: 'replace_blocks',
    payload: { startLine: 1, endLine: 1, text: '<h1>Replaced by the debug panel</h1>' },
  },
]

function actionsFor(kind: string): DebugAction[] {
  switch (kind) {
    case 'docs':
      return DOC_ACTIONS
    case 'slides':
      return SLIDE_ACTIONS
    case 'sheets':
      return SHEET_ACTIONS
    case 'markdown':
      return MARKDOWN_ACTIONS
    case 'html':
      return HTML_ACTIONS
    default:
      return []
  }
}

interface ResultEntry {
  id: number
  command: string
  ok: boolean
  body: string
}

const MAX_RESULT_CHARS = 4000

function formatResult(value: unknown): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  if (text === undefined) return '(no result)'
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated)` : text
}

let resultSeq = 0

export function DebugPanel() {
  const [tabs, setTabs] = useState<BridgeTab[]>([])
  const [pinnedWcId, setPinnedWcId] = useState<number | null>(null)
  const [results, setResults] = useState<ResultEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [customCommand, setCustomCommand] = useState('read_document')
  const [customPayload, setCustomPayload] = useState('{}')

  const refreshTabs = useCallback(async (): Promise<void> => {
    try {
      setTabs(await window.workspaceShell.bridgeTabs())
    } catch {
      setTabs([])
    }
  }, [])

  useEffect(() => {
    void refreshTabs()
    return window.workspaceShell.onShellEvent((event) => {
      if (event.type === 'document.changed') void refreshTabs()
    })
  }, [refreshTabs])

  // Pinning follows the active tab by default, and drops a pin whose tab is gone.
  useEffect(() => {
    if (pinnedWcId !== null && !tabs.some((tab) => tab.wcId === pinnedWcId)) {
      setPinnedWcId(null)
    }
  }, [tabs, pinnedWcId])

  const activeTab = useMemo(
    () =>
      (pinnedWcId !== null ? tabs.find((tab) => tab.wcId === pinnedWcId) : undefined) ??
      tabs.find((tab) => tab.active),
    [tabs, pinnedWcId],
  )

  const run = useCallback(
    async (command: string, payload: unknown): Promise<void> => {
      if (!activeTab) return
      setBusy(true)
      // A new document means the previous results describe a document that is no
      // longer on screen; clearing on switch keeps the log honest.
      try {
        const result = await window.workspaceShell.bridgeRunCommand(
          activeTab.wcId,
          command,
          payload,
        )
        setResults((current) => [
          { id: (resultSeq += 1), command, ok: true, body: formatResult(result) },
          ...current,
        ])
      } catch (error) {
        setResults((current) => [
          {
            id: (resultSeq += 1),
            command,
            ok: false,
            body: error instanceof Error ? error.message : String(error),
          },
          ...current,
        ])
      } finally {
        setBusy(false)
      }
    },
    [activeTab],
  )

  const runCustom = (): void => {
    let payload: unknown
    try {
      payload = customPayload.trim() ? JSON.parse(customPayload) : {}
    } catch (error) {
      setResults((current) => [
        {
          id: (resultSeq += 1),
          command: customCommand,
          ok: false,
          body: `payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
        ...current,
      ])
      return
    }
    void run(customCommand.trim(), payload)
  }

  const actions = activeTab ? actionsFor(activeTab.kind) : []

  return (
    <section className="debug-panel" data-testid="debug-panel">
      <div className="debug-head">
        <span className="panel-title">Debug panel</span>
        <button
          className="link"
          type="button"
          disabled={results.length === 0}
          onClick={() => setResults([])}
        >
          Clear
        </button>
      </div>

      {tabs.length > 1 ? (
        <select
          className="debug-select"
          data-testid="debug-tab-select"
          value={activeTab?.wcId ?? ''}
          onChange={(event) => setPinnedWcId(Number(event.target.value))}
        >
          {tabs.map((tab) => (
            <option key={tab.wcId} value={tab.wcId}>
              {tab.title}
              {tab.active ? ' · active' : ''}
            </option>
          ))}
        </select>
      ) : null}

      {!activeTab ? (
        <p className="hint" data-testid="debug-no-document">
          No document open. Open a docx, pptx, xlsx, md or html file to test the bridge.
        </p>
      ) : (
        <>
          <div className="debug-subject" data-testid="debug-subject">
            <span className="debug-path" title={activeTab.path}>
              {activeTab.title}
            </span>
            <span className="debug-kind">{activeTab.kind}</span>
            {activeTab.readOnly ? <span className="badge">read-only</span> : null}
          </div>

          <div className="debug-actions">
            {actions.length === 0 ? (
              <p className="hint">
                No operations are wired for <code>{activeTab.kind}</code> yet.
              </p>
            ) : (
              actions.map((action) => (
                <button
                  key={action.label}
                  className={action.query ? 'button button-quiet' : 'button'}
                  data-testid="debug-action"
                  data-command={action.command}
                  type="button"
                  disabled={busy}
                  title={`${action.command} ${JSON.stringify(action.payload)}`}
                  onClick={() => void run(action.command, action.payload)}
                >
                  {action.label}
                </button>
              ))
            )}
          </div>

          <div className="debug-custom">
            <input
              className="debug-command"
              data-testid="debug-command"
              value={customCommand}
              spellCheck={false}
              onChange={(event) => setCustomCommand(event.target.value)}
            />
            <textarea
              className="debug-payload"
              data-testid="debug-payload"
              rows={3}
              value={customPayload}
              spellCheck={false}
              onChange={(event) => setCustomPayload(event.target.value)}
            />
            <button
              className="button button-quiet"
              data-testid="debug-run-custom"
              type="button"
              disabled={busy}
              onClick={runCustom}
            >
              Run command
            </button>
          </div>

          <div className="debug-results" data-testid="debug-results">
            {results.length === 0 ? (
              <p className="hint">
                Results appear here. Watch the editor for the incremental render.
              </p>
            ) : (
              results.map((entry) => (
                <div
                  key={entry.id}
                  className={entry.ok ? 'debug-result' : 'debug-result debug-result-error'}
                >
                  <div className="debug-result-head">
                    <span className="debug-result-command">{entry.command}</span>
                    <span className="debug-result-status">{entry.ok ? 'ok' : 'error'}</span>
                  </div>
                  <pre className="debug-result-body">{entry.body}</pre>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </section>
  )
}
