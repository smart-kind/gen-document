# GenOffice 重构方案：从 Office 套件到目标驱动的智能文档工作空间

> 状态：草案（待补充标书 SOP、参考资料后完善）
> 日期：2026-09-25
> 配套文档：`design-docs/implementation-prd.md`（实现规格：Tool Set 定义、模板格式、模板提取流水线）

## 1. 背景

GenOffice 当前是一个 Electron 桌面应用，提供类 Office 的文档编辑能力，包含 6 种文档类型的编辑器：

- **Docs** — Word 文档编辑（Tiptap + OOXML）
- **Sheets** — Excel 表格编辑（IronCalc Rust engine）
- **Slides** — PPT 演示文稿编辑
- **PDF** — PDF 阅读与标注
- **Markdown** — Markdown 编辑
- **HTML** — HTML 页面编辑

每个编辑器作为独立的 Electron WebContentsView 运行，通过一个轻量 Shell（tab strip + Home 页）组织在一起。每个编辑器内嵌了 AI Panel，可以在文档内部执行编辑操作（加内容、改格式、调结构等）。

## 2. 问题

当前架构的核心矛盾：**按文档类型组织 vs 按工作目标组织**。

| 维度        | 当前                          | 目标                                                |
| ----------- | ----------------------------- | --------------------------------------------------- |
| 组织方式    | 一个 tab = 一个文档，按类型分 | 一个工作空间 = 一个目标，内含多种类型文档           |
| AI 作用范围 | 编辑器内部（改文字、加表格）  | 整个应用（创建空间、管理文件、控制 UI、跨文档协调） |
| 模板/技能   | 通用文档编辑技能              | 按目标定制的模板和技能集（标书、工作计划等）        |
| 文件管理    | 无（单文档操作）              | 工作空间内的多文档管理                              |
| 应用控制    | 用户手动操作                  | AI 可控制 UI 外观、语言、布局等                     |

典型场景：用户要写一份标书，需要同时管理技术方案（docx）、报价表（xlsx）、演示稿（pptx）、参考资料（pdf），这些分散在不同 tab 里，没有统一的目标上下文把它们组织起来。

## 3. 目标架构

### 3.1 整体分层

```
┌─────────────────────────────────────────────────────┐
│  业务 Shell（新建）                                   │
│                                                     │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │              │  │  工作空间视图                   │ │
│  │  聊天/指令面板 │  │                              │ │
│  │              │  │  ┌────────────────────────┐   │ │
│  │  AI Harness  │  │  │ 文件树 / 文档列表       │   │ │
│  │  调度各层     │  │  │ ┌─ 标书/              │   │ │
│  │  Tool Set    │  │  │ │  技术方案.docx       │   │ │
│  │              │  │  │ │  报价表.xlsx         │   │ │
│  │              │  │  │ │  演示稿.pptx         │   │ │
│  │              │  │  │ │  参考资料.pdf        │   │ │
│  │              │  │  │ └─ ...                │   │ │
│  │              │  │  └────────────────────────┘   │ │
│  │              │  │                              │ │
│  │              │  │  [嵌入的编辑器区域]            │ │
│  │              │  │  点击文档 → 加载对应 engine    │ │
│  └──────────────┘  └──────────────────────────────┘ │
│                                                     │
│  ┌──────────────────────────────────────────────────┐│
│  │  模板 / 技能库（按目标类型组织）                    ││
│  │  标书模板 | 工作计划模板 | ...                     ││
│  └──────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────┤
│  GenOffice Engines（复用层）                          │
│  docs-engine | sheets-engine | slides-engine | ...   │
│  （纯数据处理 + 编辑器渲染，通过 WebContentsView 嵌入） │
└─────────────────────────────────────────────────────┘
```

### 3.2 AI Harness：分层 Tool Set

AI 的能力不是一个扁平的工具列表，而是分层的、可扩展的 Tool Set 体系：

```
AI Harness
│
├── Workspace Tool Set          — 工作空间生命周期管理
│   ├── create_workspace(goal, template)
│   ├── switch_workspace(id)
│   ├── configure_workspace(settings)
│   └── ...
│
├── File System Tool Set        — 工作空间内的文件管理
│   ├── add_document(type, template?)
│   ├── move_document(id, path)
│   ├── import_file(external_path)
│   ├── export_workspace(format)
│   └── ...
│
├── Document Tool Set           — 文档内容编辑（已有）
│   ├── insert_paragraph / table / image
│   ├── modify_style / format
│   ├── restructure / reorder
│   └── ...
│
├── UI Appearance Tool Set      — 应用界面控制
│   ├── set_language(locale)
│   ├── set_theme(mode)
│   ├── toggle_panel(visibility)
│   ├── set_layout(mode)
│   └── ...
│
├── Version Control Tool Set    — 工作空间版本管理（未来）
│   ├── save_version(message?)    // git commit 当前 workspace 所有变更
│   ├── list_versions()           // 查看历史版本
│   ├── diff_version(version_id)  // 对比某版本与当前状态
│   ├── rollback(version_id)      // 回滚到指定版本
│   ├── push(remote?)             // 推送到远程仓库（如已配置）
│   └── ...
│
│   说明：workspace 文件夹本身是一个 git 仓库。AI 根据用户指令
│   （如"保存一个版本"、"回退到上个版本"）调用这些 tool。
│   本地 commit 即可工作；配置远程仓库后可推送实现多人协作。
│
└── ??? Tool Set                — 未来按需扩展
    ├── collaboration?
    ├── version_control?
    └── ...
```

