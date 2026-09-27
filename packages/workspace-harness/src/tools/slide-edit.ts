import { Type } from 'typebox'
import type { ToolSet } from '../tool/registry.js'
import type { AnyHarnessTool, ToolContext, ToolResult } from '../tool/types.js'
import { normalizeRel } from '../workspace/paths.js'

/**
 * Slide-deck editing tools.
 *
 * These operate through the main-process slides session (applySessionTxn),
 * so the visible deck updates in place without flicker. They only work when
 * the target presentation is open in a tab.
 */
export function createSlideEditToolSet(): ToolSet {
  const tools: AnyHarnessTool[] = [
    {
      name: 'slide_read_deck',
      label: '读取幻灯片',
      description:
        'Read the live slide deck structure. Returns each slide with its elements ' +
        '(text, shape, image, table) and their IDs. Use element IDs as targets for ' +
        'slide_apply_ops. The deck must be open via ui_open_document first.',
      parameters: Type.Object({
        path: Type.String({ description: 'Workspace-relative path of the open presentation' }),
      }),
      set: 'slide-edit',
      effect: 'query',
      execute: async (ctx: ToolContext, params: { path: string }): Promise<ToolResult> => {
        const rel = normalizeRel(params.path)
        const tab = findSlidesTab(ctx, rel)
        if (!tab) return tabNotOpenError(rel)

        try {
          const result = (await ctx.docEditBridge!.runCommand(tab.wcId, 'read_deck', {})) as {
            slideSize?: unknown
            slides?: unknown[]
            emuPerPx?: number
          }
          return {
            output: JSON.stringify(result, null, 2),
            summary: `读取 ${rel}`,
          }
        } catch (error) {
          return { output: errorText(error), isError: true }
        }
      },
    },
    {
      name: 'slide_apply_ops',
      label: '应用幻灯片操作',
      description:
        'Apply structural edits to the open presentation: add/remove/reorder slides, ' +
        'update text in elements, move/resize elements, change styling. ' +
        'The deck updates incrementally without flicker. ' +
        'Use slide_read_deck first to learn element IDs and slide indexes.',
      parameters: Type.Object({
        path: Type.String({ description: 'Workspace-relative path of the open presentation' }),
        ops: Type.Array(Type.Any(), {
          description:
            'Array of pptx-ops: add_slide, remove_slide, reorder_slides, update_text, ' +
            'move_element, resize_element, etc.',
        }),
        dryRun: Type.Optional(Type.Boolean({ description: 'Validate without changing the deck' })),
      }),
      set: 'slide-edit',
      effect: 'mutation',
      execute: async (
        ctx: ToolContext,
        params: { path: string; ops: unknown[]; dryRun?: boolean },
      ): Promise<ToolResult> => {
        const rel = normalizeRel(params.path)
        const tab = findSlidesTab(ctx, rel)
        if (!tab) return tabNotOpenError(rel)

        try {
          const result = (await ctx.docEditBridge!.runCommand(tab.wcId, 'apply_ops', {
            ops: params.ops,
            dryRun: params.dryRun === true,
          })) as { summary?: string; output?: string; applied?: boolean }
          return {
            output: result.output ?? result.summary ?? 'Ops applied',
            mutated: params.dryRun !== true,
            summary: `应用操作到 ${rel}`,
          }
        } catch (error) {
          return { output: errorText(error), isError: true }
        }
      },
    },
  ]

  return {
    id: 'slide-edit',
    tools: (ctx: ToolContext) => {
      if (!ctx.docEditBridge) return []
      const hasSlides = ctx.docEditBridge.listOpenTabs().some((t) => t.kind === 'slides')
      return hasSlides ? tools : []
    },
  }
}

function findSlidesTab(ctx: ToolContext, rel: string): { wcId: number; kind: string } | undefined {
  const tab = ctx.docEditBridge?.findTabByPath(rel)
  if (!tab || tab.kind !== 'slides') return undefined
  return tab
}

function tabNotOpenError(rel: string): ToolResult {
  return {
    output:
      `${rel} is not open in the editor. Use ui_open_document to open it first, ` +
      `then use the slide_* incremental editing tools.`,
    isError: true,
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
