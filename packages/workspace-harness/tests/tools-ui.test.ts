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
  root = mkdtempSync(join(tmpdir(), 'workspace-harness-ui-tools-'))
  store = new WorkspaceStore(join(root, 'workspaces'))
  ctx = createFakeContext(store, '写标书')
  h = makeHarness(store, ctx)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ui tool set', () => {
  it('declares the expected names and effects', () => {
    expect(
      h.tools
        .filter((t) => t.set === 'ui')
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      'ui_activate_document',
      'ui_close_document',
      'ui_get_language',
      'ui_get_theme',
      'ui_list_open_documents',
      'ui_notify',
      'ui_open_document',
      'ui_set_language',
      'ui_set_theme',
      'ui_toggle_panel',
    ])
    expect(h.effectOf('ui_set_theme')).toBe('ui_control')
    expect(h.effectOf('ui_get_theme')).toBe('query')
  })

  it('switches language and theme on the shell', async () => {
    await h.call('ui_set_language', { locale: 'en' })
    expect(ctx.ui.language).toBe('en')
    expect((await h.call('ui_get_language')).output).toContain('en')

    await h.call('ui_set_theme', { mode: 'dark' })
    expect(ctx.ui.theme).toBe('dark')
    expect((await h.call('ui_get_theme')).output).toContain('dark')
  })

  it('opens a document and makes it the active one', async () => {
    await h.call('fs_add_document', { type: 'docx', name: '技术方案.docx' })

    const result = await h.call('ui_open_document', { path: '产出/技术方案.docx' })

    const post = result.postState as {
      document: { path: string; readOnly: boolean; active: boolean }
    }
    expect(post.document).toMatchObject({
      path: '产出/技术方案.docx',
      readOnly: false,
      active: true,
    })
  })

  it('always opens a read-only zone document read-only, even without being asked', async () => {
    await h.call('fs_add_document', { type: 'md', name: 'note.md' })
    // Mount a file, then open it through the read-only library zone.
    await h.call('fs_add_reference', {
      externalPath: join(ctx.workspace.dir, '产出', 'note.md'),
    })

    const result = await h.call('ui_open_document', { path: '引用/note.md' })

    const post = result.postState as { document: { readOnly: boolean } }
    expect(post.document.readOnly).toBe(true)
  })

  it('lists, activates and closes open documents', async () => {
    await h.call('fs_add_document', { type: 'docx', name: 'a.docx' })
    await h.call('fs_add_document', { type: 'docx', name: 'b.docx' })
    await h.call('ui_open_document', { path: '产出/a.docx' })
    await h.call('ui_open_document', { path: '产出/b.docx' })

    const listed = await h.call('ui_list_open_documents')
    expect(listed.output).toContain('a.docx')
    expect((listed.postState as { openDocuments: unknown[] }).openDocuments).toHaveLength(2)

    await h.call('ui_activate_document', { id: 'tab-1' })
    expect(ctx.shell.documents.find((d) => d.id === 'tab-1')?.active).toBe(true)

    await h.call('ui_close_document', { id: 'tab-1' })
    expect(ctx.shell.documents.map((d) => d.id)).toEqual(['tab-2'])
  })

  it('reports activating an unknown tab instead of throwing', async () => {
    const result = await h.call('ui_activate_document', { id: 'tab-nope' })
    expect(result.isError).toBe(true)
  })

  it('toggles a panel and notifies the user', async () => {
    await h.call('ui_toggle_panel', { panel: 'fileTree', visible: false })
    expect(ctx.ui.panels.get('fileTree')).toBe(false)

    await h.call('ui_notify', { message: '初稿已保存', level: 'info' })
    expect(ctx.ui.notifications).toEqual([{ message: '初稿已保存', level: 'info' }])
  })
})