每层 Tool Set 独立定义接口，AI 根据用户指令在不同层级调度。

### 3.3 Tool Effect Taxonomy：渲染不是 tool，是框架的副作用

**现状（已核实）**：现有 genoffice **不存在** `render` / `preview` / `refresh` 类工具（全仓搜索 0 命中）。各编辑器采用的是「工具直接写活的模型 → 框架响应式重绘」：docs 直接 dispatch ProseMirror transaction（Tiptap 自动重绘）、slides 用 `access.applySlide` 写回 React state、sheets 走 `applyChangePlan`（Univer 自动刷新）。

**但这个模式没有形式化**——它是各 app 各自临时实现的隐式约定：

- 没有统一的副作用声明，每个 app 自己决定写完之后通知谁
- slides 的 MCP 路径需要**手工**推送变更通知（`apps/shell/src/main/mcp/slides-bridge.ts:162` 注释：因为 MCP 没有发起 renderer）
- 跨 app 无法保证一致性，新增工具集时没有可依赖的规则

因此设计目标不是「修复一个错误」，而是**把隐式约定升级为显式契约**：工具声明 `effect`，框架统一分发。这样新增工具集只要声明 effect，渲染同步自动获得。

另一个相关的真实低效模式是 **mutate → read 乒乓**：变更工具返回信息不足，agent 必须再调一次读工具才能继续（slides 的布局审计回喂、sheets 的写后 300ms 回读、pdf 改页后必须重读、块索引改完即失效）。应对方式见下方 effect taxonomy 之外的第二条原则——**变更类工具必须返回足够的 `postState`**。

**新 harness 的设计原则：按 effect 分类，框架自动处理副作用。**

```
Tool Effect Taxonomy
│
├── mutation    — 修改文档状态（insert_content, replace_blocks, format, ...）
│                 → 框架自动触发 editor 刷新（debounced）
│                 → AI 完全无感知
│
├── query       — 纯读取，无副作用（get_content, search, list_styles, ...）
│                 → 返回数据给 AI，不触发 UI 变化
│
├── ui_control  — 改变应用 UI 状态（set_theme, set_language, toggle_panel, ...）
│                 → 框架自动 apply 到 shell
│
└── workspace   — 结构性变更（create_workspace, add_file, move_file, ...）
                  → 框架自动更新文件树等 UI 组件
```

**实现方式：**

- pi-agent 有 `afterToolCall` hook — 在每个 tool 执行后触发
- 我们在 hook 里检查 tool 声明的 effect 类型
- `mutation` → 发 `document_changed` 事件 → 活跃编辑器订阅并 debounced 重绘
- `ui_control` → 发 `ui_state_changed` 事件 → shell 响应
- `workspace` → 发 `workspace_structure_changed` 事件 → 文件树等组件刷新
- AI 完全不知道渲染这回事 — 它改内容，用户立刻看到

**Tool 注册时声明 effect：**

```ts
const insertContent: AgentTool = {
  name: "insert_content",
  effect: "mutation",  // ← 框架据此自动处理 UI 同步
  description: "...",
  parameters: Type.Object({ ... }),
  execute: async (...) => { ... },
};
```

**边界情况：**

- **连续多次 mutation** → debounced 渲染（如 100ms 窗口），不逐次刷
- **mutation 发生在非活跃文档** → 不立即渲染，但状态已持久化；用户打开时自然看到最新
- **"先草拟再确认"场景** → 这是另一个 UX 模式（propose/accept），和 tool effect 无关，在 UI 层处理

**结论：AI 的 tool set 里不应该有任何 `render` / `preview` / `refresh` 类的工具。渲染是框架的副作用，不是 AI 的决策。**

**配套原则——变更类工具必须返回 `postState`：** 每个 `effect: "mutation"` 的工具都要返回变更后的结构化摘要（受影响的对象 id、新结构、最新大纲、工具内部自检发现的问题），使 agent 无需紧接一次 read 调用即可继续决策。`postState` 进 LLM 上下文，`display` 只进 UI（如渲染缩略图），两者分工明确。

> 详细的工具契约、effect 分发实现、以及全部 Tool Set 的逐条定义，见 `design-docs/implementation-prd.md` §4。

### 3.4 工作空间模型

```
Workspace（= 磁盘上一个文件夹）
├── goal: string              // "写标书"、"季度工作计划"...
├── template: TemplateRef     // 关联的模板配置（数据，不是架构选择）
├── conversations: Conversation[]
│   ├── id, title, created_at
│   ├── agent_session_id      // pi-agent 会话状态标识
│   ├── scope: DocumentRef[]  // 本对话涉及的文档（可跨多个）
│   └── messages: Message[]   // 对话历史
├── documents: Document[]     // 空间内的文档列表
│   ├── id, name, type
│   ├── path (空间内相对路径，或软链接 → 外部路径)
│   └── metadata
├── settings: WorkspaceConfig // 空间级配置（语言、主题等）
└── created_at, updated_at

Conversation（对话 = 一次任务上下文）
├── 一个 workspace 内可有多个 conversation
├── 每个 conversation 对应一个独立的 pi-agent 会话
├── 可涉及 1 个或多个 document
└── 示例："创建技术方案文档"、"校验所有文档格式"、"调整报价表数据"

Template（模板 = 配置数据）
├── id: string
├── name: string              // "建筑工程标书"
├── goal_hint: string         // 适用目标描述
├── document_specs: Spec[]    // 预定义的文档组合
│   ├── type: "docx" | "xlsx" | "pptx" | "pdf" | "md"
│   ├── role: string          // "技术方案"、"报价表"...
│   └── skeleton?: Blob       // 可选的初始内容骨架
└── skills: SkillRef[]        // 关联的 AI 技能引用

存储形态：
├── workspace 文件夹根目录有 manifest（描述 workspace 元数据）
├── 文档文件直接存放在文件夹内
├── 可有软链接指向跨工作区公用文件
└── 可选 SQLite 存放结构化数据（会话索引、搜索索引等）
```

