# GenOffice 重构实现 PRD（v1·骨架版）

> 状态：草案
> 日期：2026-09-26
> 上游文档：`design-docs/restructuring-plan.md`（架构决策与选型依据）
> 本文档定位：把重构计划落成**可实现的骨架规格**——Tool Set 如何定义、只读引用资料如何工作。

---

## 0. 优先级原则：骨架优先，细化后置

**当前唯一目标：把骨架跑起来。**

- 设计文档只规定**结构性**的东西：有哪些层、有哪些工具集、工具契约长什么样、数据放哪里
- 一切**颗粒度**问题（做几个原型、保存几个版本、模板抽多细、列表支持几项）**不在文档里决定**，由用户与 agent 在对话中随意决定
- 如果某个决策只影响颗粒度，不做设计，留给实测后微调
- 判断标准只有一条：**这个决定会不会导致结构性变化？** 会，现在定；不会，以后说

### 0.1 两种约束必须分清

这是本项目最容易搞混的一点：

| 约束类型         | 要不要                | 说明                                                   |
| ---------------- | --------------------- | ------------------------------------------------------ |
| **数据边界约束** | ✅ **要，硬约束**     | 只读引用目录不能被写；File System 工具必须拒绝         |
| **格式约束**     | ❌ **不要，明确不做** | 参考文档不构成任何格式契约。允许任意偏离、增删、改布局 |

**具体后果**：不追求「用本软件写出的标书都长一个样」。相反，**灵活编辑是刻意保留的能力**——7 页的参考做成 13 页、3 条特性扩成 7 条、单栏变双栏、删掉旁边的示意图，都是允许且正常的。

---

## 1. 目标与范围

### 1.1 v1 要达成的目标

用一个可运行的最小闭环证明「目标驱动的文档工作空间」成立：

1. 能**创建工作空间**并声明目标（如「编写 XX 医院综合楼技术标书」）
2. 能**挂载只读引用资料**（公司资质、历史标书、旧汇报 PPT 等），对工作空间是**只读**的
3. AI 能在工作空间内**创建/编辑/管理多个不同类型的文档**，而不只是一个文档
4. AI 能**操作应用本身**（切语言、切主题、打开/关闭/激活文档）
5. AI 改完内容后，**UI 自动反映变化**，AI 不需要调用任何「渲染」工具
6. 能在工作空间里**开多个对话**，每个对话对应一个独立任务上下文
7. **能从只读参考文档里复制页面/内容块进当前文档，然后自由改造**

### 1.2 v1 非目标（明确不做）

- ❌ **不做模板系统**——不做模板格式、不做模板库、不做格式契约。理由见 §6.2
- ❌ **不做模板自动提取流水线**（签名/去重/占位符化那套，已裁撤）
- ❌ 不做自动保存 / 自动暂存版本——版本**只由用户显式触发**
- ❌ 不做 Web 版（仅 Electron 桌面端）
- ❌ 不做多人实时协同编辑
- ❌ 不做 Sub-agent 编排的产品化（只保证 orchestrator 的 tool 契约位置）

### 1.3 分期

| 阶段              | 内容                                                                                    | 判定标准                                                  |
| ----------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **v1-a 骨架**     | workspace shell 起壳、pi-agent 接入、Workspace / File System（含只读引用）/ UI Tool Set | 能建空间、挂只读资料、加文档、开编辑器、AI 能切语言改主题 |
| **v1-b 编辑闭环** | Document Tool Set 迁移（docs + slides）、effect 自动渲染、postState                     | AI 在空间内能完整写一份 docx + 一份 pptx                  |
| **v1-c 参考复用** | 从参考文档复制页/块进当前文档；「抽离参考」技能                                         | 照着 `references/` 里的旧 PPT 做出一份新汇报              |
| **v2**            | 版本管理（显式触发）、外部 MCP Client、协作                                             | —                                                         |

**v1-a 是当前全部工作重点。** v1-b / v1-c 的规格写在文档里只是为了让骨架不返工。

---

## 2. 核心概念与术语

| 术语                      | 定义                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Workspace**             | 磁盘上一个文件夹 = 一个工作目标 = 一个 git 仓库（三者是同一个东西）。含 manifest、文档、**引用资料**、对话记录、可选 SQLite |
| **Conversation**          | 工作空间内一次任务上下文。一对一映射一个 pi-agent 会话。可跨多个文档                                                        |
| **Document**              | 工作空间内的一个文件（docx/xlsx/pptx/pdf/md/html），可带自由标注的用途说明                                                  |
| **引用资料（Reference）** | 通过软链接挂进工作空间的**只读**外部文件或目录，集中存放、多空间共用，不复制                                                |
| **Editor View**           | 承载某个文档的 Electron `WebContentsView`（复用现有各 app 的渲染进程）                                                      |
| **Tool Set**              | 一组同类工具的集合，独立定义、独立注册                                                                                      |
| **Tool Effect**           | 工具声明自己属于 `query`/`mutation`/`ui_control`/`workspace` 哪一类，框架据此自动处理副作用                                 |
| **postState**             | 变更类工具返回的「变更后结构化摘要」，让 agent 无需再读一次即可继续                                                         |

> 术语里**没有** Template / Archetype / Placeholder / Role —— 这些概念已裁撤。

---

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│  apps/workspace-shell（新建）                                 │
│                                                              │
│  ┌────────────────┐  ┌────────────────────────────────────┐  │
│  │ 会话面板        │  │  工作空间视图                       │  │
│  │ (多 conversation)│  │  ├ 文件树（可写区 + 只读引用区）     │  │
│  │                │  │  ├ 标签栏（打开的 Editor View）      │  │
│  │ pi-agent       │  │  └ 编辑器区域（WebContentsView）     │  │
│  │  ├ Agent Loop  │  │                                    │  │
│  │  ├ Tool Sets ──┼──┼─► effect 分发 → 自动渲染            │  │
│  │  └ Hooks       │  │                                    │  │
│  └────────────────┘  └────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ Harness 基础设施                                          ││
│  │  ToolRegistry | EventBus | WorkspaceStore                ││
│  │  ReferenceStore（只读）| PermissionGate | SnapshotManager ││
│  └──────────────────────────────────────────────────────────┘│
├──────────────────────────────────────────────────────────────┤
│  复用层：现有编辑器 app 的 main 模块                          │
│  configure*Runtime / create*View / register*Ipc              │
│  + MCP bridge（docs/sheets 的 request-response 已验证可用）   │
├──────────────────────────────────────────────────────────────┤
│  Engine 层（原样复用）                                        │
│  pptx-engine | docx-engine | pptx-ops | docx patch | ...      │
└──────────────────────────────────────────────────────────────┘
```

**关键复用判断（基于代码调研）**：

- 现有编辑器已经为「被外部驱动」设计好了：`configure*Runtime(config)` 注入路径、`create*View()` 造视图、`register*Ipc()` 注册通道（`apps/shell/src/main/index.ts:398-437`）
- **docs 与 sheets 已有渲染进程侧的 request-response bridge**（`apps/shell/src/main/mcp/docs-bridge.ts:110`、`sheets-bridge.ts:112`），docs 侧直接复用内置 AI 的 `executeTool`（`apps/docs/src/renderer/mcp-bridge.ts:214`）—— 这条链路正是新 harness 驱动编辑器可直接复用的机制
- **slides 走主进程 session**（`apps/shell/src/main/mcp/slides-bridge.ts:148` 的 `applySessionTxn`），没有渲染进程协议
- **跨文档复制内容已有实现**：slides 的 `insertSlidePptx` / `mergeSlideFromSource`（`packages/pptx-engine`、`pptx-ops/src/ops/slide-ops.ts:229`），sheets 的 `merge_attached_workbooks`（`apps/sheets/src/renderer/ai/merge-skill.ts:42`）—— 这正是「从只读参考复制内容」要用的机制

---

## 4. Tool Set 定义规范

### 4.1 Tool 的接口形态

工具契约以 pi-agent 的 `AgentTool` 为基础，增加 `effect`、`set`、`postState` 三个字段。

```ts
// packages/workspace-harness/src/tool/types.ts

