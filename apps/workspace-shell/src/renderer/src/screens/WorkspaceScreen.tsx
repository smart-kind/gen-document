import { useCallback, useEffect, useRef, useState } from 'react'
import type { OpenDocument, ThemeMode } from '@genoffice/workspace-harness'
import type {
  AgentStreamEvent,
  ModelCatalogue,
  TreeEntry,
  WorkflowInstruction,
  WorkflowKind,
  WorkspaceSnapshot,
  ZoneGroup,
} from '../../../shared/api'
import { ChatPanel, type ChatMessage } from '../components/ChatPanel'
import { ConversationList } from '../components/ConversationList'
import { DebugPanel } from '../components/DebugPanel'
import { TopBar } from '../components/TopBar'
import { WorkspaceSettingsDialog } from '../components/WorkspaceSettingsDialog'
import { ZoneTree } from '../components/ZoneTree'
import { useI18n } from '../locale'

let messageSeq = 0
function nextMessageId(): string {
  messageSeq += 1
  return `m${messageSeq}`
}

const NO_ZONES: ZoneGroup[] = []

interface Props {
  snapshot: WorkspaceSnapshot
  catalogue: ModelCatalogue | null
  chatVisible: boolean
  onToggleChat: () => void
  /** The debug panel takes the right column while it is up. */
  debugVisible: boolean
  onToggleDebug: () => void
  onBack: () => void
  /** Re-read the snapshot from the main process after a structural change. */
  onRefresh: () => Promise<WorkspaceSnapshot | null>
  onError: (message: string) => void
  settingsOpen: boolean
  onOpenSettings: () => void
  onCloseSettings: () => void
  theme: ThemeMode
  onTheme: (mode: ThemeMode) => void
}

/**
 * The working screen: rail, editor area and chat column.
 *
 * The middle column is only a placeholder — the real document is a
 * `WebContentsView` the main process paints over the window, inset by whatever
 * the renderer reports. So the middle column must contain nothing that has to be
 * clicked: the document tabs live in the top bar and the two workflow entries
 * live at the bottom of the rail, both outside the painted rectangle.
 *
 * State is pulled, not pushed: harness effects arrive as shell events and this
 * screen re-reads whatever the effect implies.
 */