## 4. AI Harness 替换：从自研 Agent Loop 到 pi-agent SDK

### 4.1 现状分析

当前 AI 系统完全自研，核心在 `packages/agent-core/src/loop.ts`（~830 行手写 ReAct 循环）。

| 组件           | 现状                                                                 | 评估                               |
| -------------- | -------------------------------------------------------------------- | ---------------------------------- |
| Agent Loop     | 手写 ReAct，turn cap 100，历史压缩，失败回滚                         | 健壮但重复造轮子                   |
| AI Provider 层 | 19 个 provider，4 种协议（Anthropic/Gemini/OpenAI-compatible/Codex） | 有价值，pi-ai 覆盖 ~35 个 provider |
| Tool 系统      | 各 app 各自定义，手写 switch 分发，无统一注册中心                    | 分散，不可扩展                     |
| Skill 系统     | `AgentSkill` 接口 + `composeSkills()` 源码级静态组合                 | 不支持动态加载                     |
| MCP            | 只做 Server（暴露能力给外部），不做 Client                           | 不能连接外部 MCP 工具              |
| Sub-agent      | 仅 Slides QC 硬编码了一个 page 一个 AgentLoop                        | 基本没有                           |
| 深度思考       | 被动接收 reasoning token，不主动请求；DeepSeek 甚至强制关闭 thinking | 不支持                             |
| 外部能力集成   | web_search 等功能硬编码在 tool 里                                    | 不可配置，不可插拔                 |

### 4.2 pi-agent SDK 调研结果

#### 4.2.1 包来源与维护

