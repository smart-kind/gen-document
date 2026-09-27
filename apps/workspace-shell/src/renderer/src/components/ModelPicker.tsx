import type { ModelCatalogue } from '../../../shared/api'
import { useI18n } from '../locale'

interface Props {
  catalogue: ModelCatalogue | null
  /** Null means "follow the global settings". */
  value: { provider: string; model: string } | null
  onChange: (value: { provider: string; model: string } | null) => void
  /** Prefix for this instance's `data-testid` hooks. */
  testid: string
}

/**
 * Provider plus model, over the shared provider catalogue.
 *
 * The empty option is not a placeholder: it is the meaningful choice "follow the
 * global settings", which is also what a workspace starts with. Credentials are
 * never chosen here — a workspace stores only ids, and the key stays in the
 * shared settings file.
 */
export function ModelPicker({ catalogue, value, onChange, testid }: Props) {
  const { t } = useI18n()
  const providers = catalogue?.providers ?? []
  const selected = providers.find((provider) => provider.id === value?.provider)

  return (
    <div className="model-picker">
      <label className="field">
        <span>{t('provider')}</span>
        <select
          data-testid={`${testid}-provider`}
          value={value?.provider ?? ''}
          onChange={(event) => {
            const id = event.target.value
            if (!id) {
              onChange(null)
              return
            }
            const meta = providers.find((provider) => provider.id === id)
            onChange({ provider: id, model: meta?.defaultModel ?? '' })
          }}
        >
          <option value="">{t('followGlobal')}</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
      </label>

      {value && selected ? (
        <label className="field">
          <span>{t('model')}</span>
          {selected.models.length > 0 ? (
            <select
              data-testid={`${testid}-model`}
              value={value.model}
              onChange={(event) =>
                onChange({ provider: value.provider, model: event.target.value })
              }
            >
              {selected.models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          ) : (
            // Codex and custom endpoints discover their model list at runtime,
            // so the id is typed rather than picked.
            <input
              data-testid={`${testid}-model`}
              value={value.model}
              onChange={(event) =>
                onChange({ provider: value.provider, model: event.target.value })
              }
            />
          )}
        </label>
      ) : null}

      {value && catalogue && !catalogue.configured.includes(value.provider) ? (
        <p className="hint hint-warn" data-testid={`${testid}-fallback`}>
          {t('modelFallback')}
        </p>
      ) : null}
    </div>
  )
}
