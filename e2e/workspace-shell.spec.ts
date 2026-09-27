/**
 * Acceptance tests for the workspace shell's three-state interface (M3).
 *
 * The product has three states — the workspace list, the new-workspace wizard
 * and the workspace itself — over the harness's four-zone model. These tests
 * drive the real built app through the `data-testid` hooks the UI exposes, and
 * check the disk against what the interface claims.
 *
 * Requires the app to be built first:
 *   npm run build -w @genoffice/workspace-shell
 */
import { expect, test } from '@playwright/test'
import type { ToolContext, WorkspaceHandle } from '@genoffice/workspace-harness'
// The harness barrel pulls pi-ai, which is ESM-only and cannot be loaded from a
// Playwright spec; the file-system tool set itself has no provider dependency.
import { createFileSystemToolSet } from '../packages/workspace-harness/src/tools/filesystem'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeWorkspaceShell, launchWorkspaceShell } from './workspace-shell-helpers'

const GOAL = '编写 XX 医院综合楼施工投标文件'

/** The four zones the harness defines, in display order. */
const ZONES = ['引用', '资料', '产出', '意见'] as const

const DEMO_NAME = '演示空间'

let scratch: string

test.beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'workspace-shell-spec-'))
})

test.afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** Enter the demo workspace from the list screen. */
async function enterDemo(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-testid="demo-row"] [data-testid="workspace-open"]').click()
  await expect(page.locator('[data-testid="zone-tree"]')).toBeVisible()
}

