import { describe, expect, it } from 'vitest'
import {
  assertSafeEntryName,
  expandUserPath,
  metaDir,
  normalizeRel,
  resolveInside,
  toWorkspaceRel,
} from '../src/workspace/paths.js'

const ROOT = '/tmp/ws-example'

describe('resolveInside', () => {
  it('resolves a path inside the workspace', () => {
    expect(resolveInside(ROOT, '产出/技术方案.docx')).toBe(`${ROOT}/产出/技术方案.docx`)
  })

  it('resolves the root itself for "."', () => {
    expect(resolveInside(ROOT, '.')).toBe(ROOT)
  })

  it('rejects traversal above the workspace root', () => {
    expect(() => resolveInside(ROOT, '../outside.docx')).toThrow(/escapes the workspace root/)
    expect(() => resolveInside(ROOT, 'a/../../outside.docx')).toThrow(/escapes/)
  })

  it('rejects an absolute path that leaves the workspace', () => {
    expect(() => resolveInside(ROOT, '/etc/passwd')).toThrow(/escapes/)
  })

  it('catches a traversal disguised as a zone path', () => {
    // The zone check and the workspace boundary are two separate layers:
    // `assertWritable` guards the data boundary, and resolveInside must still
    // stop a path that normalizes out of a zone from leaving the workspace.
    expect(() => resolveInside(ROOT, '产出/../../etc/passwd')).toThrow(/escapes/)
  })
})

describe('normalizeRel', () => {
  it('strips a leading ./ and normalizes separators', () => {
    expect(normalizeRel('./产出/a.md')).toBe('产出/a.md')
    expect(normalizeRel('产出\\a.md')).toBe('产出/a.md')
  })
})

describe('helpers', () => {
  it('builds the bookkeeping directory path', () => {
    expect(metaDir(ROOT)).toBe(`${ROOT}/.workspace`)
  })

  it('expands a leading tilde', () => {
    expect(expandUserPath('~').startsWith('/')).toBe(true)
    expect(expandUserPath('~/Downloads/a.pdf')).not.toContain('~')
    expect(expandUserPath('/abs/a.pdf')).toBe('/abs/a.pdf')
  })

  it('rejects unsafe entry names', () => {
    expect(() => assertSafeEntryName('a/b', 'reference name')).toThrow(/path separators/)
    expect(() => assertSafeEntryName('..', 'reference name')).toThrow(/Invalid/)
    expect(() => assertSafeEntryName('', 'reference name')).toThrow(/Invalid/)
    expect(() => assertSafeEntryName('公司资质', 'reference name')).not.toThrow()
  })

  it('converts an absolute path back to a workspace-relative path', () => {
    expect(toWorkspaceRel(ROOT, `${ROOT}/产出/a.docx`)).toBe('产出/a.docx')
  })
})