import type { TSchema } from 'typebox'

/** 工具副作用的分类——框架据此自动处理 UI 同步，AI 不需要知道 */
export type ToolEffect =
  | 'query' // 纯读取，无副作用
  | 'mutation' // 修改文档内容 → 框架触发编辑器重绘
  | 'ui_control' // 改变应用 UI 状态 → 框架触发 shell 响应
  | 'workspace' // 改变工作空间结构 → 框架刷新文件树 / 标签栏

export type ToolSetId = 'workspace' | 'filesystem' | 'document' | 'ui' | 'version'

export interface HarnessTool {
  /** 工具名，全局唯一，见 4.2 命名规范 */
  name: string
  /** UI 上显示的中文名（活动条、日志） */
  label: string
  /** 给模型看的说明。这是 prompt engineering 最重的地方 */
  description: string
  /** TypeBox schema（pi-agent 要求） */
  parameters: TSchema
  /** 归属工具集 */
  set: ToolSetId
  /** 副作用分类 */
  effect: ToolEffect
  /** 执行。ctx 由 harness 在每次调用时注入 */
  execute(ctx: ToolContext, params: unknown, signal?: AbortSignal): Promise<ToolResult>
}

export interface ToolResult {
  /** 回喂给模型的内容 */
  output: string
  isError?: boolean
  /** 是否改变了持久化状态——驱动整轮快照回滚 */
  mutated?: boolean
  /** 活动条文案（UI 用） */
  summary?: string
  /** UI 专用旁路，永不进 LLM 上下文（图片、链接、卡片） */
  display?: DisplayPayload
  /** 变更后的结构化摘要——让 agent 不必再读一次，见 4.7 */
  postState?: unknown
}

export interface ToolContext {
  workspace: WorkspaceHandle
  /** 当前激活的编辑器文档；无激活时为 undefined */
  activeDocument?: DocumentHandle
  /** 显式指定目标文档（多文档操作时用） */
  resolveDocument(ref: DocumentRef): Promise<DocumentHandle | undefined>
  /** 应用级控制：语言、主题、面板、标签 */
  ui: UiBridge
  /** 打开/关闭/激活编辑器 */
  shell: ShellBridge
  /** 只读引用资料库 */
  references: ReferenceStore
  /** 版本控制 */
  vcs: VersionBridge
  /** 发出事件（一般由 harness 自动做，工具很少直接用） */
  emit(event: HarnessEvent): void
}
```

### 4.2 命名规范

**格式：`<set>_<verb>_<object>`，全小写下划线。**

理由：新 harness 里**所有**工具共处一个 agent 的 tool 列表，而调研发现现有代码存在严重跨域重名——`apply_ops` 在 docs/slides/markdown/html/pdf 五处语义完全不同，`web_search` 有五份近义复制，`create_document` 三处枚举不同。不前缀化必然冲突。

| 工具集          | 前缀                                                    | 示例                                      |
| --------------- | ------------------------------------------------------- | ----------------------------------------- |
| Workspace       | `workspace_`                                            | `workspace_create`, `workspace_open`      |
| File System     | `fs_`                                                   | `fs_add_reference`, `fs_move`, `fs_list`  |
| Document        | `doc_` / `sheet_` / `slide_` / `pdf_` / `md_` / `html_` | `slide_insert_from_file`, `doc_apply_ops` |
| UI Appearance   | `ui_`                                                   | `ui_set_language`, `ui_open_document`     |
| Version Control | `version_`                                              | `version_save`, `version_rollback`        |

Document 工具集内部再按文档类型分前缀，因为它们是**同一类能力在不同文档模型上的投影**，动词应当保持一致（`*_apply_ops`、`*_read`、`*_insert_from_file`），便于模型迁移理解。

### 4.3 结果契约

继承现有 `ToolExecution` 的成熟语义（`packages/agent-core/src/types.ts:60-73`），保留 `output/isError/mutated/summary/display`，新增 `postState`：

| 字段        | 去向                 | 作用                                                                  |
| ----------- | -------------------- | --------------------------------------------------------------------- |
| `output`    | LLM 上下文           | 工具说明性结果                                                        |
| `isError`   | LLM 上下文           | 失败时让模型自我纠错                                                  |
| `mutated`   | Harness              | 首个 mutated 工具执行前抓快照，支持「回滚整轮」                       |
| `summary`   | 仅 UI                | 活动条文案                                                            |
| `display`   | 仅 UI                | 图片/链接/问卷卡片；**永不进 LLM 上下文**（避免 base64 图片吃 token） |
| `postState` | LLM 上下文（精简后） | 变更后状态摘要，免去后续 read 调用                                    |

> **教训来源**：现有代码里 `display` 是个好设计，但 `ToolExecution` 被复制了三份（`apps/docs/.../tools.ts:694`、`apps/sheets/.../tools.ts:560` 都缺 `display`）。新 harness **只允许一份定义**，各 app 不得自定义。

### 4.4 工具集的注册与组合

```ts
export interface ToolSet {
  id: ToolSetId
  /** 依据运行时上下文动态产出工具（可条件注册，如无生图能力时不注册 generate_image） */
  tools(ctx: ToolContext): HarnessTool[]
}