export function WorkspaceScreen({
  snapshot,
  catalogue,
  chatVisible,
  onToggleChat,
  debugVisible,
  onToggleDebug,
  onBack,
  onRefresh,
  onError,
  settingsOpen,
  onOpenSettings,
  onCloseSettings,
  theme,
  onTheme,
}: Props) {
  const { t } = useI18n()
  const workspaceId = snapshot.workspace.id

  const [zones, setZones] = useState<ZoneGroup[]>(NO_ZONES)
  const [children, setChildren] = useState<Record<string, TreeEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [openDocuments, setOpenDocuments] = useState<OpenDocument[]>([])
  const [activeConversation, setActiveConversation] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)

  const activeConversationRef = useRef<string | null>(null)
  activeConversationRef.current = activeConversation

  const fail = useCallback(
    (err: unknown): void => onError(err instanceof Error ? err.message : String(err)),
    [onError],
  )

  const loadZones = useCallback(async (): Promise<void> => {
    try {
      setZones(await window.workspaceShell.listZones())
    } catch (err) {
      fail(err)
    }
  }, [fail])

  const refreshDocuments = useCallback(async (): Promise<void> => {
    try {
      setOpenDocuments(await window.workspaceShell.listOpenDocuments())
    } catch (err) {
      fail(err)
    }
  }, [fail])

  // A new workspace means new paths: nothing from the previous one carries over.
  useEffect(() => {
    setChildren({})
    setExpanded(new Set())
    setActiveConversation(null)
    setMessages([])
    void loadZones()
    void refreshDocuments()
  }, [workspaceId, loadZones, refreshDocuments])

  useEffect(
    () =>
      window.workspaceShell.onShellEvent((event) => {
        if (event.type === 'workspace.changed') {
          void loadZones()
          void refreshDocuments()
          return
        }
        if (event.type === 'document.changed') {
          void loadZones()
          void refreshDocuments()
        }
      }),
    [loadZones, refreshDocuments],
  )

  // The agent's stream: text deltas, one-line tool activity, and failures.
  useEffect(
    () =>
      window.workspaceShell.onAgentEvent((event: AgentStreamEvent) => {
        if (event.conversationId !== activeConversationRef.current) return
        switch (event.kind) {
          case 'turn_start':
            setBusy(true)
            return
          case 'turn_end':
            setBusy(false)
            void loadZones()
            void refreshDocuments()
            return
          case 'text_delta':
            setMessages((current) => appendAssistant(current, event.text))
            return
          case 'tool':
            setMessages((current) => [
              ...current,
              {
                id: nextMessageId(),
                role: 'tool',
                text: event.summary
                  ? event.summary
                  : event.isError
                    ? t('toolFailed', { tool: event.toolName })
                    : t('toolRun', { tool: event.toolName }),
              },
            ])
            return
          case 'error':
            setBusy(false)
            setMessages((current) => [
              ...current,
              { id: nextMessageId(), role: 'error', text: event.message },
            ])
        }
      }),
    [loadZones, refreshDocuments, t],
  )

  // Switching conversation swaps the transcript: contexts must not bleed.
  useEffect(() => {
    if (!activeConversation) {
      setMessages([])
      return
    }
    let cancelled = false
    void window.workspaceShell
      .transcript(activeConversation)
      .then((transcript) => {
        if (cancelled) return
        setMessages(
          transcript.map((entry) => ({ id: nextMessageId(), role: entry.role, text: entry.text })),
        )
      })
      .catch(fail)
    return () => {
      cancelled = true
    }
  }, [activeConversation, fail])

  const toggleDir = useCallback(
    async (path: string): Promise<void> => {
      if (expanded.has(path)) {
        setExpanded((current) => {
          const next = new Set(current)
          next.delete(path)
          return next
        })
        return
      }
      try {
        const listing = await window.workspaceShell.listTree(path)
        setChildren((current) => ({ ...current, [path]: listing }))
        setExpanded((current) => new Set(current).add(path))
      } catch (err) {
        fail(err)
      }
    },
    [expanded, fail],
  )

  const openFile = useCallback(
    async (entry: TreeEntry): Promise<void> => {
      try {
        await window.workspaceShell.openDocument(entry.path, { readOnly: entry.readOnly })
        await refreshDocuments()
        await loadZones()
      } catch (err) {
        onError(t('openFailed', { error: err instanceof Error ? err.message : String(err) }))
      }
    },
    [loadZones, onError, refreshDocuments, t],
  )

  const createConversation = useCallback(
    async (title: string): Promise<string | null> => {
      try {
        const entry = await window.workspaceShell.createConversation(title)
        setActiveConversation(entry.id)
        return entry.id
      } catch (err) {
        fail(err)
        return null
      }
    },
    [fail],
  )

  const send = useCallback(
    (text: string): void => {
      const conversationId = activeConversation
      if (!conversationId) return
      setMessages((current) => [
        ...current,
        { id: nextMessageId(), role: 'user', text },
        { id: nextMessageId(), role: 'assistant', text: '' },
      ])
      setBusy(true)
      void window.workspaceShell.prompt(conversationId, text)
    },
    [activeConversation],
  )

  /**
   * Open a conversation on one of the two workflows.
   *
   * The instruction is built in the main process from the workspace's real
   * zone contents, so it names the rule files, the produced documents and the
   * opinion files that actually exist — the renderer only chooses which
   * workflow and what to call the conversation.
   */
  const startWorkflow = useCallback(
    async (kind: WorkflowKind, title: string): Promise<void> => {
      let workflow: WorkflowInstruction
      try {
        workflow = await window.workspaceShell.workflowInstruction(kind)
      } catch (err) {
        fail(err)
        return
      }
      const conversationId = await createConversation(title)
      if (!conversationId) return
      // The conversation list is painted from the snapshot, so the new one only
      // appears — marked active — after the snapshot is re-read.
      void onRefresh()
      setMessages([{ id: nextMessageId(), role: 'user', text: workflow.instruction }])
      setBusy(true)
      try {
        await window.workspaceShell.prompt(conversationId, workflow.instruction)
      } catch (err) {
        fail(err)
      }
    },
    [createConversation, fail, onRefresh],
  )

  return (
    <div className="workspace-view">
      <TopBar
        variant="workspace"
        openDocuments={openDocuments}
        chatVisible={chatVisible}
        onToggleChat={onToggleChat}
        debugVisible={debugVisible}
        onToggleDebug={onToggleDebug}
        onOpenSettings={onOpenSettings}
        onActivateDocument={(id) => {
          void window.workspaceShell.activateDocument(id).then(refreshDocuments)
        }}
        onCloseDocument={(id) => {
          void window.workspaceShell.closeDocument(id, { save: true }).then(refreshDocuments)
        }}
        theme={theme}
        onTheme={onTheme}
      />

      <div className="workspace-body">
        <aside className="rail" data-testid="left-rail">
          <div className="rail-head">
            <button className="link" data-testid="back-to-list" type="button" onClick={onBack}>
              ← {t('back')}
            </button>
            <span className="rail-name" data-testid="workspace-name">
              {snapshot.workspace.name}
            </span>
            <span className="rail-goal" title={snapshot.workspace.goal}>
              {snapshot.workspace.goal}
            </span>
          </div>

          <ZoneTree
            groups={zones}
            children={children}
            expanded={expanded}
            onToggleDir={(path) => void toggleDir(path)}
            onOpenFile={(entry) => void openFile(entry)}
          />

          <div className="rail-actions">
            <button
              className="button button-quiet"
              data-testid="validate-output"
              type="button"
              onClick={() => void startWorkflow('validate', t('validateOutput'))}
            >
              {t('validateOutput')}
            </button>
            <button
              className="button button-quiet"
              data-testid="summarize-feedback"
              type="button"
              onClick={() => void startWorkflow('summarize', t('summarizeFeedback'))}
            >
              {t('summarizeFeedback')}
            </button>
          </div>
        </aside>

        {/* Painted over by the editor view; a placeholder only with nothing open. */}
        <main className="editor-area" data-testid="editor-area">
          <p className="hint">{openDocuments.length === 0 ? t('noOpenDocuments') : ''}</p>
        </main>

        {debugVisible ? (
          <aside className="chat-column" data-testid="debug-column">
            <DebugPanel />
          </aside>
        ) : chatVisible ? (
          <aside className="chat-column" data-testid="chat-panel">
            <ConversationList
              conversations={snapshot.conversations}
              activeId={activeConversation}
              onSelect={setActiveConversation}
              onCreate={() => void createConversation(t('newConversation'))}
              onDelete={(id) =>
                void window.workspaceShell
                  .deleteConversation(id)
                  .then(() => {
                    if (activeConversationRef.current === id) setActiveConversation(null)
                    return onRefresh()
                  })
                  .catch(fail)
              }
            />
            <ChatPanel
              messages={messages}
              busy={busy}
              disabled={!activeConversation}
              onSend={send}
              onStop={() => {
                if (activeConversation) window.workspaceShell.abort(activeConversation)
              }}
            />
          </aside>
        ) : null}
      </div>

      {settingsOpen ? (
        <WorkspaceSettingsDialog
          snapshot={snapshot}
          catalogue={catalogue}
          onClose={onCloseSettings}
          onChanged={() => {
            void onRefresh()
            void loadZones()
          }}
        />
      ) : null}
    </div>
  )
}

/** Append streamed text to the trailing assistant bubble, or start one. */
function appendAssistant(messages: ChatMessage[], text: string): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant') {
    return [...messages.slice(0, -1), { ...last, text: last.text + text }]
  }
  return [...messages, { id: nextMessageId(), role: 'assistant', text }]
}
