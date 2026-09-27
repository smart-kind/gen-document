import { useState } from 'react'
import { useI18n } from '../locale'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'error'
  text: string
}

interface Props {
  messages: ChatMessage[]
  busy: boolean
  disabled: boolean
  onSend: (text: string) => void
  onStop: () => void
}

/**
 * The conversation the agent actually runs in.
 *
 * Assistant text streams in as it is produced; tool activity is a one-line
 * summary taken from the tool result's `details.summary`, which is the design's
 * single channel for "what the framework just did".
 */
export function ChatPanel({ messages, busy, disabled, onSend, onStop }: Props) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')

  const send = (): void => {
    const text = draft.trim()
    if (!text || disabled) return
    onSend(text)
    setDraft('')
  }

  return (
    <section className="chat" data-testid="chat">
      <div className="chat-log" data-testid="chat-log">
        {messages.length === 0 ? (
          <p className="hint">{t('emptyChat')}</p>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`bubble bubble-${message.role}`}>
              {message.text}
            </div>
          ))
        )}
        {busy ? <div className="bubble bubble-tool">{t('working')}</div> : null}
      </div>
      <div className="chat-compose">
        <textarea
          data-testid="chat-input"
          rows={3}
          value={draft}
          placeholder={t('composerPlaceholder')}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
        />
        <div className="form-actions">
          <button
            className="button"
            data-testid="chat-send"
            type="button"
            disabled={disabled || !draft.trim()}
            onClick={send}
          >
            {t('send')}
          </button>
          <button className="button button-quiet" type="button" disabled={!busy} onClick={onStop}>
            {t('stop')}
          </button>
        </div>
      </div>
    </section>
  )
}