export function composeToolSets(ctx: ToolContext, sets: ToolSet[]): HarnessTool[] {
  const out: HarnessTool[] = []
  const seen = new Set<string>()
  for (const set of sets) {
    for (const tool of set.tools(ctx)) {
      if (seen.has(tool.name)) {
        // 与现有 composeSkills 一致：重名直接抛错，不静默覆盖
        throw new Error(`duplicate tool name: ${tool.name}`)
      }
      seen.add(tool.name)
      out.push(tool)
    }
  }
  return out
}
```

要点：

1. **重名抛错**——沿用 `packages/agent-core/src/skill.ts:59-65` 的既有约定，防止迁移期静默覆盖
2. **工具集每次 prompt 前重算**——支持按运行时能力动态裁剪
3. **注册进 pi-agent**：`agent.state.tools = composeToolSets(ctx, ALL_SETS)`
4. **上下文注入**：`ctx` 在**每次工具调用时**由 harness 重新解析（而非创建 agent 时固定），这样 `activeDocument` 能跟随用户切标签页实时更新

### 4.5 权限与沙箱

| 层次         | 机制                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **只读引用** | File System 的写工具（`fs_move` / `fs_rename` / `fs_delete` / `fs_export` 的目标）**必须拒绝** `references/` 下的路径；编辑器打开引用资料时以只读模式打开 |
| 文件范围     | File System 工具只允许操作**工作空间目录内**的路径；`fs_import` / `fs_export` 是仅有的两个「跨边界」工具，需显式路径参数                                  |
| 破坏性操作   | `workspace_delete` / `fs_delete` / `version_rollback` 需用户确认（`display` 返回确认卡片）                                                                |
| 网络         | 搜索/生图类工具与现有实现一致，走已有 provider 配置                                                                                                       |
| 脚本执行     | slides 的 `slide_execute_script` 沿用现有沙箱（`layout-script-interpreter.ts`，acorn 解析 + 白名单求值，`MAX_STEPS=25000`），**不使用 eval**              |

pi-agent 本身不提供权限层（见重构计划 §4.2.4），权限完全由 harness 在 `ctx` 和 `execute` 内部实现。

### 4.6 渲染同步机制

**核心设计约束：渲染不是 AI 的 tool，是框架的副作用。**

AI 的工具列表里**不存在**也不需要 `render` / `preview` / `refresh` 类工具。工具执行后由 harness 统一分发：

```
tool.execute() 返回
      │
      ▼
harness.afterToolCall(tool, result)          ← 挂在 pi-agent 的 afterToolCall hook
      │
      ├─ effect === "mutation"
      │     emit("document.changed", { docRef, toolName, postState })
      │     → 目标 Editor View 收到 IPC → debounced(100ms) 重绘
      │
      ├─ effect === "ui_control"
      │     emit("ui.changed", { what, value })
      │     → shell 渲染进程更新语言/主题/面板/标签
      │
      ├─ effect === "workspace"
      │     emit("workspace.changed", { kind })
      │     → 文件树 / 标签栏 / 空间列表刷新
      │
      └─ effect === "query"  → 无副作用
```

**现状说明（已核实）**：现有 genoffice **并不存在** render/preview/refresh 工具（全仓 0 命中）。各编辑器采用的是「工具直接写活的模型 → 框架响应式重绘」：docs 直接 dispatch ProseMirror transaction（Tiptap 自动重绘）、slides 用 `access.applySlide` 写回 React state、sheets 走 `applyChangePlan`（Univer 自动刷新）。

**但这个模式没有形式化**——它是各 app 各自临时实现的隐式约定：没有统一的副作用声明；slides 的 MCP 路径需要**手工**推送变更通知（`apps/shell/src/main/mcp/slides-bridge.ts:162` 注释：因为 MCP 没有发起 renderer）；跨 app 无法保证一致性。

因此设计目标不是「修复一个错误」，而是**把隐式约定升级为显式契约**：工具声明 `effect`，框架统一分发。这样新增工具集只要声明 effect，渲染同步自动获得。

**边界情况**：

- **连续多次 mutation**：debounced 100ms 内合并为一次重绘
- **mutation 作用于非激活文档**：不立即重绘，但状态已落盘；用户切到该文档时自然看到最新内容
- **「先草拟再确认」**：这是独立的 UX 模式，未来作为 `display` 里的 proposal 卡片 + 确认工具实现，与 effect 机制无关

### 4.7 自校验原则（避免 mutate → read 乒乓）

调研发现现有实现有一类真实的低效模式：**变更工具返回信息不足，agent 必须再调一次读工具才能继续**：

| 现象                                                | 位置                                             |
| --------------------------------------------------- | ------------------------------------------------ |
| slides 布局审计在工具内跑，把修复指令塞进返回值     | `slides-skill.ts:1346-1350, 1423-1428`           |
| sheets 写完等 300ms 重算再读回公式结果              | `apps/sheets/src/renderer/ai/tools.ts:1300-1359` |
| pdf 文件级操作后必须重读（页号变了）                | `apps/pdf` 的 `insert_blank_page` 描述           |
| docs/slides 的块索引、durable id 改完就变，必须重读 | CLI `slides_read` 描述                           |

**v1 契约要求：每个 `mutation` 工具必须返回足够的 `postState`，使 agent 无需紧接一次 read 即可继续决策。**

```ts
// 反例（现有风格）：agent 必须再 read 一次
{ output: "Inserted 3 paragraphs." }

