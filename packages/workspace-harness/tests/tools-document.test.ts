import { buildBlankDocx, parseDocx, saveDocx, type SaveBlock } from '@genoffice/docx-engine'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/workspace/store.js'
import { createFakeContext, type FakeContext } from './helpers/fake-context.js'
import { makeHarness, type Harness } from './helpers/tools.js'

/**
 * doc_read_blocks: reading a document's real content without a renderer.
 *
 * The .docx side is exercised against a package this test builds, saves and
 * re-reads with the docx engine — the same round trip the demo workspace uses.
 */

const HEADING = '示例技术说明'
const PARAGRAPHS = ['第一段正文', '第二段正文', '第三段正文']

let root: string
let store: WorkspaceStore
let ctx: FakeContext
let h: Harness

const abs = (rel: string): string => join(ctx.workspace.dir, rel)

async function writeDocx(rel: string, title: string, paragraphs: string[]): Promise<void> {
  const parsed = await parseDocx(await buildBlankDocx())
  const blocks: SaveBlock[] = [
    { kind: 'generated', block: { type: 'heading', level: 1, runs: [{ text: title }] } },
    ...paragraphs.map((text): SaveBlock => ({
      kind: 'generated',
      block: { type: 'paragraph', runs: [{ text }] },
    })),
  ]
  writeFileSync(abs(rel), Buffer.from(await saveDocx(parsed, blocks)))
}

interface ReadPostState {
  path: string
  zone?: string
  format: string
  totalBlocks: number
  returnedRange: { start: number; end: number }
  truncated: boolean
  outline: { block: number; level?: number; text: string }[]
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'workspace-harness-doc-tools-'))
  store = new WorkspaceStore(join(root, 'workspaces'))
  ctx = createFakeContext(store, '校验产出')
  h = makeHarness(store, ctx)
  await writeDocx('产出/技术说明.docx', HEADING, PARAGRAPHS)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('doc_read_blocks', () => {
  it('declares itself as a read-only document tool', () => {
    const declared = h.tools.find((tool) => tool.name === 'doc_read_blocks')
    expect(declared?.set).toBe('document')
    expect(h.effectOf('doc_read_blocks')).toBe('query')
  })

  it('reads a real .docx as a numbered block list with an outline', async () => {
    const result = await h.call('doc_read_blocks', { path: '产出/技术说明.docx' })

    expect(result.isError).toBeUndefined()
    const lines = result.output.split('\n')
    expect(lines[0]).toContain('1\theading')
    expect(lines[0]).toContain(HEADING)
    expect(lines[1]).toContain(`2\tparagraph\t${PARAGRAPHS[0]}`)
    expect(result.output).toContain(PARAGRAPHS[2])

    const post = result.postState as ReadPostState
    expect(post.path).toBe('产出/技术说明.docx')
    expect(post.zone).toBe('output')
    expect(post.format).toBe('docx')
    expect(post.totalBlocks).toBe(4)
    expect(post.returnedRange).toEqual({ start: 1, end: 4 })
    expect(post.truncated).toBe(false)
    expect(post.outline).toEqual([{ block: 1, level: 1, text: HEADING }])
  })

  it('truncates to the requested window and reports it', async () => {
    const result = await h.call('doc_read_blocks', {
      path: '产出/技术说明.docx',
      offset: 3,
      limit: 1,
    })

    expect(result.output).toBe(`3\tparagraph\t${PARAGRAPHS[1]}`)
    const post = result.postState as ReadPostState
    expect(post.totalBlocks).toBe(4)
    expect(post.returnedRange).toEqual({ start: 3, end: 3 })
    expect(post.truncated).toBe(true)
  })

  it('says so when the window is past the end of the document', async () => {
    const result = await h.call('doc_read_blocks', { path: '产出/技术说明.docx', offset: 50 })

    expect(result.output).toContain('no block in that range')
    expect((result.postState as ReadPostState).truncated).toBe(false)
  })

  it.each(['pdf', 'pptx'])('refuses a .%s with a clear reason', async (ext) => {
    writeFileSync(abs(`产出/文件.${ext}`), 'not readable here', 'utf8')

    const result = await h.call('doc_read_blocks', { path: `产出/文件.${ext}` })

    expect(result.isError).toBe(true)
    expect(result.output).toContain(`产出/文件.${ext}`)
    expect(result.output).toMatch(/cannot be read yet/)
  })

  it('reads a markdown file line by line, with its headings as an outline', async () => {
    writeFileSync(abs('资料/规则.md'), '# 规则\n\n1. 要写日期\n2. 要写金额\n', 'utf8')

    const result = await h.call('doc_read_blocks', { path: '资料/规则.md', offset: 3, limit: 2 })

    expect(result.output).toBe('3\t1. 要写日期\n4\t2. 要写金额')
    const post = result.postState as ReadPostState
    // Reads are allowed in a read-only zone: only writes are restricted.
    expect(post.zone).toBe('material')
    expect(post.format).toBe('md')
    expect(post.totalBlocks).toBe(5)
    expect(post.truncated).toBe(true)
    expect(post.outline).toEqual([{ block: 1, level: 1, text: '规则' }])
  })

  it('reports a missing file and an unreadable format without pretending', async () => {
    const missing = await h.call('doc_read_blocks', { path: '产出/没有这个.docx' })
    expect(missing.isError).toBe(true)

    await h.call('fs_write_text', { path: '产出/数据.json', content: '{}' })
    const unsupported = await h.call('doc_read_blocks', { path: '产出/数据.json' })
    expect(unsupported.isError).toBe(true)
    expect(unsupported.output).toMatch(/cannot be read yet/)
  })
})
