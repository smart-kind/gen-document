import { buildBlankDocx, parseDocx, saveDocx, type SaveBlock } from '@genoffice/docx-engine'
import { addElement, createBlankPptx, openPptx, savePptx } from '@genoffice/pptx-engine'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { addDocument } from './documents.js'
import { ReferenceStore } from './references.js'
import type { WorkspaceStore } from './store.js'
import type { DocumentType, WorkspaceHandle } from './types.js'
import { ZONE_DIRS } from './zones.js'

/** Name of the workspace that always exists and teaches the model by example. */
export const DEMO_WORKSPACE_NAME = '演示空间'

/** Directory inside the shared library that the demo workspace mounts. */
const DEMO_LIBRARY_DIR = '示例资料'

/** English Metric Units per inch; pptx geometry is expressed in EMU. */
const EMU = 914_400

/**
 * Ensure the demo workspace exists, creating it on first launch.
 *
 * The demo workspace is the product's explanation of itself: it serves no goal,
 * it cannot be deleted, and it arrives with all four zones populated by real
 * files. Anyone opening it can edit a genuine .docx and .pptx without first
 * understanding what a goal-driven workspace is for.
 *
 * Idempotent by design — an existing one is returned untouched, because the
 * user is expected to have edited its documents.
 */
export async function ensureDemoWorkspace(
  store: WorkspaceStore,
  libraryRoot: string,
): Promise<WorkspaceHandle> {
  const existing = store.list().find((entry) => entry.demo && entry.available)
  if (existing) {
    const handle = store.open(existing.id)
    if (handle) return handle
  }
  return provisionDemoWorkspace(store, libraryRoot)
}

/** Build the demo workspace from scratch, sample documents included. */
export async function provisionDemoWorkspace(
  store: WorkspaceStore,
  libraryRoot: string,
): Promise<WorkspaceHandle> {
  const handle = store.create({ goal: '', name: DEMO_WORKSPACE_NAME, demo: true })

  // A small shared library, so 引用/ demonstrates a mount rather than a folder.
  const libraryDir = join(libraryRoot, DEMO_LIBRARY_DIR)
  mkdirSync(libraryDir, { recursive: true })
  writeFileSync(join(libraryDir, '公司简介.md'), DEMO_COMPANY_PROFILE, 'utf8')
  writeFileSync(join(libraryDir, '资质清单.md'), DEMO_QUALIFICATIONS, 'utf8')
  new ReferenceStore(handle, (next) => store.save(next)).add(libraryDir)

  // 资料/ holds project-exclusive inputs. Provisioning writes directly: the
  // read-only rule is a boundary for tools and the agent, not for the app
  // setting the workspace up.
  writeFile(handle, `${ZONE_DIRS.material}/示例-校验规则.md`, DEMO_RULES)
  writeFile(handle, `${ZONE_DIRS.feedback}/示例-批阅意见.md`, DEMO_FEEDBACK)

  // 产出/ holds documents worth opening: a real .docx and a real .pptx, plus
  // the note that explains the four zones.
  writeFile(handle, `${ZONE_DIRS.output}/示例-说明.md`, demoReadme())
  writeFileBytes(
    handle,
    `${ZONE_DIRS.output}/示例-技术说明.docx`,
    await buildDocx(DEMO_DOC_TITLE, DEMO_DOC_PARAGRAPHS),
  )
  writeFileBytes(
    handle,
    `${ZONE_DIRS.output}/示例-项目汇报.pptx`,
    await buildPptx(DEMO_DECK_TITLE, DEMO_DECK_LINES),
  )

  for (const entry of DEMO_DOCUMENTS) {
    addDocument(handle, {
      path: `${ZONE_DIRS.output}/${entry.name}`,
      type: entry.type,
      note: entry.note,
      source: { kind: 'new' },
    })
  }
  addDocument(handle, {
    path: `${ZONE_DIRS.feedback}/示例-批阅意见.md`,
    type: 'md',
    note: '示例意见：审阅者给的零星反馈',
    source: { kind: 'new' },
  })
  addDocument(handle, {
    path: `${ZONE_DIRS.material}/示例-校验规则.md`,
    type: 'md',
    note: '示例规则：校验产出时要逐条对照',
    source: { kind: 'new' },
  })

  store.save(handle)
  return handle
}

interface DemoDocumentSpec {
  name: string
  type: DocumentType
  note: string
}

const DEMO_DOCUMENTS: DemoDocumentSpec[] = [
  { name: '示例-说明.md', type: 'md', note: '这个空间是怎么组织的' },
  { name: '示例-技术说明.docx', type: 'docx', note: '示例产出：可以直接打开改的 Word' },
  { name: '示例-项目汇报.pptx', type: 'pptx', note: '示例产出：可以直接打开改的 PPT' },
]

function writeFile(handle: WorkspaceHandle, rel: string, text: string): void {
  writeFileBytes(handle, rel, Buffer.from(text, 'utf8'))
}

