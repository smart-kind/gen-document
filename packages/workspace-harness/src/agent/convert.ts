import {
  contentText,
  type ImageContent as PiImageContent,
  type Message as PiMessage,
  type ThinkingContent as PiThinkingContent,
  type Tool as PiTool,
  type ToolCall as PiToolCall,
} from '@earendil-works/pi-ai'
import type { AgentImage, AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'

/** Narrow a content block to a tool call. */
function isToolCall(block: { type: string }): block is PiToolCall {
  return block.type === 'toolCall'
}

/** Narrow a content block to thinking text. */
function isThinking(block: { type: string }): block is PiThinkingContent {
  return block.type === 'thinking'
}

function isImage(block: { type: string }): block is PiImageContent {
  return block.type === 'image'
}

/**
 * Translate pi-agent's transcript into the message shape the repo's provider
 * layer speaks.
 *
 * System messages are dropped: they carry the prompt and tool declarations,
 * which travel separately to the provider.
 */
export function toProviderMessages(messages: readonly PiMessage[]): AgentMessage[] {
  const out: AgentMessage[] = []
  let pendingResults: { id: string; name: string; output: string; isError?: boolean }[] = []

  const flushResults = (): void => {
    if (pendingResults.length === 0) return
    out.push({ role: 'tool', results: pendingResults })
    pendingResults = []
  }

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'toolResult') {
      // Consecutive tool results belong to one assistant turn; the provider
      // layer expects them grouped in a single tool message.
      pendingResults.push({
        id: message.toolCallId,
        name: message.toolName,
        output: contentText(message.content),
        ...('isError' in message && message.isError ? { isError: true } : {}),
      })
      continue
    }

    flushResults()

    if (message.role === 'user') {
      const images = Array.isArray(message.content)
        ? message.content
            .filter(isImage)
            .map((block): AgentImage => ({ base64: block.data, mime: block.mimeType }))
        : []
      out.push({
        role: 'user',
        text: contentText(message.content),
        ...(images.length > 0 ? { images } : {}),
      })
      continue
    }

    const toolCalls = message.content.filter(isToolCall).map((block): AgentToolCall => ({
      id: block.id,
      name: block.name,
      input: block.arguments as Record<string, unknown>,
    }))
    const reasoning = message.content
      .filter(isThinking)
      .map((block) => block.thinking)
      .join('')

    out.push({
      role: 'assistant',
      text: contentText(message.content),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(reasoning ? { reasoning } : {}),
    })
  }

  flushResults()
  return out
}

/**
 * Convert declared tools into the JSON-Schema tool definitions the provider
 * layer expects. TypeBox schemas are JSON Schema documents, so the parameter
 * schema passes through unchanged.
 */
export function toToolDefs(tools: readonly PiTool[]): AgentToolDef[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as Record<string, unknown>,
  }))
}