// v1 要求
{
  output: "已在第 12 块后插入 3 个段落。",
  mutated: true,
  postState: {
    documentId: "doc-7",
    insertedRange: { startBlockIndex: 13, endBlockIndex: 15 },
    blocks: [
      { index: 13, type: "heading", styleId: "Heading2", preview: "2.1 系统架构" },
      { index: 14, type: "paragraph", preview: "本系统采用…" },
      { index: 15, type: "paragraph", preview: "具体而言…" },
    ],
    outline: [ /* 最新文档大纲（层级 + 标题） */ ],
    issues: []   // 工具内部自检发现的问题
  }
}
```

`postState` 与 `display` 的区别：`postState` 是给**模型**看的结构化摘要（进上下文），`display` 是给**用户**看的渲染物（不进上下文）。两者可以同时返回。

工具内部自检（如 slides 的布局审计）也应内聚在 `execute` 里，结果进 `postState.issues`，而不是让 agent 再调一次审计工具。

---

## 5. Tool Set 清单（v1）

图例：effect `Q`=query `M`=mutation `U`=ui_control `W`=workspace。

### 5.1 Workspace Tool Set（`packages/workspace-harness/src/tools/workspace.ts`）

| 工具名                   | 参数                               | effect | 底层                                         | 范围 |
| ------------------------ | ---------------------------------- | ------ | -------------------------------------------- | ---- |
| `workspace_create`       | `goal`, `name?`, `parentDir?`      | W      | 新建目录 + manifest + git init               | v1   |
| `workspace_list`         | —                                  | Q      | 扫描工作空间根目录                           | v1   |
| `workspace_open`         | `id`                               | W      | 切换活动工作空间，重建 shell 视图            | v1   |
| `workspace_describe`     | `id?`（缺省=当前）                 | Q      | 读 manifest + 文档列表 + 引用列表 + 对话列表 | v1   |
| `workspace_update`       | `goal?`, `name?`                   | W      | 改 manifest                                  | v1   |
| `workspace_delete`       | `id`, `confirm`                    | W      | 删目录（需确认）                             | v1   |
| `workspace_get_settings` | —                                  | Q      | 读空间级设置                                 | v1   |
| `workspace_set_settings` | `language?`, `theme?`, `autoSave?` | W      | 写空间级设置，并**同步应用到 UI**            | v1   |

> `workspace_set_settings` 是最能体现「AI 能操作应用本身」的工具——用户说「把界面换成中文」，agent 调它，触发 manifest 更新 + UI 应用。

### 5.2 File System Tool Set（`.../tools/filesystem.ts`）

**可写区操作：**

| 工具名                                | 参数                              | effect | 说明                                             | 范围 |
| ------------------------------------- | --------------------------------- | ------ | ------------------------------------------------ | ---- |
| `fs_list`                             | `dir?`, `includeReferences?`      | Q      | 遍历，带类型/dirty/只读标记                      | v1   |
| `fs_add_document`                     | `type`, `name?`, `note?`          | W      | 新建文档（`buildBlankDocx` / `createBlankPptx`） | v1   |
| `fs_import`                           | `externalPath`, `destDir?`, `as?` | W      | 复制进空间（**副本，可写**）                     | v1   |
| `fs_export`                           | `paths[]`, `destPath`, `format?`  | W      | 导出到空间外                                     | v1   |
| `fs_move` / `fs_rename` / `fs_delete` | 各自参数                          | W      | 均**拒绝** `references/` 路径                    | v1   |
| `fs_read_text`                        | `path`, `offset?`, `limit?`       | Q      | 读文本类文件（md/html/txt）                      | v1   |
| `fs_search`                           | `query`, `glob?`, `regex?`        | Q      | 空间内搜索（含引用资料）                         | v2   |

**只读引用资料操作（本 PRD 的结构性新增）：**

| 工具名                | 参数                                        | effect | 说明                                    | 范围 |
| --------------------- | ------------------------------------------- | ------ | --------------------------------------- | ---- |
| `fs_add_reference`    | `externalPath`, `as?`, `readOnly`（恒为真） | W      | 软链接挂进 `references/`，登记 manifest | v1   |
| `fs_list_references`  | —                                           | Q      | 列出引用库（来源、是否可用、大小）      | v1   |
| `fs_remove_reference` | `nameOrPath`                                | W      | 摘除链接（**不删源文件**）              | v1   |

`fs_add_reference` 的语义要点：

- 挂进来的是**链接**，不是副本——公司资料改了，所有引用它的工作空间立即看到最新版
- 对工作空间**只读**，工具层拒绝任何写操作
- 引用资料**可以**被读、被搜索、**可以被复制内容进当前文档**（见 5.3 的 `*_insert_from_file`），只是不能被原地修改

### 5.3 Document Tool Set

**设计原则**：按文档类型分子前缀，但**动词表统一**，使模型能跨类型迁移理解。

统一动词表：

| 动词                 | 语义                                | 必须返回的 postState          |
| -------------------- | ----------------------------------- | ----------------------------- |
| `*_read`             | 读取内容（分页）                    | —                             |
| `*_get_context`      | 读取当前上下文（结构、选区、统计）  | —                             |
| `*_apply_ops`        | 批量结构化操作（事务）              | 受影响对象 id + 新几何/新结构 |
| `*_insert`           | 插入内容                            | 插入位置 + 新对象列表         |
| `*_insert_from_file` | **从另一个文档复制内容块/页面进来** | 插入位置 + 新对象列表         |
| `*_replace`          | 替换范围                            | 替换后范围 + 新结构           |
| `*_write`            | 长文流式写作                        | 最终结构                      |
| `*_execute_script`   | 脚本化批量编辑（仅 slides/html）    | 操作日志 + 审计结果           |
| `*_audit`            | 自检（布局/格式/一致性）            | 问题清单                      |

**`*_insert_from_file` 是「参考复用」的机制核心**——它让「照着旧的做一份新的」变成「复制几页进来 + 自由改造」，而不是「套用一个固定格式」。

**5.3.1 docs（Word）** — 迁移自 `apps/docs/src/renderer/ai/tools.ts`（现有 29 + 8 个）

| 工具名                                                                                                       | 参数要点                                                       | effect | 来源                                                  |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------ | ----------------------------------------------------- |
| `doc_get_context`                                                                                            | —                                                              | Q      | `get_document_context`                                |
| `doc_read_blocks`                                                                                            | `startBlockIndex`, `endBlockIndex`, `offset?`                  | Q      | `read_blocks`                                         |
| `doc_insert_content`                                                                                         | `html`, `afterBlockIndex?`                                     | M      | `insert_content`                                      |
| **`doc_insert_from_file`**                                                                                   | `source`, `blockRange?`, `afterBlockIndex?`, `keepFormatting?` | M      | **新增**（底层复用 `Block.originalXml` + patch 机制） |
| `doc_write_document`                                                                                         | `plan`, `title?`, `context?`, `replaceDocument?`               | M      | `write_document`（保留流式）                          |
| `doc_replace_blocks`                                                                                         | `startBlockIndex`, `endBlockIndex`, `html`                     | M      | `replace_blocks`                                      |
| `doc_replace_selection`                                                                                      | `html`                                                         | M      | `replace_selection`                                   |
| `doc_apply_ops`                                                                                              | `ops[]`, `dryRun?`                                             | M      | `apply_ops`                                           |
| `doc_define_style`                                                                                           | `styleId`, `name`, `type`, 段落/字符属性                       | M      | `define_style`                                        |
| `doc_list_styles`                                                                                            | —                                                              | Q      | `list_styles`                                         |
| `doc_set_page_setup`                                                                                         | `paper`, `orientation`, `margins`, `columns`...                | M      | `set_page_setup`                                      |
| `doc_set_header_footer`                                                                                      | `kind`, `text`, `view`                                         | M      | `set_header_footer`                                   |
| `doc_insert_table` / `doc_insert_image` / `doc_insert_chart`                                                 | 各自参数                                                       | M      | 现有                                                  |
| `doc_read_revisions` / `doc_accept_changes` / `doc_reject_changes`                                           | 各自参数                                                       | Q/M    | 现有                                                  |
| `doc_read_comments` / `doc_add_comment` / `doc_reply_comment` / `doc_resolve_comment` / `doc_delete_comment` | 各自参数                                                       | Q/M    | 现有                                                  |
| `doc_insert_footnote` / `doc_insert_endnote` / `doc_read_notes` / `doc_edit_note` / `doc_delete_note`        | 各自参数                                                       | Q/M    | 现有                                                  |
| `doc_set_watermark` / `doc_insert_text_box` / `doc_insert_picture`                                           | 各自参数                                                       | M      | 现有                                                  |

**5.3.2 slides（PPT）** — 迁移自 `apps/slides/src/renderer/ai/slides-skill.ts`（现有 18 个）

| 工具名                       | 参数要点                                             | effect | 来源                                                                            |
| ---------------------------- | ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| `slide_read`                 | `slideIndex`                                         | Q      | `read_slide`                                                                    |
| `slide_get_deck_context`     | —                                                    | Q      | 新增（现有靠逐页 `read_slide`）                                                 |
| `slide_execute_script`       | `slideIndex`, `code`, `explanation`                  | M      | `execute_slide_script`（沙箱 DSL）                                              |
| `slide_apply_ops`            | `ops[]`, `isolation`, `dryRun?`                      | M      | `apply_ops`                                                                     |
| **`slide_insert_from_file`** | `source`, `pages[]`, `atIndex?`, `keepSourceLayout?` | M      | **新增**（底层复用 `insertSlidePptx` / `mergeSlideFromSource`，已存在且有测试） |
| `slide_add_page`             | `layoutPath?`, `afterIndex?`                         | M      | `addSlideWithLayout`                                                            |
| `slide_set_layout`           | `slideIndex`, `layoutPath?`                          | M      | `setSlideLayout` / `resetSlideLayout`                                           |
| `slide_delete_page`          | `slideIndex`                                         | M      | 现有                                                                            |
| `slide_regenerate`           | `slideIndex`, `brief`, `layout?`, `dataSource`       | M      | `regenerate_slide`                                                              |
| `slide_plan_deck`            | `core_hook`, `style`, `pages[]`                      | M      | `plan_deck`                                                                     |
| `slide_generate_deck`        | `topic?`, `pages[]`, `insert_mode`                   | M      | `generate_deck`                                                                 |
| `slide_audit_layout`         | `slideIndex?`                                        | Q      | 抽出（原内聚在 `execute_script` 返回值）                                        |
| `slide_edit_chart`           | `slideIndex`, `sourceId`, `kind`, `series`...        | M      | `edit_chart`                                                                    |
| `slide_list_layouts`         | —                                                    | Q      | 新增（现有靠 UI 下拉）                                                          |

> 注意：`slide_insert_from_file` 的 `source` **可以指向只读引用资料**——这是「从历史 PPT 复制页」的正规路径。`keepSourceLayout` 对应现有的「源格式 / 目标主题」两种粘贴语义。

**5.3.3 其他文档类型**：sheets / pdf / markdown / html 按同一动词表映射。sheets 的 `sheet_insert_from_file` 直接对应已有的 `merge_attached_workbooks`。v1 只要求**接口对齐**，实现沿用现有代码，不做重写。

**5.3.4 共享媒体工具**（各文档类型共用同一实现，按类型前缀注册）：

| 工具名                | 参数                          | effect                   |
| --------------------- | ----------------------------- | ------------------------ |
| `*_web_search`        | `query`, `maxResults?`        | Q                        |
| `*_image_search`      | `query`, `maxResults?`        | Q                        |
| `*_generate_image`    | `prompt`, `aspectRatio?`...   | Q（产出物，不改文档）    |
| `*_analyze_media`     | `mediaUrls[]`, `requirements` | Q                        |
| `*_read_attachment`   | `index`, `offset?`            | Q                        |
| `*_ask_clarification` | `questions[]`                 | Q（经 `display` 弹问卷） |

> 调研发现 `files-skill.ts` 有 **4 份复制**、`search-skill.ts` 有 **3 份**。v1 一律合并为单一实现，按前缀注册，消除重复。

### 5.4 UI Appearance Tool Set（`.../tools/ui.ts`）

**这一组直接补上实测发现的缺口** —— 现有代码里语言/主题/标签控制都是 IPC（`apps/shell/src/main/index.ts:3686` 语言、`:3721` 主题、`:4160` 标签），**完全没有暴露成工具**，所以 AI 说「把语言换成中文」时无能为力。

| 工具名                   | 参数                                | effect | 底层 IPC                                     | 范围 |
| ------------------------ | ----------------------------------- | ------ | -------------------------------------------- | ---- |
| `ui_set_language`        | `locale`（如 `zh-CN`）              | U      | `home:set-language`                          | v1   |
| `ui_get_language`        | —                                   | Q      | `home:get-language`                          | v1   |
| `ui_set_theme`           | `mode`: `light`\|`dark`\|`system`   | U      | `home:set-theme`                             | v1   |
| `ui_get_theme`           | —                                   | Q      | `home:get-theme`                             | v1   |
| `ui_open_document`       | `path` 或 `documentId`, `readOnly?` | U      | TabManager 打开 + 激活                       | v1   |
| `ui_close_document`      | `documentId`, `save?`               | U      | `tabs:close`                                 | v1   |
| `ui_activate_document`   | `documentId`                        | U      | `tabs:activate`                              | v1   |
| `ui_list_open_documents` | —                                   | Q      | `open_documents list`（已有 MCP 实现可参照） | v1   |
| `ui_toggle_panel`        | `panel`, `visible`                  | U      | shell 渲染进程                               | v1   |
| `ui_notify`              | `message`, `level`                  | U      | shell 渲染进程（只提示，无状态）             | v1   |
| `ui_set_layout`          | `mode`: `edit`\|`present`\|`focus`  | U      | shell 渲染进程                               | v2   |

> `ui_open_document` 的 `readOnly` 用于把引用资料以只读方式打开——预览历史文档而不误改。

### 5.5 Version Control Tool Set（`.../tools/version.ts`）

工作空间本身是 git 仓库（见 §7.1）。编辑器内部的单文档快照继续用于细粒度回滚，本工具集用于**工作空间级粗粒度版本标记**。

**触发方式：仅显式触发。不做自动保存、不做自动暂存。**

两种触发路径：

1. UI 上一个「保存为一个版本」按钮
2. 用户对 agent 说「保存一个版本」→ agent 调 `version_save`

| 工具名               | 参数                   | effect | 底层                                          | 范围 |
| -------------------- | ---------------------- | ------ | --------------------------------------------- | ---- |
| `version_save`       | `message?`             | W      | `git add -A` + `commit`（提交全部未提交变更） | v2   |
| `version_status`     | —                      | Q      | `git status --porcelain`                      | v2   |
| `version_list`       | `limit?`               | Q      | `git log --oneline`                           | v2   |
| `version_diff`       | `versionId?`, `path?`  | Q      | `git diff`                                    | v2   |
| `version_rollback`   | `versionId`, `confirm` | W/M    | `git checkout` / `git revert`                 | v2   |
| `version_push`       | `remote?`, `branch?`   | W      | `git push`（仅在配置了 remote 时可用）        | v2   |
| `version_set_remote` | `url`, `branch?`       | W      | `git remote add`（配置后可多人协作）          | v2   |

### 5.6 现有工具迁移映射（摘要）

| 现有位置                                                                                    | 现有工具数 | 迁移去向                                                                              |
| ------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------- |
| `apps/docs/src/renderer/ai/tools.ts` + `page-setup.ts` + `style-ops.ts` + `floating-ops.ts` | 37         | `doc_*`                                                                               |
| `apps/slides/src/renderer/ai/slides-skill.ts`                                               | 18         | `slide_*`                                                                             |
| `apps/sheets/src/renderer/ai/tools.ts` 等 5 个 skill                                        | 18         | `sheet_*`                                                                             |
| `apps/markdown/src/renderer/ai/tools.ts`                                                    | 9          | `md_*`                                                                                |
| `apps/html/src/renderer/ai/tools.ts`                                                        | 8          | `html_*`                                                                              |
| `apps/pdf/src/renderer/ai/tools.ts`                                                         | 45         | `pdf_*`（v1 仅对齐接口）                                                              |
| `apps/shell/src/main/mcp/tools/*.ts`                                                        | 18         | 保留为 MCP Server 暴露面；内部实现改为调用同一批 `doc_*`/`slide_*` 实现，消除契约分叉 |
| `apps/*/src/renderer/ai/{files,search}-skill.ts`                                            | 7 份复制   | 合并为单一共享实现                                                                    |

**迁移期的不变量**：底层实现逻辑不变，只改「注册方式」（手写 switch → `HarnessTool` 对象）与工具名。每个迁移后的工具都要按 §4.2 前缀化命名并补 `effect` / `postState`。

---

## 6. 参考资料与风格复用

### 6.1 只读引用资料库

**为什么需要**：写文档时反复要用到公司层面的资料（资质证书、历史标书、旧汇报 PPT、品牌规范）。这些资料**每个项目都要用**，但**不该每个项目复制一份**——复制会产生大量重复和版本分叉（公司资质更新了，一百个项目里的副本全是旧的）。

**做法**：一份集中存放的物理目录，各工作空间**软链接**挂进自己的 `references/`。

```
<userData>/references/                     ← 集中存放，一份（可配置到任意路径）
├── 公司资质/
│   ├── 营业执照.pdf
│   └── 资质证书汇编.pdf
├── 历史标书/
│   └── 2025-XX医院投标.docx
└── 汇报模板样例/
    └── 年度汇报.pptx
