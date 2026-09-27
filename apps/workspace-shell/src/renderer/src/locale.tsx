import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { format, htmlLang, type Lang, type Params } from '@genoffice/i18n'
import { strings, type StringKey } from './strings'

/**
 * App-local i18n over `@genoffice/i18n`.
 *
 * The shared `createI18n` requires every one of the 20 UI languages, and this
 * app ships zh + en; the key set is still defined by the zh dictionary and the
 * en dictionary is compile-time checked against it (`Record<StringKey, string>`).
 */

export type TFunc = (key: StringKey, params?: Params) => string

function translate(lang: Lang, key: StringKey, params?: Params): string {
  const dict = lang === 'zh' || lang === 'zh-TW' ? strings.zh : strings.en
  return format(dict[key] ?? strings.zh[key], params)
}

interface LocaleValue {
  lang: Lang
  setLang: (lang: Lang) => void
}

const LocaleContext = createContext<LocaleValue>({ lang: 'en', setLang: () => {} })

export function LocaleProvider({ initial, children }: { initial: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial)

  // Language changes pushed from the main process: an agent `ui_set_language`
  // call, or a window the user switched.
  useEffect(
    () =>
      window.workspaceShell.onLanguageChanged((next) => {
        document.documentElement.lang = htmlLang(next)
        setLangState(next)
      }),
    [],
  )

  const value = useMemo<LocaleValue>(
    () => ({
      lang,
      setLang: (next) => {
        setLangState(next)
        document.documentElement.lang = htmlLang(next)
        void window.workspaceShell.setLanguage(next)
      },
    }),
    [lang],
  )
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export interface I18n {
  lang: Lang
  setLang: (lang: Lang) => void
  t: TFunc
}

export function useI18n(): I18n {
  const { lang, setLang } = useContext(LocaleContext)
  return { lang, setLang, t: (key, params) => translate(lang, key, params) }
}
