import { buildBlankDocx } from '@genoffice/docx-engine'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { blankXlsxBuffer } from '@genoffice/xlsx-gateway/gateway/csv-import'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { Type } from 'typebox'
import type { ToolSet } from '../tool/registry.js'
import type { AnyHarnessTool, ToolContext, ToolResult } from '../tool/types.js'
import {
  addDocument,
  documentTypeFor,
  forgetPath,
  normalizeDocPath,
} from '../workspace/documents.js'
import { expandUserPath, normalizeRel, resolveInside } from '../workspace/paths.js'
import type { DocumentType, WorkspaceHandle } from '../workspace/types.js'
import { assertWritable, isReadOnlyPath, READ_ONLY_ZONES, ZONE_DIRS } from '../workspace/zones.js'
import { describeDocument } from './summary.js'

/** Directories that are harness or VCS bookkeeping rather than user content. */
const HIDDEN_DIRS = new Set(['.workspace', '.git'])

const EXTENSIONS: Record<DocumentType, string> = {
  docx: '.docx',
  xlsx: '.xlsx',
  pptx: '.pptx',
  pdf: '.pdf',
  md: '.md',
  html: '.html',
  txt: '.txt',
}

/** Text types `fs_read_text` accepts, plus the file-size ceiling it will read. */
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.html',
  '.htm',
  '.json',
  '.csv',
  '.yml',
  '.yaml',
])
/**
 * Ceiling for reading a text document. Shared with `doc_read_blocks`, so the
 * two readers disagree about nothing a model could trip over.
 */
export const MAX_TEXT_BYTES = 1_048_576
const DEFAULT_READ_LINES = 400
const MAX_READ_LINES = 4_000

/**
 * File System tools: everything that moves bytes inside a workspace.
 *
 * Every write funnels through `assertWritable`, which accepts only the writable
 * output zones and harness bookkeeping. That check is the hard data boundary
 * from the design: the read-only zones hold a shared symlink library and this
 * project's authoritative inputs, so a write through them would either corrupt
 * material other workspaces see or change what a validation run compares
 * against.
 */