```

```
每个 workspace:
<workspace>/
└── references/                            ← 只读引用区（软链接）
    ├── 公司资质 -> <userData>/references/公司资质
    └── 年度汇报.pptx -> <userData>/references/汇报模板样例/年度汇报.pptx
```

**性质**：

| 属性           | 值                                                                              |
| -------------- | ------------------------------------------------------------------------------- |
| 是否复制       | **否**，是软链接。源更新 → 所有工作空间立即看到最新版                           |
| 是否可写       | **否，只读**。工具层拒绝写入；编辑器以只读模式打开                              |
| 是否可读/搜索  | **是**                                                                          |
| 内容能否被复用 | **能**——可以把其中的页面/内容块复制进当前文档（复制出来的是独立副本，可自由改） |
| 摘除引用       | `fs_remove_reference` 只摘链接，**不删源文件**                                  |

**这个「只读」是硬约束，必须实现**（见 §0.1 的约束区分）——它是数据边界，不是格式要求。

### 6.2 为什么不做「模板系统」

上一版 PRD 设计了一套模板机制（模板格式、模板库、页面原型、角色分类、去重、占位符化）。**已整体裁撤**，理由：

1. **格式本来就不该固定。** 同类型标书每次格式都不一样，招标方要求各异。硬套一个模板 = 产出千篇一律的东西，这恰恰是要避免的
2. **模板与成品不是一对一。** 7 页的参考可能做成 13 页（某页复制多份），也可能单栏改双栏、3 条特性扩成 7 条、删掉示意图。任何「原型 → 实例」的强映射都撑不住这种自由度
3. **占位符机制是多余的。** 内联 `{{key}}` 之类的槽位体系，在「允许任意偏离」的前提下没有意义——用户本来就要改结构，槽位反而成了绊脚绳
4. **抽取流水线成本高、收益不确定。** 页面签名、结构去重、角色分类、LLM 兜底标注——这套机器要运转起来不容易，而它解决的「自动提炼」问题，在骨架阶段根本不需要

**替代方案更简单也更强**：不做「模板」这个产品概念，只做两件事——

- **引用资料**（§6.1，架构概念，必须有）
- **从参考文档复制内容 + 自由改造**（§6.3–6.5，技能 + 现有工具，不需要新格式）

### 6.3 「抽离参考」：一个对话驱动的过程

模板不是预先安装的资产，而是**需要时临时抽出来的一份参考**：

```
用户：把 references/年度汇报.pptx 的样式抽出来看看

