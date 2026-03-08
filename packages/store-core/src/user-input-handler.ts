/**
 * Shared user_input WS message handler (#1708)
 *
 * Both the app and dashboard receive `user_input` messages from the server
 * when another client sends a message. This module extracts the common
 * parsing logic so both handlers stay in sync.
 */

export interface RawUserInputMessage {
  clientId?: string
  sessionId?: string
  text?: string
  timestamp?: number
}

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
  msg: RawUserInputMessage,
  myClientId: string | null,
  activeSessionId: string | null,
): ParsedUserInput | null {
  const senderClientId = msg.clientId
  if (senderClientId && senderClientId === myClientId) return null
  const targetSessionId = msg.sessionId || activeSessionId
  if (!targetSessionId) return null
  return {
    sessionId: targetSessionId,
    type: 'user_input',
    content: msg.text || '',
    timestamp: msg.timestamp || Date.now(),
  }
}
