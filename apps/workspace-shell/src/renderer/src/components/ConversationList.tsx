import type { ConversationEntry } from '@genoffice/workspace-harness'
import { useI18n } from '../locale'

interface Props {
  conversations: ConversationEntry[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}

/** One agent per conversation, so this list is the user's task switcher. */
export function ConversationList({ conversations, activeId, onSelect, onCreate, onDelete }: Props) {
  const { t } = useI18n()
  return (
    <section className="panel conversation-panel" data-testid="conversation-list">
      <div className="panel-head">
        <span className="panel-title">{t('conversations')}</span>
        <button className="link" data-testid="new-conversation" type="button" onClick={onCreate}>
          {t('newConversation')}
        </button>
      </div>
      {conversations.length === 0 ? (
        <p className="hint">{t('noConversations')}</p>
      ) : (
        <ul className="list">
          {conversations.map((conversation) => (
            <li key={conversation.id} className="list-item">
              <button
                className={conversation.id === activeId ? 'list-row list-row-active' : 'list-row'}
                type="button"
                onClick={() => onSelect(conversation.id)}
              >
                <span className="list-row-name">{conversation.title}</span>
              </button>
              <button
                className="link link-danger"
                type="button"
                onClick={() => onDelete(conversation.id)}
              >
                {t('deleteConversation')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
