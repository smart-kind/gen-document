import { existsSync } from 'node:fs'
import { BrowserWindow, type WebContentsView } from 'electron'
import {
  createDocsView,
  requestDocsClose,
  setActiveDocsResolver,
  teardownDocsRenderer,
} from '../../../docs/src/main/docs-main'
import { createHtmlView, requestHtmlClose } from '../../../html/src/main/html-main'
import { createMarkdownView, requestMarkdownClose } from '../../../markdown/src/main/markdown-main'
import { createPdfView, requestPdfClose } from '../../../pdf/src/main/pdf-main'
import {
  createSheetsView,
  queueWorkbookForView,
  requestSheetsClose,
  setActiveSheetsWebContents,
} from '../../../sheets/src/main/sheets-main'
import {
  createSlidesView,
  requestSlidesClose,
  setActiveSlidesWebContents,
} from '../../../slides/src/main/slides-main'
import {
  documentTypeFor,
  findDocument,
  normalizeRel,
  resolveInside,
  type DocumentEntry,
  type DocumentType,
  type OpenDocument,
  type WorkspaceHandle,
} from '@genoffice/workspace-harness'
import {
  editorBounds,
  normalizeInsets,
  workspaceInsets,
  type ContentBounds,
  type LayoutInsets,
} from '../shared/layout'
import { editorKindForPath, isReadOnlyPath, tabTitleFor, type EditorKind } from './editor-tabs'

/**
 * The workspace shell's own editor view pool.
 *
 * It deliberately does not reuse the unified shell's TabManager: that manager
 * owns a tab strip, a Home tab, detached windows and a per-module menu, none of
 * which the workspace shell has, and it lays its views out from y=0 as full-width
 * children. Here the views are inset by whatever the renderer reports, so the
 * rail, the tab strip and a collapsed chat column all stay clickable.
 */

interface EditorTab {
  id: string
  kind: EditorKind
  view: WebContentsView
  /** Workspace-relative POSIX path. */
  path: string
  absPath: string
  title: string
  readOnly: boolean
}

export interface EditorHostOptions {
  window: BrowserWindow
  /** Folder of the open workspace, or null when none is open. */
  workspaceDir: () => string | null
  /** Handle of the open workspace, used to resolve registered documents. */
  workspace: () => WorkspaceHandle | null
  /** Called whenever the tab set or the active tab changes. */
  onChanged?: () => void
}

export class EditorHost {
  private readonly tabs: EditorTab[] = []
  private activeId: string | null = null
  private nextId = 1
  /** Chrome reported by the renderer; the default matches a freshly opened window. */
  private insets: LayoutInsets = workspaceInsets(true)

  constructor(private readonly options: EditorHostOptions) {
    const win = options.window
    win.on('resize', () => this.layout())
  }

  /** The layout the renderer last reported. */
  layoutInsets(): LayoutInsets {
    return this.insets
  }

  /**
   * Accept the renderer's reported layout and re-place every open view.
   *
   * The renderer is the single authority: only it knows whether the chat column
   * is collapsed, so the main process must never assume a fixed sidebar width.
   */
  setInsets(input: unknown): void {
    this.insets = normalizeInsets(input)
    this.layout()
  }

  /** Keep every open view inside the editor area. */
  layout(): void {
    const win = this.options.window
    if (win.isDestroyed()) return
    const bounds = this.editorArea()
    for (const tab of this.tabs) tab.view.setBounds(bounds)
  }

  /** Open a workspace-relative path, reusing the tab if it is already open. */
  open(relPathInput: string, options?: { readOnly?: boolean }): OpenDocument {
    const rel = normalizeRel(relPathInput)
    const workspaceDir = this.requireWorkspaceDir()
    const absPath = resolveInside(workspaceDir, rel)
    if (!existsSync(absPath)) throw new Error(`no such document: ${rel}`)

    const type = documentTypeFor(rel)
    if (!type) throw new Error(`unsupported document type: ${rel}`)
    const kind = editorKindForPath(rel)
    if (!kind) throw new Error(`no editor for ${rel}`)

    const existing = this.tabs.find((tab) => tab.path === rel)
    if (existing) {
      this.activate(existing.id)
      return this.summarize(existing)
    }

    const view = this.createView(kind, absPath)
    this.options.window.contentView.addChildView(view)
    view.setVisible(false)
    view.setBounds(this.editorArea())

    const tab: EditorTab = {
      id: `tab${this.nextId++}`,
      kind,
      view,
      path: rel,
      absPath,
      title: tabTitleFor(rel),
      readOnly: isReadOnlyPath(rel, options?.readOnly),
    }
    view.webContents.once('destroyed', () => this.forget(tab.id))
    this.tabs.push(tab)
    this.activate(tab.id)
    return this.summarize(tab)
  }

  /**
   * Close a tab. With `save` (the default) the owning editor runs its own
   * unsaved-changes flow and may refuse to close; a read-only tab has nothing to
   * save, so it closes without asking.
   */
  async close(id: string, options?: { save?: boolean }): Promise<void> {
    const tab = this.tabs.find((candidate) => candidate.id === id)
    if (!tab) return
    if (options?.save !== false && !tab.readOnly) {
      if (!(await this.requestClose(tab))) return
    }
    this.destroy(tab)
  }

