import type { WorkspaceShellApi } from '../../shared/api'

declare global {
  interface Window {
    workspaceShell: WorkspaceShellApi
  }
}
