import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceService } from '../src/main/workspace-service'
import { buildWorkflowInstruction } from '../src/main/workflows'

/**
 * The two workflow instructions.
 *
 * Both are built from the live zone contents, so these tests run against a
 * real workspace folder with real files in it: what the instruction names is
 * what a validation or summarising run will actually read.
 */

let root: string
let service: WorkspaceService

const STAMPED = new Date(2026, 8, 27, 14, 12)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-shell-workflows-'))
  service = new WorkspaceService({
    root,
    activeIdFile: join(root, 'active.json'),
    bridges: () => {
      throw new Error('the workflow builder must not need a bridge')
    },
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('校验产出 instruction', () => {
  it('lists the real rule files and produced documents, and a stamped report path', () => {
    const workspace = service.create({ goal: '校验一下' })
    writeFileSync(join(workspace.dir, '资料', '业主需求.md'), '# 要求\n', 'utf8')
    writeFileSync(join(workspace.dir, '资料', '校验规则.md'), '# 规则\n', 'utf8')
    writeFileSync(join(workspace.dir, '产出', '投标文件.docx'), 'PK', 'utf8')
    writeFileSync(join(workspace.dir, '意见', '批阅.md'), '- 意见一\n', 'utf8')

    const built = buildWorkflowInstruction(workspace, 'validate', STAMPED)

    expect(built.kind).toBe('validate')
    expect(built.outputPath).toBe('产出/校验报告-20260927-1412.md')
    expect(built.instruction).toContain('资料/业主需求.md')
    expect(built.instruction).toContain('资料/校验规则.md')
    expect(built.instruction).toContain('产出/投标文件.docx')
    expect(built.instruction).toContain(built.outputPath)
    expect(built.instruction).toContain('doc_read_blocks')
    expect(built.instruction).toContain('fs_write_text')
    // Validation reads rules and output only; the feedback zone is not its input.
    expect(built.instruction).not.toContain('意见/批阅.md')
    // And it must leave the read-only inputs alone.
    expect(built.instruction).toContain('只读')
  })

  it('says an empty zone is empty instead of leaving the list blank', () => {
    const workspace = service.create({ goal: '空空间' })

    const built = buildWorkflowInstruction(workspace, 'validate', STAMPED)

    expect(built.instruction).toContain('资料/ 下没有找到规则文件')
    expect(built.instruction).toContain('不要凭空编造')
  })

  it('counts the files that live in subdirectories', () => {
    const workspace = service.create({ goal: '深层产出' })
    mkdirSync(join(workspace.dir, '产出', '参考资料'), { recursive: true })
    writeFileSync(join(workspace.dir, '产出', '参考资料', '附件.md'), '# 附件\n', 'utf8')

    const built = buildWorkflowInstruction(workspace, 'validate', STAMPED)

    expect(built.instruction).toContain('产出/参考资料/（目录）')
    expect(built.instruction).toContain('另有 1 个在子目录里')
  })
})

describe('汇总意见 instruction', () => {
  it('lists the real opinion files and produced documents, and keeps 意见/ read-only', () => {
    const workspace = service.create({ goal: '汇总一下' })
    writeFileSync(join(workspace.dir, '资料', '校验规则.md'), '# 规则\n', 'utf8')
    writeFileSync(join(workspace.dir, '意见', '批阅一.md'), '- 报价偏高\n', 'utf8')
    writeFileSync(join(workspace.dir, '意见', '批阅二.md'), '- 缺进度安排\n', 'utf8')
    writeFileSync(join(workspace.dir, '产出', '投标文件.docx'), 'PK', 'utf8')

    const built = buildWorkflowInstruction(workspace, 'summarize', STAMPED)

    expect(built.kind).toBe('summarize')
    expect(built.outputPath).toBe('产出/意见处置-20260927-1412.md')
    expect(built.instruction).toContain('意见/批阅一.md')
    expect(built.instruction).toContain('意见/批阅二.md')
    expect(built.instruction).toContain('产出/投标文件.docx')
    expect(built.instruction).toContain(built.outputPath)
    // Conclusions never go back into 意见/: those files are the raw evidence.
    expect(built.instruction).toContain('不要写回 意见/')
  })
})