  activate(id: string): void {
    const target = this.tabs.find((tab) => tab.id === id)
    if (!target) return
    for (const tab of this.tabs) tab.view.setVisible(tab.id === id)
    target.view.setBounds(this.editorArea())
    this.activeId = id
    this.pointActiveTargets(target)
    if (!this.options.window.isDestroyed() && this.options.window.isFocused()) {
      target.view.webContents.focus()
    }
    this.options.onChanged?.()
  }

  list(): OpenDocument[] {
    return this.tabs.map((tab) => this.summarize(tab))
  }

  /** Open paths, workspace-relative. */
  openPaths(): string[] {
    return this.tabs.map((tab) => tab.path)
  }

  /** Tab info for the docs bridge: path, webContents id, and kind. */
  tabInfos(): Array<{ path: string; wcId: number; kind: string }> {
    return this.tabs.map((tab) => ({
      path: tab.path,
      wcId: tab.view.webContents.id,
      kind: tab.kind,
    }))
  }

  /**
   * Open tabs with the flags the debug panel needs.
   *
   * `tabInfos` is the bridge's own addressing (path/wcId/kind); this adds the
   * title, the active mark and the read-only flag the panel paints, so the
   * renderer can pick the active tab and offer the right operations without a
   * second lookup.
   */
  bridgeTabs(): Array<{
    path: string
    title: string
    wcId: number
    kind: string
    active: boolean
    readOnly: boolean
  }> {
    return this.tabs.map((tab) => ({
      path: tab.path,
      title: tab.title,
      wcId: tab.view.webContents.id,
      kind: tab.kind,
      active: tab.id === this.activeId,
      readOnly: tab.readOnly,
    }))
  }

  /** The registered document of the active tab, for `ToolContext.activeDocument`. */
  activeDocument(): DocumentEntry | undefined {
    const tab = this.tabs.find((candidate) => candidate.id === this.activeId)
    const workspace = this.options.workspace()
    if (!tab || !workspace) return undefined
    return findDocument(workspace, tab.path)
  }

  activeTabId(): string | null {
    return this.activeId
  }

  /** Drop every tab when the workspace changes; the paths belong to the old folder. */
  closeAll(): void {
    for (const tab of [...this.tabs]) this.destroy(tab)
  }

  private createView(kind: EditorKind, absPath: string): WebContentsView {
    switch (kind) {
      case 'docs':
        return createDocsView(absPath)
      case 'sheets': {
        const view = createSheetsView({ includeAiHandlers: false })
        queueWorkbookForView(view.webContents, absPath)
        return view
      }
      case 'slides':
        return createSlidesView(absPath)
      case 'pdf':
        return createPdfView(absPath)
      case 'markdown':
        return createMarkdownView(absPath)
      case 'html':
        return createHtmlView(absPath)
    }
  }

  /** Ask the owning editor to settle its unsaved changes; false means it refused. */
  private async requestClose(tab: EditorTab): Promise<boolean> {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return true
    const parent = this.options.window
    switch (tab.kind) {
      case 'docs':
        return requestDocsClose(wc, parent)
      case 'sheets':
        return requestSheetsClose(wc, parent)
      case 'slides':
        return requestSlidesClose(wc, parent)
      case 'pdf':
        return requestPdfClose(wc, parent)
      case 'markdown':
        return requestMarkdownClose(wc, parent)
      case 'html':
        return requestHtmlClose(wc, parent)
    }
  }

  private destroy(tab: EditorTab): void {
    const index = this.tabs.indexOf(tab)
    if (index < 0) return
    this.tabs.splice(index, 1)
    if (this.activeId === tab.id) {
      this.activeId = null
      const fallback = this.tabs[index - 1] ?? this.tabs[0]
      if (fallback) this.activate(fallback.id)
    }
    tab.view.setVisible(false)
    if (!this.options.window.isDestroyed()) {
      this.options.window.contentView.removeChildView(tab.view)
    }
    if (tab.kind === 'docs') {
      // `webContents.close()` on a docs tab wedges Electron's UI thread in a
      // native modal run loop (the unified shell hit this first: it detaches and
      // lets the orphan be reclaimed at quit, which is what teardownDocsRenderer does).
      teardownDocsRenderer(tab.view.webContents)
    } else if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.close()
    }
    this.options.onChanged?.()
  }

  /** Called when a webContents dies on its own (renderer crash, self-close). */
  private forget(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    this.tabs.splice(index, 1)
    if (this.activeId === id) this.activeId = this.tabs[0]?.id ?? null
    this.options.onChanged?.()
  }

  /** Point the editor modules' process-global "active editor" at this tab. */
  private pointActiveTargets(tab: EditorTab): void {
    setActiveDocsResolver(tab.kind === 'docs' ? () => tab.view.webContents : () => null)
    if (tab.kind === 'sheets') setActiveSheetsWebContents(tab.view.webContents)
    if (tab.kind === 'slides') setActiveSlidesWebContents(tab.view.webContents)
  }

  private summarize(tab: EditorTab): OpenDocument {
    const type = documentTypeFor(tab.path) ?? ('txt' as DocumentType)
    return {
      id: tab.id,
      path: tab.path,
      type,
      title: tab.title,
      active: tab.id === this.activeId,
      readOnly: tab.readOnly,
    }
  }

  private requireWorkspaceDir(): string {
    const dir = this.options.workspaceDir()
    if (!dir) throw new Error('no workspace is open')
    return dir
  }

  /** Where a view may paint: the content rectangle minus the reported insets. */
  private editorArea(): ContentBounds {
    return editorBounds(this.options.window.getContentBounds(), this.insets)
  }
}
