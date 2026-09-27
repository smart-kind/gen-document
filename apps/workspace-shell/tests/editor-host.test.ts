import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { editorKindForPath, isReadOnlyPath, tabTitleFor } from '../src/main/editor-tabs'
import { listTreeEntries } from '../src/main/file-tree'
import { appendTranscript, readTranscript, sessionPath } from '../src/main/agent-service'
import {
  CHAT_PANEL_WIDTH,
  editorBounds,
  LEFT_RAIL_WIDTH,
  normalizeInsets,
  TOP_BAR_HEIGHT,
  workspaceInsets,
} from '../src/shared/layout'

/**
 * The editor-host rules the main process decides from: which editor serves a
 * path, where its view may paint, and whether it is read-only. These live in a
 * module without Electron imports so they can be tested directly; the tab pool
 * itself needs a real WebContentsView and is exercised by the app.
 */

let workspaceDir: string

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'ws-editor-'))
  mkdirSync(join(workspaceDir, '引用'), { recursive: true })
  mkdirSync(join(workspaceDir, '资料'), { recursive: true })
})

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true })
})

describe('editorKindForPath', () => {
  it('routes each supported extension to its editor app', () => {
    expect(editorKindForPath('plan.docx')).toBe('docs')
    expect(editorKindForPath('budget.XLSX')).toBe('sheets')
    expect(editorKindForPath('deck.pptx')).toBe('slides')
    expect(editorKindForPath('tender.pdf')).toBe('pdf')
    expect(editorKindForPath('notes.md')).toBe('markdown')
    expect(editorKindForPath('page.html')).toBe('html')
  })

  it('returns null for paths no editor can render', () => {
    expect(editorKindForPath('archive.zip')).toBeNull()
    expect(editorKindForPath('LICENSE')).toBeNull()
  })

  it('titles a tab with the bare file name', () => {
    expect(tabTitleFor('sub/dir/bid.docx')).toBe('bid.docx')
  })
})

describe('window layout', () => {
  it('insets the editor area by the rail, the chat column and the top bar', () => {
    expect(editorBounds({ width: 1440, height: 920 }, workspaceInsets(true))).toEqual({
      x: LEFT_RAIL_WIDTH,
      y: TOP_BAR_HEIGHT,
      width: 1440 - LEFT_RAIL_WIDTH - CHAT_PANEL_WIDTH,
      height: 920 - TOP_BAR_HEIGHT,
    })
  })

  it('gives the chat column width back to the editor when it is collapsed', () => {
    const size = { width: 1440, height: 920 }
    const shown = editorBounds(size, workspaceInsets(true))
    const hidden = editorBounds(size, workspaceInsets(false))
    expect(shown.x).toBe(hidden.x)
    expect(shown.y).toBe(hidden.y)
    expect(workspaceInsets(false).right).toBe(0)
    expect(hidden.width - shown.width).toBe(CHAT_PANEL_WIDTH)
  })

  it('never covers the rail for a window narrower than the chrome', () => {
    const bounds = editorBounds({ width: 200, height: 100 }, workspaceInsets(true))
    expect(bounds.x).toBe(LEFT_RAIL_WIDTH)
    expect(bounds.width).toBe(0)
    expect(bounds.height).toBe(Math.max(0, 100 - TOP_BAR_HEIGHT))
  })

  it('accepts explicit insets so callers can offset different chrome', () => {
    expect(editorBounds({ width: 1000, height: 800 }, { left: 100, right: 50, top: 50 })).toEqual({
      x: 100,
      y: 50,
      width: 850,
      height: 750,
    })
  })

  it('coerces an untrusted insets payload instead of trusting it', () => {
    expect(normalizeInsets({ left: 240.4, right: -5, top: Number.NaN })).toEqual({
      left: 240,
      right: 0,
      top: 0,
    })
    expect(normalizeInsets(undefined)).toEqual({ left: 0, right: 0, top: 0 })
    expect(normalizeInsets('nonsense')).toEqual({ left: 0, right: 0, top: 0 })
  })
})

