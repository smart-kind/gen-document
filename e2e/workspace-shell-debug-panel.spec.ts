/**
 * Acceptance test for the workspace shell's debug panel: the document-edit
 * bridge's test bench.
 *
 * The panel exists so the bridge can be exercised by a button rather than
 * through an agent, so this test drives the real built app the same way — open a
 * document, click an action, and check the document actually changed and the
 * editor was never reloaded.
 *
 * Requires the app to be built first:
 *   npm run build -w @genoffice/workspace-shell
 */
import { expect, test } from '@playwright/test'
import JSZip from 'jszip'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeWorkspaceShell, launchWorkspaceShell } from './workspace-shell-helpers'

const SAMPLE_DOC = '产出/示例-技术说明.docx'
const SAMPLE_DECK = '产出/示例-项目汇报.pptx'
const SAMPLE_SHEET = '产出/示例-数据.xlsx'
const SAMPLE_MD = '产出/示例-说明.md'

/** A minimal-but-valid single-sheet xlsx, since the demo ships no spreadsheet. */
async function writeSampleXlsx(path: string): Promise<void> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Hello</t></is></c></row></sheetData>' +
      '</worksheet>',
  )
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }))
}

/** Enter the demo workspace from the list screen. */
async function enterDemo(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-testid="demo-row"] [data-testid="workspace-open"]').click()
  await expect(page.locator('[data-testid="zone-tree"]')).toBeVisible()
}