export function createFileSystemToolSet(): ToolSet {
  const tools: AnyHarnessTool[] = [
    {
      name: 'fs_list',
      label: '列出目录',
      description:
        'List a directory inside the workspace, marking entries that live under a read-only zone and entries open in an editor.',
      parameters: Type.Object({
        dir: Type.Optional(
          Type.String({
            description: 'Workspace-relative directory; defaults to the workspace root',
          }),
        ),
        includeReadOnly: Type.Optional(
          Type.Boolean({
            description: `Include the read-only input zones (${READ_ONLY_ZONES.map((zone) => ZONE_DIRS[zone]).join(', ')}); defaults to true`,
          }),
        ),
      }),
      set: 'filesystem',
      effect: 'query',
      execute: async (
        ctx: ToolContext,
        params: { dir?: string; includeReadOnly?: boolean },
      ): Promise<ToolResult> => {
        const rel = normalizeRel(params.dir ?? '.')
        const abs = resolveInside(ctx.workspace.dir, rel)
        if (!existsSync(abs)) return { output: `No such directory: ${rel}`, isError: true }
        if (!statSync(abs).isDirectory())
          return { output: `${rel} is not a directory`, isError: true }

        const open = await ctx.shell.listOpenDocuments()
        const includeReadOnly = params.includeReadOnly !== false

        const entries = readdirSync(abs, { withFileTypes: true })
          .filter((entry) => !HIDDEN_DIRS.has(entry.name))
          .filter(
            (entry) =>
              includeReadOnly || !isReadOnlyPath(rel === '.' ? entry.name : `${rel}/${entry.name}`),
          )
          .map((entry) => {
            const childRel = rel === '.' ? entry.name : `${rel}/${entry.name}`
            const childAbs = join(abs, entry.name)
            const readOnly = isReadOnlyPath(childRel)
            const docType = documentTypeFor(entry.name)
            let kind: 'file' | 'dir' | 'missing'
            let size: number | undefined
            try {
              const stat = statSync(childAbs)
              kind = stat.isDirectory() ? 'dir' : 'file'
              size = stat.isFile() ? stat.size : undefined
            } catch {
              kind = 'missing'
            }
            const tab = open.find((d) => normalizeDocPath(d.path) === childRel)
            return {
              name: entry.name,
              path: childRel,
              kind,
              readOnly,
              ...(docType ? { type: docType } : {}),
              ...(size !== undefined ? { size } : {}),
              ...(tab ? { open: true, dirty: tab.dirty ?? false } : {}),
            }
          })
          .sort((a, b) =>
            a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
          )

        return {
          output:
            entries.length === 0
              ? `${rel} is empty.`
              : entries
                  .map(
                    (e) =>
                      `${e.readOnly ? '[read-only] ' : ''}${e.kind === 'dir' ? 'dir  ' : 'file '}${e.path}${e.size !== undefined ? `  (${e.size}B)` : ''}${e.open ? '  (open)' : ''}`,
                  )
                  .join('\n'),
          postState: { dir: rel, entries },
        }
      },
    },

    {
      name: 'fs_add_document',
      label: '新建文档',
      description:
        'Create a new blank document in the writable part of the workspace and register it. Supported types: docx, pptx, xlsx, md, html, txt. PDF cannot be created blank — import one instead.',
      parameters: Type.Object({
        type: Type.Union(
          [
            Type.Literal('docx'),
            Type.Literal('pptx'),
            Type.Literal('xlsx'),
            Type.Literal('md'),
            Type.Literal('html'),
            Type.Literal('txt'),
          ],
          { description: 'Document type to create' },
        ),
        name: Type.Optional(
          Type.String({ description: 'File name without a directory, e.g. "技术方案.docx"' }),
        ),
        dir: Type.Optional(
          Type.String({
            description: `Workspace-relative directory; defaults to ${ZONE_DIRS.output}/`,
          }),
        ),
        note: Type.Optional(Type.String({ description: 'Free-text purpose note' })),
      }),
      set: 'filesystem',
      effect: 'workspace',
      execute: async (
        ctx: ToolContext,
        params: { type: DocumentType; name?: string; dir?: string; note?: string },
      ): Promise<ToolResult> => {
        const dir = params.dir ? normalizeRel(params.dir) : ZONE_DIRS.output
        const fileName = ensureExtension(
          params.name?.trim() || `untitled${EXTENSIONS[params.type]}`,
          params.type,
        )
        const rel = dir === '.' ? fileName : `${dir}/${fileName}`
        assertWritable(rel)
        const abs = resolveInside(ctx.workspace.dir, rel)
        if (existsSync(abs)) return { output: `${rel} already exists.`, isError: true }

        mkdirSync(dirname(abs), { recursive: true })
        await writeBlankDocument(abs, params.type, basename(fileName, extname(fileName)))
        const entry = addDocument(ctx.workspace, {
          path: rel,
          type: params.type,
          note: params.note,
          source: { kind: 'new' },
        })
        ctx.saveWorkspace()

        return {
          output: `Created ${rel} (${entry.id}).`,
          mutated: true,
          summary: `新建 ${rel}`,
          postState: { document: describeDocument(entry) },
        }
      },
    },

    {
      name: 'fs_import',
      label: '导入文件',
      description:
        'Copy a file or folder from outside the workspace into it. This makes a writable copy, unlike fs_add_reference which links read-only shared material.',
      parameters: Type.Object({
        externalPath: Type.String({ description: 'Absolute path outside the workspace' }),
        destDir: Type.Optional(
          Type.String({
            description: `Workspace-relative destination directory; defaults to ${ZONE_DIRS.output}/`,
          }),
        ),
        as: Type.Optional(
          Type.String({ description: 'Destination name; defaults to the source name' }),
        ),
      }),
      set: 'filesystem',
      effect: 'workspace',
      execute: async (
        ctx: ToolContext,
        params: { externalPath: string; destDir?: string; as?: string },
      ): Promise<ToolResult> => {
        const source = expandUserPath(params.externalPath)
        if (!existsSync(source))
          return { output: `Source does not exist: ${source}`, isError: true }

        const destDir = params.destDir ? normalizeRel(params.destDir) : ZONE_DIRS.output
        const name = params.as?.trim() || basename(source)
        const rel = destDir === '.' ? name : `${destDir}/${name}`
        assertWritable(rel)
        const abs = resolveInside(ctx.workspace.dir, rel)
        if (existsSync(abs)) return { output: `${rel} already exists.`, isError: true }

        mkdirSync(dirname(abs), { recursive: true })
        const isDir = statSync(source).isDirectory()
        cpSync(source, abs, { recursive: isDir })

        const imported: string[] = []
        if (isDir) {
          for (const child of readdirSync(abs, { withFileTypes: true })) {
            if (!child.isFile()) continue
            const childRel = `${rel}/${child.name}`
            const entry = addDocument(ctx.workspace, {
              path: childRel,
              source: { kind: 'imported', from: join(source, child.name) },
            })
            imported.push(entry.path)
          }
        } else {
          const entry = addDocument(ctx.workspace, {
            path: rel,
            source: { kind: 'imported', from: source },
          })
          imported.push(entry.path)
        }
        ctx.saveWorkspace()

        return {
          output: `Imported ${source} as ${rel}${isDir ? ` (${imported.length} file(s) registered)` : ''}. The copy is writable.`,
          mutated: true,
          summary: `导入 ${rel}`,
          postState: {
            imported,
            documents: ctx.workspace.manifest.documents.map((d) => describeDocument(d)),
          },
        }
      },
    },

    {
      name: 'fs_export',
      label: '导出文件',
      description:
        'Copy workspace files out to a directory outside the workspace. Read-only input zones cannot be exported; nothing inside the workspace changes.',
      parameters: Type.Object({
        paths: Type.Array(Type.String(), { description: 'Workspace-relative paths to export' }),
        destPath: Type.String({
          description: 'Absolute destination directory (created if missing)',
        }),
        format: Type.Optional(
          Type.String({ description: 'Target format; only the source format is supported today' }),
        ),
      }),
      set: 'filesystem',
      effect: 'workspace',
      execute: async (
        ctx: ToolContext,
        params: { paths: string[]; destPath: string; format?: string },
      ): Promise<ToolResult> => {
        if (params.paths.length === 0) return { output: 'No paths given.', isError: true }
        const dest = expandUserPath(params.destPath)
        const exported: string[] = []

        for (const raw of params.paths) {
          const rel = normalizeRel(raw)
          assertWritable(rel)
          const abs = resolveInside(ctx.workspace.dir, rel)
          if (!existsSync(abs)) return { output: `No such path: ${rel}`, isError: true }
          const sourceType = documentTypeFor(rel)
          if (
            params.format &&
            sourceType &&
            params.format.toLowerCase().replace(/^\./, '') !== sourceType
          ) {
            return {
              output: `Cannot convert ${rel} to "${params.format}": format conversion is not available yet, export it in its source format instead.`,
              isError: true,
            }
          }
          mkdirSync(dest, { recursive: true })
          cpSync(abs, join(dest, basename(rel)), { recursive: statSync(abs).isDirectory() })
          exported.push(join(dest, basename(rel)))
        }

        return {
          output: `Exported ${exported.length} path(s) to ${dest}:\n${exported.join('\n')}`,
          summary: `导出到 ${dest}`,
          postState: { exported },
        }
      },
    },

    {
      name: 'fs_move',
      label: '移动文件',
      description:
        'Move or rename a path inside the workspace, updating registered document paths. Read-only input zones are refused.',
      parameters: Type.Object({
        from: Type.String({ description: 'Workspace-relative source path' }),
        to: Type.String({ description: 'Workspace-relative destination path' }),
      }),
      set: 'filesystem',
      effect: 'workspace',
      execute: async (
        ctx: ToolContext,
        params: { from: string; to: string },
      ): Promise<ToolResult> => {
        const from = normalizeRel(params.from)
        const to = normalizeRel(params.to)
        assertWritable(from)
        assertWritable(to)
        const fromAbs = resolveInside(ctx.workspace.dir, from)
        const toAbs = resolveInside(ctx.workspace.dir, to)
        if (!existsSync(fromAbs)) return { output: `No such path: ${from}`, isError: true }
        if (existsSync(toAbs)) return { output: `${to} already exists.`, isError: true }

        mkdirSync(dirname(toAbs), { recursive: true })
        renameSync(fromAbs, toAbs)
        const moved = rewritePaths(ctx.workspace, from, to)
        ctx.saveWorkspace()

        return {
          output: `Moved ${from} to ${to}${moved ? ` (${moved} document path(s) updated)` : ''}.`,
          mutated: true,
          summary: `移动 ${from}`,
          postState: {
            from,
            to,
            documents: ctx.workspace.manifest.documents.map((d) => describeDocument(d)),
          },
        }
      },
    },

    {
      name: 'fs_rename',
      label: '重命名',
      description:
        'Rename an entry in place, keeping it in the same directory. Read-only input zones are refused.',
      parameters: Type.Object({
        path: Type.String({ description: 'Workspace-relative path to rename' }),
        name: Type.String({ description: 'New file name, without a directory' }),
      }),
      set: 'filesystem',
      effect: 'workspace',
      execute: async (
        ctx: ToolContext,
        params: { path: string; name: string },
      ): Promise<ToolResult> => {
        const rel = normalizeRel(params.path)
        assertWritable(rel)
        const name = params.name.trim()
        if (!name || name.includes('/') || name.includes('\\')) {
          return {
            output: `Invalid name "${params.name}": it must be a plain file name.`,
            isError: true,
          }
        }
        const parent = dirname(rel)
        const to = parent === '.' ? name : `${parent}/${name}`
        assertWritable(to)

        const fromAbs = resolveInside(ctx.workspace.dir, rel)
        const toAbs = resolveInside(ctx.workspace.dir, to)
        if (!existsSync(fromAbs)) return { output: `No such path: ${rel}`, isError: true }
        if (existsSync(toAbs)) return { output: `${to} already exists.`, isError: true }

        renameSync(fromAbs, toAbs)
        const renamed = rewritePaths(ctx.workspace, rel, to)
        ctx.saveWorkspace()

        return {
          output: `Renamed ${rel} to ${to}${renamed ? ` (${renamed} document path(s) updated)` : ''}.`,
          mutated: true,
          summary: `重命名 ${rel}`,
          postState: {
            from: rel,
            to,
            documents: ctx.workspace.manifest.documents.map((d) => describeDocument(d)),
          },
        }
      },
    },

    {
      name: 'fs_delete',
      label: '删除文件',
      description:
        'Delete a file or folder inside the workspace. Requires confirm=true; without it the tool returns a confirmation request and changes nothing. Read-only input zones are refused.',
      parameters: Type.Object({
        path: Type.String({ description: 'Workspace-relative path to delete' }),
        confirm: Type.Optional(Type.Boolean({ description: 'Must be true to actually delete' })),
      }),
      set: 'filesystem',
      effect: 'workspace',
      execute: async (
        ctx: ToolContext,
        params: { path: string; confirm?: boolean },
      ): Promise<ToolResult> => {
        const rel = normalizeRel(params.path)
        // Checked before the zone boundary: the root is not a document path, and
        // a plainer message than "unzoned" is more useful here.
        if (rel === '.' || rel === '') {
          return { output: 'Refusing to delete the workspace root.', isError: true }
        }
        assertWritable(rel)
        const abs = resolveInside(ctx.workspace.dir, rel)
        if (!existsSync(abs)) return { output: `No such path: ${rel}`, isError: true }

        if (params.confirm !== true) {
          return {
            output: `Refusing to delete ${rel} without confirmation. Ask the user, then re-issue with confirm=true.`,
            summary: `删除 ${rel} 需要确认`,
            display: {
              kind: 'confirm',
              confirm: { prompt: `Delete ${rel}?`, token: rel },
            },
          }
        }

        rmSync(abs, { recursive: true, force: true })
        forgetPath(ctx.workspace, rel)
        ctx.saveWorkspace()

        return {
          output: `Deleted ${rel}.`,
          mutated: true,
          summary: `删除 ${rel}`,
          postState: {
            deleted: rel,
            documents: ctx.workspace.manifest.documents.map((d) => describeDocument(d)),
          },
        }
      },
    },

    {
      name: 'fs_read_text',
      label: '读取文本',
      description:
        'Read a text file (md, txt, html, json, csv, yaml) inside the workspace, including the read-only input zones. Line-based windowing keeps large files out of context.',
      parameters: Type.Object({
        path: Type.String({ description: 'Workspace-relative path' }),
        offset: Type.Optional(
          Type.Number({ description: '1-based first line to read; defaults to 1' }),
        ),
        limit: Type.Optional(
          Type.Number({ description: `Max lines; defaults to ${DEFAULT_READ_LINES}` }),
        ),
      }),
      set: 'filesystem',
      effect: 'query',
      execute: async (
        ctx: ToolContext,
        params: { path: string; offset?: number; limit?: number },
      ): Promise<ToolResult> => {
        const rel = normalizeRel(params.path)
        const abs = resolveInside(ctx.workspace.dir, rel)
        if (!existsSync(abs)) return { output: `No such file: ${rel}`, isError: true }
        if (!statSync(abs).isFile()) return { output: `${rel} is not a file`, isError: true }

        const ext = extname(rel).toLowerCase()
        if (!TEXT_EXTENSIONS.has(ext)) {
          return {
            output: `${rel} is not a text file this tool reads (${[...TEXT_EXTENSIONS].join(', ')}).`,
            isError: true,
          }
        }
        const size = statSync(abs).size
        if (size > MAX_TEXT_BYTES) {
          return {
            output: `${rel} is ${size}B, over the ${MAX_TEXT_BYTES}B read limit.`,
            isError: true,
          }
        }

        const all = readFileSync(abs, 'utf8').split('\n')
        const offset = Math.max(1, Math.floor(params.offset ?? 1))
        const limit = Math.min(
          MAX_READ_LINES,
          Math.max(1, Math.floor(params.limit ?? DEFAULT_READ_LINES)),
        )
        const slice = all.slice(offset - 1, offset - 1 + limit)
        const lastLine = offset - 1 + slice.length

        return {
          output: slice.map((line, i) => `${offset + i}\t${line}`).join('\n'),
          summary: `读取 ${rel}`,
          postState: {
            path: rel,
            readOnly: isReadOnlyPath(rel),
            totalLines: all.length,
            returnedRange: { startLine: offset, endLine: lastLine },
            truncated: lastLine < all.length,
          },
        }
      },
    },

    {
      name: 'fs_write_text',
      label: '写入文本',
      description: `Write a text file into the writable part of the workspace (${ZONE_DIRS.output}/ or ${ZONE_DIRS.feedback}/), creating its directory if needed, and register it as a document. This is how a report or an analysis is saved. The read-only input zones refuse the write.`,
      parameters: Type.Object({
        path: Type.String({
          description: `Workspace-relative path, e.g. ${ZONE_DIRS.output}/校验报告-20260927-1412.md`,
        }),
        content: Type.String({ description: 'Text to write' }),
        mode: Type.Optional(
          Type.Union([Type.Literal('replace'), Type.Literal('append'), Type.Literal('create')], {
            description:
              'replace overwrites the file (default), append adds to its end, create fails when it already exists',
          }),
        ),
      }),
      set: 'filesystem',
      effect: 'workspace',
      execute: async (
        ctx: ToolContext,
        params: { path: string; content: string; mode?: 'replace' | 'append' | 'create' },
      ): Promise<ToolResult> => {
        const rel = normalizeRel(params.path)
        if (rel === '.' || rel === '') {
          return { output: 'A file path is required.', isError: true }
        }
        assertWritable(rel)

        const mode = params.mode ?? 'replace'
        const abs = resolveInside(ctx.workspace.dir, rel)
        const exists = existsSync(abs)
        if (exists && statSync(abs).isDirectory()) {
          return { output: `${rel} is a directory, not a text file.`, isError: true }
        }
        if (mode === 'create' && exists) {
          return {
            output: `${rel} already exists; use mode "replace" to overwrite it or "append" to add to it.`,
            isError: true,
          }
        }

        mkdirSync(dirname(abs), { recursive: true })
        if (mode === 'append') appendFileSync(abs, params.content, 'utf8')
        else writeFileSync(abs, params.content, 'utf8')

        const entry =
          ctx.resolveDocument(rel) ??
          addDocument(ctx.workspace, { path: rel, source: { kind: 'new' } })
        ctx.saveWorkspace()
        const bytes = statSync(abs).size

        return {
          output: `Wrote ${rel} (${mode}, ${bytes}B).`,
          mutated: true,
          summary: `写入 ${rel}`,
          postState: { document: describeDocument(entry), bytes, mode },
        }
      },
    },

    {
      name: 'fs_add_reference',
      label: '挂载引用资料',
      description: `Mount an external file or folder into ${ZONE_DIRS.library}/ as a symlink. Nothing is copied: the linked source stays authoritative for every workspace that mounts it, and the mount is read-only for this workspace.`,
      parameters: Type.Object({
        externalPath: Type.String({ description: 'Absolute path of the shared material to mount' }),
        as: Type.Optional(Type.String({ description: 'Mount name; defaults to the source name' })),
      }),
      set: 'filesystem',
      effect: 'workspace',
      execute: async (
        ctx: ToolContext,
        params: { externalPath: string; as?: string },
      ): Promise<ToolResult> => {
        const info = ctx.references.add(params.externalPath, params.as)
        return {
          output: `Mounted ${info.target} at ${info.link} (read-only, linked not copied).`,
          mutated: true,
          summary: `挂载引用 ${info.name}`,
          postState: { reference: info, references: ctx.references.list() },
        }
      },
    },

    {
      name: 'fs_list_references',
      label: '列出引用资料',
      description:
        'List the read-only reference mounts, reporting whether each linked source is still available.',
      parameters: Type.Object({}),
      set: 'filesystem',
      effect: 'query',
      execute: async (ctx: ToolContext): Promise<ToolResult> => {
        const references = ctx.references.list()
        return {
          output:
            references.length === 0
              ? 'No references mounted.'
              : references
                  .map(
                    (r) =>
                      `${r.available ? '' : '[missing] '}${r.link} -> ${r.target}${r.size !== undefined ? `  (${r.size}B)` : ''}`,
                  )
                  .join('\n'),
          postState: { references },
        }
      },
    },

    {
      name: 'fs_remove_reference',
      label: '摘除引用资料',
      description:
        'Unmount a reference. Only the link is removed; the linked source file is never deleted.',
      parameters: Type.Object({
        nameOrPath: Type.String({
          description: `Mount name or its ${ZONE_DIRS.library}/ path`,
        }),
      }),
      set: 'filesystem',
      effect: 'workspace',
      execute: async (ctx: ToolContext, params: { nameOrPath: string }): Promise<ToolResult> => {
        const removed = ctx.references.remove(params.nameOrPath)
        return {
          output: `Unmounted ${removed.link}. The source at ${removed.target} is untouched.`,
          mutated: true,
          summary: `摘除引用 ${removed.name}`,
          postState: { removed, references: ctx.references.list() },
        }
      },
    },
  ]

  return { id: 'filesystem', tools: () => tools }
}

