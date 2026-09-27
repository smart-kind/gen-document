import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { Lang } from '@genoffice/i18n'
import type { ThemeMode } from '@genoffice/workspace-harness'
import {
  WORKSPACE_CHANNELS,
  type AgentStreamEvent,
  type NotifyPayload,
  type ShellEvent,
  type WorkspaceShellApi,
} from '../shared/api'

/**
 * The renderer's whole view of the main process.
 *
 * Every method is a thin `invoke`; nothing here decides anything, so the
 * renderer cannot reach past the IPC surface the main process registered.
 */

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api: WorkspaceShellApi = {
  listWorkspaces: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.listWorkspaces),
  createWorkspace: (input) => ipcRenderer.invoke(WORKSPACE_CHANNELS.createWorkspace, input),
  openWorkspace: (id) => ipcRenderer.invoke(WORKSPACE_CHANNELS.openWorkspace, id),
  closeWorkspace: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.closeWorkspace),
  lastActiveWorkspace: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.lastActiveWorkspace),
  describeWorkspace: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.describeWorkspace),
  setWorkspaceSettings: (patch) =>
    ipcRenderer.invoke(WORKSPACE_CHANNELS.setWorkspaceSettings, patch),
  deleteWorkspace: (id) => ipcRenderer.invoke(WORKSPACE_CHANNELS.deleteWorkspace, id),
  defaultParentDir: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.defaultParentDir),

  listTree: (dir) => ipcRenderer.invoke(WORKSPACE_CHANNELS.listTree, dir),
  listZones: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.listZones),
  listReferences: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.listReferences),
  addReference: (externalPath, as) =>
    ipcRenderer.invoke(WORKSPACE_CHANNELS.addReference, externalPath, as),
  removeReference: (nameOrPath) =>
    ipcRenderer.invoke(WORKSPACE_CHANNELS.removeReference, nameOrPath),
  addMaterial: (externalPath, as) =>
    ipcRenderer.invoke(WORKSPACE_CHANNELS.addMaterial, externalPath, as),
  removeMaterial: (nameOrPath) => ipcRenderer.invoke(WORKSPACE_CHANNELS.removeMaterial, nameOrPath),

  inspectPath: (path) => ipcRenderer.invoke(WORKSPACE_CHANNELS.inspectPath, path),
  listModels: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.listModels),

  setLayoutInsets: (insets) => ipcRenderer.invoke(WORKSPACE_CHANNELS.setLayoutInsets, insets),
  getLayoutInsets: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.getLayoutInsets),

  openDocument: (path, options) =>
    ipcRenderer.invoke(WORKSPACE_CHANNELS.openDocument, path, options),
  closeDocument: (id, options) => ipcRenderer.invoke(WORKSPACE_CHANNELS.closeDocument, id, options),
  activateDocument: (id) => ipcRenderer.invoke(WORKSPACE_CHANNELS.activateDocument, id),
  listOpenDocuments: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.listOpenDocuments),
  activeDocument: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.activeDocument),
  bridgeTabs: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.bridgeTabs),
  bridgeRunCommand: (wcId, command, payload) =>
    ipcRenderer.invoke(WORKSPACE_CHANNELS.bridgeRunCommand, wcId, command, payload),

  listConversations: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.listConversations),
  createConversation: (title) => ipcRenderer.invoke(WORKSPACE_CHANNELS.createConversation, title),
  deleteConversation: (id) => ipcRenderer.invoke(WORKSPACE_CHANNELS.deleteConversation, id),
  transcript: (id) => ipcRenderer.invoke(WORKSPACE_CHANNELS.transcript, id),
  workflowInstruction: (kind) => ipcRenderer.invoke(WORKSPACE_CHANNELS.workflowInstruction, kind),
  prompt: (conversationId, text) =>
    ipcRenderer.invoke(WORKSPACE_CHANNELS.prompt, conversationId, text),
  steer: (conversationId, text) => ipcRenderer.send(WORKSPACE_CHANNELS.steer, conversationId, text),
  abort: (conversationId) => ipcRenderer.send(WORKSPACE_CHANNELS.abort, conversationId),

  getLanguage: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.getLanguage),
  setLanguage: (lang) => ipcRenderer.invoke(WORKSPACE_CHANNELS.setLanguage, lang),
  getTheme: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.getTheme),
  setTheme: (mode) => ipcRenderer.invoke(WORKSPACE_CHANNELS.setTheme, mode),

  onAgentEvent: (listener) => subscribe<AgentStreamEvent>(WORKSPACE_CHANNELS.agentEvent, listener),
  onShellEvent: (listener) => subscribe<ShellEvent>(WORKSPACE_CHANNELS.shellEvent, listener),
  onNotify: (listener) => subscribe<NotifyPayload>(WORKSPACE_CHANNELS.notify, listener),
  onLanguageChanged: (listener) => subscribe<Lang>(WORKSPACE_CHANNELS.languageChanged, listener),
  onThemeChanged: (listener) => subscribe<ThemeMode>(WORKSPACE_CHANNELS.themeChanged, listener),
}

contextBridge.exposeInMainWorld('workspaceShell', api)
