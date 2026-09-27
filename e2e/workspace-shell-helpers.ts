/**
 * Launcher for the workspace-shell E2E tests.
 *
 * Boots the built `apps/workspace-shell/out` against a scratch userData dir
 * (via GENOFFICE_USER_DATA) so a run never touches real settings and never
 * collides with a running install's single-instance lock.
 * Build first: `npm run build -w @genoffice/workspace-shell`.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const WORKSPACE_SHELL_DIR = resolve(__dirname, '../apps/workspace-shell')
export const WORKSPACE_ARTIFACTS_DIR = resolve(__dirname, 'artifacts')

const MAIN = join(WORKSPACE_SHELL_DIR, 'out/main/index.js')

export interface LaunchWorkspaceShellOptions {
  /** UI language override; defaults to English for stable assertions. */
  lang?: string
  /** Extra environment variables for the launched app. */
  env?: Record<string, string>
  /** Subdirectory of e2e/artifacts to store this launch's video in. */
  videoDir: string
  /** Reuse a scratch dir, to simulate a second launch over the same data. */
  userDataDir?: string
}

export interface LaunchedWorkspaceShell {
  app: ElectronApplication
  page: Page
  userDataDir: string
}

export async function launchWorkspaceShell(
  options: LaunchWorkspaceShellOptions,
): Promise<LaunchedWorkspaceShell> {
  if (!existsSync(MAIN)) {
    throw new Error(
      `Missing build output at ${MAIN} — run \`npm run build -w @genoffice/workspace-shell\` first`,
    )
  }
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), 'genoffice-ws-e2e-')))
  await writeFile(join(userDataDir, 'app-settings.json'), JSON.stringify({}))

  const require = createRequire(join(WORKSPACE_SHELL_DIR, 'package.json'))
  const executablePath = require('electron') as unknown as string
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...hostEnv } = process.env

  const args: string[] = []
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu')
  args.push(WORKSPACE_SHELL_DIR)

  const app = await electron.launch({
    executablePath,
    args,
    env: {
      ...hostEnv,
      GENOFFICE_USER_DATA: userDataDir,
      GENOFFICE_LANG: options.lang ?? 'en',
      ...(options.env ?? {}),
      ...(process.platform === 'linux' ? { ELECTRON_DISABLE_SANDBOX: '1' } : {}),
    },
    recordVideo:
      process.platform === 'linux'
        ? undefined
        : {
            dir: join(WORKSPACE_ARTIFACTS_DIR, options.videoDir),
            size: { width: 1280, height: 800 },
          },
  })
  const page = await app.firstWindow()
  await waitForShellReady(page)
  return { app, page, userDataDir }
}

/**
 * Poll through `evaluate` rather than waiting on load lifecycle events:
 * Playwright can attach mid-navigation and miss them entirely, in which case
 * `waitForLoadState` hangs on a page that is in fact loaded.
 */
async function waitForShellReady(page: Page, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() =>
        document.readyState !== 'loading' &&
        window.location.href !== 'about:blank' &&
        Boolean((window as unknown as { workspaceShell?: unknown }).workspaceShell) &&
        Boolean(document.querySelector('.app'))
          ? document.readyState
          : null,
      )
      .catch(() => null)
    if (ready) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`workspace-shell renderer never became ready (url: ${page.url()})`)
}

/** Close the app, stubbing the native save dialog so shutdown stays unattended. */
export async function closeWorkspaceShell(launched: LaunchedWorkspaceShell): Promise<void> {
  await launched.app
    .evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox
    })
    .catch(() => {})
  const child = launched.app.process()
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 20_000)
  try {
    await launched.app.close()
  } finally {
    clearTimeout(killTimer)
  }
}