test.describe('workspace shell', () => {
  test('lands on the workspace list with the demo workspace and no editor area', async () => {
    const launched = await launchWorkspaceShell({ videoDir: 'workspace-shell-list', lang: 'en' })
    try {
      const { page } = launched

      await expect(page.locator('[data-testid="workspace-list"]')).toBeVisible()
      await expect(page.locator('[data-testid="new-workspace"]')).toBeVisible()
      await expect(page.locator('[data-testid="demo-row"]')).toContainText(DEMO_NAME)

      // Nothing is open: the list screen has neither the editor area nor a tree.
      await expect(page.locator('[data-testid="editor-area"]')).toHaveCount(0)
      await expect(page.locator('[data-testid="zone-tree"]')).toHaveCount(0)
      await expect(page.locator('[data-testid="chat-panel"]')).toHaveCount(0)

      // The demo is pinned to the top and carries no delete affordance.
      const rows = await page.evaluate(() => window.workspaceShell.listWorkspaces())
      expect(rows[0]?.demo).toBe(true)
      expect(rows[0]?.name).toBe(DEMO_NAME)
      await expect(
        page.locator('[data-testid="demo-row"] [data-testid="workspace-delete"]'),
      ).toHaveCount(0)
      await expect(
        page.locator('[data-testid="workspace-row"] [data-testid="workspace-delete"]'),
      ).toHaveCount(0)

      // On disk: the demo folder has all four zones and real sample documents.
      const demoDir = rows[0]!.dir
      for (const zone of ZONES) expect(existsSync(join(demoDir, zone))).toBe(true)
      const produced = readdirSync(join(demoDir, '产出'))
      expect(produced).toContain('示例-技术说明.docx')
      expect(produced).toContain('示例-项目汇报.pptx')
    } finally {
      await closeWorkspaceShell(launched)
    }
  })

  test('shows the four zones, marks the read-only ones, and opens a produced .docx', async () => {
    const launched = await launchWorkspaceShell({ videoDir: 'workspace-shell-zones', lang: 'en' })
    try {
      const { page } = launched
      await enterDemo(page)

      for (const zone of ['library', 'material', 'output', 'feedback']) {
        await expect(page.locator(`[data-testid="zone-group-${zone}"]`)).toBeVisible()
      }

      // The two input zones are marked read-only; the two working zones are not.
      await expect(page.locator('[data-testid="zone-lock-library"]')).toBeVisible()
      await expect(page.locator('[data-testid="zone-lock-material"]')).toBeVisible()
      await expect(page.locator('[data-testid="zone-lock-output"]')).toHaveCount(0)
      await expect(page.locator('[data-testid="zone-lock-feedback"]')).toHaveCount(0)

      const materialRow = page.locator(
        '[data-testid="zone-group-material"] [data-testid="zone-file"]',
      )
      await expect(materialRow).toHaveAttribute('data-readonly', 'true')

      const sample = page.locator(
        '[data-testid="zone-group-output"] [data-testid="zone-file"][data-path="产出/示例-技术说明.docx"]',
      )
      await expect(sample).toBeVisible()
      await sample.click()

      await expect(page.locator('[data-testid="doc-tab"]')).toContainText('示例-技术说明.docx')
      const open = await page.evaluate(() => window.workspaceShell.listOpenDocuments())
      expect(open.map((doc) => doc.path)).toEqual(['产出/示例-技术说明.docx'])
      expect(open[0]?.readOnly).toBe(false)

      // A file in a read-only zone opens read-only instead.
      const rules = page.locator(
        '[data-testid="zone-group-material"] [data-testid="zone-file"][data-path="资料/示例-校验规则.md"]',
      )
      await rules.click()
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.workspaceShell.listOpenDocuments())).find(
              (doc) => doc.path === '资料/示例-校验规则.md',
            )?.readOnly,
        )
        .toBe(true)
    } finally {
      await closeWorkspaceShell(launched)
    }
  })

  test('walks the three-step wizard and writes nothing before the last step', async () => {
    const launched = await launchWorkspaceShell({ videoDir: 'workspace-shell-wizard', lang: 'en' })
    try {
      const { page } = launched
      const parent = join(scratch, 'spaces')
      const library = join(scratch, '公司资质')
      mkdirSync(library, { recursive: true })
      writeFileSync(join(library, '营业执照.txt'), 'shared', 'utf8')
      const rules = join(scratch, '业主需求.md')
      writeFileSync(rules, '# requirements', 'utf8')

      await page.locator('[data-testid="new-workspace"]').click()
      await expect(page.locator('[data-testid="wizard-body-1"]')).toBeVisible()
      await expect(page.locator('[data-testid="wizard-next"]')).toBeDisabled()

      await page.locator('[data-testid="wizard-goal"]').fill(GOAL)
      await page.locator('[data-testid="wizard-next"]').click()

      await expect(page.locator('[data-testid="wizard-body-2"]')).toBeVisible()
      await page.locator('[data-testid="wizard-parent-dir"]').fill(parent)

      // A path that does not exist is refused rather than silently skipped.
      await page.locator('[data-testid="wizard-ref-path"]').fill('/definitely/not/here')
      await page.locator('[data-testid="wizard-ref-add"]').click()
      await expect(page.locator('[data-testid="wizard-ref-item"]')).toHaveAttribute(
        'data-status',
        'missing',
      )
      await expect(page.locator('[data-testid="wizard-next"]')).toBeDisabled()

      // Fixing it: remove the bad one, mount a real library and copy real material.
      await page.locator('[data-testid="wizard-ref-item"] button').click()
      await page.locator('[data-testid="wizard-ref-path"]').fill(library)
      await page.locator('[data-testid="wizard-ref-add"]').click()
      await expect(page.locator('[data-testid="wizard-ref-item"]')).toHaveAttribute(
        'data-status',
        'ok',
      )
      await page.locator('[data-testid="wizard-material-path"]').fill(rules)
      await page.locator('[data-testid="wizard-material-add"]').click()
      await expect(page.locator('[data-testid="wizard-material-item"]')).toHaveAttribute(
        'data-status',
        'ok',
      )
      await expect(page.locator('[data-testid="wizard-next"]')).toBeEnabled()
      await page.locator('[data-testid="wizard-next"]').click()

      await expect(page.locator('[data-testid="wizard-body-3"]')).toBeVisible()
      await page.locator('[data-testid="wizard-provider"]').selectOption('genspark')
      await page.locator('[data-testid="wizard-language"]').selectOption('en')

      // Nothing has been written yet: the target folder does not exist at all.
      expect(existsSync(parent)).toBe(false)

      await page.locator('[data-testid="wizard-create"]').click()

      // Back on the list, with the new row present and marked.
      await expect(page.locator('[data-testid="workspace-list"]')).toBeVisible()
      const row = page.locator('[data-testid="workspace-row"]', { hasText: GOAL })
      await expect(row).toBeVisible()
      await expect(row).toHaveClass(/workspace-row-highlight/)

      const created = (await page.evaluate(() => window.workspaceShell.listWorkspaces())).find(
        (entry) => entry.goal === GOAL,
      )
      expect(created?.dir.startsWith(parent)).toBe(true)
      expect(readdirSync(parent)).toHaveLength(1)

      const dir = created!.dir
      for (const zone of ZONES) expect(existsSync(join(dir, zone))).toBe(true)

      // The reference is a symlink into the shared library, the material is a copy.
      const link = join(dir, '引用', '公司资质')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(library)
      expect(readFileSync(join(dir, '资料', '业主需求.md'), 'utf8')).toBe('# requirements')

      const manifest = JSON.parse(readFileSync(join(dir, '.workspace', 'manifest.json'), 'utf8'))
      expect(manifest.goal).toBe(GOAL)
      expect(manifest.name).toBe(GOAL)
      expect(manifest.references).toHaveLength(1)
      expect(manifest.settings.language).toBe('en')
      expect(manifest.settings.agentModel.provider).toBe('genspark')
    } finally {
      await closeWorkspaceShell(launched)
    }
  })

  test('refuses tool writes into the read-only zones and marks them in the UI', async () => {
    const launched = await launchWorkspaceShell({
      videoDir: 'workspace-shell-readonly',
      lang: 'en',
    })
    try {
      const { page } = launched
      await enterDemo(page)

      // The UI says so.
      await expect(page.locator('[data-testid="zone-lock-material"]')).toBeVisible()
      await expect(page.locator('[data-testid="zone-lock-library"]')).toBeVisible()
      await expect(
        page.locator(
          '[data-testid="zone-group-material"] [data-testid="zone-file"][data-path="资料/示例-校验规则.md"]',
        ),
      ).toHaveAttribute('data-readonly', 'true')

      // And the tool layer refuses, against the very folder the UI is showing.
      const demo = (await page.evaluate(() => window.workspaceShell.listWorkspaces())).find(
        (entry) => entry.demo,
      )!
      // The handle is read off disk rather than through the harness store, for the
      // same reason the tool set is imported by path.
      const manifest = JSON.parse(
        readFileSync(join(demo.dir, '.workspace', 'manifest.json'), 'utf8'),
      )
      const workspace: WorkspaceHandle = {
        id: manifest.id,
        name: manifest.name,
        goal: manifest.goal,
        dir: demo.dir,
        manifest,
      }

      const addDocument = createFileSystemToolSet()
        .tools({ workspace } as unknown as ToolContext)
        .find((tool) => tool.name === 'fs_add_document')!
      const ctx = {
        workspace,
        saveWorkspace: () => {},
        emit: () => {},
      } as unknown as ToolContext
      for (const zone of ['资料', '引用']) {
        let message = ''
        try {
          await addDocument.execute(ctx, { type: 'md', name: 'intruder.md', dir: zone })
        } catch (error) {
          message = String(error)
        }
        expect(message).toMatch(/read-only/)
        expect(existsSync(join(workspace.dir, zone, 'intruder.md'))).toBe(false)
      }

      // The writable zones are still writable, so the refusal is targeted.
      await addDocument.execute(ctx, { type: 'md', name: 'fine.md', dir: '产出' })
      expect(existsSync(join(workspace.dir, '产出', 'fine.md'))).toBe(true)
    } finally {
      await closeWorkspaceShell(launched)
    }
  })

  test('reports insets the main process stores, and gives the width back when chat collapses', async () => {
    const launched = await launchWorkspaceShell({ videoDir: 'workspace-shell-layout', lang: 'en' })
    try {
      const { page } = launched
      await enterDemo(page)

      const readPublished = (): Promise<Record<string, string>> =>
        page.evaluate(() => {
          const style = getComputedStyle(document.documentElement)
          return {
            left: style.getPropertyValue('--inset-left').trim(),
            right: style.getPropertyValue('--inset-right').trim(),
            top: style.getPropertyValue('--inset-top').trim(),
          }
        })

      const shownInset = await readPublished()
      expect(shownInset).toEqual({ left: '240px', right: '360px', top: '44px' })
      expect(await page.evaluate(() => window.workspaceShell.getLayoutInsets())).toEqual({
        left: 240,
        right: 360,
        top: 44,
      })

      const before = await page.locator('[data-testid="editor-area"]').boundingBox()
      await expect(page.locator('[data-testid="chat-panel"]')).toBeVisible()

      await page.locator('[data-testid="chat-toggle"]').click()

      await expect(page.locator('[data-testid="chat-panel"]')).toHaveCount(0)
      await expect
        .poll(
          async () => (await page.evaluate(() => window.workspaceShell.getLayoutInsets())).right,
        )
        .toBe(0)

      // The renderer's published insets and the main process's stored ones agree.
      const hiddenInset = await readPublished()
      expect(hiddenInset).toEqual({ left: '240px', right: '0px', top: '44px' })
      expect(await page.evaluate(() => window.workspaceShell.getLayoutInsets())).toEqual({
        left: 240,
        right: 0,
        top: 44,
      })

      const after = await page.locator('[data-testid="editor-area"]').boundingBox()
      expect(Math.round(after!.width - before!.width)).toBe(360)
      expect(after!.x).toBe(before!.x)
    } finally {
      await closeWorkspaceShell(launched)
    }
  })

  test('persists a model and language change from the settings dialog', async () => {
    const launched = await launchWorkspaceShell({
      videoDir: 'workspace-shell-settings',
      lang: 'en',
    })
    try {
      const { page } = launched
      await enterDemo(page)

      await page.locator('[data-testid="settings-open"]').click()
      await expect(page.locator('[data-testid="settings-dialog"]')).toBeVisible()

      // The first real provider after "follow the global settings".
      await page.locator('[data-testid="settings-provider"]').selectOption({ index: 1 })
      const provider = await page.locator('[data-testid="settings-provider"]').inputValue()
      const model = await page.locator('[data-testid="settings-model"]').inputValue()
      expect(provider).not.toBe('')
      expect(model).not.toBe('')

      await page.locator('[data-testid="settings-language"]').selectOption('zh')
      await page.locator('[data-testid="settings-save"]').click()
      await expect(page.locator('[data-testid="settings-dialog"]')).toHaveCount(0)

      await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('zh-CN')

      const demo = (await page.evaluate(() => window.workspaceShell.listWorkspaces())).find(
        (entry) => entry.demo,
      )!
      const manifest = JSON.parse(
        readFileSync(join(demo.dir, '.workspace', 'manifest.json'), 'utf8'),
      )
      expect(manifest.settings.agentModel).toEqual({ provider, model })
      expect(manifest.settings.language).toBe('zh')
    } finally {
      await closeWorkspaceShell(launched)
    }
  })

  test('turns the two workflow buttons into conversations built from the real zones', async () => {
    const launched = await launchWorkspaceShell({
      videoDir: 'workspace-shell-workflows',
      lang: 'zh',
    })
    try {
      const { page } = launched
      await enterDemo(page)

      /** First user message of the newest conversation with this title, or null. */
      const firstMessage = (title: string): Promise<{ role?: string; text: string } | null> =>
        page.evaluate(async (wanted: string) => {
          const conversations = await window.workspaceShell.listConversations()
          const found = [...conversations].reverse().find((entry) => entry.title === wanted)
          if (!found) return null
          const first = (await window.workspaceShell.transcript(found.id))[0]
          return first ? { role: first.role, text: first.text } : null
        }, title)

      // 校验产出: the rule file, the produced .docx, and a stamped report path.
      await page.locator('[data-testid="validate-output"]').click()
      await expect
        .poll(async () => (await firstMessage('校验产出')) !== null, { timeout: 20_000 })
        .toBe(true)

      const validated = await firstMessage('校验产出')
      expect(validated?.role).toBe('user')
      expect(validated?.text).toContain('资料/示例-校验规则.md')
      expect(validated?.text).toContain('产出/示例-技术说明.docx')
      expect(validated?.text).toMatch(/产出\/校验报告-\d{8}-\d{4}\.md/)
      // The conversation is the active one and its instruction is on screen.
      await expect(
        page.locator('[data-testid="conversation-list"] .list-row-active'),
      ).toContainText('校验产出')
      await expect(page.locator('[data-testid="chat-log"]')).toContainText('产出/校验报告-')

      // 汇总意见: the opinion file, the produced documents, and its own report path.
      await page.locator('[data-testid="summarize-feedback"]').click()
      await expect
        .poll(async () => (await firstMessage('汇总意见')) !== null, { timeout: 20_000 })
        .toBe(true)

      const summarized = await firstMessage('汇总意见')
      expect(summarized?.role).toBe('user')
      expect(summarized?.text).toContain('意见/示例-批阅意见.md')
      expect(summarized?.text).toContain('产出/示例-技术说明.docx')
      expect(summarized?.text).toMatch(/产出\/意见处置-\d{8}-\d{4}\.md/)
      // Conclusions never go back into 意见/, which stays the raw evidence.
      expect(summarized?.text).toContain('不要写回 意见/')
      await expect(
        page.locator('[data-testid="conversation-list"] .list-row-active'),
      ).toContainText('汇总意见')
    } finally {
      await closeWorkspaceShell(launched)
    }
  })
})

declare global {
  interface Window {
    workspaceShell: import('../apps/workspace-shell/src/shared/api').WorkspaceShellApi
  }
}
