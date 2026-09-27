import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DocumentEntry,
  ShellBridge,
  UiBridge,
  VersionBridge,
} from '@genoffice/workspace-harness'
import { WorkspaceService } from '../src/main/workspace-service'

/**
 * WorkspaceService: creating, opening and remembering the active workspace, and
 * the tool context every agent call is built from. No fake records are used —
 * the service runs against a real temp registry tree.
 */

const ui = (): UiBridge => ({
  getLanguage: async () => 'en',
  setLanguage: async () => {},
  getTheme: async () => 'system',
  setTheme: async () => {},
  togglePanel: async () => {},
  notify: async () => {},
})

const shell = (): ShellBridge => ({
  openDocument: async (path) => ({
    id: 'tab',
    path,
    type: 'md',
    title: path,
    active: true,
    readOnly: false,
  }),
  closeDocument: async () => {},
  activateDocument: async () => {},
  listOpenDocuments: async () => [],
  openWorkspace: async () => {},
})

const vcs = (): VersionBridge => ({ enabled: () => false })

let root: string
let activeIdFile: string
let service: WorkspaceService

function build(activeDocument?: () => DocumentEntry | undefined): WorkspaceService {
  return new WorkspaceService({
    root,
    activeIdFile,
    bridges: () => ({ ui: ui(), shell: shell(), vcs: vcs() }),
    ...(activeDocument ? { activeDocument } : {}),
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-service-'))
  activeIdFile = join(root, 'active-workspace.json')
  service = build()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceService', () => {
  it('creates a workspace and makes it current', () => {
    const handle = service.create({ goal: 'draft the tender document' })
    expect(service.current()?.id).toBe(handle.id)
    expect(service.list()).toHaveLength(1)
    expect(service.current()?.goal).toBe('draft the tender document')
  })

  it('persists the active id and remembers it without opening anything', () => {
    const handle = service.create({ goal: 'goal one' })
    expect(JSON.parse(readFileSync(activeIdFile, 'utf8'))).toEqual({ workspaceId: handle.id })

    // The list is the landing screen, so a fresh instance opens nothing; it only
    // knows which row to mark as last opened.
    const reopened = build()
    expect(reopened.current()).toBeNull()
    expect(reopened.lastActiveId()).toBe(handle.id)
  })

  it('drops the open workspace without forgetting the last-opened mark', () => {
    const handle = service.create({ goal: 'goal one' })
    service.close()
    expect(service.current()).toBeNull()
    expect(() => service.buildContext()).toThrow(/no workspace/)
    expect(service.lastActiveId()).toBe(handle.id)
  })

  it('clears the pointer when the workspace is deleted', () => {
    const handle = service.create({ goal: 'goal one' })
    service.remove(handle.id)
    expect(service.lastActiveId()).toBeNull()
    expect(JSON.parse(readFileSync(activeIdFile, 'utf8'))).toEqual({ workspaceId: null })
  })

  it('tolerates a corrupted pointer file', () => {
    writeFileSync(activeIdFile, 'not json', 'utf8')
    expect(build().lastActiveId()).toBeNull()
  })

  it('throws for an unknown workspace id', () => {
    expect(() => service.open('ws-missing')).toThrow(/unknown workspace/)
  })

  it('keeps the active id pointing at the newest workspace on open', () => {
    const first = service.create({ goal: 'first' })
    const second = service.create({ goal: 'second' })
    service.open(first.id)
    expect(JSON.parse(readFileSync(activeIdFile, 'utf8')).workspaceId).toBe(first.id)
    expect(second.id).not.toBe(first.id)
  })

  it('drops the open workspace when it is deleted', () => {
    const handle = service.create({ goal: 'goal' })
    service.remove(handle.id)
    expect(service.current()).toBeNull()
    expect(() => service.buildContext()).toThrow(/no workspace/)
  })

  it('builds a context whose documents resolve by id and by path', () => {
    const handle = service.create({ goal: 'goal' })
    handle.manifest.documents.push({
      id: 'doc-1',
      path: 'plan.md',
      type: 'md',
      addedAt: 'now',
      source: { kind: 'new' },
    })
    service.saveWorkspace()

    const ctx = service.buildContext()
    expect(ctx.workspace.id).toBe(handle.id)
    expect(ctx.resolveDocument('doc-1')?.path).toBe('plan.md')
    expect(ctx.resolveDocument('./plan.md')?.path).toBe('plan.md')
    expect(ctx.resolveDocument('nope.md')).toBeUndefined()
    expect(ctx.references.list()).toEqual([])
    expect(ctx.vcs.enabled()).toBe(false)
  })

  it('exposes the active editor document on the context when there is one', () => {
    const entry: DocumentEntry = {
      id: 'doc-1',
      path: 'plan.md',
      type: 'md',
      addedAt: 'now',
      source: { kind: 'new' },
    }
    const withDocument = build(() => entry)
    withDocument.create({ goal: 'goal' })
    const ctx = withDocument.buildContext()
    expect(ctx.activeDocument?.path).toBe('plan.md')
  })

  it('leaves activeDocument unset when no editor tab is open', () => {
    service.create({ goal: 'goal' })
    expect(service.buildContext().activeDocument).toBeUndefined()
  })

  it('forwards harness events to the injected sink', () => {
    const onEvent = vi.fn()
    const withSink = new WorkspaceService({
      root,
      activeIdFile,
      bridges: () => ({ ui: ui(), shell: shell(), vcs: vcs() }),
      onEvent,
    })
    withSink.create({ goal: 'goal' })
    withSink.buildContext().emit({ type: 'workspace.changed' })
    expect(onEvent).toHaveBeenCalledWith({ type: 'workspace.changed' })
  })

  it('saves a reference mount through the workspace store', () => {
    const handle = service.create({ goal: 'goal' })
    const source = join(root, 'shared.md')
    writeFileSync(source, 'shared', 'utf8')

    service.referenceStore().add(source)
    expect(service.current()?.manifest.references.map((ref) => ref.readOnly)).toEqual([true])
    expect(service.registry.open(handle.id)?.manifest.references).toHaveLength(1)
  })

  it('requires an open workspace for tools that need one', () => {
    expect(() => service.buildContext()).toThrow(/no workspace is open/)
    expect(() => service.referenceStore()).toThrow(/no workspace is open/)
    expect(() => service.materialStore()).toThrow(/no workspace is open/)
    expect(() => service.saveWorkspace()).toThrow(/no workspace is open/)
  })

  it('reports the counts the list screen shows for each row', () => {
    const handle = service.create({ goal: 'goal' })
    const source = join(root, 'rules.md')
    writeFileSync(source, 'rules', 'utf8')
    service.materialStore().add(source)
    const library = join(root, 'library')
    mkdirSync(library, { recursive: true })
    service.referenceStore().add(library)

    const row = service.listRows().find((entry) => entry.id === handle.id)
    expect(row?.references).toBe(1)
    expect(row?.documents).toBe(0)
    // The material copy is not a registered document; it is a zone file.
    expect(
      service
        .materialStore()
        .list()
        .map((entry) => entry.name),
    ).toEqual(['rules.md'])
  })

  it('persists goal, name and workspace settings from the settings dialog', () => {
    const handle = service.create({ goal: 'goal' })
    service.setSettings({
      name: 'renamed',
      goal: 'a sharper goal',
      language: 'zh',
      agentModel: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    })

    const onDisk = JSON.parse(readFileSync(join(handle.dir, '.workspace', 'manifest.json'), 'utf8'))
    expect(onDisk.name).toBe('renamed')
    expect(onDisk.goal).toBe('a sharper goal')
    expect(onDisk.settings.language).toBe('zh')
    expect(onDisk.settings.agentModel).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    })
    expect(service.current()?.name).toBe('renamed')
  })

  it('clears a workspace setting when the patch asks to follow the app default', () => {
    const handle = service.create({ goal: 'goal' })
    service.setSettings({ language: 'zh', agentModel: { provider: 'genspark', model: 'm' } })
    service.setSettings({ language: null, agentModel: null })

    const onDisk = JSON.parse(readFileSync(join(handle.dir, '.workspace', 'manifest.json'), 'utf8'))
    expect(onDisk.settings.language).toBeUndefined()
    expect(onDisk.settings.agentModel).toBeUndefined()
  })

  it('keeps the reference store writing to the handle the settings edit produced', () => {
    const handle = service.create({ goal: 'goal' })
    service.setSettings({ name: 'renamed' })
    const library = join(root, 'library')
    mkdirSync(library, { recursive: true })
    service.referenceStore().add(library)

    const onDisk = JSON.parse(readFileSync(join(handle.dir, '.workspace', 'manifest.json'), 'utf8'))
    expect(onDisk.name).toBe('renamed')
    expect(onDisk.references).toHaveLength(1)
  })
})
