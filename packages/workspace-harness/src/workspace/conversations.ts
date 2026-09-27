import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from './json-file.js'
import { metaDir } from './paths.js'
import { MANIFEST_SCHEMA_VERSION, type ConversationEntry, type ConversationsFile } from './types.js'

/**
 * Conversation index path.
 *
 * The index lives beside the manifest rather than inside it: conversation
 * records change on every new chat, and rewriting the manifest for that would
 * churn the file that describes the workspace structure.
 */
export function conversationsPath(workspaceDir: string): string {
  return join(metaDir(workspaceDir), 'conversations.json')
}

export function readConversations(workspaceDir: string): ConversationEntry[] {
  const raw = readJsonFile<ConversationsFile>(conversationsPath(workspaceDir))
  return Array.isArray(raw?.conversations) ? raw.conversations : []
}

export function writeConversations(
  workspaceDir: string,
  conversations: ConversationEntry[],
): ConversationEntry[] {
  const file: ConversationsFile = { schemaVersion: MANIFEST_SCHEMA_VERSION, conversations }
  writeJsonFile(conversationsPath(workspaceDir), file)
  return conversations
}

/** Insert or replace a conversation record, matched by id. */
export function addConversation(
  workspaceDir: string,
  entry: ConversationEntry,
): ConversationEntry[] {
  const rest = readConversations(workspaceDir).filter((c) => c.id !== entry.id)
  return writeConversations(workspaceDir, [...rest, entry])
}

export function removeConversation(workspaceDir: string, id: string): ConversationEntry[] {
  return writeConversations(
    workspaceDir,
    readConversations(workspaceDir).filter((c) => c.id !== id),
  )
}
