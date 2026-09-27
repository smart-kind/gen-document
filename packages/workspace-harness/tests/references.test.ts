import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReferenceStore } from '../src/workspace/references.js'
import { WorkspaceStore } from '../src/workspace/store.js'
import type { WorkspaceHandle } from '../src/workspace/types.js'

let root: string
let store: WorkspaceStore
let ws: WorkspaceHandle
let library: string

function referenceStore(): ReferenceStore {
  return new ReferenceStore(ws, (handle) => store.save(handle))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-harness-refs-'))
  store = new WorkspaceStore(join(root, 'workspaces'))
  ws = store.create({ goal: '写标书' })
  library = join(root, 'library')
  mkdirSync(join(library, '公司资质'), { recursive: true })
  writeFileSync(join(library, '公司资质', '营业执照.txt'), 'v1', 'utf8')
  writeFileSync(join(library, '年度汇报.pptx'), 'ppt-bytes', 'utf8')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ReferenceStore.add', () => {
  it('mounts a symlink and records it in the manifest', () => {
    const refs = referenceStore()
    const info = refs.add(join(library, '公司资质'))

    expect(info.name).toBe('公司资质')
    expect(info.link).toBe('引用/公司资质')
    expect(info.kind).toBe('dir')
    expect(info.readOnly).toBe(true)
    expect(existsSync(join(ws.dir, '引用', '公司资质'))).toBe(true)

    const onDisk = JSON.parse(readFileSync(join(ws.dir, '.workspace', 'manifest.json'), 'utf8'))
    expect(onDisk.references).toHaveLength(1)
    expect(onDisk.references[0].target).toBe(join(library, '公司资质'))
  })

  it('honours an explicit mount name', () => {
    const refs = referenceStore()
    const info = refs.add(join(library, '年度汇报.pptx'), '旧汇报')
    expect(info.name).toBe('旧汇报')
    expect(info.link).toBe('引用/旧汇报')
    expect(info.kind).toBe('file')
  })

  it('exposes the latest source content through the link', () => {
    const refs = referenceStore()
    refs.add(join(library, '公司资质'))
    const viaLink = join(ws.dir, '引用', '公司资质', '营业执照.txt')
    expect(readFileSync(viaLink, 'utf8')).toBe('v1')

    // The mount is a link, so an update to the shared source is visible at once.
    writeFileSync(join(library, '公司资质', '营业执照.txt'), 'v2', 'utf8')
    expect(readFileSync(viaLink, 'utf8')).toBe('v2')
  })

  it('rejects a missing source', () => {
    expect(() => referenceStore().add(join(library, 'nope'))).toThrow(/does not exist/)
  })

  it('rejects a duplicate mount name', () => {
    const refs = referenceStore()
    refs.add(join(library, '公司资质'))
    expect(() => refs.add(join(library, '公司资质'))).toThrow(/already mounted/)
  })

  it('rejects a name containing a path separator', () => {
    const refs = referenceStore()
    expect(() => refs.add(join(library, '公司资质'), '../escape')).toThrow(/path separators/)
  })
})

describe('ReferenceStore.list', () => {
  it('reports availability and size', () => {
    const refs = referenceStore()
    refs.add(join(library, '年度汇报.pptx'))
    const [entry] = refs.list()
    expect(entry?.available).toBe(true)
    expect(entry?.kind).toBe('file')
    expect(entry?.size).toBe('ppt-bytes'.length)
  })

  it('marks a mount whose target moved as missing', () => {
    const refs = referenceStore()
    refs.add(join(library, '年度汇报.pptx'))
    rmSync(join(library, '年度汇报.pptx'), { force: true })

    const [entry] = refs.list()
    expect(entry?.available).toBe(false)
    expect(entry?.kind).toBe('missing')
  })
})

describe('ReferenceStore.remove', () => {
  it('unmounts the link and leaves the source untouched', () => {
    const refs = referenceStore()
    refs.add(join(library, '公司资质'))

    const removed = refs.remove('公司资质')

    expect(removed.link).toBe('引用/公司资质')
    expect(existsSync(join(ws.dir, '引用', '公司资质'))).toBe(false)
    expect(existsSync(join(library, '公司资质', '营业执照.txt'))).toBe(true)
    expect(refs.list()).toEqual([])
  })

  it('accepts either the name or the link path', () => {
    const refs = referenceStore()
    refs.add(join(library, '年度汇报.pptx'))
    expect(refs.remove('引用/年度汇报.pptx').name).toBe('年度汇报.pptx')
  })

  it('rejects an unknown reference', () => {
    expect(() => referenceStore().remove('nope')).toThrow(/no such reference/)
  })

  it('refuses to remove real content that is not a symlink', () => {
    const refs = referenceStore()
    const info = refs.add(join(library, '公司资质'))
    // Replace the mount with a real directory: removing it would delete data
    // that no longer belongs to the reference library.
    rmSync(join(ws.dir, info.link), { force: true })
    mkdirSync(join(ws.dir, info.link), { recursive: true })
    writeFileSync(join(ws.dir, info.link, 'real.txt'), 'mine', 'utf8')

    expect(() => refs.remove('公司资质')).toThrow(/not a symlink/)
    expect(existsSync(join(ws.dir, info.link, 'real.txt'))).toBe(true)
  })
})
