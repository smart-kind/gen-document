import { useCallback, useEffect, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { ReferenceInfo } from '@genoffice/workspace-harness'
import type { ModelCatalogue, TreeEntry, WorkspaceSnapshot } from '../../../shared/api'
import { ModelPicker } from './ModelPicker'
import { useI18n } from '../locale'

interface Props {
  snapshot: WorkspaceSnapshot
  catalogue: ModelCatalogue | null
  onClose: () => void
  /** Anything changed on disk: the workspace screen re-reads its zones. */
  onChanged: () => void
}

const LANGS: Lang[] = ['zh', 'en']

/**
 * Everything configurable about one workspace, in one place.
 *
 * Goal, name, model and language are workspace fields; references and material
 * are the two read-only input zones, and both are edited as explicit user
 * actions here rather than by the agent — the tool layer refuses to write either
 * zone, so mounting and copying are the only way in.
 */
export function WorkspaceSettingsDialog({ snapshot, catalogue, onClose, onChanged }: Props) {
  const { t } = useI18n()
  const workspace = snapshot.workspace

  const [name, setName] = useState(workspace.name)
  const [goal, setGoal] = useState(workspace.goal)
  const [language, setLanguage] = useState<string>(workspace.manifest.settings.language ?? '')
  const [agentModel, setAgentModel] = useState(workspace.manifest.settings.agentModel ?? null)

  const [references, setReferences] = useState<ReferenceInfo[]>(snapshot.references)
  const [material, setMaterial] = useState<TreeEntry[]>([])
  const [referenceDraft, setReferenceDraft] = useState('')
  const [materialDraft, setMaterialDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The demo workspace serves no goal, so an empty goal is only an error when
  // there was one before; clearing a goal is never a valid edit.
  const goalMissing = goal.trim() === '' && workspace.goal.trim() !== ''

  const fail = useCallback((err: unknown): void => {
    setError(err instanceof Error ? err.message : String(err))
  }, [])

  const reloadMaterial = useCallback(async (): Promise<void> => {
    try {
      const groups = await window.workspaceShell.listZones()
      setMaterial(groups.find((group) => group.zone === 'material')?.entries ?? [])
    } catch (err) {
      fail(err)
    }
  }, [fail])

  const reloadReferences = useCallback(async (): Promise<void> => {
    try {
      setReferences(await window.workspaceShell.listReferences())
    } catch (err) {
      fail(err)
    }
  }, [fail])

  useEffect(() => {
    void reloadMaterial()
  }, [reloadMaterial])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await window.workspaceShell.setWorkspaceSettings({
        ...(goal.trim() ? { goal: goal.trim() } : {}),
        name,
        language: (language || null) as Lang | null,
        agentModel,
      })
      setSaving(false)
      onChanged()
      onClose()
    } catch (err) {
      setSaving(false)
      fail(err)
    }
  }

  return (
    <div className="modal-backdrop" data-testid="settings-dialog">
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('settingsTitle')}>
        <header className="modal-head">
          <h2 className="modal-title">{t('settingsTitle')}</h2>
          <button
            className="icon-button"
            data-testid="settings-close"
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="modal-body">
          <label className="field">
            <span>{t('name')}</span>
            <input
              data-testid="settings-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field">
            <span>{t('goal')}</span>
            <textarea
              data-testid="settings-goal"
              rows={2}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
            />
          </label>
          {goalMissing ? <p className="hint hint-warn">{t('goalRequired')}</p> : null}

          <ModelPicker
            catalogue={catalogue}
            value={agentModel}
            onChange={setAgentModel}
            testid="settings"
          />

          <label className="field">
            <span>{t('language')}</span>
            <select
              data-testid="settings-language"
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
            >
              <option value="">{t('followSystem')}</option>
              {LANGS.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
          </label>

          <section className="path-list">
            <h3 className="path-list-title">{t('referencesSettings')}</h3>
            <ul className="path-rows">
              {references.map((reference) => (
                <li key={reference.link} className="path-row" data-testid="settings-reference-item">
                  <span className="path-row-name" title={reference.target}>
                    {reference.name}
                  </span>
                  {reference.available ? null : (
                    <span className="path-state">✗ {t('missing')}</span>
                  )}
                  <button
                    className="link link-danger"
                    data-testid="settings-reference-remove"
                    type="button"
                    onClick={() => {
                      void window.workspaceShell
                        .removeReference(reference.name)
                        .then(reloadReferences)
                        .then(onChanged)
                        .catch(fail)
                    }}
                  >
                    {t('remove')}
                  </button>
                </li>
              ))}
            </ul>
            <div className="form-inline">
              <input
                data-testid="settings-reference-path"
                value={referenceDraft}
                placeholder={t('pathPlaceholder')}
                onChange={(event) => setReferenceDraft(event.target.value)}
              />
              <button
                className="button button-quiet"
                data-testid="settings-reference-add"
                type="button"
                disabled={!referenceDraft.trim()}
                onClick={() => {
                  const path = referenceDraft.trim()
                  setReferenceDraft('')
                  void window.workspaceShell
                    .addReference(path)
                    .then(reloadReferences)
                    .then(onChanged)
                    .catch(fail)
                }}
              >
                {t('mountReference')}
              </button>
            </div>
          </section>

          <section className="path-list">
            <h3 className="path-list-title">{t('materialSettings')}</h3>
            <ul className="path-rows">
              {material.map((entry) => (
                <li key={entry.path} className="path-row" data-testid="settings-material-item">
                  <span className="path-row-name" title={entry.path}>
                    {entry.name}
                  </span>
                  <button
                    className="link link-danger"
                    data-testid="settings-material-remove"
                    type="button"
                    onClick={() => {
                      void window.workspaceShell
                        .removeMaterial(entry.name)
                        .then(reloadMaterial)
                        .then(onChanged)
                        .catch(fail)
                    }}
                  >
                    {t('remove')}
                  </button>
                </li>
              ))}
            </ul>
            <div className="form-inline">
              <input
                data-testid="settings-material-path"
                value={materialDraft}
                placeholder={t('pathPlaceholder')}
                onChange={(event) => setMaterialDraft(event.target.value)}
              />
              <button
                className="button button-quiet"
                data-testid="settings-material-add"
                type="button"
                disabled={!materialDraft.trim()}
                onClick={() => {
                  const path = materialDraft.trim()
                  setMaterialDraft('')
                  void window.workspaceShell
                    .addMaterial(path)
                    .then(reloadMaterial)
                    .then(onChanged)
                    .catch(fail)
                }}
              >
                {t('addMaterial')}
              </button>
            </div>
          </section>

          {error ? <p className="error">{error}</p> : null}
        </div>

        <footer className="modal-foot">
          <button
            className="button"
            data-testid="settings-save"
            type="button"
            disabled={saving || goalMissing}
            onClick={() => void save()}
          >
            {t('save')}
          </button>
          <button className="button button-quiet" type="button" onClick={onClose}>
            {t('cancel')}
          </button>
        </footer>
      </div>
    </div>
  )
}
