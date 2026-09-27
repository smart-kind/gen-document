import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/workspace/store.js'
import { createFakeContext, type FakeContext } from './helpers/fake-context.js'
import { makeHarness, type Harness } from './helpers/tools.js'

let root: string
let library: string
let store: WorkspaceStore
let ctx: FakeContext
let h: Harness

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-harness-fs-tools-'))
  store = new WorkspaceStore(join(root, 'workspaces'))
  ctx = createFakeContext(store, '写标书')
  h = makeHarness(store, ctx)
  library = join(root, 'library')
  mkdirSync(join(library, '公司资质'), { recursive: true })
  writeFileSync(join(library, '公司资质', '营业执照.txt'), 'v1', 'utf8')
  writeFileSync(join(library, '招标文件.pdf'), '%PDF-1.7 fake', 'utf8')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const abs = (rel: string): string => join(ctx.workspace.dir, rel)

describe('fs_add_document', () => {
  it('declares the file system tool set', () => {
    expect(
      h.tools
        .filter((t) => t.set === 'filesystem')
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      'fs_add_document',
      'fs_add_reference',
      'fs_delete',
      'fs_export',
      'fs_import',
      'fs_list',
      'fs_list_references',
      'fs_move',
      'fs_read_text',
      'fs_remove_reference',
      'fs_rename',
      'fs_write_text',
    ])
    expect(h.effectOf('fs_add_document')).toBe('workspace')
    expect(h.effectOf('fs_read_text')).toBe('query')
  })

  it('creates a real docx package in 产出/ by default and registers it', async () => {
    const result = await h.call('fs_add_document', { type: 'docx', name: '技术方案.docx' })

    expect(result.mutated).toBe(true)
    expect(readFileSync(abs('产出/技术方案.docx')).subarray(0, 2).toString()).toBe('PK')
    expect(ctx.workspace.manifest.documents.map((d) => d.path)).toEqual(['产出/技术方案.docx'])
    expect(store.open(ctx.workspace.id)?.manifest.documents).toHaveLength(1)
  })

  it('creates xlsx and pptx as packages, and text types as text', async () => {
    await h.call('fs_add_document', { type: 'pptx', name: '演示稿.pptx' })
    await h.call('fs_add_document', { type: 'xlsx', name: '报价表.xlsx' })
    await h.call('fs_add_document', { type: 'md', name: '说明.md' })
    await h.call('fs_add_document', { type: 'html', name: '页面.html' })
    await h.call('fs_add_document', { type: 'txt', name: '备注.txt' })

    expect(readFileSync(abs('产出/演示稿.pptx')).subarray(0, 2).toString()).toBe('PK')
    expect(readFileSync(abs('产出/报价表.xlsx')).subarray(0, 2).toString()).toBe('PK')
    expect(readFileSync(abs('产出/说明.md'), 'utf8')).toBe('# 说明\n')
    expect(readFileSync(abs('产出/页面.html'), 'utf8')).toContain('<title>页面</title>')
    expect(readFileSync(abs('产出/备注.txt'), 'utf8')).toBe('')
  })

  it('appends the type extension when the name has none, and honours a subdirectory', async () => {
    await h.call('fs_add_document', { type: 'md', name: '无扩展名', dir: '产出/参考资料' })
    expect(existsSync(abs('产出/参考资料/无扩展名.md'))).toBe(true)
  })

  it('refuses to overwrite an existing file', async () => {
    await h.call('fs_add_document', { type: 'md', name: 'a.md' })
    const again = await h.call('fs_add_document', { type: 'md', name: 'a.md' })
    expect(again.isError).toBe(true)
  })
})

