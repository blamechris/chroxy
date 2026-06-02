/**
 * Claude wire-format stream parser.
 *
 * Shared by CliSession (which parses `--include-partial-messages` JSON
 * stream events from `claude -p`) and SdkSession (which receives full
 * assistant message blocks from the Agent SDK) so the two providers
 * cannot drift in how they interpret Anthropic streaming-protocol
 * primitives.
 *
 * Pure functions only — no I/O, no state. Callers own the per-turn
 * context and event emission; the parser just translates wire-format
 * input into emit-ready payloads / semantic descriptors.
 *
 * Public API:
 *
 *   extractToolInputSemantics(toolName, parsedInput)
 *     -> { kind, payload } | null
 *     Single source for Task / AskUserQuestion / EnterPlanMode /
 *     ExitPlanMode tool-input interpretation. `parsedInput` is the
 *     already-JSON-parsed object (CliSession parses accumulated
 *     partial_json chunks; SdkSession receives `block.input` directly).
 *
 *   buildToolStartData(messageId, contentBlock)
 *     -> { messageId, toolUseId, tool, input, serverName? }
 *     Shape of the `tool_start` event for both providers. Reuses a
 *     single derived toolId for both `messageId` and `toolUseId` so
 *     the wire schema (`ServerToolStartSchema.toolUseId: z.string()`)
 *     holds even on the defensive fallback path when `content_block.id`
 *     is absent.
 */

import { parseMcpToolName } from './mcp-tools.js'

/**
 * Tools whose input fields drive session-level state (plan mode, agent
 * tracking, user-question prompts). The semantics returned here are
 * applied by the caller to its own state (CliSession or SdkSession)
 * via the `kind` discriminator.
 *
 * @param {string} toolName
 * @param {unknown} parsedInput - JSON-parsed tool input object, or null
 * @returns {{ kind: 'ask_user_question' | 'task' | 'enter_plan' | 'exit_plan', payload: object } | null}
 */
export function extractToolInputSemantics(toolName, parsedInput) {
  if (!toolName) return null
  const input = parsedInput && typeof parsedInput === 'object' ? parsedInput : {}

  switch (toolName) {
    case 'AskUserQuestion':
      return {
        kind: 'ask_user_question',
        payload: { questions: input.questions },
      }

    case 'Task': {
      const description = (typeof input.description === 'string'
        ? input.description
        : 'Background task').slice(0, 200)
      return {
        kind: 'task',
        payload: { description },
      }
    }

    case 'EnterPlanMode':
      return { kind: 'enter_plan', payload: {} }

    case 'ExitPlanMode': {
      const allowedPrompts = Array.isArray(input.allowedPrompts)
        ? input.allowedPrompts
        : []
      return { kind: 'exit_plan', payload: { allowedPrompts } }
    }

    default:
      return null
  }
}

/**
 * Build the `tool_start` event payload from a `content_block_start`
 * event's content_block object.
 *
 * @param {string} messageId - The current turn-level messageId, used
 *   as the fallback toolId source when `contentBlock.id` is missing.
 * @param {{ id?: string, name: string, type: string }} contentBlock
 * @returns {{ messageId: string, toolUseId: string, tool: string, input: null, serverName?: string }}
 */
export function buildToolStartData(messageId, contentBlock) {
  // Use the tool's content_block.id as the tool_start messageId so each
  // tool in a multi-tool turn has a distinct id. Sharing the turn-level
  // messageId across tools collides with the post-tool stream_start id
  // and corrupts client message state. Reused for toolUseId so the wire
  // schema (`ServerToolStartSchema.toolUseId: z.string()`) holds even
  // on the defensive fallback path.
  const toolId = contentBlock.id || `${messageId}-tool`
  const data = {
    messageId: toolId,
    toolUseId: toolId,
    tool: contentBlock.name,
    input: null,
  }
  const mcp = parseMcpToolName(contentBlock.name)
  if (mcp) data.serverName = mcp.serverName
  return data
}
