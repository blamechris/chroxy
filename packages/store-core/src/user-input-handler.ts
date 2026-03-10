/**
 * Shared user_input WS message handler (#1708)
 *
 * Both the app and dashboard receive `user_input` messages from the server
 * when another client sends a message. This module extracts the common
 * parsing logic so both handlers stay in sync.
 */

export interface ParsedUserInput {
  /** Session that should receive the message */
  sessionId: string
  type: 'user_input'
  content: string
  timestamp: number
}

/**
 * Parse an incoming `user_input` WS message.
 *
 * Returns null when the message should be skipped:
 * - Sent by this client (already shown via optimistic UI)
 * - No target session can be determined
 */
export function parseUserInputMessage(
  msg: Record<string, unknown>,
  myClientId: string | null,
  activeSessionId: string | null,
): ParsedUserInput | null {
  const senderClientId = typeof msg.clientId === 'string' ? msg.clientId : undefined
  if (senderClientId && senderClientId === myClientId) return null
  const targetSessionId = (typeof msg.sessionId === 'string' ? msg.sessionId : null) || activeSessionId
  if (!targetSessionId) return null
  return {
    sessionId: targetSessionId,
    type: 'user_input',
    content: typeof msg.text === 'string' ? msg.text : '',
    timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
  }
}