describe('zone permission matrix', () => {
  /** Both read-only zones, with a real file the tools must leave alone. */
  const readOnlyCases = [
    { dir: '引用', file: '引用/文件.md' },
    { dir: '资料', file: '资料/规则.md' },
  ] as const

  it.each(readOnlyCases)('refuses every write tool aimed at $dir/', async ({ dir, file }) => {
    writeFileSync(abs(file), 'authoritative', 'utf8')

    await expect(h.call('fs_add_document', { type: 'md', name: 'x.md', dir })).rejects.toThrow(
      /read-only input zone/,
    )
    await expect(
      h.call('fs_import', { externalPath: join(library, '招标文件.pdf'), destDir: dir }),
    ).rejects.toThrow(/read-only input zone/)
    await expect(h.call('fs_move', { from: file, to: '产出/moved.md' })).rejects.toThrow(
      /read-only input zone/,
    )
    await expect(h.call('fs_rename', { path: file, name: 'renamed.md' })).rejects.toThrow(
      /read-only input zone/,
    )
    await expect(h.call('fs_delete', { path: file, confirm: true })).rejects.toThrow(
      /read-only input zone/,
    )
    await expect(
      h.call('fs_export', { paths: [file], destPath: join(root, 'out') }),
    ).rejects.toThrow(/read-only input zone/)
    await expect(h.call('fs_write_text', { path: file, content: 'intruder' })).rejects.toThrow(
      /read-only input zone/,
    )

    // The refused write changed nothing.
    expect(readFileSync(abs(file), 'utf8')).toBe('authoritative')
    expect(existsSync(join(root, 'out'))).toBe(false)
    expect(existsSync(abs('产出/moved.md'))).toBe(false)
  })

  it('rejects unzoned top-level paths', async () => {
    writeFileSync(abs('notes.md'), 'loose', 'utf8')

    await expect(
      h.call('fs_add_document', { type: 'md', name: 'notes.md', dir: '.' }),
    ).rejects.toThrow(/documents live in/)
    await expect(h.call('fs_move', { from: 'notes.md', to: '产出/notes.md' })).rejects.toThrow(
      /documents live in/,
    )
    await expect(h.call('fs_delete', { path: 'notes.md', confirm: true })).rejects.toThrow(
      /documents live in/,
    )

    expect(readFileSync(abs('notes.md'), 'utf8')).toBe('loose')
  })

  it('accepts both writable zones', async () => {
    await h.call('fs_add_document', { type: 'md', name: 'draft.md', dir: '产出' })
    await h.call('fs_add_document', { type: 'md', name: '审阅.md', dir: '意见' })

    expect(existsSync(abs('产出/draft.md'))).toBe(true)
    expect(existsSync(abs('意见/审阅.md'))).toBe(true)

    // A move straight into the feedback zone also passes the boundary.
    await h.call('fs_move', { from: '产出/draft.md', to: '意见/draft.md' })
    expect(existsSync(abs('意见/draft.md'))).toBe(true)
  })
})

describe('read-only reference mount', () => {
  it('mounts, lists and unmounts a reference without touching the source', async () => {
    const mounted = await h.call('fs_add_reference', {
      externalPath: join(library, '公司资质'),
    })
    expect(mounted.mutated).toBe(true)
    expect(existsSync(abs('引用/公司资质'))).toBe(true)

    const listed = await h.call('fs_list_references')
    expect(listed.output).toContain('引用/公司资质')

    const removed = await h.call('fs_remove_reference', { nameOrPath: '公司资质' })
    expect(removed.mutated).toBe(true)
    expect(existsSync(abs('引用/公司资质'))).toBe(false)
    expect(existsSync(join(library, '公司资质', '营业执照.txt'))).toBe(true)
  })

  it('reads through a mounted reference and reports it read-only', async () => {
    await h.call('fs_add_reference', { externalPath: join(library, '公司资质') })

    const result = await h.call('fs_read_text', { path: '引用/公司资质/营业执照.txt' })

    expect(result.output).toContain('v1')
    expect((result.postState as { readOnly: boolean }).readOnly).toBe(true)
  })
})

describe('fs_import', () => {
  it('copies a file into 产出/ by default and registers it', async () => {
    const result = await h.call('fs_import', { externalPath: join(library, '招标文件.pdf') })

    expect(result.mutated).toBe(true)
    expect(existsSync(abs('产出/招标文件.pdf'))).toBe(true)
    const entry = ctx.workspace.manifest.documents[0]
    expect(entry?.path).toBe('产出/招标文件.pdf')
    expect(entry?.type).toBe('pdf')
    expect(entry?.source).toEqual({ kind: 'imported', from: join(library, '招标文件.pdf') })
  })

  it('copies into an explicit writable directory as a writable copy', async () => {
    await h.call('fs_import', {
      externalPath: join(library, '招标文件.pdf'),
      destDir: '产出/参考资料',
    })

    expect(existsSync(abs('产出/参考资料/招标文件.pdf'))).toBe(true)
    // The copy is writable, unlike a reference mount.
    writeFileSync(abs('产出/参考资料/招标文件.pdf'), 'edited', 'utf8')
    expect(readFileSync(join(library, '招标文件.pdf'), 'utf8')).toBe('%PDF-1.7 fake')
  })

  it('imports a folder and registers the files directly inside it', async () => {
    await h.call('fs_import', { externalPath: join(library, '公司资质'), destDir: '产出' })

    expect(existsSync(abs('产出/公司资质/营业执照.txt'))).toBe(true)
    expect(ctx.workspace.manifest.documents.map((d) => d.path)).toEqual([
      '产出/公司资质/营业执照.txt',
    ])
  })

  it('reports a missing source without throwing', async () => {
    const result = await h.call('fs_import', { externalPath: join(root, 'nope.pdf') })
    expect(result.isError).toBe(true)
  })
})

