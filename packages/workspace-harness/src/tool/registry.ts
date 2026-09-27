import type { AnyHarnessTool, ToolContext, ToolSetId } from './types.js'

export interface ToolSet {
  id: ToolSetId
  /**
   * Computed per prompt, so a set can withhold tools the current runtime cannot
   * serve (for example document tools when no document is open).
   */
  tools(ctx: ToolContext): AnyHarnessTool[]
}

/**
 * Flatten tool sets into one list.
 *
 * Duplicate names throw instead of silently overwriting. Every tool shares a
 * single agent tool list, and the existing codebase already suffers from
 * cross-domain collisions (`apply_ops` meant five different things across
 * apps) — the `<set>_` prefix exists precisely to prevent that, so a collision
 * is a bug worth failing on.
 */
export function composeToolSets(ctx: ToolContext, sets: ToolSet[]): AnyHarnessTool[] {
  const out: AnyHarnessTool[] = []
  const seen = new Set<string>()
  for (const set of sets) {
    for (const tool of set.tools(ctx)) {
      if (seen.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`)
      seen.add(tool.name)
      out.push(tool)
    }
  }
  return out
}

/** Index tools by name for effect lookup during post-call dispatch. */
export function indexTools(tools: AnyHarnessTool[]): Map<string, AnyHarnessTool> {
  const byName = new Map<string, AnyHarnessTool>()
  for (const tool of tools) byName.set(tool.name, tool)
  return byName
}
