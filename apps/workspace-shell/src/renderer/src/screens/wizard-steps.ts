import type { Lang } from '@genoffice/i18n'
import type { InspectPathResult } from '../../../shared/api'

/**
 * Wizard rules, kept free of React so the step gate can be unit-tested.
 *
 * The wizard writes nothing until the last step: steps 1 and 2 only collect
 * values and check paths, and `create` is the single write. A path that does not
 * exist is refused rather than silently skipped — a workspace whose declared
 * inputs are missing would be worse than one that was never created.
 */

export type WizardStep = 0 | 1 | 2

export const WIZARD_STEP_COUNT = 3

/** A path the user has added, with what the live check last said about it. */
export interface PendingPath {
  path: string
  /** Null while the check is still running. */
  check: InspectPathResult | null
}

export interface WizardDraft {
  step: WizardStep
  goal: string
  name: string
  parentDir: string
  references: PendingPath[]
  materials: PendingPath[]
  /** Null means "follow the global settings". */
  agentModel: { provider: string; model: string } | null
  /** Null means "follow the system locale". */
  language: Lang | null
}

export function emptyDraft(parentDir: string): WizardDraft {
  return {
    step: 0,
    goal: '',
    name: '',
    parentDir,
    references: [],
    materials: [],
    agentModel: null,
    language: null,
  }
}

/** Workspace name the harness will end up using when the field is left blank. */
export function resolvedName(draft: WizardDraft): string {
  return draft.name.trim() || draft.goal.trim().slice(0, 60)
}

/** A path check that failed, or a check that has not come back yet. */
export function pathStatus(pending: PendingPath): 'unknown' | 'ok' | 'missing' {
  if (!pending.check) return 'unknown'
  return pending.check.exists ? 'ok' : 'missing'
}

function pathsAcceptable(paths: readonly PendingPath[]): boolean {
  return paths.every((pending) => pathStatus(pending) !== 'missing')
}

/** Whether the current step's requirements are met, so `下一步` may be pressed. */
export function canAdvance(draft: WizardDraft): boolean {
  switch (draft.step) {
    case 0:
      return draft.goal.trim().length > 0
    case 1:
      return (
        draft.parentDir.trim().length > 0 &&
        pathsAcceptable(draft.references) &&
        pathsAcceptable(draft.materials)
      )
    case 2:
      // Model and language are optional: both fall back to the app settings.
      return true
  }
}

/** Whether `创建` may be pressed: every step, not just the visible one. */
export function canCreate(draft: WizardDraft): boolean {
  return ([0, 1, 2] as WizardStep[]).every((step) => canAdvance({ ...draft, step }))
}

/** How many of the pending paths name something that is not there. */
export function missingPathCount(draft: WizardDraft): number {
  return [...draft.references, ...draft.materials].filter(
    (pending) => pathStatus(pending) === 'missing',
  ).length
}
