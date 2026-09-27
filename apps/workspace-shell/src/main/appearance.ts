import { app, nativeTheme } from 'electron'
import { normalizeLang, setUiLang, type Lang } from '@genoffice/i18n'
import type { ThemeMode, UiBridge } from '@genoffice/workspace-harness'
import { WORKSPACE_CHANNELS, type NotifyPayload } from '../shared/api'
import { readWorkspaceSettings, writeWorkspaceSettings } from './app-settings'

/**
 * Language and theme of the workspace shell.
 *
 * Both are app-level, not per-workspace, and both are announced on the channels
 * the embedded editor views already listen to (`app:language-changed`,
 * `app:theme-changed`), so a switch here repaints the editors too instead of
 * leaving them on the previous theme.
 */
export interface AppearanceOptions {
  /** `<userData>/app-settings.json`. */
  settingsFile: string
  /** Channel the editor views receive; they are separate webContents. */
  broadcastAll: (channel: string, payload: unknown) => void
  /** Channel the workspace shell's own renderer receives. */
  broadcastShell: (channel: string, payload: unknown) => void
}

export class Appearance {
  private readonly language: Lang
  private theme: ThemeMode

  constructor(private readonly options: AppearanceOptions) {
    const stored = readWorkspaceSettings(options.settingsFile)
    // GENOFFICE_LANG overrides the OS locale for tests, the same way the unified
    // shell does; a stored choice still wins over both.
    this.language = stored.language ?? normalizeLang(process.env.GENOFFICE_LANG ?? app.getLocale())
    this.theme = stored.theme ?? 'system'
    setUiLang(this.language)
    nativeTheme.themeSource = this.theme
  }

  getLanguage(): Lang {
    return this.language
  }

  getTheme(): ThemeMode {
    return this.theme
  }

  setLanguage(lang: Lang): void {
    if (lang === this.language) return
    writeWorkspaceSettings(this.options.settingsFile, { language: lang })
    setUiLang(lang)
    this.options.broadcastAll(WORKSPACE_CHANNELS.languageChanged, lang)
  }

  setTheme(mode: ThemeMode): void {
    if (mode === this.theme) return
    this.theme = mode
    writeWorkspaceSettings(this.options.settingsFile, { theme: mode })
    nativeTheme.themeSource = mode
    this.options.broadcastAll(WORKSPACE_CHANNELS.themeChanged, mode)
  }

  /** The bridge the UI tool set drives. */
  ui(): UiBridge {
    return {
      getLanguage: async () => this.language,
      setLanguage: async (locale) => this.setLanguage(normalizeLang(locale)),
      getTheme: async () => this.theme,
      setTheme: async (mode) => this.setTheme(mode),
      togglePanel: async (panel, visible) => {
        this.options.broadcastShell(WORKSPACE_CHANNELS.shellEvent, {
          type: 'ui.changed',
          payload: { panel, visible },
        })
      },
      notify: async (message, level) => {
        this.options.broadcastShell(WORKSPACE_CHANNELS.notify, {
          message,
          level,
        } satisfies NotifyPayload)
      },
    }
  }
}
