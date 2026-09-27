import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MaterialStore } from '../src/workspace/material.js'
import { WorkspaceStore } from '../src/workspace/store.js'

let root: string
let owner: string
let workspaceDir: string

const materials = (): MaterialStore => new MaterialStore(workspaceDir)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-harness-material-'))
  workspaceDir = new WorkspaceStore(join(root, 'workspaces')).create({ goal: '写标书' }).dir
  owner = join(root, 'owner')
  mkdirSync(owner, { recursive: true })
  writeFileSync(join(owner, '需求.md'), '需求内容', 'utf8')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('MaterialStore.add', () => {
  it('copies the file into 资料/ and reports it', () => {
    const entry = materials().add(join(owner, '需求.md'))

    expect(entry).toEqual({ name: '需求.md', path: '资料/需求.md', kind: 'file', readOnly: true })
    expect(readFileSync(join(workspaceDir, '资料', '需求.md'), 'utf8')).toBe('需求内容')
  })

  it('honours an explicit name', () => {
    const entry = materials().add(join(owner, '需求.md'), '业主需求.md')
    expect(entry.path).toBe('资料/业主需求.md')
    expect(existsSync(join(workspaceDir, '资料', '业主需求.md'))).toBe(true)
  })

  it('copies a folder recursively', () => {
    mkdirSync(join(owner, '规范'))
    writeFileSync(join(owner, '规范', '校验.md'), '规则', 'utf8')

    const entry = materials().add(join(owner, '规范'))

    expect(entry.kind).toBe('dir')
    expect(readFileSync(join(workspaceDir, '资料', '规范', '校验.md'), 'utf8')).toBe('规则')
  })

  it('rejects a missing source', () => {
    expect(() => materials().add(join(owner, 'nope.md'))).toThrow(/does not exist/)
  })

  it('rejects a duplicate name', () => {
    materials().add(join(owner, '需求.md'))
    expect(() => materials().add(join(owner, '需求.md'))).toThrow(/already exists/)
  })

  it('rejects a name containing a path separator', () => {
    expect(() => materials().add(join(owner, '需求.md'), '../escape')).toThrow(/path separators/)
  })
})

describe('MaterialStore.list', () => {
  it('reports the copied item as the inventory', () => {
    materials().add(join(owner, '需求.md'))
    expect(materials().list()).toEqual([
      {
        name: '需求.md',
        path: '资料/需求.md',
        kind: 'file',
        size: Buffer.byteLength('需求内容'),
        readOnly: true,
      },
    ])
  })

  it('is empty before anything is copied', () => {
    expect(materials().list()).toEqual([])
  })
})

describe('MaterialStore.remove', () => {
  it('deletes the copy and leaves the source untouched', () => {
    materials().add(join(owner, '需求.md'))

    expect(materials().remove('需求.md')).toBe('资料/需求.md')

    expect(existsSync(join(workspaceDir, '资料', '需求.md'))).toBe(false)
    expect(readFileSync(join(owner, '需求.md'), 'utf8')).toBe('需求内容')
  })

  it('accepts the zone-relative path too', () => {
    materials().add(join(owner, '需求.md'))
    expect(materials().remove('资料/需求.md')).toBe('资料/需求.md')
  })

  it('refuses an unknown name', () => {
    expect(() => materials().remove('nope.md')).toThrow(/no such material/)
  })
})
