import { useCallback, useEffect, useState } from 'react'
import type { ThemeMode } from '@genoffice/workspace-harness'
import type { ModelCatalogue, WorkspaceRow, WorkspaceSnapshot } from '../../shared/api'
import {
  LEFT_RAIL_WIDTH,
  TOP_BAR_HEIGHT,
  ZERO_INSETS,
  workspaceInsets,
  type LayoutInsets,
} from '../../shared/layout'
import { TopBar } from './components/TopBar'
import { useI18n } from './locale'
import { CreateWorkspaceWizard } from './screens/CreateWorkspaceWizard'
import { WorkspaceListScreen } from './screens/WorkspaceListScreen'
import { WorkspaceScreen } from './screens/WorkspaceScreen'

type View = 'list' | 'workspace'

/**
 * The three-state product: workspace list, new-workspace wizard, workspace.
 *
 * The list is the landing state every time — nothing is restored on startup, so
 * the last workspace is only marked, never reopened. Creating and opening are
 * separate actions on purpose: the wizard drops the new row back on the list,
 * marked, and the user decides when to go in.
 *
 * This component also owns the window chrome geometry: it publishes the insets
 * the layout actually uses, and the main process insets every editor view by
 * exactly those numbers. While the list is up the chat column does not exist, so
 * a stale `right` inset would let an editor paint over the list.
 */
