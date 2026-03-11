/**
 * Pure message grouping logic — no React or native dependencies.
 * Groups consecutive tool_use/thinking messages into ActivityGroups.
 */
import type { ChatMessage } from '../../store/types';

export type DisplayGroup =
  | { type: 'single'; message: ChatMessage }
  | { type: 'activity'; messages: ChatMessage[]; isActive: boolean; key: string };

/** Group consecutive tool_use and thinking messages into ActivityGroups.
 *  Pure structural grouping — does not depend on streaming state. */
export function groupMessages(messages: ChatMessage[]): DisplayGroup[] {
  const groups: DisplayGroup[] = [];
  let activityBuf: ChatMessage[] = [];

  const flushActivity = () => {
    if (activityBuf.length > 0) {
      groups.push({
        type: 'activity',
        messages: [...activityBuf],
        isActive: false,
        key: `activity-${activityBuf[0].id}`,
      });
      activityBuf = [];
    }
  };

  for (const msg of messages) {
    if (msg.type === 'tool_use' || msg.type === 'thinking') {
      activityBuf.push(msg);
    } else {
      flushActivity();
      groups.push({ type: 'single', message: msg });
    }
  }
  flushActivity();

  return groups;
}

/** Apply streaming isActive overlay — shallow-copies the groups array to mark
 *  the last activity group as active when streaming is in progress.
 *  `streamingMessageId` is used as a truthy flag (non-null = streaming). */
export function applyStreamingOverlay(
  baseGroups: DisplayGroup[],
  messages: ChatMessage[],
  streamingMessageId: string | null,
): DisplayGroup[] {
  if (!streamingMessageId || baseGroups.length === 0) return baseGroups;
  const last = baseGroups[baseGroups.length - 1];
  if (last.type !== 'activity') return baseGroups;
  const lastMsg = last.messages[last.messages.length - 1];
  if (lastMsg !== messages[messages.length - 1]) return baseGroups;
  const result = baseGroups.slice(0, -1);
  result.push({ ...last, isActive: true });
  return result;
}
