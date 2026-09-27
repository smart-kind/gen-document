import { existsSync } from 'node:fs'
import { Type } from 'typebox'
import type { ToolSet } from '../tool/registry.js'
import type { AnyHarnessTool, ToolContext, ToolResult } from '../tool/types.js'
import { normalizeRel, resolveInside } from '../workspace/paths.js'
import type { ThemeMode } from '../workspace/types.js'
import { isReadOnlyPath } from '../workspace/zones.js'

/**
 * Application-level UI tools.
 *
 * These close the gap that made "switch the interface to Chinese" impossible:
 * language, theme and tab control already exist as shell IPC, but were never
 * exposed to the model. Every tool here delegates to a bridge, so the shell
 * implementation stays the single place that knows how the UI actually changes.
 */
export function createUiToolSet(): ToolSet {
  const tools: AnyHarnessTool[] = [
    {
      name: 'ui_set_language',
      label: '切换界面语言',
      description: 'Change the application interface language, e.g. "zh-CN" or "en".',
      parameters: Type.Object({
        locale: Type.String({ description: 'Locale tag, e.g. "zh-CN"' }),
      }),
      set: 'ui',
      effect: 'ui_control',
      execute: async (ctx: ToolContext, params: { locale: string }): Promise<ToolResult> => {
        await ctx.ui.setLanguage(params.locale)
        return {
          output: `Interface language is now ${params.locale}.`,
          summary: `切换语言 ${params.locale}`,
          postState: { language: await ctx.ui.getLanguage() },
        }
      },
    },

    {
      name: 'ui_get_language',
      label: '读取界面语言',
      description: 'Read the current application interface language.',
      parameters: Type.Object({}),
      set: 'ui',
      effect: 'query',
      execute: async (ctx: ToolContext): Promise<ToolResult> => {
        const language = await ctx.ui.getLanguage()
        return { output: `Interface language: ${language}`, postState: { language } }
      },
    },

    {
      name: 'ui_set_theme',
      label: '切换主题',
      description: 'Change the application theme.',
      parameters: Type.Object({
        mode: Type.Union([Type.Literal('light'), Type.Literal('dark'), Type.Literal('system')], {
          description: 'Theme mode',
        }),
      }),
      set: 'ui',
      effect: 'ui_control',
      execute: async (ctx: ToolContext, params: { mode: ThemeMode }): Promise<ToolResult> => {
        await ctx.ui.setTheme(params.mode)
        return {
          output: `Theme is now ${params.mode}.`,
          summary: `切换主题 ${params.mode}`,
          postState: { theme: await ctx.ui.getTheme() },
        }
      },
    },

    {
      name: 'ui_get_theme',
      label: '读取主题',
      description: 'Read the current application theme.',
      parameters: Type.Object({}),
      set: 'ui',
      effect: 'query',
      execute: async (ctx: ToolContext): Promise<ToolResult> => {
        const theme = await ctx.ui.getTheme()
        return { output: `Theme: ${theme}`, postState: { theme } }
      },
    },

    {
      name: 'ui_open_document',
      label: '打开文档',
      description:
        'Open a document in an editor tab and activate it. Documents in a read-only input zone always open read-only, so previewing shared or authoritative material cannot modify it.',
      parameters: Type.Object({
        path: Type.String({ description: 'Workspace-relative document path' }),
        readOnly: Type.Optional(
          Type.Boolean({ description: 'Force read-only, even for writable paths' }),
        ),
      }),
      set: 'ui',
      effect: 'ui_control',
      execute: async (
        ctx: ToolContext,
        params: { path: string; readOnly?: boolean },
      ): Promise<ToolResult> => {
        const rel = normalizeRel(params.path)
        const abs = resolveInside(ctx.workspace.dir, rel)
        if (!existsSync(abs)) return { output: `No such document: ${rel}`, isError: true }

        const readOnly = params.readOnly === true || isReadOnlyPath(rel)
        const opened = await ctx.shell.openDocument(rel, { readOnly })
        return {
          output: `Opened ${rel}${readOnly ? ' (read-only)' : ''}.`,
          summary: `打开 ${rel}`,
          postState: { document: opened, openDocuments: await ctx.shell.listOpenDocuments() },
        }
      },
    },

    {
      name: 'ui_close_document',
      label: '关闭文档',
      description: 'Close an open editor tab by its tab id.',
      parameters: Type.Object({
        id: Type.String({ description: 'Tab id from ui_list_open_documents' }),
        save: Type.Optional(Type.Boolean({ description: 'Save before closing; defaults to true' })),
      }),
      set: 'ui',
      effect: 'ui_control',
      execute: async (
        ctx: ToolContext,
        params: { id: string; save?: boolean },
      ): Promise<ToolResult> => {
        await ctx.shell.closeDocument(params.id, { save: params.save !== false })
        return {
          output: `Closed ${params.id}.`,
          summary: `关闭 ${params.id}`,
          postState: { openDocuments: await ctx.shell.listOpenDocuments() },
        }
      },
    },

    {
      name: 'ui_activate_document',
      label: '激活文档',
      description:
        'Bring an already-open document tab to the front. This is what makes it the active document for later tool calls.',
      parameters: Type.Object({
        id: Type.String({ description: 'Tab id from ui_list_open_documents' }),
      }),
      set: 'ui',
      effect: 'ui_control',
      execute: async (ctx: ToolContext, params: { id: string }): Promise<ToolResult> => {
        const before = await ctx.shell.listOpenDocuments()
        if (!before.some((doc) => doc.id === params.id)) {
          return { output: `No open tab with id ${params.id}.`, isError: true }
        }
        await ctx.shell.activateDocument(params.id)
        const openDocuments = await ctx.shell.listOpenDocuments()
        return {
          output: `Activated ${params.id}.`,
          summary: `激活 ${params.id}`,
          postState: {
            activeDocument: openDocuments.find((doc) => doc.active) ?? null,
            openDocuments,
          },
        }
      },
    },

    {
      name: 'ui_list_open_documents',
      label: '列出打开的文档',
      description: 'List the open editor tabs, marking which one is active.',
      parameters: Type.Object({}),
      set: 'ui',
      effect: 'query',
      execute: async (ctx: ToolContext): Promise<ToolResult> => {
        const openDocuments = await ctx.shell.listOpenDocuments()
        return {
          output:
            openDocuments.length === 0
              ? 'No documents are open.'
              : openDocuments
                  .map(
                    (doc) =>
                      `${doc.active ? '* ' : '  '}${doc.id}  ${doc.path}  (${doc.type}${doc.readOnly ? ', read-only' : ''}${doc.dirty ? ', unsaved' : ''})`,
                  )
                  .join('\n'),
          postState: {
            activeDocument: openDocuments.find((doc) => doc.active) ?? null,
            openDocuments,
          },
        }
      },
    },

    {
      name: 'ui_toggle_panel',
      label: '显示/隐藏面板',
      description: 'Show or hide a shell panel by name.',
      parameters: Type.Object({
        panel: Type.String({ description: 'Panel identifier, e.g. "conversations" or "fileTree"' }),
        visible: Type.Boolean({ description: 'Whether the panel should be visible' }),
      }),
      set: 'ui',
      effect: 'ui_control',
      execute: async (
        ctx: ToolContext,
        params: { panel: string; visible: boolean },
      ): Promise<ToolResult> => {
        await ctx.ui.togglePanel(params.panel, params.visible)
        return {
          output: `Panel ${params.panel} is now ${params.visible ? 'visible' : 'hidden'}.`,
          summary: `${params.visible ? '显示' : '隐藏'}面板 ${params.panel}`,
          postState: { panel: params.panel, visible: params.visible },
        }
      },
    },

    {
      name: 'ui_notify',
      label: '提示用户',
      description: 'Show a short message in the shell. Informational only; it changes no state.',
      parameters: Type.Object({
        message: Type.String({ description: 'Message text' }),
        level: Type.Optional(
          Type.Union([Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')], {
            description: 'Severity; defaults to info',
          }),
        ),
      }),
      set: 'ui',
      effect: 'ui_control',
      execute: async (
        ctx: ToolContext,
        params: { message: string; level?: 'info' | 'warn' | 'error' },
      ): Promise<ToolResult> => {
        const level = params.level ?? 'info'
        await ctx.ui.notify(params.message, level)
        return { output: `Notified the user.`, summary: params.message, postState: { level } }
      },
    },
  ]

  return { id: 'ui', tools: () => tools }
}
