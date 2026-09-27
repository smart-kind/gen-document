import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  composeToolSets,
  createFileSystemToolSet,
  toAgentTools,
  type OpenDocument,
  type ShellBridge,
  type UiBridge,
  type VersionBridge,
} from '@genoffice/workspace-harness'
import { createAgentToolSets } from '../src/main/tool-wiring'
import { WorkspaceService } from '../src/main/workspace-service'

/**
 * Tool wiring: the exact composition AgentService builds per prompt, executed
 * against a real workspace. This catches the integration mistakes a unit test of
 * either side alone would miss — a bridge that cannot serve a tool, a tool that
 * bypasses `saveWorkspace`, or a read-only path that opens writable.
 */

const openedDocuments: string[] = []
const openDocumentOptions: Array<{ readOnly?: boolean }> = []

function shellBridge(): ShellBridge {
  return {
    openDocument: async (path, options): Promise<OpenDocument> => {
      openedDocuments.push(path)
      openDocumentOptions.push(options ?? {})
      return {
        id: `tab-${openedDocuments.length}`,
        path,
        type: 'md',
        title: path,
        active: true,
        readOnly: options?.readOnly === true,
      }
    },
    closeDocument: async () => {},
    activateDocument: async () => {},
    listOpenDocuments: async () => [],
    openWorkspace: async () => {},
  }
}

const uiBridge = (): UiBridge => ({
  getLanguage: async () => 'en',
  setLanguage: async () => {},
  getTheme: async () => 'system',
  setTheme: async () => {},
  togglePanel: async () => {},
  notify: async () => {},
})

const versionBridge: VersionBridge = { enabled: () => false }

let root: string
let workspaceDir: string
let service: WorkspaceService

function toolFor(name: string) {
  const tools = composeToolSets(service.buildContext(), createAgentToolSets(service.registry))
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return { tool, ctx: service.buildContext() }
}

beforeEach(() => {
  openedDocuments.length = 0
  openDocumentOptions.length = 0
  root = mkdtempSync(join(tmpdir(), 'ws-tools-'))
  service = new WorkspaceService({
    root,
    activeIdFile: join(root, 'active.json'),
    bridges: () => ({ ui: uiBridge(), shell: shellBridge(), vcs: versionBridge }),
  })
  workspaceDir = service.create({ goal: 'wire the tools' }).dir
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('agent tool wiring', () => {
  it('composes the four sets without a duplicate tool name', () => {
    const tools = composeToolSets(service.buildContext(), createAgentToolSets(service.registry))
    expect(tools.length).toBeGreaterThan(20)
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length)
    expect(tools.map((tool) => tool.name)).toContain('fs_add_document')
    // The two workflows' own tools are in the set the agent really runs with.
    expect(tools.map((tool) => tool.name)).toContain('doc_read_blocks')
    expect(tools.map((tool) => tool.name)).toContain('fs_write_text')
  })

  it('creates a document on disk and registers it in the manifest', async () => {
    const { tool, ctx } = toolFor('fs_add_document')
    const result = await tool.execute(ctx, { type: 'md', name: 'plan.md' })

    expect(result.isError).toBeUndefined()
    expect(result.output).toContain('产出/plan.md')
    expect(readFileSync(join(workspaceDir, '产出', 'plan.md'), 'utf8')).toContain('# plan')
    // saveWorkspace went through the store, so a fresh open sees the document
    expect(
      service.registry.open(service.current()!.id)?.manifest.documents.map((d) => d.path),
    ).toEqual(['产出/plan.md'])
  })

  it('opens a writable document read-write and a read-only zone document read-only', async () => {
    writeFileSync(join(workspaceDir, '产出', 'plan.md'), '# plan\n', 'utf8')

    const writable = toolFor('ui_open_document')
    await writable.tool.execute(writable.ctx, { path: '产出/plan.md' })
    expect(openedDocuments[0]).toBe('产出/plan.md')
    expect(openDocumentOptions[0]).toEqual({ readOnly: false })

    const shared = join(root, 'shared.md')
    writeFileSync(shared, 'shared', 'utf8')
    symlinkSync(shared, join(workspaceDir, '引用', 'shared.md'))

    const readOnly = toolFor('ui_open_document')
    await readOnly.tool.execute(readOnly.ctx, { path: '引用/shared.md' })
    expect(openDocumentOptions[1]).toEqual({ readOnly: true })
  })

  it('hands a refused write into the mount back to the model as a tool error', async () => {
    // Through the agent wrapper: `assertWritable` throws, and the wrapper turns
    // that into a recoverable tool result instead of ending the turn.
    const ctx = service.buildContext()
    const tools = toAgentTools(composeToolSets(ctx, [createFileSystemToolSet()]), () => ctx)
    const addDocument = tools.find((tool) => tool.name === 'fs_add_document')!
    const result = await addDocument.execute('call-1', {
      type: 'md',
      name: 'x.md',
      dir: '引用',
    })

    expect(result.details.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/read-only/)
  })

  it('lists the workspace tree through the same rules as the file tree', async () => {
    const { tool, ctx } = toolFor('fs_list')
    const result = await tool.execute(ctx, {})
    expect(result.output).toContain('引用')
    const postState = result.postState as { entries: Array<{ path: string; readOnly: boolean }> }
    expect(postState.entries.find((entry) => entry.path === '引用')?.readOnly).toBe(true)
    expect(postState.entries.find((entry) => entry.path === '资料')?.readOnly).toBe(true)
    expect(postState.entries.find((entry) => entry.path === '产出')?.readOnly).toBe(false)
  })

  it('reports the current workspace through workspace_describe', async () => {
    const { tool, ctx } = toolFor('workspace_describe')
    const result = await tool.execute(ctx, {})
    expect(result.output).toContain('wire the tools')
  })

  it('deletes nothing without confirmation', async () => {
    const add = toolFor('fs_add_document')
    await add.tool.execute(add.ctx, { type: 'md', name: 'plan.md' })

    const del = toolFor('fs_delete')
    const refused = await del.tool.execute(del.ctx, { path: '产出/plan.md' })
    expect(refused.display?.kind).toBe('confirm')
    expect(refused.mutated).toBeUndefined()
  })

  it('switches the shell language through the UI bridge', async () => {
    const setLanguage = vi.fn(async () => {})
    const uiService = new WorkspaceService({
      root,
      activeIdFile: join(root, 'active2.json'),
      bridges: () => ({
        ui: { ...uiBridge(), setLanguage },
        shell: shellBridge(),
        vcs: versionBridge,
      }),
    })
    uiService.create({ goal: 'ui bridge' })
    const tools = composeToolSets(uiService.buildContext(), createAgentToolSets(uiService.registry))
    const tool = tools.find((candidate) => candidate.name === 'ui_set_language')!
    const result = await tool.execute(uiService.buildContext(), { locale: 'zh-CN' })

    expect(setLanguage).toHaveBeenCalledWith('zh-CN')
    expect(result.summary).toContain('zh-CN')
  })
})
