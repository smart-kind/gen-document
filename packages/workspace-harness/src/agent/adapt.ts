import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { TextContent } from '@earendil-works/pi-ai'
import type {
  AnyHarnessTool,
  DisplayPayload,
  ToolContext,
  ToolEffect,
  ToolResult,
} from '../tool/types.js'

/**
 * UI-only payload attached to a pi-agent tool result.
 *
 * `content` is the only field that reaches the model, so the harness splits its
 * result across the two channels: model-facing text in `content`, everything
 * meant for the user in `details`.
 */
export interface HarnessDetails {
  effect: ToolEffect
  summary?: string
  display?: DisplayPayload
  postState?: unknown
  isError?: boolean
}

/**
 * Wrap harness tools as pi-agent tools.
 *
 * `context` is a function rather than a value: pi-agent resolves the tool list
 * once, but the active document changes as the user switches tabs, so the
 * context has to be re-read on every call.
 */
export function toAgentTools(tools: AnyHarnessTool[], context: () => ToolContext): AgentTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (_toolCallId, params, signal) => runTool(tool, params, context(), signal),
  }))
}

async function runTool(
  tool: AnyHarnessTool,
  params: unknown,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<AgentToolResult<HarnessDetails>> {
  try {
    return toAgentToolResult(tool, await tool.execute(ctx, params, signal))
  } catch (error) {
    // Handed back as a result, not thrown: a refused path (a write into the
    // read-only mount, say) is something the model should be able to correct,
    // not a reason to end the turn.
    return toAgentToolResult(tool, {
      output: error instanceof Error ? error.message : String(error),
      isError: true,
      summary: `${tool.label} 失败`,
    })
  }
}

export function toAgentToolResult(
  tool: AnyHarnessTool,
  result: ToolResult,
): AgentToolResult<HarnessDetails> {
  const content: TextContent[] = [{ type: 'text', text: result.output }]
  if (result.postState !== undefined) {
    // postState must reach the model, and only `content` does, so it travels as
    // a second text block rather than as structured metadata.
    content.push({ type: 'text', text: `postState: ${JSON.stringify(result.postState)}` })
  }
  return {
    content,
    details: {
      effect: tool.effect,
      ...(result.summary ? { summary: result.summary } : {}),
      ...(result.display ? { display: result.display } : {}),
      ...(result.postState !== undefined ? { postState: result.postState } : {}),
      ...(result.isError ? { isError: true } : {}),
    },
  }
}
