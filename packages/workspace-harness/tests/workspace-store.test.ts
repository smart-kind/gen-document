import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { documentsInZone } from '../src/workspace/documents.js'
import { manifestPath } from '../src/workspace/manifest.js'
import { WorkspaceStore } from '../src/workspace/store.js'
import type { DocumentEntry, WorkspaceManifest } from '../src/workspace/types.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-harness-store-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceStore.create', () => {
  it('lays out the folder and writes a manifest', () => {
    const store = new WorkspaceStore(join(root, 'workspaces'))
    const ws = store.create({ goal: '编写 XX 医院综合楼技术标书', name: '医院投标' })

    expect(ws.name).toBe('医院投标')
    for (const zone of ['引用', '资料', '产出', '意见']) {
      expect(existsSync(join(ws.dir, zone)), zone).toBe(true)
    }
    expect(existsSync(join(ws.dir, '.workspace'))).toBe(true)
    expect(existsSync(join(ws.dir, '.gitignore'))).toBe(true)

    const onDisk = JSON.parse(readFileSync(manifestPath(ws.dir), 'utf8')) as WorkspaceManifest
    expect(onDisk.schemaVersion).toBe(1)
    expect(onDisk.id).toBe(ws.id)
    expect(onDisk.goal).toBe('编写 XX 医院综合楼技术标书')
    expect(onDisk.documents).toEqual([])
    expect(onDisk.references).toEqual([])
    expect(onDisk.vcs.branch).toBe('main')
    expect(onDisk.demo).toBeUndefined()
  })

  it('defaults the name to the goal', () => {
    const store = new WorkspaceStore(join(root, 'workspaces'))
    const ws = store.create({ goal: '季度工作计划' })
    expect(ws.name).toBe('季度工作计划')
  })

  it('rejects an empty goal', () => {
    const store = new WorkspaceStore(join(root, 'workspaces'))
    expect(() => store.create({ goal: '   ' })).toThrow(/goal/)
    expect(() => store.create({ goal: '   ', demo: false })).toThrow(/goal/)
  })

  it('creates inside an explicit parent directory', () => {
    const store = new WorkspaceStore(join(root, 'workspaces'))
    const parent = join(root, 'elsewhere')
    const ws = store.create({ goal: 'g', parentDir: parent })
    expect(ws.dir.startsWith(parent)).toBe(true)
    expect(existsSync(ws.dir)).toBe(true)
  })

  it('lets the demo workspace start without a goal', () => {
    const store = new WorkspaceStore(join(root, 'workspaces'))
    const ws = store.create({ goal: '', demo: true, name: '示例空间' })

    expect(ws.goal).toBe('')
    expect(ws.manifest.demo).toBe(true)
    expect(ws.name).toBe('示例空间')

    const onDisk = JSON.parse(readFileSync(manifestPath(ws.dir), 'utf8')) as WorkspaceManifest
    expect(onDisk.demo).toBe(true)
    expect(onDisk.goal).toBe('')
    // Reopening keeps the flag, and absence of it reads as false.
    expect(store.open(ws.id)?.manifest.demo).toBe(true)
  })
})

describe('documentsInZone', () => {
  it('selects the registered documents that sit in one zone', () => {
    const store = new WorkspaceStore(join(root, 'workspaces'))
    const ws = store.create({ goal: 'g' })
    const doc = (id: string, path: string): DocumentEntry => ({
      id,
      path,
      type: 'md',
      addedAt: 'now',
      source: { kind: 'new' },
    })
    ws.manifest.documents = [
      doc('d1', '产出/a.md'),
      doc('d2', '意见/b.md'),
      doc('d3', '产出/子/c.md'),
    ]

    expect(documentsInZone(ws, 'output').map((d) => d.id)).toEqual(['d1', 'd3'])
    expect(documentsInZone(ws, 'feedback').map((d) => d.id)).toEqual(['d2'])
    expect(documentsInZone(ws, 'library')).toEqual([])
    expect(documentsInZone(ws, 'material')).toEqual([])
  })
})

describe('WorkspaceStore registry', () => {
  it('lists, reopens and updates what it created', () => {
    const store = new WorkspaceStore(join(root, 'workspaces'))
    const created = store.create({ goal: '初始目标' })

    expect(store.list().map((w) => w.id)).toEqual([created.id])
    expect(store.list()[0]?.available).toBe(true)
    expect(store.open(created.id)?.goal).toBe('初始目标')

    const updated = store.update(created.id, { goal: '改后的目标', name: '改后名字' })
    expect(updated.goal).toBe('改后的目标')
    expect(store.open(created.id)?.name).toBe('改后名字')
    expect(store.list()[0]?.goal).toBe('改后的目标')
  })

  it('returns undefined for an unknown workspace', () => {
    const store = new WorkspaceStore(join(root, 'workspaces'))
    expect(store.open('ws-nope')).toBeUndefined()
    expect(() => store.update('ws-nope', { goal: 'g' })).toThrow(/unknown workspace/)
  })

  it('reports a moved folder as unavailable instead of dropping it', () => {
    const store = new WorkspaceStore(join(root, 'workspaces'))
    const created = store.create({ goal: 'g' })
    rmSync(created.dir, { recursive: true, force: true })

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]?.available).toBe(false)
    expect(store.open(created.id)).toBeUndefined()
  })
})

describe('WorkspaceStore.remove', () => {
  it('deletes the folder and the index entry', () => {
    const store = new WorkspaceStore(join(root, 'workspaces'))
    const created = store.create({ goal: 'g' })

    store.remove(created.id)

    expect(existsSync(created.dir)).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('will not delete a folder that no longer reads as a workspace', () => {
    const store = new WorkspaceStore(join(root, 'workspaces'))
    const created = store.create({ goal: 'g' })
    // Simulate a hand-edited or moved index entry: the manifest is gone, so the
    // folder is no longer provably ours and must survive.
    rmSync(manifestPath(created.dir), { force: true })

    store.remove(created.id)

    expect(existsSync(created.dir)).toBe(true)
    expect(store.list()).toEqual([])
  })

  it('rejects an unknown workspace', () => {
    const store = new WorkspaceStore(join(root, 'workspaces'))
    expect(() => store.remove('ws-nope')).toThrow(/unknown workspace/)
  })
})
