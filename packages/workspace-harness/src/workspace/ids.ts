import { randomUUID } from 'node:crypto'

/**
 * Opaque prefixed id, e.g. `doc-1f0c9a7b2d4e6f8a1c3b`.
 *
 * The prefix keeps ids self-describing in logs and tool output without needing
 * a lookup table.
 */
export function newId(prefix: 'ws' | 'doc' | 'conv'): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 20)}`
}
