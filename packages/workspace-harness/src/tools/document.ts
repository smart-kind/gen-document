import { parseDocx, type Block } from '@genoffice/docx-engine'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { Type } from 'typebox'
import type { ToolSet } from '../tool/registry.js'
import type { AnyHarnessTool, ToolContext, ToolResult } from '../tool/types.js'
import { normalizeRel, resolveInside } from '../workspace/paths.js'
import { zoneOf } from '../workspace/zones.js'
import { MAX_TEXT_BYTES } from './filesystem.js'

/** Plain-text formats the read falls back to a line window for. */
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.html', '.htm'])

/** Number of blocks (or lines) one read returns by default, and at most. */
const DEFAULT_BLOCK_LIMIT = 200
const MAX_BLOCK_LIMIT = 1_000

/** One heading of the outline the read reports back, so the agent can navigate. */
interface OutlineEntry {
  /** 1-based number of the heading block. */
  block: number
  level?: number
  text: string
}

/**
 * Document tools: reading the content of a produced or collected document.
 *
 * `.docx` goes through `@genoffice/docx-engine`'s parser, which runs in plain
 * Node — the same path the demo workspace uses to write and read its sample
 * Word file. Nothing here needs a renderer, an open editor tab or Electron, so
 * a workflow can read a document no window is showing.
 *
 * Reads are allowed in every zone: only *writing* is restricted, and a
 * validation run has to read the read-only rules like any other input.
 */
export function createDocumentToolSet(): ToolSet {
  const tools: AnyHarnessTool[] = [
    {
      name: 'doc_read_blocks',
      label: '读取文档',
      description:
        'Read a document as a numbered list of blocks: 1-based number, block type (with heading level and style when present) and the text of its runs joined. .docx is parsed to its real block structure; md, txt and html are read line by line. Cite the block numbers when reporting a problem, and page with offset/limit on a long document. pdf and pptx cannot be read yet.',
      parameters: Type.Object({
        path: Type.String({ description: 'Workspace-relative path' }),
        offset: Type.Optional(
          Type.Number({
            description: '1-based number of the first block to return; defaults to 1',
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: `Max blocks to return; defaults to ${DEFAULT_BLOCK_LIMIT}, capped at ${MAX_BLOCK_LIMIT}`,
          }),
        ),
      }),
      set: 'document',
      effect: 'query',
      execute: async (
        ctx: ToolContext,
        params: { path: string; offset?: number; limit?: number },
      ): Promise<ToolResult> => {
        const rel = normalizeRel(params.path)
        const abs = resolveInside(ctx.workspace.dir, rel)
        if (!existsSync(abs)) return { output: `No such file: ${rel}`, isError: true }
        if (!statSync(abs).isFile()) return { output: `${rel} is not a file`, isError: true }

        const offset = Math.max(1, Math.floor(params.offset ?? 1))
        const limit = Math.min(
          MAX_BLOCK_LIMIT,
          Math.max(1, Math.floor(params.limit ?? DEFAULT_BLOCK_LIMIT)),
        )

        const ext = extname(rel).toLowerCase()
        if (ext === '.docx') return readDocxBlocks(rel, abs, offset, limit)
        if (TEXT_EXTENSIONS.has(ext)) return readTextLines(rel, abs, offset, limit)
        return {
          output: `${rel}: ${ext || 'this file type'} cannot be read yet — doc_read_blocks reads .docx, .md, .txt and .html today.`,
          isError: true,
        }
      },
    },
  ]

  return { id: 'document', tools: () => tools }
}

/** Parse a .docx package and report its blocks as a numbered window. */
async function readDocxBlocks(
  rel: string,
  abs: string,
  offset: number,
  limit: number,
): Promise<ToolResult> {
  let blocks: Block[]
  try {
    blocks = (await parseDocx(readFileSync(abs))).blocks
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { output: `${rel} could not be parsed as a .docx package: ${detail}`, isError: true }
  }

  // Body-trailing elements (the section properties) are not content, so they
  // carry no number an agent could usefully cite.
  const visible = blocks.filter((block) => !block.hidden)
  const slice = visible.slice(offset - 1, offset - 1 + limit)
  const last = offset - 1 + slice.length

  return {
    output:
      slice.length === 0
        ? `${rel} has no block in that range (${visible.length} block(s) in total).`
        : slice.map((block, i) => blockLine(offset + i, block)).join('\n'),
    summary: `读取 ${rel}`,
    postState: {
      path: rel,
      zone: zoneOf(rel),
      format: 'docx',
      totalBlocks: visible.length,
      hiddenBlocks: blocks.length - visible.length,
      returnedRange: { start: offset, end: last },
      truncated: last < visible.length,
      outline: outlineOf(visible),
    },
  }
}

/** Read a plain-text document as a numbered line window, like `fs_read_text`. */
function readTextLines(rel: string, abs: string, offset: number, limit: number): ToolResult {
  const size = statSync(abs).size
  if (size > MAX_TEXT_BYTES) {
    return {
      output: `${rel} is ${size}B, over the ${MAX_TEXT_BYTES}B read limit.`,
      isError: true,
    }
  }

  const lines = readFileSync(abs, 'utf8').split('\n')
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const last = offset - 1 + slice.length

  return {
    output: slice.map((line, i) => `${offset + i}\t${line}`).join('\n'),
    summary: `读取 ${rel}`,
    postState: {
      path: rel,
      zone: zoneOf(rel),
      format: extname(rel).toLowerCase().replace(/^\./, ''),
      totalBlocks: lines.length,
      returnedRange: { start: offset, end: last },
      truncated: last < lines.length,
      outline: outlineOfLines(lines, extname(rel).toLowerCase()),
    },
  }
}

/** One line per block: number, block kind, text. */
function blockLine(number: number, block: Block): string {
  const kind = [
    block.type,
    block.level ? `h${block.level}` : '',
    block.styleId ? `(${block.styleId})` : '',
  ]
    .filter(Boolean)
    .join(' ')
  return `${number}\t${kind}\t${blockText(block)}`
}

/** Everything a reader needs from a block, whatever kind it is. */
function blockText(block: Block): string {
  const runs = block.runs?.map((run) => run.text).join('') ?? ''
  if (runs) return runs
  if (block.table) {
    return block.table.rows
      .map((row) => row.map((cell) => cell.paras.join(' ')).join(' | '))
      .join(' / ')
  }
  if (block.previewText) return block.previewText
  return block.label ? `[${block.label}]` : ''
}

function outlineOf(blocks: Block[]): OutlineEntry[] {
  const outline: OutlineEntry[] = []
  blocks.forEach((block, index) => {
    if (block.type !== 'heading') return
    outline.push({
      block: index + 1,
      ...(block.level ? { level: block.level } : {}),
      text: blockText(block),
    })
  })
  return outline
}

/** Markdown ATX headings, so a text report can be navigated the same way. */
function outlineOfLines(lines: string[], ext: string): OutlineEntry[] {
  if (ext !== '.md' && ext !== '.markdown') return []
  const outline: OutlineEntry[] = []
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (match)
      outline.push({ block: index + 1, level: match[1]?.length ?? 1, text: match[2] ?? '' })
  })
  return outline
}