export function App() {
  const { t } = useI18n()

  const [view, setView] = useState<View>('list')
  const [rows, setRows] = useState<WorkspaceRow[]>([])
  const [lastActiveId, setLastActiveId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null)
  const [defaultParentDir, setDefaultParentDir] = useState('')
  const [theme, setTheme] = useState<ThemeMode>('system')
  const [chatVisible, setChatVisible] = useState(true)
  const [debugVisible, setDebugVisible] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshList = useCallback(async (): Promise<void> => {
    try {
      const [list, lastActive] = await Promise.all([
        window.workspaceShell.listWorkspaces(),
        window.workspaceShell.lastActiveWorkspace(),
      ])
      setRows(list)
      setLastActiveId(lastActive)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const refreshSnapshot = useCallback(async (): Promise<WorkspaceSnapshot | null> => {
    try {
      const next = await window.workspaceShell.describeWorkspace()
      setSnapshot(next)
      return next
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    }
  }, [])

  const openWorkspace = useCallback(async (id: string): Promise<void> => {
    try {
      const next = await window.workspaceShell.openWorkspace(id)
      setSnapshot(next)
      setHighlightId(null)
      setView(next ? 'workspace' : 'list')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const backToList = useCallback(async (): Promise<void> => {
    try {
      await window.workspaceShell.closeWorkspace()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setSnapshot(null)
    setSettingsOpen(false)
    setView('list')
    await refreshList()
  }, [refreshList])

  useEffect(() => {
    void refreshList()
    void refreshSnapshot()
    void window.workspaceShell.getTheme().then(setTheme)
    void window.workspaceShell.listModels().then(setCatalogue)
    void window.workspaceShell.defaultParentDir().then(setDefaultParentDir)
  }, [refreshList, refreshSnapshot])

  useEffect(() => window.workspaceShell.onThemeChanged(setTheme), [])
  useEffect(() => window.workspaceShell.onNotify((payload) => setNotice(payload.message)), [])

  useEffect(
    () =>
      window.workspaceShell.onShellEvent((event) => {
        const payload = event.payload as { panel?: string; visible?: boolean } | undefined
        if (event.type === 'ui.changed') {
          if (payload?.panel === 'chat' && typeof payload.visible === 'boolean') {
            setChatVisible(payload.visible)
          }
          return
        }
        if (event.type === 'workspace.changed') {
          void refreshList()
        }
      }),
    [refreshList],
  )

  // Single publication point for the chrome geometry. The list and the wizard
  // have no editor area, so they report zero insets. The debug panel and the
  // chat column share the right slot, so either one reserves the same inset.
  useEffect(() => {
    const insets = view === 'workspace' ? workspaceInsets(chatVisible || debugVisible) : ZERO_INSETS
    publishInsets(insets)
  }, [view, chatVisible, debugVisible])

  /** Chat and the debug panel are mutually exclusive in the one right column. */
  const toggleChat = useCallback((): void => {
    setChatVisible((visible) => {
      if (!visible) setDebugVisible(false)
      return !visible
    })
  }, [])

  const toggleDebug = useCallback((): void => {
    setDebugVisible((visible) => {
      if (!visible) setChatVisible(false)
      return !visible
    })
  }, [])

  const activeRow = view === 'workspace' ? snapshot : null

  return (
    <div className="app" data-view={view}>
      {notice ? (
        <p className="notice" data-testid="notice" onClick={() => setNotice(null)}>
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="error" data-testid="error" onClick={() => setError(null)}>
          {t('refreshFailed', { error })}
        </p>
      ) : null}

      {view === 'list' || !activeRow ? (
        <>
          <TopBar
            variant="list"
            openDocuments={[]}
            chatVisible={false}
            onToggleChat={() => setChatVisible((value) => !value)}
            debugVisible={false}
            onToggleDebug={() => {}}
            onOpenSettings={() => setSettingsOpen(true)}
            onActivateDocument={() => {}}
            onCloseDocument={() => {}}
            theme={theme}
            onTheme={(mode) => {
              setTheme(mode)
              void window.workspaceShell.setTheme(mode)
            }}
          />
          <WorkspaceListScreen
            rows={rows}
            lastActiveId={lastActiveId}
            highlightId={highlightId}
            onOpen={(id) => void openWorkspace(id)}
            onSettings={(id) => {
              // Settings belong to the workspace, so the row's 设置 enters it with
              // the dialog already open rather than editing a closed folder.
              void openWorkspace(id).then(() => setSettingsOpen(true))
            }}
            onDelete={(id) => {
              void window.workspaceShell
                .deleteWorkspace(id)
                .then(refreshList)
                .catch((err) => setError(err instanceof Error ? err.message : String(err)))
            }}
            onCreate={() => setWizardOpen(true)}
          />
        </>
      ) : (
        <WorkspaceScreen
          snapshot={activeRow}
          catalogue={catalogue}
          chatVisible={chatVisible}
          onToggleChat={toggleChat}
          debugVisible={debugVisible}
          onToggleDebug={toggleDebug}
          onBack={() => void backToList()}
          onRefresh={refreshSnapshot}
          onError={setError}
          settingsOpen={settingsOpen}
          onOpenSettings={() => setSettingsOpen(true)}
          onCloseSettings={() => setSettingsOpen(false)}
          theme={theme}
          onTheme={(mode) => {
            setTheme(mode)
            void window.workspaceShell.setTheme(mode)
          }}
        />
      )}

      {wizardOpen ? (
        <CreateWorkspaceWizard
          catalogue={catalogue}
          defaultParentDir={defaultParentDir}
          onCancel={() => setWizardOpen(false)}
          onCreated={(id, warnings) => {
            setWizardOpen(false)
            setHighlightId(id)
            setView('list')
            setSnapshot(null)
            setNotice(
              warnings.length > 0
                ? `${t('createdWorkspace')} · ${t('createPartial', { items: warnings.join('; ') })}`
                : t('createdWorkspace'),
            )
            // Creating and opening are separate: the workspace was activated only
            // so its settings could be written, and the list is where the user
            // lands with the new row marked.
            void window.workspaceShell.closeWorkspace().then(refreshList)
            void refreshSnapshot()
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * Push the layout to both sides: CSS variables for this window, and the insets
 * the main process must honour for the editor views.
 */
function publishInsets(insets: LayoutInsets): void {
  const root = document.documentElement
  root.style.setProperty('--left-rail-width', `${LEFT_RAIL_WIDTH}px`)
  root.style.setProperty('--chat-panel-width', `${insets.right}px`)
  root.style.setProperty('--topbar-height', `${TOP_BAR_HEIGHT}px`)
  root.style.setProperty('--inset-left', `${insets.left}px`)
  root.style.setProperty('--inset-right', `${insets.right}px`)
  root.style.setProperty('--inset-top', `${insets.top}px`)
  void window.workspaceShell.setLayoutInsets(insets)
}
