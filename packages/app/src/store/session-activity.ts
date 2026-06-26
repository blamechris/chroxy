/**
 * Per-session chat activity state — re-export shim.
 *
 * The implementation now lives in @chroxy/store-core (`chat-activity.ts`)
 * so the dashboard's presence rail + composer lozenge read the SAME state
 * machine as mobile (chat redesign #6389, Phase 0 #6390). This module
 * re-exports it under the original mobile names so every existing import
 * site keeps working unchanged.
 */
export { deriveChatActivity as deriveActivityState } from '@chroxy/store-core';
export type {
  ChatActivityState as ActivityState,
  SessionChatActivity as SessionActivity,
  ChatActivityInput,
} from '@chroxy/store-core';
