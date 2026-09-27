import { composeToolSets, type ToolSet } from '../../src/tool/registry.js'
import type { AnyHarnessTool, ToolContext, ToolEffect, ToolResult } from '../../src/tool/types.js'
import { createDocumentToolSet } from '../../src/tools/document.js'
import { createFileSystemToolSet } from '../../src/tools/filesystem.js'
import { createUiToolSet } from '../../src/tools/ui.js'
import { createWorkspaceToolSet } from '../../src/tools/workspace.js'
import type { WorkspaceStore } from '../../src/workspace/store.js'

export interface Harness {
  tools: AnyHarnessTool[]
  call(name: string, params?: unknown): Promise<ToolResult>
  effectOf(name: string): ToolEffect | undefined
  has(name: string): boolean
}

/** Compose every v1-a tool set over one context, plus small test conveniences. */
export function makeHarness(store: WorkspaceStore, ctx: ToolContext): Harness {
  const sets: ToolSet[] = [
    createWorkspaceToolSet({ store }),
    createFileSystemToolSet(),
    createDocumentToolSet(),
    createUiToolSet(),
  ]
  const tools = composeToolSets(ctx, sets)
  const find = (name: string): AnyHarnessTool => {
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`no such tool: ${name}`)
    return tool
  }
  return {
    tools,
    call: (name, params = {}) => find(name).execute(ctx, params),
    effectOf: (name) => tools.find((t) => t.name === name)?.effect,
    has: (name) => tools.some((t) => t.name === name),
  }
}
