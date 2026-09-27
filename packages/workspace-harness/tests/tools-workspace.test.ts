import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/workspace/store.js'
import { createFakeContext, type FakeContext } from './helpers/fake-context.js'
import { makeHarness, type Harness } from './helpers/tools.js'

let root: string
let store: WorkspaceStore
let ctx: FakeContext
let h: Harness

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-harness-ws-tools-'))
  store = new WorkspaceStore(join(root, 'workspaces'))
  ctx = createFakeContext(store, '写标书')
  h = makeHarness(store, ctx)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('workspace tool set', () => {
  it('declares the expected names and effects', () => {
    expect(
      h.tools
        .filter((t) => t.set === 'workspace')
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      'workspace_create',
      'workspace_delete',
      'workspace_describe',
      'workspace_get_settings',
      'workspace_list',
      'workspace_open',
      'workspace_set_settings',
      'workspace_update',
    ])
    expect(h.effectOf('workspace_create')).toBe('workspace')
    expect(h.effectOf('workspace_list')).toBe('query')
    expect(h.effectOf('workspace_set_settings')).toBe('workspace')
  })

  it('creates a workspace and returns it as postState', async () => {
    const result = await h.call('workspace_create', {
      goal: '编写 XX 医院综合楼投标文件',
      name: '医院投标',
    })

    expect(result.isError).toBeFalsy()
    expect(result.mutated).toBe(true)
    const post = result.postState as { workspace: { id: string; name: string; dir: string } }
    expect(post.workspace.name).toBe('医院投标')
    expect(store.list().map((w) => w.id)).toContain(post.workspace.id)
  })

  it('lists workspaces and flags a folder that disappeared', async () => {
    await h.call('workspace_create', { goal: 'g', name: 'A' })
    rmSync(ctx.workspace.dir, { recursive: true, force: true })

    const result = await h.call('workspace_list')

    expect(result.output).toContain('folder missing')
  })

  it('switches the shell to another workspace', async () => {
    const created = await h.call('workspace_create', { goal: '另一个目标' })
    const id = (created.postState as { workspace: { id: string } }).workspace.id

    const result = await h.call('workspace_open', { id })

    expect(result.isError).toBeFalsy()
    expect(ctx.shell.openedWorkspaces).toEqual([id])
  })

  it('rejects opening an unknown workspace without throwing', async () => {
    const result = await h.call('workspace_open', { id: 'ws-nope' })
    expect(result.isError).toBe(true)
  })

  it('describes the current workspace with its documents and references', async () => {
    await h.call('fs_add_document', { type: 'docx', name: '技术方案.docx' })

    const result = await h.call('workspace_describe')
    const post = result.postState as {
      workspace: {
        documents: unknown[]
        zones: { library: number; material: number; output: number; feedback: number }
      }
      conversations: unknown[]
    }

    expect(result.output).toContain('documents: 1')
    expect(post.workspace.documents).toHaveLength(1)
    // The new document landed in the output zone, so its count reflects it.
    expect(post.workspace.zones).toEqual({ library: 0, material: 0, output: 1, feedback: 0 })
    expect(post.conversations).toEqual([])
  })

  it('updates goal and name', async () => {
    const result = await h.call('workspace_update', { goal: '新目标', name: '新名字' })

    expect(result.mutated).toBe(true)
    expect(ctx.workspace.goal).toBe('新目标')
    expect(store.open(ctx.workspace.id)?.name).toBe('新名字')
  })

  it('applies language and theme to the running UI', async () => {
    const result = await h.call('workspace_set_settings', { language: 'en', theme: 'dark' })

    expect(result.mutated).toBe(true)
    // The bridge is what actually changes the shell.
    expect(ctx.ui.language).toBe('en')
    expect(ctx.ui.theme).toBe('dark')
    // The workspace copy survives for the next launch.
    expect(ctx.workspace.manifest.settings).toMatchObject({ language: 'en', theme: 'dark' })
    expect(store.open(ctx.workspace.id)?.manifest.settings.theme).toBe('dark')
  })

  it('reports the current settings', async () => {
    const result = await h.call('workspace_get_settings')
    expect(result.output).toContain('settings')
    expect((result.postState as { settings: { autoSave: boolean } }).settings.autoSave).toBe(true)
  })

  it('persists the agent model and returns it in postState', async () => {
    const agentModel = { provider: 'anthropic', model: 'claude-sonnet-4' }

    const result = await h.call('workspace_set_settings', { agentModel })

    expect(result.mutated).toBe(true)
    const post = result.postState as {
      workspace: { settings: { agentModel?: typeof agentModel } }
    }
    expect(post.workspace.settings.agentModel).toEqual(agentModel)
    expect(ctx.workspace.manifest.settings.agentModel).toEqual(agentModel)
    expect(store.open(ctx.workspace.id)?.manifest.settings.agentModel).toEqual(agentModel)
  })

  it('reads the agent model back', async () => {
    await h.call('workspace_set_settings', {
      agentModel: { provider: 'openai', model: 'gpt-5' },
    })

    const result = await h.call('workspace_get_settings')

    expect(
      (result.postState as { settings: { agentModel?: unknown } }).settings.agentModel,
    ).toEqual({ provider: 'openai', model: 'gpt-5' })
  })

  it('requires confirmation before deleting, then deletes', async () => {
    const created = await h.call('workspace_create', { goal: '临时', name: '临时' })
    const id = (created.postState as { workspace: { id: string } }).workspace.id

    const refused = await h.call('workspace_delete', { id })
    expect(refused.mutated).toBeFalsy()
    expect(refused.display?.kind).toBe('confirm')
    expect(store.open(id)).toBeDefined()

    const done = await h.call('workspace_delete', { id, confirm: true })
    expect(done.mutated).toBe(true)
    expect(store.open(id)).toBeUndefined()
  })
})
