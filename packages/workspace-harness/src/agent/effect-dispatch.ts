import type { AfterToolCallContext, AfterToolCallResult } from '@earendil-works/pi-agent-core'
import type { AnyHarnessTool, HarnessEvent, ToolEffect } from '../tool/types.js'
import type { HarnessDetails } from './adapt.js'

/** Coalescing window: a burst of changes collapses into one repaint. */
export const EFFECT_DEBOUNCE_MS = 100

export interface EffectDispatcherOptions {
  toolFor(name: string): AnyHarnessTool | undefined
  emit(event: HarnessEvent): void
  debounceMs?: number
}

export interface EffectDispatcher {
  afterToolCall(
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ): Promise<AfterToolCallResult | undefined>
  /** Deliver any coalesced events immediately. */
  flush(): void
}

/**
 * Turn a tool's declared effect into a UI event.
 *
 * This is where the design's central contract lives: no tool renders anything
 * itself and the model never asks for a repaint. A tool declares its effect and
 * the framework decides who has to refresh.
 */
export function createEffectDispatcher(options: EffectDispatcherOptions): EffectDispatcher {
  const debounceMs = options.debounceMs ?? EFFECT_DEBOUNCE_MS
  const pending = new Map<HarnessEvent['type'], unknown[]>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (pending.size === 0) return
    const batch = [...pending.entries()]
    pending.clear()
    for (const [type, payloads] of batch) {
      options.emit({ type, payload: payloads.length === 1 ? payloads[0] : payloads })
    }
  }

  const queue = (type: HarnessEvent['type'], payload: unknown): void => {
    const list = pending.get(type)
    if (list) list.push(payload)
    else pending.set(type, [payload])
    if (timer === undefined) {
      timer = setTimeout(flush, debounceMs)
      // Emitting a repaint must never hold the host process open.
      timer.unref?.()
    }
  }

  return {
    flush,
    async afterToolCall(context, signal) {
      const details = context.result.details as HarnessDetails | undefined
      const effect = details?.effect ?? options.toolFor(context.toolCall.name)?.effect
      const eventType = effect ? EVENT_TYPE[effect] : undefined
      if (eventType) queue(eventType, payloadFor(eventType, context, details))

      // An aborted run still has to show what already changed.
      if (signal?.aborted) flush()

      // A harness-level failure becomes a tool error so the loop can react to it
      // the same way it reacts to a provider-reported failure.
      return details?.isError ? { isError: true } : undefined
    },
  }
}

const EVENT_TYPE: Record<ToolEffect, HarnessEvent['type'] | undefined> = {
  query: undefined,
  mutation: 'document.changed',
  ui_control: 'ui.changed',
  workspace: 'workspace.changed',
}

function payloadFor(
  type: HarnessEvent['type'],
  context: AfterToolCallContext,
  details: HarnessDetails | undefined,
): Record<string, unknown> {
  const toolName = context.toolCall.name
  if (type === 'document.changed') {
    const documentId = readDocumentId(details?.postState)
    return {
      toolName,
      ...(documentId ? { documentId } : {}),
      postState: details?.postState,
    }
  }
  if (type === 'workspace.changed') {
    return { kind: toolName, postState: details?.postState }
  }
  return { what: toolName, value: details?.postState }
}

/** Mutation postState carries the affected document; lift its id into the event. */
function readDocumentId(postState: unknown): string | undefined {
  if (!postState || typeof postState !== 'object') return undefined
  const document = (postState as { document?: { id?: unknown } }).document
  return typeof document?.id === 'string' ? document.id : undefined
}
