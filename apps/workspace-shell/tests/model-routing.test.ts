import { describe, expect, it } from 'vitest'
import { defaultAiSettings } from '@genoffice/ai-provider'
import type { AiSettings } from '@genoffice/ai-provider'
import { isProviderConfigured, resolveWorkspaceRouting } from '../src/main/model-routing'

/**
 * Which provider a conversation uses.
 *
 * The rule this pins down is the whole point of the per-workspace model: a
 * workspace may name a provider and a model, but the credentials stay global, so
 * an override the app cannot serve must degrade to the global routing instead of
 * failing the turn.
 */

function settings(overrides: Partial<AiSettings> = {}): AiSettings {
  const base = defaultAiSettings()
  return {
    ...base,
    provider: 'genspark',
    providers: {
      ...base.providers,
      anthropic: { ...base.providers.anthropic, apiKey: 'sk-anthropic', model: 'claude-opus-4-7' },
    },
    ...overrides,
  }
}

describe('resolveWorkspaceRouting', () => {
  it('uses the workspace provider and model when the global config can serve it', () => {
    const result = resolveWorkspaceRouting(settings(), {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    })
    expect(result.fallback).toBeUndefined()
    expect(result.routing?.provider).toBe('anthropic')
    expect(result.routing?.config.model).toBe('claude-sonnet-4-6')
    // Credentials are never per-workspace: the key comes from the global config.
    expect(result.routing?.config.apiKey).toBe('sk-anthropic')
  })

  it('falls back to the global provider when no workspace override is set', () => {
    const result = resolveWorkspaceRouting(settings())
    expect(result.fallback).toBeUndefined()
    expect(result.routing?.provider).toBe('genspark')
  })

  it('falls back and says why when the workspace names an unconfigured provider', () => {
    // Anthropic exists in the catalogue but has no key in this settings file.
    const result = resolveWorkspaceRouting(defaultAiSettings(), {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    })
    expect(result.fallback).toBe('provider-unconfigured')
    expect(result.routing?.provider).toBe('genspark')
  })

  it('falls back for a provider id the catalogue does not know at all', () => {
    const result = resolveWorkspaceRouting(settings(), {
      provider: 'not-a-provider',
      model: 'some-model',
    })
    expect(result.fallback).toBe('provider-unconfigured')
    expect(result.routing?.provider).toBe('genspark')
  })

  it('ignores an empty override rather than reporting a fallback', () => {
    const result = resolveWorkspaceRouting(settings(), { provider: '', model: '' })
    expect(result.fallback).toBeUndefined()
    expect(result.routing?.provider).toBe('genspark')
  })

  it('answers whether a provider is usable from the shared settings', () => {
    expect(isProviderConfigured(settings(), 'anthropic')).toBe(true)
    expect(isProviderConfigured(defaultAiSettings(), 'anthropic')).toBe(false)
    expect(isProviderConfigured(defaultAiSettings(), 'genspark')).toBe(true)
  })
})