/** Append the type's extension when the caller gave a name without one. */
function ensureExtension(name: string, type: DocumentType): string {
  return extname(name) ? name : `${name}${EXTENSIONS[type]}`
}

async function writeBlankDocument(abs: string, type: DocumentType, title: string): Promise<void> {
  switch (type) {
    case 'docx':
      writeFileSync(abs, Buffer.from(await buildBlankDocx()))
      return
    case 'pptx':
      writeFileSync(abs, Buffer.from(await createBlankPptx()))
      return
    case 'xlsx':
      writeFileSync(abs, await blankXlsxBuffer())
      return
    case 'md':
      writeFileSync(abs, `# ${title}\n`, 'utf8')
      return
    case 'html':
      writeFileSync(
        abs,
        `<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>\n<body></body>\n</html>\n`,
        'utf8',
      )
      return
    case 'txt':
      writeFileSync(abs, '', 'utf8')
      return
    case 'pdf':
      throw new Error('no blank PDF template is available; import an existing PDF with fs_import')
  }
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch,
  )
}

/**
 * Repoint registered documents after a move or rename. A folder move carries
 * every document underneath it.
 */
function rewritePaths(workspace: WorkspaceHandle, from: string, to: string): number {
  let changed = 0
  for (const doc of workspace.manifest.documents) {
    if (doc.path !== from && !doc.path.startsWith(`${from}/`)) continue
    doc.path = `${to}${doc.path.slice(from.length)}`
    changed += 1
  }
  return changed
}
