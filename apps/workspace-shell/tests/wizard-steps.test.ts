import { describe, expect, it } from 'vitest'
import {
  canAdvance,
  canCreate,
  emptyDraft,
  missingPathCount,
  pathStatus,
  resolvedName,
  type WizardDraft,
} from '../src/renderer/src/screens/wizard-steps'

/**
 * The wizard's gates.
 *
 * Step 1 and step 2 both have something that must be true before the user may
 * continue, and `创建` needs all of them at once — the wizard writes nothing
 * until then, so a bad step cannot be discovered half-way through creating a
 * workspace.
 */

function draft(values: Partial<WizardDraft> = {}): WizardDraft {
  return { ...emptyDraft('/tmp/workspaces'), ...values }
}

describe('wizard steps', () => {
  it('refuses to advance past the goal step without a goal', () => {
    expect(canAdvance(draft({ step: 0 }))).toBe(false)
    expect(canAdvance(draft({ step: 0, goal: '   ' }))).toBe(false)
    expect(canAdvance(draft({ step: 0, goal: '写一份投标文件' }))).toBe(true)
  })

  it('refuses to advance while a project folder or a mount target does not exist', () => {
    const withBadPath = draft({
      step: 1,
      goal: 'goal',
      references: [{ path: '/nope', check: { exists: false, name: 'nope' } }],
    })
    expect(canAdvance(withBadPath)).toBe(false)
    expect(missingPathCount(withBadPath)).toBe(1)

    const withEmptyParent = draft({ step: 1, goal: 'goal', parentDir: '  ' })
    expect(canAdvance(withEmptyParent)).toBe(false)

    const good = draft({
      step: 1,
      goal: 'goal',
      references: [{ path: '/lib', check: { exists: true, kind: 'dir', name: 'lib', entries: 3 } }],
      materials: [{ path: '/rules.md', check: { exists: true, kind: 'file', name: 'rules.md' } }],
    })
    expect(canAdvance(good)).toBe(true)
  })

  it('treats a check that has not come back yet as not-yet-ok', () => {
    const pending = draft({
      step: 1,
      goal: 'goal',
      references: [{ path: '/lib', check: null }],
    })
    // Not "missing": the step stays available and the row still paints as checking.
    expect(pathStatus(pending.references[0]!)).toBe('unknown')
    expect(canAdvance(pending)).toBe(true)
  })

  it('lets the model step through, because both choices have a default', () => {
    expect(canAdvance(draft({ step: 2 }))).toBe(true)
  })

  it('only allows creating when every step would allow it', () => {
    const goalOnly = draft({ step: 2, goal: 'goal' })
    expect(canCreate(goalOnly)).toBe(true)

    const withBadReference = draft({
      step: 2,
      goal: 'goal',
      references: [{ path: '/nope', check: { exists: false, name: 'nope' } }],
    })
    expect(canAdvance(withBadReference)).toBe(true)
    expect(canCreate(withBadReference)).toBe(false)
    expect(canCreate(draft({ step: 2 }))).toBe(false)
  })

  it('defaults the name to the goal, truncated the way the store does', () => {
    const long = 'x'.repeat(80)
    expect(resolvedName(draft({ goal: long }))).toHaveLength(60)
    expect(resolvedName(draft({ goal: 'goal', name: '  named  ' }))).toBe('named')
  })
})
