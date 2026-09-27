import { Type } from 'typebox'
import type { ToolSet } from '../tool/registry.js'
import type { AnyHarnessTool, ToolContext, ToolResult } from '../tool/types.js'
import { readConversations } from '../workspace/conversations.js'
import type { WorkspaceStore } from '../workspace/store.js'
import type { ThemeMode } from '../workspace/types.js'
import { describeWorkspace } from './summary.js'

export interface WorkspaceToolSetDeps {
  store: WorkspaceStore
}

/**
 * Workspace lifecycle tools.
 *
 * These are the tools that let the agent work at the level of "a goal with
 * documents in it" rather than "a file". `workspace_set_settings` is the one
 * that most directly makes the agent able to operate the application itself:
 * it writes the workspace settings and applies the same values to the running
 * shell through the UI bridge.
 */
export function createWorkspaceToolSet(deps: WorkspaceToolSetDeps): ToolSet {
  const { store } = deps

  const tools: AnyHarnessTool[] = [
    {
      name: 'workspace_create',
      label: '创建工作空间',
      description:
        'Create a new workspace for a work goal. A workspace is a folder on disk that holds its own manifest, documents and read-only reference mounts; every other tool operates inside one.',
      parameters: Type.Object({
        goal: Type.String({
          description: 'The work goal this workspace serves, e.g. "编写 XX 医院综合楼施工投标文件"',
        }),
        name: Type.Optional(
          Type.String({ description: 'Short display name; defaults to the goal' }),
        ),
        parentDir: Type.Optional(
          Type.String({
            description:
              'Absolute parent directory for the new folder; defaults to the workspaces root',
          }),
        ),
      }),
      set: 'workspace',
      effect: 'workspace',
      execute: async (
        _ctx: ToolContext,
        params: { goal: string; name?: string; parentDir?: string },
      ): Promise<ToolResult> => {
        const handle = store.create(params)
        return {
          output: `Created workspace "${handle.name}" (${handle.id}) at ${handle.dir}.`,
          mutated: true,
          summary: `创建工作空间 ${handle.name}`,
          postState: describeWorkspace(handle),
        }
      },
    },

    {
      name: 'workspace_list',
      label: '列出工作空间',
      description:
        'List every known workspace with its goal and folder, marking ones whose folder is gone.',
      parameters: Type.Object({}),
      set: 'workspace',
      effect: 'query',
      execute: async (): Promise<ToolResult> => {
        const workspaces = store.list()
        if (workspaces.length === 0) {
          return { output: 'No workspaces yet. Use workspace_create to make one.' }
        }
        const lines = workspaces.map(
          (w) =>
            `- ${w.id}  "${w.name}"  goal: ${w.goal}  dir: ${w.dir}${w.available ? '' : '  [folder missing]'}`,
        )
        return {
          output: `${workspaces.length} workspace(s):\n${lines.join('\n')}`,
          summary: `${workspaces.length} 个工作空间`,
          postState: { workspaces },
        }
      },
    },

    {
      name: 'workspace_open',
      label: '切换工作空间',
      description:
        'Switch the application to another workspace. The shell rebuilds its file tree and editor tabs around that workspace.',
      parameters: Type.Object({
        id: Type.String({ description: 'Workspace id from workspace_list' }),
      }),
      set: 'workspace',
      effect: 'workspace',
      execute: async (ctx: ToolContext, params: { id: string }): Promise<ToolResult> => {
        const handle = store.open(params.id)
        if (!handle) {
          return { output: `No workspace with id ${params.id}.`, isError: true }
        }
        await ctx.shell.openWorkspace(handle.id)
        return {
          output: `Switched to workspace "${handle.name}" (${handle.id}).`,
          summary: `切换到 ${handle.name}`,
          postState: describeWorkspace(handle),
        }
      },
    },

    {
      name: 'workspace_describe',
      label: '查看工作空间',
      description:
        'Read a workspace: goal, settings, documents, read-only references and conversations. Omit id for the current workspace.',
      parameters: Type.Object({
        id: Type.Optional(
          Type.String({ description: 'Workspace id; defaults to the current workspace' }),
        ),
      }),
      set: 'workspace',
      effect: 'query',
      execute: async (ctx: ToolContext, params: { id?: string }): Promise<ToolResult> => {
        const handle = params.id ? store.open(params.id) : ctx.workspace
        if (!handle) return { output: `No workspace with id ${String(params.id)}.`, isError: true }
        const conversations = readConversations(handle.dir)
        return {
          output: [
            `Workspace "${handle.name}" (${handle.id})`,
            `goal: ${handle.goal}`,
            `dir: ${handle.dir}`,
            `documents: ${handle.manifest.documents.length}`,
            `references: ${handle.manifest.references.length}`,
            `conversations: ${conversations.length}`,
          ].join('\n'),
          postState: {
            ...describeWorkspace(handle, { conversations: conversations.length }),
            conversations,
          },
        }
      },
    },

    {
      name: 'workspace_update',
      label: '修改工作空间',
      description: 'Change the current workspace goal or display name.',
      parameters: Type.Object({
        goal: Type.Optional(Type.String({ description: 'New goal' })),
        name: Type.Optional(Type.String({ description: 'New display name' })),
      }),
      set: 'workspace',
      effect: 'workspace',
      execute: async (
        ctx: ToolContext,
        params: { goal?: string; name?: string },
      ): Promise<ToolResult> => {
        const handle = store.update(ctx.workspace.id, params)
        // The caller's context still points at the old manifest object.
        ctx.workspace.name = handle.name
        ctx.workspace.goal = handle.goal
        ctx.workspace.manifest = handle.manifest
        return {
          output: `Updated workspace "${handle.name}".`,
          mutated: true,
          summary: `修改工作空间 ${handle.name}`,
          postState: describeWorkspace(handle),
        }
      },
    },

    {
      name: 'workspace_delete',
      label: '删除工作空间',
      description:
        'Delete a workspace and its folder, including every document inside it. Requires confirm=true; without it the tool returns a confirmation request instead and changes nothing.',
      parameters: Type.Object({
        id: Type.String({ description: 'Workspace id' }),
        confirm: Type.Optional(
          Type.Boolean({
            description: 'Must be true to actually delete; omit to request confirmation',
          }),
        ),
      }),
      set: 'workspace',
      effect: 'workspace',
      execute: async (
        _ctx: ToolContext,
        params: { id: string; confirm?: boolean },
      ): Promise<ToolResult> => {
        if (params.confirm !== true) {
          return {
            output: `Refusing to delete ${params.id} without confirmation. Ask the user, then re-issue with confirm=true — the workspace folder and all documents in it are removed.`,
            summary: '删除工作空间需要确认',
            display: {
              kind: 'confirm',
              confirm: {
                prompt: `Delete workspace ${params.id} and its folder?`,
                token: params.id,
              },
            },
          }
        }
        const entry = store.remove(params.id)
        return {
          output: `Deleted workspace ${entry.id} at ${entry.dir}.`,
          mutated: true,
          summary: `删除工作空间 ${entry.name}`,
          postState: { deleted: { id: entry.id, name: entry.name, dir: entry.dir } },
        }
      },
    },

    {
      name: 'workspace_get_settings',
      label: '读取空间设置',
      description: 'Read the current workspace settings (language, theme, auto-save, agent model).',
      parameters: Type.Object({}),
      set: 'workspace',
      effect: 'query',
      execute: async (ctx: ToolContext): Promise<ToolResult> => {
        const settings = ctx.workspace.manifest.settings
        return {
          output: `Workspace settings: ${JSON.stringify(settings)}`,
          postState: { settings },
        }
      },
    },

    {
      name: 'workspace_set_settings',
      label: '修改空间设置',
      description:
        'Change the current workspace settings and apply them to the running application, so a request like "switch the interface to Chinese" takes effect immediately.',
      parameters: Type.Object({
        language: Type.Optional(Type.String({ description: 'UI locale, e.g. "zh-CN"' })),
        theme: Type.Optional(
          Type.Union([Type.Literal('light'), Type.Literal('dark'), Type.Literal('system')], {
            description: 'UI theme mode',
          }),
        ),
        autoSave: Type.Optional(Type.Boolean({ description: 'Whether editors auto-save' })),
        agentModel: Type.Optional(
          Type.Object(
            { provider: Type.String(), model: Type.String() },
            {
              description:
                "Model this workspace's conversations use. Only the provider and model id are stored here; credentials stay in the shared AI settings.",
            },
          ),
        ),
      }),
      set: 'workspace',
      effect: 'workspace',
      execute: async (
        ctx: ToolContext,
        params: {
          language?: string
          theme?: ThemeMode
          autoSave?: boolean
          agentModel?: { provider: string; model: string }
        },
      ): Promise<ToolResult> => {
        const settings = { ...ctx.workspace.manifest.settings }
        if (params.language !== undefined) settings.language = params.language
        if (params.theme !== undefined) settings.theme = params.theme
        if (params.autoSave !== undefined) settings.autoSave = params.autoSave
        if (params.agentModel !== undefined) settings.agentModel = params.agentModel
        ctx.workspace.manifest.settings = settings
        ctx.saveWorkspace()

        // The bridge is what actually changes the running shell; the workspace
        // copy keeps the choice for the next launch.
        if (params.language !== undefined) await ctx.ui.setLanguage(params.language)
        if (params.theme !== undefined) await ctx.ui.setTheme(params.theme)

        return {
          output: `Applied workspace settings: ${JSON.stringify(settings)}.`,
          mutated: true,
          summary: '修改空间设置',
          postState: { workspace: { id: ctx.workspace.id, settings } },
        }
      },
    },
  ]

  return { id: 'workspace', tools: () => tools }
}
