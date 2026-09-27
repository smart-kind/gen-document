import {
  activeProvider,
  maxOutputTokensOf,
  type AiProviderId,
  type AiSettings,
} from '@genoffice/ai-provider'
import { resolveRouting, type ProviderRouting } from '@genoffice/workspace-harness'

/**
 * Which provider a conversation actually talks to.
 *
 * A workspace may name its own provider and model, but never its own
 * credentials: the API key and base URL stay in the shared `ai-settings.json`,
 * so a key is configured once and no secret is copied into every workspace
 * folder. A workspace override that names a provider the app has no usable
 * config for is ignored rather than failing the prompt, and the settings dialog
 * says so — silently disabling AI would be worse than a documented fallback.
 */

/** Workspace-level model choice; only an id pair, never credentials. */
export interface WorkspaceModelOverride {
  provider: string
  model: string
}

/** Why a workspace override was not used. */
export type ModelFallbackReason = 'provider-unconfigured'

export interface ModelRoutingResult {
  /** Undefined when nothing is usable at all, exactly as the global resolver reports it. */
  routing: ProviderRouting | undefined
  /** Set when a workspace override was dropped in favour of the global routing. */
  fallback?: ModelFallbackReason
}

/** Whether the shared settings hold a usable config for this provider. */
export function isProviderConfigured(settings: AiSettings, provider: string): boolean {
  if (!(provider in settings.providers)) return false
  const target = provider as AiProviderId
  // The provider layer already decides what "usable" means (a key, a base URL,
  // a model id); asking it keeps one definition instead of two.
  return activeProvider({ ...settings, provider: target }) === target
}

/**
 * Resolve the routing for one conversation.
 *
 * Priority: a workspace override whose provider is configured, otherwise the
 * global active provider.
 */
export function resolveWorkspaceRouting(
  settings: AiSettings,
  override?: WorkspaceModelOverride,
): ModelRoutingResult {
  const provider = override?.provider?.trim()
  const model = override?.model?.trim()
  if (provider && model && isProviderConfigured(settings, provider)) {
    const target = provider as AiProviderId
    const config = settings.providers[target]
    return {
      routing: {
        provider: target,
        config: { ...config, model },
        maxTokens: maxOutputTokensOf(settings),
      },
    }
  }
  const routing = resolveRouting(settings)
  return provider && model ? { routing, fallback: 'provider-unconfigured' } : { routing }
}
