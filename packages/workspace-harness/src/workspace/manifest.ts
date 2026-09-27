import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from './json-file.js'
import { metaDir } from './paths.js'
import { MANIFEST_SCHEMA_VERSION, type WorkspaceManifest } from './types.js'

/** Absolute path of a workspace's manifest. */
export function manifestPath(workspaceDir: string): string {
  return join(metaDir(workspaceDir), 'manifest.json')
}

/** Build the manifest for a freshly created workspace. */
export function createManifest(input: {
  id: string
  name: string
  goal: string
  now: string
  demo?: boolean
}): WorkspaceManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    goal: input.goal,
    createdAt: input.now,
    updatedAt: input.now,
    references: [],
    documents: [],
    settings: { autoSave: true },
    vcs: { enabled: true, remote: null, branch: 'main' },
    ...(input.demo ? { demo: true } : {}),
  }
}

/**
 * Read a workspace manifest.
 *
 * Returns null when the file is missing or unparseable. A manifest written by a
 * newer schema throws instead: silently degrading it would drop fields the
 * caller never sees.
 */
export function readManifest(workspaceDir: string): WorkspaceManifest | null {
  const raw = readJsonFile<WorkspaceManifest>(manifestPath(workspaceDir))
  if (!raw) return null
  if (raw.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported manifest schemaVersion ${String(raw.schemaVersion)} in ${workspaceDir}; this build reads ${MANIFEST_SCHEMA_VERSION}`,
    )
  }
  return {
    ...raw,
    references: raw.references ?? [],
    documents: raw.documents ?? [],
    settings: raw.settings ?? {},
    vcs: raw.vcs ?? { enabled: true, remote: null, branch: 'main' },
    // Written only for the demo workspace; older manifests simply omit it.
    demo: raw.demo ?? false,
  }
}

/** Persist a manifest, creating `.workspace/` if needed. */
export function writeManifest(workspaceDir: string, manifest: WorkspaceManifest): void {
  writeJsonFile(manifestPath(workspaceDir), manifest)
}
