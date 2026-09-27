import React from 'react'
import { createRoot } from 'react-dom/client'
import { htmlLang } from '@genoffice/i18n'
import { App } from './App'
import { LocaleProvider } from './locale'
import '@genoffice/ui/tokens.css'
import './styles.css'

// macOS keeps the window's traffic lights over the content, so the top bar
// reserves room for them (see .topbar in styles.css).
if (navigator.platform.toLowerCase().includes('mac')) document.body.classList.add('mac')

/**
 * Resolve language and theme before the first paint so the window never flashes
 * the wrong theme, then hand the resolved values to the app.
 */
void Promise.all([
  window.workspaceShell.getLanguage().catch(() => 'en' as const),
  window.workspaceShell.getTheme().catch(() => 'system' as const),
]).then(([lang, theme]) => {
  document.documentElement.lang = htmlLang(lang)
  applyTheme(theme)
  window.workspaceShell.onThemeChanged((next) => applyTheme(next))

  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <LocaleProvider initial={lang}>
        <App />
      </LocaleProvider>
    </React.StrictMode>,
  )
})

/** `system` means "no attribute": tokens.css then follows prefers-color-scheme. */
function applyTheme(mode: 'light' | 'dark' | 'system'): void {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', mode)
}
