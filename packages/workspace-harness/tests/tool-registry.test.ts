import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from 'typebox'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { composeToolSets, indexTools, type ToolSet } from '../src/tool/registry.js'
import type { AnyHarnessTool, ToolContext, ToolEffect, ToolSetId } from '../src/tool/types.js'
import { WorkspaceStore } from '../src/workspace/store.js'
import { createFakeContext, type FakeContext } from './helpers/fake-context.js'

let root: string
let ctx: FakeContext

function tool(name: string, effect: ToolEffect = 'query'): AnyHarnessTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    set: 'workspace',
    effect,
    execute: async () => ({ output: 'ok' }),
  }
}

function set(
  id: ToolSetId,
  tools: AnyHarnessTool[] | ((ctx: ToolContext) => AnyHarnessTool[]),
): ToolSet {
  return { id, tools: (context) => (typeof tools === 'function' ? tools(context) : tools) }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-harness-registry-'))
  ctx = createFakeContext(new WorkspaceStore(join(root, 'workspaces')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('composeToolSets', () => {
  it('flattens sets in declaration order', () => {
    const composed = composeToolSets(ctx, [
      set('workspace', [tool('workspace_create'), tool('workspace_list')]),
      set('filesystem', [tool('fs_list')]),
    ])
    expect(composed.map((t) => t.name)).toEqual(['workspace_create', 'workspace_list', 'fs_list'])
  })

  it('throws on a duplicate name rather than silently overwriting', () => {
    expect(() =>
      composeToolSets(ctx, [
        set('workspace', [tool('workspace_create')]),
        set('filesystem', [tool('workspace_create')]),
      ]),
    ).toThrow(/duplicate tool name: workspace_create/)
  })

  it('lets a set withhold tools based on the runtime context', () => {
    const contextual = set('document', (context) =>
      context.activeDocument ? [tool('doc_read_blocks')] : [],
    )
    expect(composeToolSets(ctx, [contextual])).toEqual([])

    ctx.activeDocument = {
      id: 'doc-1',
      path: 'a.docx',
      type: 'docx',
      addedAt: '',
      source: { kind: 'new' },
    }
    expect(composeToolSets(ctx, [contextual]).map((t) => t.name)).toEqual(['doc_read_blocks'])
  })
})

describe('indexTools', () => {
  it('maps tool names to their declarations for effect lookup', () => {
    const byName = indexTools([tool('ui_set_theme', 'ui_control'), tool('fs_list', 'query')])
    expect(byName.get('ui_set_theme')?.effect).toBe('ui_control')
    expect(byName.get('fs_list')?.effect).toBe('query')
    expect(byName.get('missing')).toBeUndefined()
  })
})
