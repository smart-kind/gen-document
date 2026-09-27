import { parseDocx } from '@genoffice/docx-engine'
import { openPptx } from '@genoffice/pptx-engine'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEMO_WORKSPACE_NAME,
  ensureDemoWorkspace,
  provisionDemoWorkspace,
} from '../src/workspace/demo.js'
import { WorkspaceStore } from '../src/workspace/store.js'
import { ZONE_DIRS } from '../src/workspace/zones.js'

let root: string
let store: WorkspaceStore
let libraryRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-harness-demo-'))
  store = new WorkspaceStore(join(root, 'workspaces'))
  libraryRoot = join(root, 'library')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Collect every string reachable from a value, cycle-safe.
 *
 * A demo document is only a usable sample if its text can be read back, and
 * this checks that without depending on the parser's exact object shape.
 */
function textOf(value: unknown): string {
  const out: string[] = []
  const seen = new Set<unknown>()
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node)
      return
    }
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    for (const child of Object.values(node as Record<string, unknown>)) walk(child)
  }
  walk(value)
  return out.join('')
}

describe('demo workspace', () => {
  it('arrives with all four zones populated', async () => {
    const handle = await provisionDemoWorkspace(store, libraryRoot)

    expect(handle.manifest.demo).toBe(true)
    expect(handle.name).toBe(DEMO_WORKSPACE_NAME)
    for (const dir of Object.values(ZONE_DIRS)) {
      expect(existsSync(join(handle.dir, dir)), dir).toBe(true)
      expect(readdirSync(join(handle.dir, dir)).length, dir).toBeGreaterThan(0)
    }
  })

  it('mounts the shared library as a link rather than a copy', async () => {
    const handle = await provisionDemoWorkspace(store, libraryRoot)

    const link = join(handle.dir, ZONE_DIRS.library, '示例资料')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(handle.manifest.references).toHaveLength(1)
    expect(handle.manifest.references[0]?.readOnly).toBe(true)
  })

  it('produces a .docx whose sample text can be read back', async () => {
    const handle = await provisionDemoWorkspace(store, libraryRoot)

    const bytes = readFileSync(join(handle.dir, ZONE_DIRS.output, '示例-技术说明.docx'))
    expect(bytes.subarray(0, 2).toString()).toBe('PK')
    expect(textOf(await parseDocx(bytes))).toContain('示例技术说明')
  })

  it('produces a .pptx whose sample text can be read back', async () => {
    const handle = await provisionDemoWorkspace(store, libraryRoot)

    const bytes = readFileSync(join(handle.dir, ZONE_DIRS.output, '示例-项目汇报.pptx'))
    expect(bytes.subarray(0, 2).toString()).toBe('PK')
    expect(textOf(await openPptx(bytes))).toContain('示例项目汇报')
  })

  it('registers the sample documents in their zones', async () => {
    const handle = await provisionDemoWorkspace(store, libraryRoot)

    const paths = handle.manifest.documents.map((doc) => doc.path)
    expect(paths).toContain(`${ZONE_DIRS.output}/示例-技术说明.docx`)
    expect(paths).toContain(`${ZONE_DIRS.output}/示例-项目汇报.pptx`)
    expect(paths).toContain(`${ZONE_DIRS.feedback}/示例-批阅意见.md`)
    expect(paths).toContain(`${ZONE_DIRS.material}/示例-校验规则.md`)
  })

  it('marks the demo in the registry so the list can find it', async () => {
    const created = await provisionDemoWorkspace(store, libraryRoot)

    const demos = store.list().filter((entry) => entry.demo)
    expect(demos).toHaveLength(1)
    expect(demos[0]?.id).toBe(created.id)
  })

  it('is idempotent: an existing demo is left untouched', async () => {
    const first = await provisionDemoWorkspace(store, libraryRoot)
    const second = await ensureDemoWorkspace(store, libraryRoot)

    expect(second.id).toBe(first.id)
    expect(store.list().filter((entry) => entry.demo)).toHaveLength(1)
  })

  it('reappears after the workspace folder is gone', async () => {
    const first = await provisionDemoWorkspace(store, libraryRoot)
    rmSync(first.dir, { recursive: true, force: true })

    const recreated = await ensureDemoWorkspace(store, libraryRoot)

    expect(recreated.id).not.toBe(first.id)
    expect(existsSync(join(recreated.dir, ZONE_DIRS.output))).toBe(true)
  })
})