describe('fs_export', () => {
  it('copies files out and leaves the workspace unchanged', async () => {
    await h.call('fs_add_document', { type: 'docx', name: '技术方案.docx' })
    const dest = join(root, 'exported')

    const result = await h.call('fs_export', {
      paths: ['产出/技术方案.docx'],
      destPath: dest,
    })

    expect(existsSync(join(dest, '技术方案.docx'))).toBe(true)
    expect(result.mutated).toBeFalsy()
    expect(ctx.workspace.manifest.documents).toHaveLength(1)
  })

  it('refuses a format conversion it cannot perform', async () => {
    await h.call('fs_add_document', { type: 'docx', name: '技术方案.docx' })
    const result = await h.call('fs_export', {
      paths: ['产出/技术方案.docx'],
      destPath: join(root, 'exported'),
      format: 'pdf',
    })
    expect(result.isError).toBe(true)
  })
})

describe('fs_move and fs_rename', () => {
  it('moves a folder and repoints every document underneath it', async () => {
    await h.call('fs_add_document', { type: 'md', name: 'a.md', dir: '产出/草稿' })

    const result = await h.call('fs_move', { from: '产出/草稿', to: '产出/归档' })

    expect(result.mutated).toBe(true)
    expect(existsSync(abs('产出/归档/a.md'))).toBe(true)
    expect(ctx.workspace.manifest.documents.map((d) => d.path)).toEqual(['产出/归档/a.md'])
  })

  it('renames in place and repoints the document', async () => {
    await h.call('fs_add_document', { type: 'md', name: 'old.md' })

    await h.call('fs_rename', { path: '产出/old.md', name: 'new.md' })

    expect(existsSync(abs('产出/new.md'))).toBe(true)
    expect(ctx.workspace.manifest.documents.map((d) => d.path)).toEqual(['产出/new.md'])
  })

  it('rejects a rename that carries a directory', async () => {
    await h.call('fs_add_document', { type: 'md', name: 'a.md' })
    const result = await h.call('fs_rename', { path: '产出/a.md', name: 'sub/a.md' })
    expect(result.isError).toBe(true)
  })
})

describe('fs_delete', () => {
  it('requires confirmation, then deletes and deregisters', async () => {
    await h.call('fs_add_document', { type: 'md', name: 'a.md' })

    const refused = await h.call('fs_delete', { path: '产出/a.md' })
    expect(refused.display?.kind).toBe('confirm')
    expect(existsSync(abs('产出/a.md'))).toBe(true)

    const done = await h.call('fs_delete', { path: '产出/a.md', confirm: true })
    expect(done.mutated).toBe(true)
    expect(existsSync(abs('产出/a.md'))).toBe(false)
    expect(ctx.workspace.manifest.documents).toEqual([])
    expect(store.open(ctx.workspace.id)?.manifest.documents).toEqual([])
  })

  it('refuses the workspace root', async () => {
    const result = await h.call('fs_delete', { path: '.', confirm: true })
    expect(result.isError).toBe(true)
  })
})

describe('fs_read_text', () => {
  it('reads a line window and reports the range', async () => {
    writeFileSync(abs('产出/notes.md'), ['a', 'b', 'c', 'd'].join('\n'), 'utf8')

    const result = await h.call('fs_read_text', { path: '产出/notes.md', offset: 2, limit: 2 })

    expect(result.output).toBe('2\tb\n3\tc')
    const post = result.postState as { totalLines: number; truncated: boolean }
    expect(post.totalLines).toBe(4)
    expect(post.truncated).toBe(true)
  })

  it('refuses a non-text file', async () => {
    await h.call('fs_add_document', { type: 'docx', name: 'doc.docx' })
    const result = await h.call('fs_read_text', { path: '产出/doc.docx' })
    expect(result.isError).toBe(true)
  })
})