| 项目      | 信息                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------ |
| 包名      | `@earendil-works/pi-agent-core`（agent loop）+ `@earendil-works/pi-ai`（provider 层）            |
| 版本      | v0.87.1（2026-09-22）                                                                            |
| 许可证    | MIT                                                                                              |
| 仓库      | [github.com/earendil-works/pi](https://github.com/earendil-works/pi)（monorepo）                 |
| 文档站    | [pi.dev](https://pi.dev) → [pi.dev/docs](https://pi.dev/docs)                                    |
| 维护者    | Mario Zechner（badlogic，libGDX 作者）、Armin Ronacher（mitsuhiko，Flask/Jinja 作者）、rwachtler |
| Node 要求 | >=22.19.0，ESM-only                                                                              |

monorepo 家族：

| 包                                               | 职责                                                                                 | 我们用不用                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------ |
| `@earendil-works/pi-ai`                          | 统一多 provider LLM API（~35 个 provider）                                           | ✅ 用                          |
| `@earendil-works/pi-agent-core`                  | Agent loop + tool 执行 + 状态管理                                                    | ✅ **主力**                    |
| `@earendil-works/pi-coding-agent`                | 交互式 `pi` CLI，内置编码工具（bash、read、write、edit）、编码 skill、文件系统操作等 | ❌ **不用**                    |
| `@earendil-works/pi-tui`                         | 终端 UI 库                                                                           | ❌ 不用（我们是 Electron GUI） |
| `@earendil-works/pi-telemetry`                   | 遥测                                                                                 | 可选                           |
| `@earendil-works/chord`                          | 应用组合运行时（RPC/插件/facet）                                                     | 可选                           |
| `@earendil-works/pi-durable`                     | 持久化会话/任务/文档运行时                                                           | 可选                           |
| `@earendil-works/pi-session-backend-sqlite-node` | SQLite 会话持久化                                                                    | 可选                           |

**为什么用 `pi-agent-core` 而不用 `pi-coding-agent`：**

`pi-coding-agent` 是面向编码场景的上层封装，内置了 bash 执行、文件读写、diff 编辑等编码工具，以及编码 skill（代码搜索、重构、测试等）。我们的场景是**文档撰写**，不是编码。引入 pi-coding-agent 会带来：

- 不需要的编码工具集（bash、file_read、file_write、diff_edit 等），污染 tool 列表，增加 LLM 选择错误工具的风险
- 编码领域的 system prompt 和 skill，与文档撰写场景无关
- 更大的依赖体积

`pi-agent-core` 是一个**干净的 agent 运行时**——只有 loop、tool 注册、流式事件、思考、压缩、hook。它不预设任何业务场景，我们在这个干净的基础上注册自己的 Tool Set（Workspace / File System / Document / UI Appearance），保持整个系统清亮、可控、可扩展。

这也是 pi 项目的设计哲学——"primitives, not features"：core 提供原语，上层场景自己组装。

#### 4.2.2 Agent 类 API 概要

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

// 1. 创建 models 注册 provider
const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6");

// 2. 创建 agent
const agent = new Agent({
  initialState: {
    systemPrompt: "你是一个文档撰写助手。",
    model,
    thinkingLevel: "medium",        // off|minimal|low|medium|high|xhigh|max
    tools: [],                      // AgentTool[]
    messages: [],
  },
  streamFn: models.streamSimple.bind(models),  // 必需：注入流式调用
  transformContext: async (msgs, signal) => ..., // 上下文裁剪/压缩
  toolExecution: "parallel",                    // parallel | sequential
  beforeToolCall: async ({ toolCall, args }) => ...,  // tool 调用前钩子
  afterToolCall: async ({ toolCall, result }) => ...,   // tool 调用后钩子
  finishTurn: async ({ message, toolResults }) => ...,  // 轮次结束钩子
  thinkingBudgets: { minimal: 128, low: 512, medium: 1024, high: 2048 },
});

// 3. 使用
agent.subscribe(async (event) => { /* 事件流：agent_start, turn_start, message_*, tool_*, ... */ });
await agent.prompt("帮我写一份技术方案");
agent.steer("调整一下结构");  // 中途插入指令
await agent.waitForIdle();
```

Tool 注册方式：

```ts
import { Type } from 'typebox'

const myTool: AgentTool = {
  name: 'create_workspace',
  label: '创建工作空间',
  description: '创建一个新的文档工作空间',
  parameters: Type.Object({
    goal: Type.String({ description: '工作目标' }),
    template: Type.String({ description: '模板 ID' }),
  }),
  execute: async (toolCallId, params, signal, onUpdate) => {
    // 实现逻辑
    return { content: [{ type: 'text', text: '已创建' }], details: {} }
  },
}
agent.state.tools = [...existingTools, myTool]
```

#### 4.2.3 pi-ai Provider 覆盖

`createModels()` 返回 `MutableModels` 接口，支持动态注册/注销 provider。内置 ~35 个 provider 工厂：

- **主流**：OpenAI、Anthropic、Google、Azure OpenAI、Amazon Bedrock、Vertex AI
- **推理/快速**：Groq、Cerebras、xAI、Mistral、Fireworks、Together AI
- **国内/亚太**：DeepSeek、Moonshot AI (Kimi)、Qwen Token Plan、MiniMax、Meta、Xiaomi MiMo、Kimi For Coding
- **网关/聚合**：OpenRouter、Cloudflare AI Gateway、Vercel AI Gateway、NVIDIA NIM
- **自定义**：任何 OpenAI-compatible API（Ollama、vLLM、LM Studio 等）→ `createProvider()`

对比 genoffice 现有 19 个 provider：pi-ai 覆盖更广，且通过 `createProvider()` 可接入任意 OpenAI-compatible 端点，现有 provider 配置可迁移。

#### 4.2.4 能力与缺失——关键发现

**内置能力：**

| 能力            | 支持情况   | 说明                                                                            |
| --------------- | ---------- | ------------------------------------------------------------------------------- |
| Agent Loop      | ✅         | 完整的 LLM → tool → LLM 循环                                                    |
| Tool 注册与执行 | ✅         | TypeBox schema，parallel/sequential 可选                                        |
| 流式事件        | ✅         | agent_start → turn_start → message_* → tool_* → turn_end → agent_end            |
| 深度思考        | ✅         | 7 级 thinkingLevel + 自定义 thinkingBudgets                                     |
| 上下文压缩      | ✅         | shouldCompact / compact / prepareCompaction / estimateContextTokens             |
| 中途介入        | ✅         | steer（打断 tool 间）+ followUp（排队等当前轮结束）                             |
| 重试策略        | ✅         | RetryPolicy：maxRetries 3, baseDelayMs 1000                                     |
| 会话持久化      | ✅（可选） | pi-durable + pi-session-backend-sqlite-node                                     |
| Hook 体系       | ✅         | beforeToolCall / afterToolCall / finishTurn / prepareRequest / transformContext |

**刻意不内置的能力（需自建或社区扩展）：**

| 能力                | 状态      | 我们的应对                                                                                       |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| **MCP Client**      | ❌ 不内置 | 使用社区包 `pi-mcp-adapter`（~1.5k★, ~89k 月下载）或自行编写 adapter 将 MCP 工具注册为 AgentTool |
| **MCP Server**      | ❌ 不内置 | genoffice 已有的 MCP Server 保持不变，独立运行                                                   |
| **Sub-agent 编排**  | ❌ 不内置 | 哲学是 "primitives, not features"；可自行实现：创建多个 Agent 实例 + 通过 tool 调度              |
| **Turn/Token 上限** | ❌ 不内置 | 通过 `finishTurn` hook 自行计数实现                                                              |
| **权限/沙箱**       | ❌ 不内置 | 宿主（Electron）层面控制，不依赖 agent                                                           |

### 4.3 替换决策

**用 `pi-agent-core`（不是 `pi-coding-agent`）+ `pi-ai` 替换自研的 agent loop 和 tool 调度层。**

选型原则：**干净、可扩展、不沾染编码场景。**

- `pi-agent-core` 是纯 agent 运行时原语——loop、tool、event、thinking、compaction、hook。零业务预设，我们自己的 Tool Set 是唯一的业务层
- `pi-coding-agent` 面向编码，内置 bash/file_read/file_write/diff_edit 等编码工具和编码 skill，与文档撰写无关，引入只会增加 LLM 的干扰项和依赖体积
- pi 的设计哲学 "primitives, not features" 正好契合我们的需求：底层干净，上层自由组装

替换理由：

- GenOffice 的核心业务是**文档处理**，不是 agent 框架。在 agent loop 上自研是偏离核心业务
- pi-agent 已具备成熟的 agent 循环、provider 体系（~35 个，覆盖现有 19 个 + 更多）、深度思考（7 级）、上下文压缩、流式事件——这些不需要重新实现
- Hook 体系（beforeToolCall / afterToolCall / finishTurn / transformContext）比硬编码的 guard rails 更灵活
- 新增 Tool Set（Workspace / File System / UI Appearance 等）在 pi-agent 体系下注册比手写 switch 分发更可维护、可扩展
- 会话持久化（pi-durable + SQLite）开箱可用

需要补充的：

- **MCP Client**：通过 `pi-mcp-adapter` 社区包或自行编写 adapter，将 MCP server 的工具注册为 AgentTool
- **Sub-agent 编排**：创建多个 Agent 实例，通过一个 "orchestrator" tool 调度子 agent（agent.state.tools 里放一个 dispatch_sub_task tool，内部创建新 Agent 并 await）
- **Turn 上限**：finishTurn hook 内计数，超限返回 `{ action: "end" }`

### 4.4 保留与替换边界

```
保留（资产）                          替换（非核心）
─────────────────────────────         ─────────────────────────────
Engine 包（docx/pptx/xlsx/...）       Agent Loop（loop.ts）
MCP Server（app-mcp.ts 及 tools）     Tool 分发机制（手写 switch）
各编辑器的 tool 实现逻辑                Skill 静态组合（composeSkills）
（insert_content, replace_blocks 等）  硬编码的外部能力（web_search 等）
Provider 协议层的经验（可迁移配置）      AgentSkill 接口定义
```

### 4.5 集成架构

```
┌──────────────────────────────────────────────────────────────┐
│  业务 Shell                                                   │
│                                                              │
│  ┌──────────────┐  ┌──────────────────────────────────────┐  │
│  │ 聊天/指令面板  │  │  工作空间视图                         │  │
│  │              │  │                                      │  │
│  │  pi-agent    │  │  文件树 + 嵌入编辑器区域               │  │
│  │  SDK         │  │                                      │  │
│  │  ┌─────────┐ │  └──────────────────────────────────────┘  │
│  │  │Agent Loop│ │                                          │
│  │  │Skills    │ │  Tool 注册（pi-agent AgentTool 接口）      │
│  │  │Hooks     │ │  ┌──────────────────────────────────┐    │
│  │  │Thinking  │ │  │ Workspace Tool Set               │    │
│  │  │Compaction│ │  │ File System Tool Set             │    │
│  │  │Retry     │ │  │ Document Tool Set                │    │
│  │  └─────────┘ │  │ UI Appearance Tool Set           │    │
│  │              │  │ [未来扩展...]                      │    │
│  │  ┌─────────┐ │  └──────────────────────────────────┘    │
│  │  │MCP      │ │                                          │
│  │  │Adapter  │ │  ← pi-mcp-adapter 或自建 adapter          │
│  │  │(Client) │ │    将外部 MCP 工具注册为 AgentTool          │
│  │  └─────────┘ │                                          │
│  └──────────────┘                                          │
├──────────────────────────────────────────────────────────────┤
│  外部 MCP Servers（即插即用）                                  │
│  搜索服务 | 知识库 | 其他第三方工具                              │
├──────────────────────────────────────────────────────────────┤
│  GenOffice MCP Server（保留，暴露给 pi-agent 及外部）           │
│  docs-bridge | slides-bridge | sheets-bridge | ...           │
├──────────────────────────────────────────────────────────────┤
│  GenOffice Engines（保留）                                    │
│  docx-engine | pptx-engine | sheets-engine | ...             │
└──────────────────────────────────────────────────────────────┘
```

关键点：

- pi-agent 通过 `pi-mcp-adapter`（或自建 adapter）作为 MCP Client 连接 GenOffice 自有 MCP Server 和外部 MCP 服务
- 新增 Tool Set 以 `AgentTool` 接口注册，用 TypeBox 定义参数 schema，并声明 `effect` 类型（见 §3.3）
- **Tool effect 自动同步**：通过 pi-agent 的 `afterToolCall` hook，框架根据 tool 的 `effect` 声明自动触发 UI 更新——mutation 触发编辑器刷新、ui_control 触发 shell 响应、workspace 触发文件树刷新。AI 不需要也不应该调用任何 render/preview 工具
- Document Tool Set 的实现逻辑（insert_content 等）迁移为 AgentTool，底层仍调用 engine
- 各编辑器内嵌的 AI Panel 也切换到 pi-agent，获得一致的 agent 体验
- Sub-agent 场景（如标书各章节并行撰写）通过 orchestrator tool 创建临时 Agent 实例实现

### 4.6 迁移风险

| 风险                                                         | 缓解                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 现有 tool 实现（30+ docs tools 等）需要适配新接口            | 逐个迁移，保持实现逻辑不变，只改注册方式（手写 switch → AgentTool 对象）             |
| AI Provider 配置（19 provider）需要迁移                      | pi-ai 覆盖 ~35 provider，现有 19 个全部覆盖；自定义端点用 `createProvider()`         |
| MCP 不内置                                                   | `pi-mcp-adapter` 社区包或自建 adapter，工作量可控                                    |
| Sub-agent 不内置                                             | 自建 orchestrator tool，创建 Agent 实例执行子任务                                    |
| Turn/token 上限不内置                                        | finishTurn hook 内计数，几行代码                                                     |
| 现有 guard rails（压缩、回滚、限流）需要验证 pi-agent 覆盖度 | 压缩有内置支持；回滚通过 beforeToolCall/afterToolCall 实现；限流通过 finishTurn 实现 |
| 各编辑器的 AgentLoop 实例化方式需要改造                      | 统一为一个 pi-agent 宿主，各编辑器通过 IPC 调用                                      |
| ESM-only + Node >=22.19.0 要求                               | 确认 Electron 版本是否满足；不满足则需升级 Electron                                  |

## 5. 现有代码的复用分析

### 5.1 可复用

| 层                       | 内容                                                                | 复用方式                            |
| ------------------------ | ------------------------------------------------------------------- | ----------------------------------- |
| Engine 包                | docx-engine, pptx-engine, sheets(Rust), pdf2docx, html2docx         | 原样复用，纯数据处理                |
| 各编辑器的 tool 实现逻辑 | insert_content, replace_blocks, write_document 等                   | 迁移为 pi-agent tool，底层逻辑不变  |
| 主进程模块化             | `configureDocsRuntime()` + `registerDocsIpc()` + `createDocsView()` | 已设计为可嵌入，直接调用            |
| Chrome 控制              | Present 模式（隐藏 ribbon）、Read Mode                              | CSS class 切换机制可复用            |
| MCP Server               | app-mcp.ts 及全套 bridge（docs/slides/sheets/open-documents）       | 保留，pi-agent 作为 MCP Client 接入 |

### 5.2 需要替换

| 层             | 内容                                                         | 替换为                                                         |
| -------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| Agent Loop     | `packages/agent-core/src/loop.ts`                            | pi-agent SDK（`@earendil-works/pi-agent-core`）                |
| AI Provider    | `packages/ai-provider/`（19 provider，4 协议）               | pi-ai（`@earendil-works/pi-ai`，~35 provider）                 |
| Tool 分发      | 各 app 内的手写 switch                                       | pi-agent AgentTool 注册（TypeBox schema）                      |
| Skill 系统     | `AgentSkill` 接口 + `composeSkills()`                        | pi-agent skill 管理 / 自建 skill loader                        |
| MCP Client     | 无                                                           | `pi-mcp-adapter` 社区包或自建 adapter                          |
| 深度思考       | 不支持                                                       | pi-agent 内置（7 级 thinkingLevel）                            |
| Sub-agent 编排 | 仅 Slides QC 硬编码                                          | 自建 orchestrator tool（创建 Agent 实例执行子任务）            |
| Guard Rails    | loop.ts 内硬编码（turn cap 100, history cap 40, 256KB 压缩） | finishTurn hook 计数 + transformContext 裁剪 + 内置 compaction |
| 外部能力       | web_search 等硬编码 tool                                     | 外部 MCP 服务 + pi-mcp-adapter，即插即用                       |

### 5.3 需要新建

| 层                     | 内容                             | 说明                         |
| ---------------------- | -------------------------------- | ---------------------------- |
| 业务 Shell             | 工作空间列表、文件树、指令面板   | 替代当前 tab strip + Home 页 |
| Workspace Tool Set     | 空间生命周期管理                 | 全新，pi-agent tool 接口     |
| File System Tool Set   | 空间内文件管理                   | 全新，pi-agent tool 接口     |
| UI Appearance Tool Set | 应用级 UI 控制                   | 全新，pi-agent tool 接口     |
| 模板系统               | 目标模板定义、文档组合、技能绑定 | 全新                         |
| 工作空间持久化         | 空间数据存取                     | 全新                         |

### 5.4 需要改造

| 内容                        | 改造点                                                    |
| --------------------------- | --------------------------------------------------------- |
| Shell 入口                  | 从 tab 管理改为工作空间管理                               |
| TabManager                  | 从「文档 tab」语义改为「编辑器 view 池」语义              |
| AI Panel 的触发方式         | 除了编辑器内触发，增加空间级指令入口；底层切换到 pi-agent |
| 各编辑器的 AgentLoop 实例化 | 统一为一个 pi-agent 宿主实例，通过 IPC 调用               |

## 6. 关键设计决策（已确认）

### 6.1 过渡策略：新建独立的 workspace shell

不在现有 `apps/shell` 上改造。在 `apps/` 下新建一个独立的 app（如 `apps/workspace-shell`），和现有 shell 并存，验证完后替换旧 shell。现有 shell 保持不变，不受影响。

### 6.2 目标平台：仅 Electron 桌面端

不做 Web 版。所有设计决策围绕 Electron 展开（WebContentsView 嵌入编辑器、主进程/渲染进程通信等）。

### 6.3 编辑器支持：机会性支持，不预设范围

不需要"选择支持哪些编辑器"——workspace 里有文档文件，用户点击某个文档时，系统根据 genoffice 对该文件类型的能力自动打开编辑器或 preview：

- genoffice 有编辑能力的类型（docs、sheets、slides 等）→ 打开编辑器
- genoffice 只有预览能力的类型（pdf 等）→ 打开 preview
- 未来 genoffice 新增编辑能力 → 自动可用

Agent 感知当前激活的标签页类型，调用对应的 Document Tool Set。这不是一个需要提前决定的架构问题。

### 6.4 会话模型：一个工作空间，多个对话

```
Workspace
├── conversations: Conversation[]
│   ├── id, title, created_at
│   ├── agent_session (独立的 pi-agent 会话状态)
│   ├── scope: 可能涉及 1 个或多个文档
│   └── purpose: "创建文档" / "校验文档" / "调整格式" / ...
├── documents: Document[]
└── ...
```

- 切换工作空间 → 上下文必然不同，会话自然隔离
- 同一工作空间内可以有多个对话，对应不同任务
- 一个对话可能跨多个文档（如"校验所有文档的格式一致性"）
- 每个对话是独立的 pi-agent 实例/会话

### 6.5 不做「模板系统」：只读引用资料 + 复制复用

**原设计（模板格式、模板库、页面原型、角色分类、去重、占位符化）已整体裁撤。** 理由：

1. **格式本来就不该固定。** 同类型标书每次格式都不一样，硬套模板会产出千篇一律的东西，这恰是要避免的
2. **模板与成品不是一对一。** 7 页参考可能做成 13 页、单栏改双栏、3 条特性扩成 7 条、删掉示意图——任何「原型 → 实例」的强映射都撑不住这种自由度
3. **占位符机制多余。** 允许任意偏离的前提下，槽位反而成了绊脚绳
4. **抽取流水线成本高、收益不确定。**

**替代方案（两条，都简单）**：

- **只读引用资料**：一份集中存放的物理目录（公司资质、历史标书、旧汇报 PPT），各工作空间**软链接**挂进 `references/`。不复制（避免重复与版本分叉）、对工作空间只读（数据边界硬约束）、可读可搜索、**内容可被复制进当前文档后自由改造**
- **「抽离参考」技能**：需要时从只读参考里抽一份**人可读的 Markdown 参考说明**（风格、页面类型清单），用户看过认可后照它写。产物是普通文件，无新格式，每次需要时做一次

「依赖这个参考生成文档」的机制是**内容复制**（`slide_insert_from_file` / `doc_insert_from_file` / `sheet_insert_from_file`），不是格式套用——复用现有 `insertSlidePptx` / `mergeSlideFromSource` / `merge_attached_workbooks`。

> 关键区分：**数据边界约束（只读目录不能写）是硬约束；格式约束（必须符合模板）明确不做。**

### 6.6 LLM 调用：统一接口，不区分"在线/离线"

无论调用远程 API 还是本地部署的模型，对系统来说都是 OpenAI-compatible 接口。pi-ai 的 `createProvider()` 可以指向任意端点。这不是一个需要专门设计的架构问题。

### 6.7 Workspace 存储：文件夹 + 可选 SQLite

一个 workspace = 磁盘上一个文件夹 = 一个 git 仓库，内含：

- 文档文件（docx、xlsx、pptx、pdf 等）
- manifest（描述 workspace 的元数据、目标、文档列表、引用列表）
- **`references/`（只读引用区，软链接指向集中资料库）**
- `参考资料/`（`fs_import` 复制进来的项目内文件，**可写**）
- 可选 SQLite 数据库（会话历史、索引等结构化数据）
- **自身是一个 git 仓库**（用于版本管理，见 §3.2 Version Control Tool Set）

```
workspace-xxx/
├── .git/                      （本地版本控制）
├── .workspace/
│   ├── manifest.json          （JSON，见 PRD §7.2）
│   ├── conversations.json
│   ├── sessions/*.jsonl
│   └── index.db               （可选 SQLite）
├── references/                （只读引用区 —— 软链接，不复制，不可写）
│   ├── 公司资质 -> <userData>/references/公司资质
│   └── 年度汇报.pptx -> <userData>/references/汇报模板样例/年度汇报.pptx
├── 参考/                      （抽离出的参考说明，可写的普通 md）
├── 技术方案.docx
├── 报价表.xlsx
├── 演示稿.pptx
├── 参考资料/                  （导入的副本，可写）
│   └── 招标文件.pdf
└── ...
```

**`references/` 与 `参考资料/` 必须区分清楚**：前者是链接、只读、跨空间共用；后者是副本、可写、项目私有。混在一起会导致「AI 误改公司资料」或「公司资料更新后各项目版本分叉」。

### 6.8 快照与版本管理

genoffice 编辑器本身已有文档级快照/回滚能力。在此基础上，workspace 级别通过 Git Tool Set 提供**跨文档的版本管理**：

- 用户指令 → AI 调用 `save_version` → workspace 内所有变更被 git commit
- 可选配置远程仓库 → 同时 push → 多人协作
- 编辑器内部的快照/回滚继续用于**单文档的细粒度操作历史**
- Git Tool Set 用于**工作空间级的粗粒度版本标记和回溯**

两者互补，不冲突。v1 可以不做 Git Tool Set，但架构上预留位置。

### 6.9 Tool Effect：渲染不是 AI 的 tool，是框架的副作用

AI 修改内容后不应再显式调用 render/preview 工具——这是框架的责任。每个 tool 注册时声明 `effect` 类型（mutation / query / ui_control / workspace），框架通过 pi-agent 的 `afterToolCall` hook 自动处理 UI 同步。AI 的 tool set 里不应该有任何 `render` / `preview` / `refresh` 类工具。详见 §3.3。

## 7. 关键设计决策（原待定项，已决议）

原待定项 1–6 已全部决议，实现细节见 `design-docs/implementation-prd.md`。

### 7.1 Workspace manifest 格式：JSON

与 TypeBox / JSON Schema 体系一致，工具直接读写，无解析依赖。会话正文不进 manifest（避免随对话膨胀），只存索引，正文落 `.workspace/sessions/*.jsonl`。

### 7.2 多对话的 Agent 实例策略：每个对话一个独立 Agent

一个空间内不同对话 = 不同任务 = 上下文必然不同，共享会话会互相污染。每个 conversation 对应独立的 pi-agent `Agent` 实例（独立 messages / tools / 上下文）。Agent 实例本身很轻，重的是模型上下文；空闲对话不持 LLM 连接，可设同时活跃上限。

### 7.3 跨工作区公用文件：软链接 + 只读（硬约束）

集中一份物理资料库（`<userData>/references/`），各工作空间用软链接挂进自己的 `references/`，**不复制**——避免重复，也避免公司资料更新后各项目副本版本分叉。不做「源文件改了自动同步引用」：软链接本身已是实时视图。

**对工作空间是只读的，这是硬约束**（区别于「格式约束」——见 §6.5）：

- File System 的写工具（`fs_move` / `fs_rename` / `fs_delete` / `fs_export` 目标）**必须拒绝** `references/` 下的路径
- 编辑器打开引用资料时以只读模式打开
- 可读、可搜索；**内容可复制进当前文档后自由改造**（复制出来的是独立副本，可写）

Windows 的软链接权限差异留到 v2（v1 可降级为「复制 + 记录来源并标记只读」）。

### 7.4 Agent 感知当前文档：push 为主 + 显式目标为辅

- **push（主）**：用户切标签页 → shell 通知 harness → harness 更新 `ToolContext.activeDocument` → 下次工具调用即拿到新值，并注入一条「当前激活文档已切换到 X」的提示
- **显式目标（辅）**：所有 Document 工具接受可选 `document` 参数指向非激活文档。跨文档任务必须靠它

必须两者都有：前者服务「跟随用户当前操作」，后者服务「一次任务跨多文档」。这个设计直接继承现有 shell MCP 的经验（内容工具已采用可选 `document` 参数，`open_documents` 支持 list/read/close）。

### 7.5 Electron + ESM 兼容性：已确认满足

实测 Electron **43.3.0** 内置 **Node 24.18.1**（`ELECTRON_RUN_AS_NODE=1 electron -e "process.versions"`），高于 pi-agent 要求的 `>=22.19.0`。Electron ≥28 原生支持 main 进程 ESM，**无需升级，无阻塞**。

### 7.6 MCP Adapter 方案：v1 不需要，接口预留

v1 的所有能力（自有 + 新增 Tool Set）都通过 `HarnessTool` **直接注册**，比绕道 MCP 更直接、类型更安全，因此不需要 MCP Client。接入**外部** MCP 服务时再评估 `pi-mcp-adapter` 社区包；架构上预留一个把 MCP server 的工具适配成 `HarnessTool` 的薄适配层。

> 注：genoffice 现有的 MCP **Server** 保持不变（这是它暴露核心能力的正确方式），但内部实现改为调用同一批新工具的实现，消除现有契约分叉（如 `insert_content` 的 `afterBlockIndex` 默认值在 app 内与 MCP 侧不一致）。

## 8. 关键设计决策（待定）

**无。** 原 4 项待定已于 2026-09-26 全部决议：

| 原待定项                | 决议                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模板目录默认位置        | **问题消解**——不做模板库。改为集中一份只读引用资料库（`<userData>/references/`），各工作空间软链接挂入，不复制（避免重复与版本分叉）                |
| PPT 原型页颗粒度        | **问题消解**——不做页面原型机制。改为「从只读参考复制页 + 自由改造」，复用 `slide_insert_from_file`（底层 `insertSlidePptx`/`mergeSlideFromSource`） |
| 标书技能形态            | **不做 schema**。标书格式每次都无法固定，强约束会导致产出千篇一律。技能 = 自然语言规则 + 自由编辑                                                   |
| `version_save` 触发粒度 | **仅显式触发**。不做自动保存 / 自动暂存。触发路径：UI 上一个「保存为一个版本」按钮，或用户对 agent 说「保存一个版本」                               |

新增决议见 §6.5（不做模板系统）与 §7.3（只读引用是硬约束）。

## 9. 待补充

- [ ] 标书撰写的 SOP 和约束条件（用户后续引入参考资料）
- [ ] 相关参考项目的经验和代码（用户后续引入）
- [x] manifest 的具体 schema 定义 → 见 `implementation-prd.md` §7.2
- [x] 对话（conversation）的数据模型细节 → 见 `implementation-prd.md` §7.2 / §7.3
- [ ] Sub-agent orchestrator tool 的具体实现方案
- [ ] pi-agent session/durable 持久化与 Electron 集成的方案