test.describe('workspace shell debug panel', () => {
  test('reserves the right column and shows the empty state with nothing open', async () => {
    const launched = await launchWorkspaceShell({
      videoDir: 'workspace-shell-debug-empty',
      lang: 'en',
    })
    try {
      const { page } = launched
      await enterDemo(page)

      await page.locator('[data-testid="debug-toggle"]').click()
      await expect(page.locator('[data-testid="debug-panel"]')).toBeVisible()
      await expect(page.locator('[data-testid="debug-no-document"]')).toBeVisible()
      // The debug panel replaces the chat column rather than stacking with it.
      await expect(page.locator('[data-testid="chat-panel"]')).toHaveCount(0)
      expect(await page.evaluate(() => window.workspaceShell.getLayoutInsets())).toEqual({
        left: 240,
        right: 360,
        top: 44,
      })
    } finally {
      await closeWorkspaceShell(launched)
    }
  })

  test('edits a docx through the bridge and the document changes in place', async () => {
    const launched = await launchWorkspaceShell({
      videoDir: 'workspace-shell-debug-panel',
      lang: 'en',
    })
    try {
      const { page } = launched
      await enterDemo(page)

      await page
        .locator(
          `[data-testid="zone-group-output"] [data-testid="zone-file"][data-path="${SAMPLE_DOC}"]`,
        )
        .click()
      await expect(page.locator('[data-testid="doc-tab"]')).toContainText('示例-技术说明.docx')

      await page.locator('[data-testid="debug-toggle"]').click()
      await expect(page.locator('[data-testid="debug-subject"]')).toContainText(
        '示例-技术说明.docx',
      )
      await expect(page.locator('[data-testid="debug-subject"]')).toContainText('docs')

      // The editor's webContents is the same before and after the edit: an
      // incremental render must not reload the tab.
      const tabBefore = (await page.evaluate(() => window.workspaceShell.bridgeTabs()))[0]
      expect(tabBefore?.kind).toBe('docs')

      const latest = page.locator('[data-testid="debug-results"] .debug-result').first()
      const action = (label: string) =>
        page.locator('[data-testid="debug-action"]', { hasText: label })

      await action('Read document').click()
      await expect(latest.locator('.debug-result-status')).toHaveText('ok')

      await action('Insert paragraph at end').click()
      await expect(latest.locator('.debug-result-status')).toHaveText('ok')

      // Read back: the inserted paragraph must be in the live document.
      await action('Read document').click()
      await expect(latest.locator('.debug-result-body')).toContainText(
        'Inserted by the debug panel.',
      )

      const tabAfter = (await page.evaluate(() => window.workspaceShell.bridgeTabs()))[0]
      expect(tabAfter?.wcId).toBe(tabBefore?.wcId)
    } finally {
      await closeWorkspaceShell(launched)
    }
  })

  test('reads and edits a pptx deck through the bridge', async () => {
    const launched = await launchWorkspaceShell({
      videoDir: 'workspace-shell-debug-deck',
      lang: 'en',
    })
    try {
      const { page } = launched
      await enterDemo(page)

      await page
        .locator(
          `[data-testid="zone-group-output"] [data-testid="zone-file"][data-path="${SAMPLE_DECK}"]`,
        )
        .click()
      await expect(page.locator('[data-testid="doc-tab"]')).toContainText('示例-项目汇报.pptx')

      await page.locator('[data-testid="debug-toggle"]').click()
      await expect(page.locator('[data-testid="debug-subject"]')).toContainText('slides')

      const latest = page.locator('[data-testid="debug-results"] .debug-result').first()
      const action = (label: string) =>
        page.locator('[data-testid="debug-action"]', { hasText: label })

      // The sample deck is one slide, so index 1 can only appear after an insert.
      await action('Read deck').click()
      await expect(latest.locator('.debug-result-status')).toHaveText('ok')
      await expect(latest.locator('.debug-result-body')).not.toContainText('"index": 1')

      await action('Add blank slide after 0').click()
      await expect(latest.locator('.debug-result-status')).toHaveText('ok')

      await action('Read deck').click()
      await expect(latest.locator('.debug-result-body')).toContainText('"index": 1')
    } finally {
      await closeWorkspaceShell(launched)
    }
  })

  test('reads a spreadsheet through the bridge', async () => {
    const launched = await launchWorkspaceShell({
      videoDir: 'workspace-shell-debug-sheet',
      lang: 'en',
    })
    try {
      const { page } = launched

      // The demo ships no spreadsheet, so plant one in its output zone first.
      const demo = (await page.evaluate(() => window.workspaceShell.listWorkspaces())).find(
        (entry) => entry.demo,
      )!
      await writeSampleXlsx(join(demo.dir, '产出', '示例-数据.xlsx'))

      await enterDemo(page)
      await page
        .locator(
          `[data-testid="zone-group-output"] [data-testid="zone-file"][data-path="${SAMPLE_SHEET}"]`,
        )
        .click()
      await expect(page.locator('[data-testid="doc-tab"]')).toContainText('示例-数据.xlsx')

      await page.locator('[data-testid="debug-toggle"]').click()
      await expect(page.locator('[data-testid="debug-subject"]')).toContainText('sheets')

      const latest = page.locator('[data-testid="debug-results"] .debug-result').first()
      await page
        .locator('[data-testid="debug-action"]', { hasText: 'Read sheet (context)' })
        .click()
      await expect(latest.locator('.debug-result-status')).toHaveText('ok')
      await expect(latest.locator('.debug-result-body')).toContainText('Sheet1')
    } finally {
      await closeWorkspaceShell(launched)
    }
  })

  test('edits a markdown file through the bridge', async () => {
    const launched = await launchWorkspaceShell({
      videoDir: 'workspace-shell-debug-markdown',
      lang: 'en',
    })
    try {
      const { page } = launched
      await enterDemo(page)

      await page
        .locator(
          `[data-testid="zone-group-output"] [data-testid="zone-file"][data-path="${SAMPLE_MD}"]`,
        )
        .click()
      await expect(page.locator('[data-testid="doc-tab"]')).toContainText('示例-说明.md')

      await page.locator('[data-testid="debug-toggle"]').click()
      await expect(page.locator('[data-testid="debug-subject"]')).toContainText('markdown')

      const latest = page.locator('[data-testid="debug-results"] .debug-result').first()
      const action = (label: string) =>
        page.locator('[data-testid="debug-action"]', { hasText: label })

      await action('Insert after block 0').click()
      await expect(latest.locator('.debug-result-status')).toHaveText('ok')

      await action('Read document').click()
      await expect(latest.locator('.debug-result-body')).toContainText(
        'Inserted after the first block.',
      )
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
