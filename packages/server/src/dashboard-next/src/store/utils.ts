/**
 * Shared utility functions for the connection store.
 *
 * Extracted from connection.ts to reduce file size. Contains pure
 * functions with no store dependency — safe to import anywhere.
 */
import type { ChatMessage, SessionState } from './types';

/** Strip ANSI escape codes for plain text display */
export function stripAnsi(str: string): string {
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07]*\x07?|\x1b[()#][A-Z0-2]|\x1b[A-Za-z]|\x9b[0-9;?]*[A-Za-z~]/g,
    '',
  );
}

/** Filter out thinking placeholder messages */
export function filterThinking(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.id !== 'thinking');
}

/**
 * Message ID Convention
 *
 * Message IDs are used to uniquely identify and track messages in the chat history.
 * The default format produced by nextMessageId is: `{prefix}-{counter}-{timestamp}`.
 *
 * Prefixes used with nextMessageId:
 * - 'user'        — User-sent messages
 * - messageType   — Server-forwarded messages where the prefix is the messageType
 *                    (e.g. 'response', 'error', 'prompt', etc.)
 * - 'tool'        — Tool use messages
 * - 'perm'        — Permission request prompts from Claude Code (tool permission dialogs)
 * - 'msg'         — Generic messages (default when no prefix is provided)
 *
 * Special IDs (not produced by nextMessageId):
 * - 'thinking'    — Ephemeral thinking placeholder (singleton, no counter/timestamp; not
 *                    persisted/filtered from transcript export, but rendered in the chat UI)
 *
 * Note on ID assignment:
 * - Most locally-created and non-streaming messages use nextMessageId(prefix).
 * - Messages that already include a server-assigned ID (e.g., streaming events such as
 *   `stream_start`/`stream_delta`, or history replay messages) keep that server-provided
 *   messageId instead of generating a new one.
 *
 * Example ID formats:
 * - 'user-1-1700000000000'
 * - 'response-2-1700000001000'
 * - 'tool-3-1700000002000'
 * - 'perm-4-1700000003000'
 */

// Monotonic message ID counter (avoids Math.random() collisions)
let messageIdCounter = 0;
export function nextMessageId(prefix = 'msg'): string {
  return `${prefix}-${++messageIdCounter}-${Date.now()}`;
}

/** Add up to 50% random jitter to a delay to prevent thundering herd on reconnect */
export function withJitter(delayMs: number): number {
  return delayMs + Math.floor(Math.random() * delayMs * 0.5);
}

/** Create a fresh empty SessionState */
export function createEmptySessionState(): SessionState {
  return {
    messages: [],
    streamingMessageId: null,
    claudeReady: false,
    terminalRawBuffer: '',
    activeModel: null,
    permissionMode: null,
    contextUsage: null,
    lastResultCost: null,
    lastResultDuration: null,
    sessionCost: null,
    isIdle: true,
    health: 'healthy',
    activeAgents: [],
    isPlanPending: false,
    planAllowedPrompts: [],
    primaryClientId: null,
    conversationId: null,
    sessionContext: null,
    mcpServers: [],
    devPreviews: [],
    ptyActive: false,
  };
}