describe('fs_write_text', () => {
  it('writes a report into 产出/ and registers it with the type from its extension', async () => {
    const result = await h.call('fs_write_text', {
      path: '产出/校验报告-20260927-1412.md',
      content: '## 结论\n\n没有问题。\n',
    })

    expect(result.mutated).toBe(true)
    expect(readFileSync(abs('产出/校验报告-20260927-1412.md'), 'utf8')).toContain('没有问题')
    const post = result.postState as { document: { path: string; type: string }; bytes: number }
    expect(post.document).toMatchObject({ path: '产出/校验报告-20260927-1412.md', type: 'md' })
    expect(post.bytes).toBeGreaterThan(0)
    expect(ctx.workspace.manifest.documents.map((d) => d.path)).toEqual([
      '产出/校验报告-20260927-1412.md',
    ])
    expect(store.open(ctx.workspace.id)?.manifest.documents).toHaveLength(1)
  })

  it('writes into 意见/ and creates a missing parent directory', async () => {
    await h.call('fs_write_text', { path: '意见/20260927/批注.md', content: 'x' })
    expect(existsSync(abs('意见/20260927/批注.md'))).toBe(true)
    expect(ctx.workspace.manifest.documents.map((d) => d.path)).toEqual(['意见/20260927/批注.md'])
  })

  it('honours replace, append and create', async () => {
    const file = '产出/notes.md'
    await h.call('fs_write_text', { path: file, content: 'one\n' })
    await h.call('fs_write_text', { path: file, content: 'two\n', mode: 'append' })
    expect(readFileSync(abs(file), 'utf8')).toBe('one\ntwo\n')

    const refused = await h.call('fs_write_text', { path: file, content: 'three', mode: 'create' })
    expect(refused.isError).toBe(true)
    expect(readFileSync(abs(file), 'utf8')).toBe('one\ntwo\n')

    await h.call('fs_write_text', { path: file, content: 'fresh\n' })
    expect(readFileSync(abs(file), 'utf8')).toBe('fresh\n')
  })

  it('registers a file once and keeps its existing document entry', async () => {
    const file = '产出/报告.md'
    await h.call('fs_write_text', { path: file, content: 'a' })
    await h.call('fs_write_text', { path: file, content: 'b', mode: 'append' })

    const registered = ctx.workspace.manifest.documents.filter((d) => d.path === file)
    expect(registered).toHaveLength(1)
    expect(registered[0]?.type).toBe('md')
  })

  it('refuses an unzoned path outside the four zones', async () => {
    await expect(h.call('fs_write_text', { path: 'notes.md', content: 'x' })).rejects.toThrow(
      /documents live in/,
    )
    expect(existsSync(abs('notes.md'))).toBe(false)
  })
})

describe('fs_list', () => {
  it('marks both read-only zones and open tabs', async () => {
    await h.call('fs_add_reference', { externalPath: join(library, '公司资质') })
    await h.call('fs_add_document', { type: 'docx', name: '技术方案.docx' })
    await h.call('ui_open_document', { path: '产出/技术方案.docx' })

    const post = (await h.call('fs_list')).postState as {
      entries: { path: string; readOnly: boolean }[]
    }

    expect(post.entries.find((e) => e.path === '引用')?.readOnly).toBe(true)
    expect(post.entries.find((e) => e.path === '资料')?.readOnly).toBe(true)
    expect(post.entries.find((e) => e.path === '产出')?.readOnly).toBe(false)
    expect(post.entries.find((e) => e.path === '意见')?.readOnly).toBe(false)
    // Harness bookkeeping is never user-visible content.
    expect(post.entries.some((e) => e.path === '.workspace')).toBe(false)

    const output = (await h.call('fs_list', { dir: '产出' })).postState as {
      entries: { path: string; readOnly: boolean; open?: boolean }[]
    }
    expect(output.entries.find((e) => e.path === '产出/技术方案.docx')).toMatchObject({
      readOnly: false,
      open: true,
    })
  })

  it('hides both read-only zones when includeReadOnly is false', async () => {
    await h.call('fs_add_reference', { externalPath: join(library, '公司资质') })

    const post = (await h.call('fs_list', { includeReadOnly: false })).postState as {
      entries: { path: string }[]
    }

    expect(post.entries.some((e) => e.path === '引用')).toBe(false)
    expect(post.entries.some((e) => e.path === '资料')).toBe(false)
    expect(post.entries.some((e) => e.path === '产出')).toBe(true)
    expect(post.entries.some((e) => e.path === '意见')).toBe(true)
  })
})
