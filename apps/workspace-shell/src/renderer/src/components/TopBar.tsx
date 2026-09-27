import type { Lang } from '@genoffice/i18n'
import type { OpenDocument, ThemeMode } from '@genoffice/workspace-harness'
import { useI18n } from '../locale'

const LANGS: Lang[] = ['zh', 'en']
const THEMES: ThemeMode[] = ['system', 'light', 'dark']

interface Props {
  /** The workspace shows the open-document strip plus the chat and settings controls. */
  variant: 'list' | 'workspace'
  openDocuments: OpenDocument[]
  chatVisible: boolean
  onToggleChat: () => void
  /** The debug panel replaces the chat column while it is up. */
  debugVisible: boolean
  onToggleDebug: () => void
  onOpenSettings: () => void
  onActivateDocument: (id: string) => void
  onCloseDocument: (id: string) => void
  theme: ThemeMode
  onTheme: (mode: ThemeMode) => void
}

/**
 * The one 44px chrome strip, above every screen.
 *
 * It is the top inset the renderer reports, so an editor view never covers it —
 * which is why the open-document strip lives here rather than over the middle
 * column, where a `WebContentsView` would paint on top of it.
 */
export function TopBar({
  variant,
  openDocuments,
  chatVisible,
  onToggleChat,
  debugVisible,
  onToggleDebug,
  onOpenSettings,
  onActivateDocument,
  onCloseDocument,
  theme,
  onTheme,
}: Props) {
  const { lang, setLang, t } = useI18n()

  return (
    <header className="topbar" data-testid="top-bar">
      <span className="topbar-title">{t('appName')}</span>

      {variant === 'workspace' ? (
        <div className="topbar-tabs">
          {openDocuments.length === 0 ? (
            <span className="topbar-empty">{t('noOpenDocuments')}</span>
          ) : (
            openDocuments.map((doc) => (
              <span
                key={doc.id}
                className={doc.active ? 'tab tab-active' : 'tab'}
                data-testid="doc-tab"
                data-path={doc.path}
              >
                <button
                  className="tab-label"
                  type="button"
                  onClick={() => onActivateDocument(doc.id)}
                >
                  {doc.title}
                  {doc.readOnly ? <span className="badge">{t('readOnly')}</span> : null}
                </button>
                <button
                  className="tab-close"
                  type="button"
                  title={t('closeDocument')}
                  onClick={() => onCloseDocument(doc.id)}
                >
                  ×
                </button>
              </span>
            ))
          )}
        </div>
      ) : (
        <span className="topbar-spacer" />
      )}

      <label className="topbar-field">
        <select
          data-testid="theme-select"
          value={theme}
          onChange={(event) => onTheme(event.target.value as ThemeMode)}
        >
          {THEMES.map((mode) => (
            <option key={mode} value={mode}>
              {mode === 'light'
                ? t('themeLight')
                : mode === 'dark'
                  ? t('themeDark')
                  : t('themeSystem')}
            </option>
          ))}
        </select>
      </label>
      <label className="topbar-field">
        <select
          data-testid="lang-select"
          value={lang}
          onChange={(event) => setLang(event.target.value as Lang)}
        >
          {LANGS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>

      {variant === 'workspace' ? (
        <>
          <button
            className="icon-button"
            data-testid="chat-toggle"
            type="button"
            aria-pressed={chatVisible}
            title={chatVisible ? t('collapseChat') : t('expandChat')}
            onClick={onToggleChat}
          >
            {chatVisible ? '»' : '«'}
          </button>
          <button
            className="icon-button"
            data-testid="debug-toggle"
            type="button"
            aria-pressed={debugVisible}
            title={t('debugPanel')}
            onClick={onToggleDebug}
          >
            ⌗
          </button>
          <button
            className="icon-button"
            data-testid="settings-open"
            type="button"
            title={t('settingsTitle')}
            onClick={onOpenSettings}
          >
            ⚙
          </button>
        </>
      ) : null}
    </header>
  )
}