agent（用 Read + slide_read 读那份只读 PPT）
  → 产出一份人可读的参考说明，落在工作空间里，如：
     参考/年度汇报-风格参考.md

内容例如：
  - 整体：16:9，深蓝主色 #1A3A6B，标题思源黑体 Bold
  - 页面类型清单（观察到 7 种）：
      封面（大标题 + 副标题 + 右下角 logo）
      目录（左侧编号列表）
      章节页（色块 + 大号数字）
      要点列表（标题 + 3~5 条项目符号）
      数据页（标题 + 折线图 + 结论文字条）
      鱼骨图页（因果分析）
      致谢页
  - 每种类型：元素布局描述 + 文字量级 + 配色用法
  - 备注：第 12 页与第 5 页结构相同，属同类页

用户看过，觉得好 → 说"照这个做一份 13 页的 XX 汇报"
```

**关键点**：

- 这是**技能（skill）**，不是引擎模块——本质是提示词 + 现有读工具的组合，不需要新格式、不需要新引擎代码
- 产物是**普通 Markdown 文件**，人可读、可改、可重做。不是新数据格式，没有 schema
- **每次需要时就做一次**。不维护一个「模板库」，也就不存在「模板目录放哪」的问题
- 用户**先看再决定用不用**——这正是他要的「用户先去看一看」

### 6.4 从参考到成品：复制 + 改造

「依赖这个参考去生成文档」的实际机制是**内容复制**，不是格式套用：

```
agent:
  1. 读 参考/年度汇报-风格参考.md（了解风格意图）
  2. 从只读参考复制几个典型页进来作为起点：
       slide_insert_from_file({ source: "references/年度汇报.pptx",
                                pages: [1, 3, 5], atIndex: 0,
                                keepSourceLayout: true })
  3. 按新内容自由改造：
       - 复制页 5 做成 4 个变体（原 3 条特性 → 各自的 5 条）
       - 某页单栏改双栏（slide_apply_ops / slide_execute_script）
       - 删掉某页里的示意图（slide_apply_ops 删元素）
       - 新增原参考里没有的页型（slide_add_page）
  4. 补足到 13 页