describe('isReadOnlyPath', () => {
  it('forces read-only for both input zones and everything under them', () => {
    expect(isReadOnlyPath('引用')).toBe(true)
    expect(isReadOnlyPath('引用/公司资质/证书.pdf')).toBe(true)
    expect(isReadOnlyPath('./资料/校验规则.md')).toBe(true)
  })

  it('keeps ordinary workspace paths writable', () => {
    expect(isReadOnlyPath('产出/plan.docx')).toBe(false)
    expect(isReadOnlyPath('意见/review.md')).toBe(false)
    expect(isReadOnlyPath('参考资料/招标文件.pdf')).toBe(false)
    expect(isReadOnlyPath('引用-notes.md')).toBe(false)
  })

  it('cannot un-set read-only, only add to it', () => {
    expect(isReadOnlyPath('产出/plan.docx', true)).toBe(true)
    expect(isReadOnlyPath('资料/校验规则.md', false)).toBe(true)
  })
})

describe('listTreeEntries', () => {
  it('hides bookkeeping directories and marks the input zones read-only', () => {
    mkdirSync(join(workspaceDir, '.workspace'), { recursive: true })
    mkdirSync(join(workspaceDir, '.git'), { recursive: true })
    mkdirSync(join(workspaceDir, '产出'), { recursive: true })
    writeFileSync(join(workspaceDir, '产出', 'plan.docx'), 'x')

    const entries = listTreeEntries(workspaceDir)
    // order between directories depends on locale collation, so assert per name
    expect(entries).toHaveLength(3)
    expect(entries.map((entry) => entry.kind)).toEqual(['dir', 'dir', 'dir'])
    const readOnly = Object.fromEntries(entries.map((entry) => [entry.name, entry.readOnly]))
    expect(readOnly).toEqual({ 引用: true, 资料: true, 产出: false })
    expect(listTreeEntries(workspaceDir, '产出')[0]).toMatchObject({
      name: 'plan.docx',
      type: 'docx',
    })
  })

  it('lists a subdirectory and flags open documents', () => {
    mkdirSync(join(workspaceDir, 'sub'))
    writeFileSync(join(workspaceDir, 'sub', 'a.md'), 'a')
    writeFileSync(join(workspaceDir, 'sub', 'b.md'), 'b')

    const entries = listTreeEntries(workspaceDir, 'sub', ['sub/b.md'])
    expect(entries.map((entry) => entry.path)).toEqual(['sub/a.md', 'sub/b.md'])
    expect(entries.find((entry) => entry.name === 'b.md')?.open).toBe(true)
    expect(entries.find((entry) => entry.name === 'a.md')?.open).toBeUndefined()
  })

  it('refuses a path that escapes the workspace', () => {
    expect(() => listTreeEntries(workspaceDir, '..')).toThrow()
  })
})

describe('conversation transcripts', () => {
  it('appends and reads back entries in order', () => {
    const id = 'conv-1'
    appendTranscript(workspaceDir, id, { role: 'user', text: 'hi', at: 'now' })
    appendTranscript(workspaceDir, id, { role: 'assistant', text: 'hello', at: 'now' })
    appendTranscript(workspaceDir, id, { role: 'tool', text: 'created plan.md', at: 'now' })

    expect(readTranscript(workspaceDir, id).map((entry) => entry.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ])
    expect(sessionPath(workspaceDir, id)).toContain(join('.workspace', 'sessions'))
  })

  it('returns an empty transcript for an unknown conversation', () => {
    expect(readTranscript(workspaceDir, 'conv-missing')).toEqual([])
  })

  it('skips a half-written line instead of failing the whole read', () => {
    appendTranscript(workspaceDir, 'conv-2', { role: 'user', text: 'first', at: 'now' })
    const file = sessionPath(workspaceDir, 'conv-2')
    writeFileSync(file, `${'{"role":"assistant","text":"interrup'}\n`, { flag: 'a' })

    const entries = readTranscript(workspaceDir, 'conv-2')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.text).toBe('first')
  })
})
