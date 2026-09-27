import {
  countZoneFiles,
  listZone,
  ZONE_DIRS,
  type WorkspaceHandle,
  type ZoneEntry,
  type ZoneId,
} from '@genoffice/workspace-harness'
import type { WorkflowInstruction, WorkflowKind } from '../shared/api'

/** Names of the two workflows this module can build an instruction for. */
const OUTPUT_STEMS: Record<WorkflowKind, string> = {
  validate: '校验报告',
  summarize: '意见处置',
}

/**
 * The instruction one of the two workflows sends as its first user message.
 *
 * A workflow is not hidden agent behaviour: it is a named entry point that
 * opens a conversation and sends one instruction. The instruction is built here,
 * in the main process, from the *actual* zone contents — the rule files that are
 * really in `资料/`, the documents that are really in `产出/`, the opinions that
 * are really in `意见/` — so the agent starts from the workspace as it is rather
 * than from a list the user has to retype.
 *
 * The text is Chinese because the zones, the file names and the produced
 * documents are; it is a prompt, not a user-visible label.
 */
export function buildWorkflowInstruction(
  workspace: WorkspaceHandle,
  kind: WorkflowKind,
  now: Date = new Date(),
): WorkflowInstruction {
  const outputPath = `${ZONE_DIRS.output}/${OUTPUT_STEMS[kind]}-${fileStamp(now)}.md`
  return {
    kind,
    outputPath,
    instruction:
      kind === 'validate'
        ? validateInstruction(workspace, outputPath)
        : summarizeInstruction(workspace, outputPath),
  }
}

function validateInstruction(workspace: WorkspaceHandle, outputPath: string): string {
  const rules = zoneEntries(workspace, 'material')
  const documents = zoneEntries(workspace, 'output')

  return [
    '请校验「产出」区的文档是否满足「资料」区的规则。',
    '',
    section(
      `规则文件（${ZONE_DIRS.material}/，只读）`,
      rules,
      '资料/ 下没有找到规则文件',
      workspace,
      'material',
    ),
    section(
      `待校验文档（${ZONE_DIRS.output}/）`,
      documents,
      '产出/ 下没有找到文档',
      workspace,
      'output',
    ),
    '工作步骤：',
    '1. 用 doc_read_blocks 逐个读上面列出的规则文件，把每一条可以检查的要求抽出来（逐条编号）。',
    '2. 用 doc_read_blocks 读每个待校验文档，记下块号；文档长时用 offset/limit 继续读。',
    '3. 逐条要求对照每份文档，列出问题：哪条要求、产出里哪一处（写清文档路径与块号）、建议怎么改。',
    `4. 用 fs_write_text 把结论写到 ${outputPath}，用 Markdown 组织：结论摘要、逐条问题、没能检查的部分。`,
    '',
    '约束：',
    `- ${ZONE_DIRS.material}/ 与 ${ZONE_DIRS.library}/ 是只读输入，任何工具都不要写入。`,
    '- 只报告真正读到的内容；读不了的文件（例如 pdf、pptx）单独列出来说明，不要当作已核对。',
    '- 规则文件里没有的要求不要凭空补上；如果规则本身不清楚，把不清楚的地方写出来。',
  ].join('\n')
}

function summarizeInstruction(workspace: WorkspaceHandle, outputPath: string): string {
  const opinions = zoneEntries(workspace, 'feedback')
  const documents = zoneEntries(workspace, 'output')

  return [
    '请汇总「意见」区的反馈，把它变成可以执行的修改目标。',
    '',
    section(
      `意见文件（${ZONE_DIRS.feedback}/）`,
      opinions,
      '意见/ 下没有找到反馈文件',
      workspace,
      'feedback',
    ),
    section(
      `现在的产出（${ZONE_DIRS.output}/）`,
      documents,
      '产出/ 下没有找到文档',
      workspace,
      'output',
    ),
    '工作步骤：',
    '1. 用 doc_read_blocks 或 fs_read_text 读完上面列出的每一个意见文件，把里面的意见逐条拆出来，写清各自来自哪个文件。',
    '2. 把讲同一件事的意见合并成一组，并说明这一组合并了哪几条。',
    '3. 每一条（或每一组）给出采纳或丢弃的结论，并写明理由。',
    '4. 由采纳的意见形成修改目标：改哪个产出文件、改成什么。',
    `5. 用 fs_write_text 把结论写到 ${outputPath}：意见清单、分组、逐条处置、修改目标。`,
    '',
    '约束：',
    `- 结论只写到 ${ZONE_DIRS.output}/，不要写回 ${ZONE_DIRS.feedback}/：那里是审阅者原始说法的证据，改了就无法追溯。`,
    '- 意见之间互相冲突时不要自行取舍，把冲突写出来并给出建议。',
  ].join('\n')
}

/** Top-level entries of a zone, which is what the rail and the instruction both show. */
function zoneEntries(workspace: WorkspaceHandle, zone: ZoneId): ZoneEntry[] {
  return listZone(workspace.dir, zone)
}

/**
 * A titled list of what a zone holds, saying plainly when it holds nothing —
 * an instruction that silently lists no file invites the agent to invent one.
 *
 * Directories are listed as such and their contents counted, so a zone whose
 * files all sit one level down still shows up instead of reading as empty.
 */
function section(
  title: string,
  entries: ZoneEntry[],
  empty: string,
  workspace: WorkspaceHandle,
  zone: ZoneId,
): string {
  if (entries.length === 0) {
    return [title, `（${empty}，请在结论里说明，不要凭空编造。）`, ''].join('\n')
  }

  const lines = entries.map((entry) =>
    entry.kind === 'dir' ? `- ${entry.path}/（目录）` : `- ${entry.path}`,
  )
  const files = entries.filter((entry) => entry.kind !== 'dir').length
  const nested = countZoneFiles(workspace.dir, zone) - files
  if (nested > 0) lines.push(`（该区共有 ${files + nested} 个文件，另有 ${nested} 个在子目录里。）`)
  return [title, ...lines, ''].join('\n')
}

/** `20260927-1412`: local time to the minute, sortable and short for a file name. */
function fileStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}`,
  ].join('-')
}
