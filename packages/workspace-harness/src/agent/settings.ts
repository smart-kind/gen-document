import { join } from 'node:path'
import {
  activeProvider,
  defaultAiSettings,
  maxOutputTokensOf,
  resolveAiSettings,
  type AiProviderConfig,
  type AiProviderId,
  type AiSettings,
} from '@genoffice/ai-provider'
import { readJsonFile } from '../workspace/json-file.js'

/** Provider settings file shared with the editor apps. */
export const AI_SETTINGS_FILE = 'ai-settings.json'

/**
 * Read the shared provider settings.
 *
 * The harness reuses the file the editor apps already write, so a provider
 * configured once works everywhere and no provider catalogue has to be
 * migrated.
 */
export function readAiSettings(userDataPath: string): AiSettings {
  const stored = readJsonFile<Partial<AiSettings>>(join(userDataPath, AI_SETTINGS_FILE))
  return resolveAiSettings(stored ?? {}, defaultAiSettings())
}

export interface ProviderRouting {
  provider: AiProviderId
  config: AiProviderConfig
  maxTokens: number
}

/** Pick the provider a request should go to, or undefined when none is usable. */
export function resolveRouting(settings: AiSettings): ProviderRouting | undefined {
  const provider = activeProvider(settings)
  const config = settings.providers[provider]
  if (!config || !config.model) return undefined
  return { provider, config, maxTokens: maxOutputTokensOf(settings) }
}
