import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isLang, type Lang } from '@genoffice/i18n'
import type { ThemeMode } from '@genoffice/workspace-harness'

/**
 * App-level preferences of the workspace shell.
 *
 * Language and theme live in `<userData>/app-settings.json`, the same file name
 * the other GenOffice apps use, so the editor views embedded here read the same
 * values they would in the unified shell.
 */
export interface WorkspaceAppSettings {
  language?: Lang
  theme?: ThemeMode
}

export function readWorkspaceSettings(file: string): WorkspaceAppSettings {
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as WorkspaceAppSettings
    const out: WorkspaceAppSettings = {}
    if (isLang(raw.language)) out.language = raw.language
    if (raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system')
      out.theme = raw.theme
    return out
  } catch {
    return {}
  }
}

export function writeWorkspaceSettings(file: string, patch: WorkspaceAppSettings): void {
  const next = { ...readWorkspaceSettings(file), ...patch }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    // An unwritable settings file must not break the session; the choice just
    // does not survive a restart.
  }
}
