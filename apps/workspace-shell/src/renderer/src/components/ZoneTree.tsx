import type { TreeEntry, ZoneGroup } from '../../../shared/api'
import { useI18n } from '../locale'
import type { StringKey } from '../strings'

const ZONE_LABEL: Record<ZoneGroup['zone'], StringKey> = {
  library: 'zoneLibrary',
  material: 'zoneMaterial',
  output: 'zoneOutput',
  feedback: 'zoneFeedback',
}

interface Props {
  /** The four zones in harness display order, each with its top-level entries. */
  groups: ZoneGroup[]
  /** Children of expanded directories, keyed by workspace-relative path. */
  children: Record<string, TreeEntry[]>
  expanded: ReadonlySet<string>
  onToggleDir: (path: string) => void
  onOpenFile: (entry: TreeEntry) => void
}

/**
 * The four zones, grouped and labelled.
 *
 * The grouping is the point: a workspace holds four kinds of content with
 * different provenance and different write rules, and a flat file list hides
 * exactly the distinction the agent works with. Read-only zones are marked and
 * still open — a reference must be viewable, just not writable.
 */
export function ZoneTree({ groups, children, expanded, onToggleDir, onOpenFile }: Props) {
  const { t } = useI18n()

  const row = (entry: TreeEntry, depth: number) => {
    const nested = children[entry.path]
    const isDir = entry.kind === 'dir'
    const open = isDir && expanded.has(entry.path)
    return (
      <div key={`${entry.path}:${depth}`} className="tree-node">
        <button
          className={`tree-row${entry.readOnly ? ' tree-row-readonly' : ''}`}
          data-testid="zone-file"
          data-path={entry.path}
          data-readonly={entry.readOnly ? 'true' : 'false'}
          style={{ paddingLeft: `${10 + depth * 14}px` }}
          type="button"
          title={entry.path}
          onClick={() => (isDir ? onToggleDir(entry.path) : onOpenFile(entry))}
        >
          <span className="tree-icon">{isDir ? (open ? '▾' : '▸') : '·'}</span>
          <span className="tree-name">{entry.name}</span>
          {entry.open ? <span className="dot" /> : null}
        </button>
        {nested?.map((child) => row(child, depth + 1))}
      </div>
    )
  }

  return (
    <nav className="zone-tree" data-testid="zone-tree">
      {groups.map((group) => (
        <section
          key={group.zone}
          className="zone"
          data-testid={`zone-group-${group.zone}`}
          data-zone={group.zone}
          data-readonly={group.readOnly ? 'true' : 'false'}
        >
          <header className="zone-head">
            <span className="zone-title">{t(ZONE_LABEL[group.zone])}</span>
            {group.readOnly ? (
              <span className="badge badge-lock" data-testid={`zone-lock-${group.zone}`}>
                {t('readOnly')}
              </span>
            ) : null}
          </header>
          {group.entries.length === 0 ? (
            <p className="hint zone-empty">{t('zoneEmpty')}</p>
          ) : (
            group.entries.map((entry) => row(entry, 0))
          )}
        </section>
      ))}
    </nav>
  )
}