```

**没有任何一步在「检查是否符合模板」**。参考只是起点的素材和风格依据。

各文档类型都走同一套：

| 类型   | 复制机制                 | 现有实现                                                                              |
| ------ | ------------------------ | ------------------------------------------------------------------------------------- |
| slides | `slide_insert_from_file` | `insertSlidePptx` / `mergeSlideFromSource`（已存在，有测试）                          |
| docs   | `doc_insert_from_file`   | `Block.originalXml` + patch 机制（原语已具备）                                        |
| sheets | `sheet_insert_from_file` | `merge_attached_workbooks`（已存在，`apps/sheets/src/renderer/ai/merge-skill.ts:42`） |

### 6.5 灵活性是刻意保留的能力

明确记录为设计要求（防止后续实现时"顺手"收紧）：

| 场景                   | 允许 | 说明                    |
| ---------------------- | ---- | ----------------------- |
| 参考 7 页 → 成品 13 页 | ✅   | 某页可复制多份          |
| 3 条特性 → 7 条特性    | ✅   | 列表项数随时可改        |
| 单栏 → 双栏            | ✅   | 布局可重构              |
| 删掉参考里的示意图     | ✅   | 元素可自由增删          |
| 成品与参考观感差异很大 | ✅   | 只要用户认可就行        |
| 参考文档被原地修改     | ❌   | 只读，硬约束（见 §0.1） |

---

## 7. 工作空间

### 7.1 目录结构

```
<workspace-dir>/
├── .git/                          # 本地版本控制（version_* 工具集操作它）
├── .workspace/
│   ├── manifest.json              # 工作空间清单
│   ├── conversations.json         # 对话索引（轻量元数据）
│   ├── sessions/                  # pi-agent 会话持久化
│   │   └── <conversationId>.jsonl
│   └── index.db                   # 可选：SQLite（全文搜索）
├── references/                    # 只读引用区（软链接指向集中资料库）
│   ├── 公司资质 -> <userData>/references/公司资质
│   └── 年度汇报.pptx -> <userData>/references/汇报模板样例/年度汇报.pptx
├── 参考/                          # 抽离出的参考说明（可写，普通 md）
│   └── 年度汇报-风格参考.md
├── 技术方案.docx
├── 报价表.xlsx
├── 演示稿.pptx
├── 参考资料/
│   └── 招标文件.pdf               # 导入的副本（可写）
└── .gitignore
```

**`references/` 与 `参考资料/` 的区别**（容易混淆，刻意分开）：

| 目录          | 内容                                     | 可写    | 是否复制        |
| ------------- | ---------------------------------------- | ------- | --------------- |
| `references/` | 软链接挂进来的外部只读资料（公司级公用） | ❌ 只读 | ❌ 链接，不复制 |
| `参考资料/`   | `fs_import` 复制进来的项目内文件         | ✅ 可写 | ✅ 副本         |

**为什么 manifest 用 JSON**：与 TypeBox / JSON Schema 体系一致，工具直接读写，无解析依赖。**为什么会话历史用 jsonl**：便于流式追加与崩溃恢复（与 pi-agent 的持久化形态对齐）；SQLite 只在需要跨会话全文搜索时启用。

### 7.2 工作空间清单（`manifest.json`）

```jsonc
{
  "schemaVersion": 1,
  "id": "ws-01J8X...",
  "name": "XX 医院综合楼投标",
  "goal": "编写并完成 XX 医院综合楼施工投标文件（技术标 + 商务标 + 演示稿）",
  "createdAt": "2026-09-26T10:00:00Z",
  "updatedAt": "2026-09-26T12:30:00Z",

  // 只读引用资料（软链接）
  "references": [
    {
      "name": "公司资质",
      "link": "references/公司资质",
      "target": "<userData>/references/公司资质",
      "readOnly": true,
    },
    {
      "name": "年度汇报",
      "link": "references/年度汇报.pptx",
      "target": "<userData>/references/汇报模板样例/年度汇报.pptx",
      "readOnly": true,
    },
  ],

  "documents": [
    {
      "id": "doc-1",
      "path": "技术方案.docx",
      "type": "docx",
      "note": "投标技术方案正文", // 自由文本，非受控枚举
      "addedAt": "2026-09-26T10:01:00Z",
      "source": { "kind": "new" },
    },
    {
      "id": "doc-2",
      "path": "参考资料/招标文件.pdf",
      "type": "pdf",
      "note": "招标方原始文件",
      "source": { "kind": "imported", "from": "~/Downloads/招标文件.pdf" },
    },
  ],

  "conversations": [
    {
      "id": "conv-1",
      "title": "撰写技术方案正文",
      "scope": ["doc-1"],
      "createdAt": "2026-09-26T10:05:00Z",
    },
    {
      "id": "conv-2",
      "title": "校验所有文档格式一致性",
      "scope": ["doc-1", "doc-2"],
      "createdAt": "2026-09-26T11:20:00Z",
    },
  ],

  "settings": { "language": "zh-CN", "theme": "light", "autoSave": true },

  "vcs": { "enabled": true, "remote": null, "branch": "main" },
}
```

注意 `documents[].note` 是**自由文本**，不是受控角色枚举——文档用途由用户/agent 随手标注即可，不引入需要维护的语义体系。

### 7.3 会话模型

**决策：每个 conversation 一个独立的 pi-agent `Agent` 实例。**

```
Workspace
├── conversation "撰写技术方案"  → Agent#1（独立 messages / tools / 上下文）
│                                    activeDocument: 技术方案.docx
├── conversation "校验格式"      → Agent#2（独立 messages / tools / 上下文）
│                                    scope: 全部文档
└── conversation "做演示稿"      → Agent#3
                                     activeDocument: 演示稿.pptx
```

理由：

- 一个空间内不同对话 = 不同任务 = 上下文必然不同，硬要共享会话会互相污染
- 一个对话可跨多个文档（如「校验所有文档格式一致性」），所以「文档 ↔ 对话」不是一对一
- 每个 Agent 独立可并存，切换对话 = 切换 Agent 实例，无需重建上下文

**成本控制**：Agent 实例本身很轻（状态 + tool 列表）；重的是模型上下文。空闲对话不持 LLM 连接，只有活跃对话在流式请求。可设同时活跃上限（具体数字属颗粒度问题，实测再定）。

**agent 如何感知当前激活文档**：**push 为主 + 显式目标为辅**，两者都要：

| 机制               | 说明                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **push**（主）     | 用户切换标签页 → shell 通知 harness → harness 更新 `ToolContext.activeDocument` → 下一次工具调用即拿到新值；同时注入一条「当前激活文档已切换到 X」的提示 |
| **显式目标**（辅） | 所有 Document 工具接受可选 `document` 参数（路径或 id），指向非激活文档。跨文档任务（如「把技术方案的第四章同步到演示稿」）必须靠它                      |

显式目标参数继承现有 shell MCP 的经验（内容工具已采用可选 `document` 参数指向已打开 tab，`open_documents` 支持 list/read/close）。

---

## 8. 端到端示例：写标书

```
[0] 挂载只读公司资料（一次性）
   → fs_add_reference({ externalPath: "<userData>/references/公司资质" })     effect: workspace
   → 文件树出现只读的「公司资质」；工具层拒绝任何写入

