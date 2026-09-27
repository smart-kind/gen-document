import { extname } from 'node:path'
import { nowIso } from '../time.js'
import { newId } from './ids.js'
import { resolveInside } from './paths.js'
import type { DocumentEntry, DocumentType, WorkspaceHandle } from './types.js'
import { zoneOf, type ZoneId } from './zones.js'

const EXTENSION_TYPES: Record<string, DocumentType> = {
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
  '.pptx': 'pptx',
  '.pdf': 'pdf',
  '.md': 'md',
  '.markdown': 'md',
  '.html': 'html',
  '.htm': 'html',
  '.txt': 'txt',
}

/** Document type implied by a file extension, or undefined for unknown types. */
export function documentTypeFor(path: string): DocumentType | undefined {
  return EXTENSION_TYPES[extname(path).toLowerCase()]
}

/** Normalize a document path to workspace-relative POSIX form. */
export function normalizeDocPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '')
}

/** Absolute path of a document inside its workspace. */
export function documentAbsPath(workspace: WorkspaceHandle, entry: DocumentEntry): string {
  return resolveInside(workspace.dir, entry.path)
}

/** Registered documents whose path sits in one zone. */
export function documentsInZone(workspace: WorkspaceHandle, zone: ZoneId): DocumentEntry[] {
  return workspace.manifest.documents.filter((entry) => zoneOf(entry.path) === zone)
}

/** Find a document by id or workspace-relative path. */
export function findDocument(workspace: WorkspaceHandle, ref: string): DocumentEntry | undefined {
  const needle = normalizeDocPath(ref.trim())
  return workspace.manifest.documents.find((d) => d.id === ref.trim() || d.path === needle)
}

/** Register (or re-register) a document in the manifest. Callers persist the workspace. */
export function addDocument(
  workspace: WorkspaceHandle,
  input: { path: string; type?: DocumentType; note?: string; source: DocumentEntry['source'] },
): DocumentEntry {
  const path = normalizeDocPath(input.path)
  const entry: DocumentEntry = {
    id: newId('doc'),
    path,
    type: input.type ?? documentTypeFor(path) ?? 'txt',
    ...(input.note ? { note: input.note } : {}),
    addedAt: nowIso(),
    source: input.source,
  }
  workspace.manifest.documents = [
    ...workspace.manifest.documents.filter((d) => d.path !== path),
    entry,
  ]
  return entry
}

/** Drop a document from the manifest. Callers persist the workspace. */
export function removeDocument(workspace: WorkspaceHandle, ref: string): DocumentEntry {
  const entry = findDocument(workspace, ref)
  if (!entry) throw new Error(`no such document: ${ref}`)
  workspace.manifest.documents = workspace.manifest.documents.filter((d) => d.id !== entry.id)
  return entry
}

/** Drop the manifest entry for a path, if any. Used after deleting the file. */
export function forgetPath(workspace: WorkspaceHandle, path: string): void {
  const normalized = normalizeDocPath(path)
  workspace.manifest.documents = workspace.manifest.documents.filter(
    (d) => d.path !== normalized && !d.path.startsWith(`${normalized}/`),
  )
}
