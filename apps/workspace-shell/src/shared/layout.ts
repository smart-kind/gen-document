/**
 * Window chrome geometry shared by the main process and the renderer.
 *
 * The editor `WebContentsView`s are children of the window's content view, so
 * they paint over the renderer's HTML. The renderer owns the layout: it
 * publishes the insets it actually uses (see `setLayoutInsets`) and the main
 * process insets every editor view by exactly those numbers. Nothing else may
 * assume a fixed sidebar width — the chat column collapses, and a constant
 * duplicated on both sides would then let the editor paint over the rail.
 */

/** Width of the left rail: back button, workspace identity and the zone tree. */
export const LEFT_RAIL_WIDTH = 240

/** Width of the chat column, which can be collapsed. */
export const CHAT_PANEL_WIDTH = 360

/** Height of the thin top bar above the editor area. */
export const TOP_BAR_HEIGHT = 44

/** How far the editor area is inset from each edge of the window content. */
export interface LayoutInsets {
  left: number
  right: number
  top: number
}

/** Insets of a screen with no editor area at all (the workspace list, the wizard). */
export const ZERO_INSETS: LayoutInsets = { left: 0, right: 0, top: 0 }

/** Insets of the workspace view, with the chat column either shown or collapsed. */
export function workspaceInsets(chatVisible: boolean): LayoutInsets {
  return {
    left: LEFT_RAIL_WIDTH,
    right: chatVisible ? CHAT_PANEL_WIDTH : 0,
    top: TOP_BAR_HEIGHT,
  }
}

export interface ViewportSize {
  width: number
  height: number
}

/** Rectangle a child view may occupy, in window content coordinates. */
export interface ContentBounds {
  x: number
  y: number
  width: number
  height: number
}

/** The one place the two sides agree on: content size minus the reported insets. */
export function editorBounds(size: ViewportSize, insets: LayoutInsets): ContentBounds {
  const left = insetValue(insets.left)
  const right = insetValue(insets.right)
  const top = insetValue(insets.top)
  return {
    x: left,
    y: top,
    width: Math.max(0, Math.round(size.width) - left - right),
    height: Math.max(0, Math.round(size.height) - top),
  }
}

/** Coerce an untrusted IPC payload into usable insets rather than trusting it. */
export function normalizeInsets(input: unknown): LayoutInsets {
  const raw = input as Partial<LayoutInsets> | null | undefined
  if (!raw || typeof raw !== 'object') return ZERO_INSETS
  return {
    left: insetValue(raw.left),
    right: insetValue(raw.right),
    top: insetValue(raw.top),
  }
}

function insetValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}
