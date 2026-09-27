import { Type } from 'typebox'
import type { ToolSet } from '../tool/registry.js'
import type { AnyHarnessTool, ToolContext, ToolResult } from '../tool/types.js'
import { normalizeRel } from '../workspace/paths.js'

/**
 * Incremental document editing tools.
 *
 * These push edits through the live ProseMirror editor via the docs MCP bridge,
 * so the visible document updates in place without flicker. They only work when
 * the target document is open in an editor tab; otherwise the agent gets a clear
 * error telling it to open the document first.
 */
export function createDocumentEditToolSet(): ToolSet {
  const tools: AnyHarnessTool[] = [
    {
      name: 'doc_insert_content',
      label: '插入内容',
      description:
        'Insert content into the open document as HTML (headings, paragraphs, bold/italic, lists, ' +
        'tables, links). The edit is applied incrementally to the visible editor without flicker. ' +
        'Appends at the end unless afterBlockIndex is given. Use doc_read_live to learn block indexes.',
      parameters: Type.Object({
        path: Type.String({ description: 'Workspace-relative path of the open document' }),
        html: Type.String({ description: 'Restricted HTML fragment to insert' }),
        afterBlockIndex: Type.Optional(
          Type.Number({
            description: 'Insert after this block index; default appends at the end',
          }),
        ),
      }),
      set: 'document-edit',
      effect: 'mutation',
      execute: async (
        ctx: ToolContext,
        params: { path: string; html: string; afterBlockIndex?: number },
      ): Promise<ToolResult> => {
        const rel = normalizeRel(params.path)
        const tab = findDocsTab(ctx, rel)
        if (!tab) return tabNotOpenError(rel)

        try {
          const result = (await ctx.docEditBridge!.runCommand(tab.wcId, 'insert_content', {
            html: params.html,
            afterBlockIndex: params.afterBlockIndex,
          })) as { summary?: string; mutated?: boolean }
          return {
            output: result.summary ?? 'Content inserted',
            mutated: true,
            summary: `插入内容到 ${rel}`,
          }
        } catch (error) {
          return { output: errorText(error), isError: true }
        }
      },
    },
    {
      name: 'doc_replace_blocks',
      label: '替换段落',
      description:
        'Replace a range of blocks in the open document with new HTML content. ' +
        'The edit is applied incrementally without flicker. ' +
        'Use doc_read_live to learn block indexes before replacing.',
      parameters: Type.Object({
        path: Type.String({ description: 'Workspace-relative path of the open document' }),
        startBlockIndex: Type.Number({ description: 'First block index to replace (inclusive)' }),
        endBlockIndex: Type.Number({ description: 'Last block index to replace (inclusive)' }),
        html: Type.String({ description: 'Restricted HTML fragment the range is replaced with' }),
      }),
      set: 'document-edit',
      effect: 'mutation',
      execute: async (
        ctx: ToolContext,
        params: {
          path: string
          startBlockIndex: number
          endBlockIndex: number
          html: string
        },
      ): Promise<ToolResult> => {
        const rel = normalizeRel(params.path)
        const tab = findDocsTab(ctx, rel)
        if (!tab) return tabNotOpenError(rel)

        try {
          const result = (await ctx.docEditBridge!.runCommand(tab.wcId, 'replace_blocks', {
            startBlockIndex: params.startBlockIndex,
            endBlockIndex: params.endBlockIndex,
            html: params.html,
          })) as { summary?: string; mutated?: boolean }
          return {
            output: result.summary ?? 'Blocks replaced',
            mutated: true,
            summary: `替换 ${rel} 的段落`,
          }
        } catch (error) {
          return { output: errorText(error), isError: true }
        }
      },
    },
    {
      name: 'doc_apply_ops',
      label: '应用格式',
      description:
        'Apply formatting commands to the open document (font, paragraph format, heading level, ' +
        'find/replace, list/indent, etc.). The ops are applied incrementally without flicker. ' +
        'Use doc_read_live for block indexes.',
      parameters: Type.Object({
        path: Type.String({ description: 'Workspace-relative path of the open document' }),
        ops: Type.Array(Type.Any(), { description: 'Array of op objects' }),
        dryRun: Type.Optional(
          Type.Boolean({ description: 'Validate without changing the document' }),
        ),
      }),
      set: 'document-edit',
      effect: 'mutation',
      execute: async (
        ctx: ToolContext,
        params: { path: string; ops: unknown[]; dryRun?: boolean },
      ): Promise<ToolResult> => {
        const rel = normalizeRel(params.path)
        const tab = findDocsTab(ctx, rel)
        if (!tab) return tabNotOpenError(rel)

        try {
          const result = (await ctx.docEditBridge!.runCommand(tab.wcId, 'apply_ops', {
            ops: params.ops,
            dryRun: params.dryRun === true,
          })) as { summary?: string; output?: string; mutated?: boolean }
          return {
            output: result.output ?? result.summary ?? 'Ops applied',
            mutated: params.dryRun !== true,
            summary: `应用格式到 ${rel}`,
          }
        } catch (error) {
          return { output: errorText(error), isError: true }
        }
      },
    },
    {
      name: 'doc_read_live',
      label: '读取实时文档',
      description:
        'Read the live document as it currently appears in the editor. Returns a block list ' +
        'with indexes that the edit tools (doc_insert_content, doc_replace_blocks, doc_apply_ops) ' +
        'address. Use this instead of doc_read_blocks when you need to edit the document, ' +
        'since it reflects the editor state including unsaved changes.',
      parameters: Type.Object({
        path: Type.String({ description: 'Workspace-relative path of the open document' }),
      }),
      set: 'document-edit',
      effect: 'query',
      execute: async (ctx: ToolContext, params: { path: string }): Promise<ToolResult> => {
        const rel = normalizeRel(params.path)
        const tab = findDocsTab(ctx, rel)
        if (!tab) return tabNotOpenError(rel)

        try {
          const result = (await ctx.docEditBridge!.runCommand(tab.wcId, 'read_document', {})) as {
            text?: string
          }
          return {
            output: result.text ?? '(empty document)',
            summary: `读取 ${rel}`,
          }
        } catch (error) {
          return { output: errorText(error), isError: true }
        }
      },
    },
  ]

  return { id: 'document-edit', tools: (ctx: ToolContext) => (ctx.docEditBridge ? tools : []) }
}

function findDocsTab(ctx: ToolContext, rel: string): { wcId: number; kind: string } | undefined {
  const tab = ctx.docEditBridge?.findTabByPath(rel)
  if (!tab || tab.kind !== 'docs') return undefined
  return tab
}

function tabNotOpenError(rel: string): ToolResult {
  return {
    output:
      `${rel} is not open in the editor. Use ui_open_document to open it first, ` +
      `then use the doc_* incremental editing tools.`,
    isError: true,
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