[1] 创建工作空间
   用户："我要写 XX 医院综合楼的标书"
   → workspace_create({ goal: "..." })                                       effect: workspace
   → 文件树可写区初始为空

[2] 导入项目资料
   用户："这是招标文件" + 拖入 PDF
   → fs_import({ externalPath: "...", destDir: "参考资料" })                  effect: workspace
   → 注意：是副本，可写（与 references/ 的链接不同）

[3] 抽取风格参考（可选，用户想要时才做）
   用户："参考一下 references/年度汇报.pptx 的样式"
   → agent 读只读PPT（slide_read 逐页）→ 产出 参考/年度汇报-风格参考.md
   → 用户看过认可

[4] 让 AI 读懂招标要求（在"撰写技术方案"对话里）
   → pdf_read({ document: "参考资料/招标文件.pdf" })                          effect: query
   → pdf 只有预览能力 → 走 pdf_read，不做编辑

[5] 填充技术方案
   → doc_get_context()                                                       effect: query
   → doc_insert_content({ afterBlockIndex, html })  × N 章                   effect: mutation
        postState: 插入范围 + 最新 outline
        → 每次 mutation 后编辑器自动重绘，AI 不需要调渲染工具
   → 若参考了历史标书：
        doc_insert_from_file({ source: "references/历史标书/2025-XX医院投标.docx",
                               blockRange: [40, 65], afterBlockIndex: 12 })    effect: mutation
        → 复制进来的是独立副本，随后随意改

[6] 做演示稿（切到"做演示稿"对话 —— 上下文自动隔离）
   → slide_insert_from_file({ source: "references/年度汇报.pptx",
                              pages: [1, 3, 5], atIndex: 0,
                              keepSourceLayout: true })                      effect: mutation
        → 画布自动显示复制的 3 页
   → 自由改造：
        - 复制页 5 做成 4 个变体，各自填充不同内容
        - 某页单栏改双栏（slide_execute_script）
        - 删掉某页里多余的示意图（slide_apply_ops）
   → 补足到 13 页

[7] 调整界面
   用户："界面换成中文"
   → ui_set_language({ locale: "zh-CN" })                                    effect: ui_control
        → shell 立即切换语言

[8] 保存版本（仅显式触发，无自动保存）
   用户："保存一个版本"
   → version_save({ message: "初稿：技术方案 + 演示稿" })                      effect: workspace
        → git add -A && git commit
   → version_push()（若已配置 remote，可选）
```

**注意**：全流程没有一次 render/preview 调用；全流程也没有一次「检查是否符合模板」；`references/` 全程只读。

---

## 9. v1 验收标准

| #   | 验收项                                                         | 验证方式                                         |
| --- | -------------------------------------------------------------- | ------------------------------------------------ |
| 1   | 能创建带目标的工作空间，磁盘上生成正确目录结构                 | 检查目录 + manifest.json                         |
| 2   | 能把外部资料软链接挂进 `references/`，且**工具层拒绝写入**     | 尝试 `fs_move`/`fs_delete` 引用路径 → 报错       |
| 3   | 引用资料源文件更新，工作空间内立即看到最新版（因为不是副本）   | 改源文件 → 重开引用文档                          |
| 4   | AI 能在可写区创建文档、导入文件（副本）、移动重命名            | 文件树与磁盘一致                                 |
| 5   | AI 能对 docs 执行插入/替换/格式化，**UI 自动反映，无渲染工具** | 操作后编辑器即时更新                             |
| 6   | AI 能对 slides 执行脚本化编辑与加页                            | 同上                                             |
| 7   | **能从只读参考文档复制页面/内容块进当前文档，并自由改造**      | 复制 3 页进新 PPT → 改结构 → 页数/布局与参考不同 |
| 8   | AI 能切换界面语言与主题                                        | UI 实际变化                                      |
| 9   | 变更类工具都返回可用 `postState`，agent 无需紧接 read          | 检查会话轨迹中无 mutate→read 乒乓                |
| 10  | 一个工作空间内可开多个对话，上下文互不污染                     | 对话 A 的上下文不出现在对话 B                    |
| 11  | 工具重名会抛错（不静默覆盖）                                   | 单测                                             |
| 12  | `version_save` 能提交整个工作空间变更，且**只由显式触发**      | `git log` 有记录；无自动提交（v2）               |

**必须通过的既有测试**：迁移后 `apps/docs/tests`、`apps/slides/tests`（含 `layout-tools.test.ts`、`slide-script.test.ts` 安全边界）全部保持绿色。

---

## 10. 风险

| #   | 风险                                                                                               | 应对                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **文档工具迁移量大**（docs 37 + slides 18 + 其他 80+）                                             | 只改注册方式与命名，实现逻辑不动；按工具集分批迁移，每批保持测试绿                                                              |
| 2   | **只读约束可能被绕过**（编辑器侧或新工具忘记检查）                                                 | 工具层集中拦截 + 单测覆盖每个写工具对 `references/` 的拒绝                                                                      |
| 3   | **`*_insert_from_file` 的跨文档格式继承**（源文档样式在目标文档可能不存在）                        | 复用现有 `keepSourceLayout` 的「源格式 / 目标主题」两模式；docs 侧走 `Block.originalXml` 保真复制                               |
| 4   | **`postState` 的设计可能过重**（全量 outline 每轮都进上下文）                                      | 分级：小工具返回受影响片段，大工具返回摘要 + 按需展开；v1 先做，用真实会话调优                                                  |
| 5   | **多 Agent 实例的资源占用**                                                                        | 空闲 Agent 不持连接；会话落 jsonl，暂停时释放；上限数字属颗粒度，实测再定                                                       |
| 6   | **软链接在 Windows 上的行为差异**                                                                  | 仅 Electron 桌面端已定；Windows 需处理创建权限，v1 可降级为「复制 + 记录来源并标记只读」                                        |
| 7   | **现有 MCP Server 与新工具集的契约分叉**（`insert_content` 的 `afterBlockIndex` 默认值在两处不同） | 迁移时统一为单一实现；MCP Server 改为调用新实现，消除分叉                                                                       |
| 8   | **pi-agent 不内置 MCP Client / Sub-agent / Turn 上限**（见重构计划 §4.2.4）                        | v1 不需要 MCP Client（能力通过 Tool Set 直接注册）；Sub-agent 只预留 orchestrator tool 位置；Turn 上限用 `finishTurn` hook 计数 |

---

## 11. 骨架跑起来之后的下一步

本 PRD 到「骨架能跑」为止。以下**刻意不设计**，等实测后按需决定：

- 颗粒度数字（同时几个对话、版本保留几个、搜索范围多大）
- 参考抽取的产物形态（Markdown 是否够用，要不要生成一份「样式样例.pptx」）
- 是否需要一个「常用参考」的快捷入口
- Sub-agent 编排、外部 MCP 接入、协作
- 任何形式的自动保存 / 自动版本
