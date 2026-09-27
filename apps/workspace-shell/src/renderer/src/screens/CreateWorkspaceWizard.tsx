import { useCallback, useEffect, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { ModelCatalogue } from '../../../shared/api'
import { ModelPicker } from '../components/ModelPicker'
import { useI18n } from '../locale'
import {
  canAdvance,
  canCreate,
  emptyDraft,
  missingPathCount,
  pathStatus,
  resolvedName,
  WIZARD_STEP_COUNT,
  type PendingPath,
  type WizardDraft,
  type WizardStep,
} from './wizard-steps'

/** The two lists of paths the wizard collects, both of them `PendingPath[]`. */
type PathField = 'references' | 'materials'

interface Props {
  catalogue: ModelCatalogue | null
  /** Resolved by the main process: new workspaces go to `<userData>/workspaces`. */
  defaultParentDir: string
  onCancel: () => void
  /** Created: the wizard reports what failed, the app decides how to show it. */
  onCreated: (id: string, warnings: string[]) => void
}

const LANGS: Lang[] = ['zh', 'en']

const STEP_LABEL = ['stepGoal', 'stepLocation', 'stepModel'] as const

/**
 * Three steps, and nothing is written until the last one.
 *
 * Steps 1 and 2 only collect values, with a live path check on every input, so a
 * mistyped folder is caught before a workspace exists. `创建` writes the
 * workspace, mounts each reference, copies each material and applies the
 * settings; an item that fails is reported and the created workspace is kept,
 * because deleting it would also throw away the items that did succeed.
 */
export function CreateWorkspaceWizard({ catalogue, defaultParentDir, onCancel, onCreated }: Props) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<WizardDraft>(() => emptyDraft(defaultParentDir))
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The folder is resolved by the main process; the draft is built before that
  // answer arrives, so fill it in once rather than baking in a guessed default.
  useEffect(() => {
    if (!defaultParentDir) return
    setDraft((current) =>
      current.parentDir ? current : { ...current, parentDir: defaultParentDir },
    )
  }, [defaultParentDir])

  const patch = useCallback((values: Partial<WizardDraft>): void => {
    setDraft((current) => ({ ...current, ...values }))
  }, [])

  const addPending = useCallback((field: PathField, pending: PendingPath): void => {
    setDraft((current) =>
      field === 'references'
        ? { ...current, references: [...current.references, pending] }
        : { ...current, materials: [...current.materials, pending] },
    )
  }, [])

  const settlePending = useCallback(
    (field: PathField, path: string, check: PendingPath['check']): void => {
      setDraft((current) => {
        const settled = current[field].map((entry) =>
          entry.path === path && !entry.check ? { path, check } : entry,
        )
        return field === 'references'
          ? { ...current, references: settled }
          : { ...current, materials: settled }
      })
    },
    [],
  )

  const removePending = useCallback((field: PathField, path: string): void => {
    setDraft((current) =>
      field === 'references'
        ? { ...current, references: current.references.filter((entry) => entry.path !== path) }
        : { ...current, materials: current.materials.filter((entry) => entry.path !== path) },
    )
  }, [])

  const checkPath = useCallback(
    async (field: PathField, raw: string): Promise<void> => {
      const path = raw.trim()
      if (!path) return
      addPending(field, { path, check: null })
      try {
        settlePending(field, path, await window.workspaceShell.inspectPath(path))
      } catch {
        settlePending(field, path, { exists: false, name: path })
      }
    },
    [addPending, settlePending],
  )

  const create = async (): Promise<void> => {
    setCreating(true)
    setError(null)
    const warnings: string[] = []
    try {
      const created = await window.workspaceShell.createWorkspace({
        goal: draft.goal.trim(),
        name: resolvedName(draft),
        parentDir: draft.parentDir.trim(),
      })
      for (const reference of draft.references) {
        try {
          await window.workspaceShell.addReference(reference.path)
        } catch (err) {
          warnings.push(`${reference.path}: ${messageOf(err)}`)
        }
      }
      for (const material of draft.materials) {
        try {
          await window.workspaceShell.addMaterial(material.path)
        } catch (err) {
          warnings.push(`${material.path}: ${messageOf(err)}`)
        }
      }
      if (draft.agentModel || draft.language) {
        try {
          await window.workspaceShell.setWorkspaceSettings({
            ...(draft.agentModel ? { agentModel: draft.agentModel } : {}),
            ...(draft.language ? { language: draft.language } : {}),
          })
        } catch (err) {
          warnings.push(`${t('stepModel')}: ${messageOf(err)}`)
        }
      }
      onCreated(created.id, warnings)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setCreating(false)
    }
  }

  const step = draft.step
  const missing = missingPathCount(draft)

  return (
    <div className="modal-backdrop" data-testid="wizard">
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('wizardTitle')}>
        <header className="modal-head">
          <h2 className="modal-title">{t('wizardTitle')}</h2>
          <span className="hint" data-testid="wizard-step-counter">
            {t('stepCounter', { current: step + 1, total: WIZARD_STEP_COUNT })}
          </span>
        </header>

        <ol className="wizard-steps">
          {STEP_LABEL.map((key, index) => (
            <li
              key={key}
              className={index === step ? 'wizard-step wizard-step-active' : 'wizard-step'}
              data-testid={`wizard-step-${index + 1}`}
              data-active={index === step ? 'true' : 'false'}
            >
              {t(key)}
            </li>
          ))}
        </ol>

        <div className="modal-body" data-testid={`wizard-body-${step + 1}`}>
          {step === 0 ? (
            <>
              <label className="field">
                <span>{t('goal')}</span>
                <textarea
                  data-testid="wizard-goal"
                  rows={3}
                  value={draft.goal}
                  placeholder={t('goalPlaceholder')}
                  onChange={(event) => patch({ goal: event.target.value })}
                />
              </label>
              <label className="field">
                <span>{t('name')}</span>
                <input
                  data-testid="wizard-name"
                  value={draft.name}
                  placeholder={resolvedName(draft) || t('namePlaceholder')}
                  onChange={(event) => patch({ name: event.target.value })}
                />
              </label>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <label className="field">
                <span>{t('parentDir')}</span>
                <input
                  data-testid="wizard-parent-dir"
                  value={draft.parentDir}
                  onChange={(event) => patch({ parentDir: event.target.value })}
                />
              </label>
              <p className="hint">{t('parentDirHint')}</p>

              <PathList
                title={t('referencesTitle')}
                hint={t('referencesHint')}
                testid="wizard-ref"
                entries={draft.references}
                onAdd={(path) => void checkPath('references', path)}
                onRemove={(path) => removePending('references', path)}
              />
              <PathList
                title={t('materialTitle')}
                hint={t('materialHint')}
                testid="wizard-material"
                entries={draft.materials}
                onAdd={(path) => void checkPath('materials', path)}
                onRemove={(path) => removePending('materials', path)}
              />

              {missing > 0 ? (
                <p className="error" data-testid="wizard-path-error">
                  {t('pathInvalid')}
                </p>
              ) : null}
            </>
          ) : null}

          {step === 2 ? (
            <>
              <ModelPicker
                catalogue={catalogue}
                value={draft.agentModel}
                onChange={(value) => patch({ agentModel: value })}
                testid="wizard"
              />
              <label className="field">
                <span>{t('language')}</span>
                <select
                  data-testid="wizard-language"
                  value={draft.language ?? ''}
                  onChange={(event) =>
                    patch({ language: (event.target.value || null) as Lang | null })
                  }
                >
                  <option value="">{t('followSystem')}</option>
                  {LANGS.map((lang) => (
                    <option key={lang} value={lang}>
                      {lang}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}

          {error ? <p className="error">{error}</p> : null}
        </div>

        <footer className="modal-foot">
          <button
            className="button button-quiet"
            data-testid="wizard-back"
            type="button"
            disabled={step === 0 || creating}
            onClick={() => patch({ step: (step - 1) as WizardStep })}
          >
            {t('prev')}
          </button>
          {step < WIZARD_STEP_COUNT - 1 ? (
            <button
              className="button"
              data-testid="wizard-next"
              type="button"
              disabled={!canAdvance(draft) || creating}
              onClick={() => patch({ step: (step + 1) as WizardStep })}
            >
              {t('next')}
            </button>
          ) : (
            <button
              className="button"
              data-testid="wizard-create"
              type="button"
              disabled={!canCreate(draft) || creating}
              onClick={() => void create()}
            >
              {t('create')}
            </button>
          )}
          <button
            className="button button-quiet"
            data-testid="wizard-cancel"
            type="button"
            disabled={creating}
            onClick={onCancel}
          >
            {t('cancel')}
          </button>
        </footer>
      </div>
    </div>
  )
}

interface PathListProps {
  title: string
  hint: string
  testid: string
  entries: PendingPath[]
  onAdd: (path: string) => void
  onRemove: (path: string) => void
}

/** One list of paths with a live check per entry; step 2 uses it twice. */
function PathList({ title, hint, testid, entries, onAdd, onRemove }: PathListProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')

  return (
    <section className="path-list" data-testid={testid}>
      <h3 className="path-list-title">{title}</h3>
      <p className="hint">{hint}</p>
      <div className="form-inline">
        <input
          data-testid={`${testid}-path`}
          value={draft}
          placeholder={t('pathPlaceholder')}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          className="button button-quiet"
          data-testid={`${testid}-add`}
          type="button"
          disabled={!draft.trim()}
          onClick={() => {
            onAdd(draft)
            setDraft('')
          }}
        >
          {t('add')}
        </button>
      </div>
      <ul className="path-rows">
        {entries.map((entry) => {
          const status = pathStatus(entry)
          const check = entry.check
          const state =
            status === 'unknown'
              ? t('pathChecking')
              : status === 'missing'
                ? `✗ ${t('pathMissing')}`
                : check?.kind === 'dir'
                  ? `✓ ${t('pathDirOk', { count: check.entries ?? 0 })}`
                  : `✓ ${t('pathFileOk')}`
          return (
            <li
              key={entry.path}
              className="path-row"
              data-testid={`${testid}-item`}
              data-path={entry.path}
              data-status={status}
            >
              <span className="path-row-name" title={entry.path}>
                {entry.path}
              </span>
              <span className={status === 'missing' ? 'path-state path-state-bad' : 'path-state'}>
                {state}
              </span>
              <button
                className="link link-danger"
                type="button"
                onClick={() => onRemove(entry.path)}
              >
                {t('remove')}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
