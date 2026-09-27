import type { ReactElement } from 'react'
import type { WorkspaceRow } from '../../../shared/api'
import { useI18n } from '../locale'

interface Props {
  rows: WorkspaceRow[]
  /** Marked on its row as the workspace opened last. */
  lastActiveId: string | null
  /** Row just created, kept marked so it is obvious where it went. */
  highlightId: string | null
  onOpen: (id: string) => void
  onSettings: (id: string) => void
  onDelete: (id: string) => void
  onCreate: () => void
}

/**
 * The landing screen, and the only one on first launch.
 *
 * The demo workspace is pinned to the top and carries no delete affordance: it
 * is the product's explanation of itself, and someone who has never used a
 * goal-driven workspace needs something they can open without deciding
 * anything first.
 */
export function WorkspaceListScreen({
  rows,
  lastActiveId,
  highlightId,
  onOpen,
  onSettings,
  onDelete,
  onCreate,
}: Props) {
  const { t } = useI18n()
  const demoRows = rows.filter((row) => row.demo)
  const otherRows = rows.filter((row) => !row.demo)

  const renderRow = (row: WorkspaceRow): ReactElement => (
    <li key={row.id}>
      <div
        className={[
          'workspace-row',
          row.demo ? 'workspace-row-demo' : '',
          row.available ? '' : 'workspace-row-unavailable',
          row.id === highlightId ? 'workspace-row-highlight' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-testid={row.demo ? 'demo-row' : 'workspace-row'}
        data-workspace-id={row.id}
        data-demo={row.demo ? 'true' : 'false'}
        data-available={row.available ? 'true' : 'false'}
      >
        <button
          className="workspace-open"
          data-testid="workspace-open"
          type="button"
          disabled={!row.available}
          onClick={() => onOpen(row.id)}
        >
          <span className="workspace-name">
            {row.name}
            {row.demo ? <span className="badge">{t('demoBadge')}</span> : null}
            {row.id === lastActiveId ? (
              <span className="badge badge-quiet" data-testid="last-opened">
                {t('lastOpened')}
              </span>
            ) : null}
            {row.available ? null : (
              <span className="badge badge-danger" data-testid="unavailable">
                {t('unavailable')}
              </span>
            )}
          </span>
          <span className="workspace-line">{row.demo ? t('demoTagline') : row.goal}</span>
        </button>

        <span className="workspace-stats">
          {t('workspaceStats', { documents: row.documents, references: row.references })}
        </span>

        <span className="workspace-row-actions">
          <button
            className="link"
            data-testid="workspace-settings"
            type="button"
            onClick={() => onSettings(row.id)}
          >
            {t('settingsAction')}
          </button>
          {row.demo ? null : (
            <button
              className="link link-danger"
              data-testid="workspace-delete"
              type="button"
              onClick={() => onDelete(row.id)}
            >
              {t('deleteAction')}
            </button>
          )}
        </span>
      </div>
    </li>
  )

  return (
    <main className="list-screen" data-testid="workspace-list">
      <div className="list-screen-body">
        {rows.length === 0 ? <p className="hint">{t('emptyList')}</p> : null}
        <ul className="workspace-list">{demoRows.map(renderRow)}</ul>
        <ul className="workspace-list">{otherRows.map(renderRow)}</ul>
      </div>
      <footer className="list-screen-footer">
        <button className="button" data-testid="new-workspace" type="button" onClick={onCreate}>
          {t('newWorkspace')}
        </button>
      </footer>
    </main>
  )
}
