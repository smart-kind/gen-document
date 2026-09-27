import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertWritable,
  countZoneFiles,
  isMetaPath,
  isReadOnlyPath,
  listZone,
  READ_ONLY_ZONES,
  zoneOf,
  zonePath,
  ZONE_DIRS,
  ZONE_ORDER,
} from '../src/workspace/zones.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-harness-zones-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('zoneOf', () => {
  it('derives the zone from the top-level directory', () => {
    expect(zoneOf('引用')).toBe('library')
    expect(zoneOf('资料')).toBe('material')
    expect(zoneOf('产出')).toBe('output')
    expect(zoneOf('意见')).toBe('feedback')
  })

  it('derives the zone of a nested path from its first segment', () => {
    expect(zoneOf('产出/2026/技术方案.docx')).toBe('output')
    expect(zoneOf('资料/规范/校验规则.md')).toBe('material')
  })

  it('has no zone outside the four directories', () => {
    expect(zoneOf('.workspace/manifest.json')).toBeUndefined()
    expect(zoneOf('notes.md')).toBeUndefined()
    expect(zoneOf('.')).toBeUndefined()
  })

  it('does not confuse a sibling whose name merely starts with a zone name', () => {
    expect(zoneOf('引用-notes.md')).toBeUndefined()
    expect(zoneOf('资料整理/草稿.md')).toBeUndefined()
  })

  it('keeps the declared order and read-only set consistent', () => {
    expect(ZONE_ORDER).toEqual(['library', 'material', 'output', 'feedback'])
    expect(READ_ONLY_ZONES).toEqual(['library', 'material'])
    expect(ZONE_DIRS.output).toBe('产出')
  })

  it('builds absolute zone paths', () => {
    expect(zonePath(root, 'output')).toBe(join(root, ZONE_DIRS.output))
  })
})

describe('isReadOnlyPath', () => {
  it('matches both read-only zones, nested or not', () => {
    expect(isReadOnlyPath('引用')).toBe(true)
    expect(isReadOnlyPath('引用/公司资质/证书.pdf')).toBe(true)
    expect(isReadOnlyPath('资料/校验规则.md')).toBe(true)
    expect(isReadOnlyPath('./资料/校验规则.md')).toBe(true)
  })

  it('does not match the writable zones, bookkeeping or unzoned paths', () => {
    expect(isReadOnlyPath('产出/a.docx')).toBe(false)
    expect(isReadOnlyPath('意见/review.md')).toBe(false)
    expect(isReadOnlyPath('.workspace/manifest.json')).toBe(false)
    expect(isReadOnlyPath('notes.md')).toBe(false)
    expect(isReadOnlyPath('引用-notes.md')).toBe(false)
  })
})

describe('isMetaPath', () => {
  it('matches only the bookkeeping directory', () => {
    expect(isMetaPath('.workspace')).toBe(true)
    expect(isMetaPath('.workspace/sessions/a.jsonl')).toBe(true)
    expect(isMetaPath('.workspace-notes.md')).toBe(false)
    expect(isMetaPath('产出/.workspace')).toBe(false)
  })
})

describe('assertWritable', () => {
  it('accepts the writable zones and harness bookkeeping', () => {
    for (const path of [
      '产出/技术方案.docx',
      '意见/审阅意见.md',
      '.workspace/manifest.json',
      '.workspace/',
    ]) {
      expect(() => assertWritable(path), path).not.toThrow()
    }
  })

  it('rejects both read-only zones', () => {
    for (const path of ['引用', '引用/公司资质/证书.pdf', '资料', '资料/校验规则.md']) {
      const zone = zoneOf(path)
      expect(() => assertWritable(path), path).toThrow(/read-only input zone/)
      expect(READ_ONLY_ZONES).toContain(zone)
    }
  })

  it('rejects the workspace root and unzoned top-level paths', () => {
    for (const path of ['.', '', 'notes.md', '归档/a.md', '引用-notes.md']) {
      expect(() => assertWritable(path), path).toThrow(/documents live in/)
    }
  })
})

describe('listZone and countZoneFiles', () => {
  it('lists top-level entries with read-only flags and sizes', () => {
    mkdirSync(zonePath(root, 'library'), { recursive: true })
    writeFileSync(join(zonePath(root, 'library'), 'a.md'), 'hello', 'utf8')
    mkdirSync(join(zonePath(root, 'output'), 'nested'), { recursive: true })
    writeFileSync(join(zonePath(root, 'output'), 'nested', 'b.md'), 'x', 'utf8')

    const library = listZone(root, 'library')
    expect(library).toEqual([
      { name: 'a.md', path: '引用/a.md', kind: 'file', size: 5, readOnly: true },
    ])

    const output = listZone(root, 'output')
    expect(output.map((entry) => entry.name)).toEqual(['nested'])
    expect(output[0]?.readOnly).toBe(false)
  })

  it('returns an empty listing for a missing zone', () => {
    expect(listZone(root, 'feedback')).toEqual([])
    expect(countZoneFiles(root, 'feedback')).toBe(0)
  })

  it('counts files recursively', () => {
    mkdirSync(join(zonePath(root, 'output'), 'deep'), { recursive: true })
    writeFileSync(join(zonePath(root, 'output'), 'a.md'), 'a', 'utf8')
    writeFileSync(join(zonePath(root, 'output'), 'deep', 'b.md'), 'b', 'utf8')
    expect(countZoneFiles(root, 'output')).toBe(2)
  })
})
