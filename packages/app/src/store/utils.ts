/**
 * Shared utility functions for the connection store.
 *
 * Extracted from connection.ts to reduce file size. Contains pure
 * functions with no store dependency — safe to import anywhere.
 *
 * The pure helpers (stripAnsi, nextMessageId, withJitter, filterThinking)
 * live in @chroxy/store-core and are re-exported here for convenience.
 */
import type { SessionState } from './types';

export {
  stripAnsi,
  nextMessageId,
  withJitter,
  filterThinking,
} from '@chroxy/store-core';

/** Create a fresh empty SessionState */
export function createEmptySessionState(): SessionState {
  return {
    messages: [],
    streamingMessageId: null,
    claudeReady: false,
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
    activityState: { state: 'idle', startedAt: Date.now() },
  };
}