function writeFileBytes(handle: WorkspaceHandle, rel: string, bytes: Uint8Array): void {
  const abs = join(handle.dir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
}

/** A minimal .docx with a heading and paragraphs, built on the blank template. */
async function buildDocx(title: string, paragraphs: string[]): Promise<Uint8Array> {
  const parsed = await parseDocx(await buildBlankDocx())
  const blocks: SaveBlock[] = [
    { kind: 'generated', block: { type: 'heading', level: 1, runs: [{ text: title }] } },
    ...paragraphs.map((text): SaveBlock => ({
      kind: 'generated',
      block: { type: 'paragraph', runs: [{ text }] },
    })),
  ]
  return saveDocx(parsed, blocks)
}

/** A one-slide .pptx with a title and body lines, built from the blank deck. */
async function buildPptx(title: string, lines: string[]): Promise<Uint8Array> {
  const opened = await openPptx(await createBlankPptx())
  const slide = opened.deck.slides[0]
  if (!slide) throw new Error('blank deck has no slide to fill')
  addElement(slide, {
    kind: 'textbox',
    offset: { x: EMU / 2, y: EMU, cx: 12 * EMU, cy: 1.5 * EMU },
    paragraphs: [{ runs: [{ text: title, bold: true, fontSize: 32 }] }],
  })
  addElement(slide, {
    kind: 'textbox',
    offset: { x: EMU / 2, y: 3 * EMU, cx: 12 * EMU, cy: 3 * EMU },
    paragraphs: lines.map((text) => ({ runs: [{ text }] })),
  })
  return savePptx(opened)
}

const DEMO_DOC_TITLE = '示例技术说明'
const DEMO_DOC_PARAGRAPHS = [
  '这是一份在演示空间里生成的示例文档，可以直接打开、修改、保存。',
  '它放在「产出」区。工作空间里能与文档相关的东西分成四块：引用、资料、产出、意见。',
  '引用与资料是只读的输入：前者是挂进来的公共资料（公司简介、资质清单），后者是只属于这个项目的东西（校验规则）。',
  '产出是你的产物，意见是别人看过产物之后给的零星反馈。',
]

const DEMO_DECK_TITLE = '示例项目汇报'
const DEMO_DECK_LINES = [
  '这是一份示例演示稿，同样放在「产出」区',
  '可以直接打开修改，也可以让 AI 帮忙改',
  '「意见」区里的反馈，就是针对这类产物提出的',
]

const DEMO_RULES = `# 示例校验规则

把这份文件当作"产出要满足什么"的清单。校验时逐条对照产出文档，给出问题清单。

1. 产出必须写明项目名称与编制日期。
2. 技术说明要给出可量化的指标，不能只写"性能良好"。
3. 报价要给出总价与分项，且总价与分项之和一致。
4. 引用第三方资质时，要写明资质名称与有效期。
`

const DEMO_FEEDBACK = `# 示例批阅意见

一个文件里可以放多条意见，每条意见都是一句具体、可执行的话。

- 报价不宜过高，建议控制在同类项目的中位区间内，并在文中说明测算依据。
- 等保要求可以提升一档，正文里只写到二级，建议按三级写。
- 技术说明缺少实施周期，建议补一节"进度安排"。
`

const DEMO_COMPANY_PROFILE = `# 公司简介（示例公共资料）

这份文件挂在「引用」区，是软链接进来的公共资料：
任何工作空间都可以挂载同一份，源文件更新后所有挂载它的空间立刻看到最新版。

- 成立时间：示例
- 主营业务：示例
- 代表项目：示例
`

const DEMO_QUALIFICATIONS = `# 资质清单（示例公共资料）

| 资质名称 | 编号 | 有效期 |
| --- | --- | --- |
| 示例资质一 | DEMO-001 | 示例 |
| 示例资质二 | DEMO-002 | 示例 |
`

/** The note in 产出/ that explains how the workspace is organised. */
function demoReadme(): string {
  return `# 演示空间

这个空间不需要你新建，它一直在。它的文档可以直接打开改，用来熟悉这里的工作方式。

## 四块内容

| 区 | 权限 | 放什么 |
| --- | --- | --- |
| 引用 | 只读 | 挂进来的公共资料，多个工作空间共用同一份 |
| 资料 | 只读 | 只属于本项目的资料，例如业主需求、校验规则 |
| 产出 | 可写 | 你产出的文档，示例里的 Word 与 PPT 就在这 |
| 意见 | 可写 | 看过产物的人给的零星反馈，一个文件里可以放多条 |

## 可以做两件事

1. **校验**：拿「资料」里的规则，逐条检查「产出」里的文档，列出问题清单。
2. **汇总意见**：把「意见」区里散落的反馈收拢起来，决定哪些采纳、哪些丢掉，形成修改目标。

想真正开始一个项目时，回到工作空间列表新建一个，填上目标、工作目录、要挂载的资料，以及这个空间用哪个模型。
`
}
