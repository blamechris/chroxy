/**
 * Tests for the streaming overlay (isActive) logic extracted from ChatView.
 * Verifies the O(1) overlay that marks the last activity group as active
 * when the streaming message is part of it.
 */
import type { ChatMessage } from '../src/store/types';
import { applyStreamingOverlay, groupMessages, DisplayGroup } from '../src/components/chat/groupMessages';

function msg(id: string, type: ChatMessage['type']): ChatMessage {
  return { id, type, content: '', timestamp: Date.now(), role: 'assistant' } as ChatMessage;
}

describe('applyStreamingOverlay', () => {
  it('returns baseGroups unchanged when no streamingMessageId', () => {
    const messages = [msg('1', 'tool_use')];
    const groups = groupMessages(messages);
    const result = applyStreamingOverlay(groups, messages, null);
    expect(result).toBe(groups); // same reference
  });

  it('returns baseGroups unchanged when groups are empty', () => {
    const groups: DisplayGroup[] = [];
    const result = applyStreamingOverlay(groups, [], 'streaming-1');
    expect(result).toBe(groups);
  });

  it('returns baseGroups unchanged when last group is not activity', () => {
    const messages = [msg('1', 'response')];
    const groups = groupMessages(messages);
    const result = applyStreamingOverlay(groups, messages, 'streaming-1');
    expect(result).toBe(groups);
  });

  it('returns baseGroups unchanged when last activity is not at end of messages', () => {
    // Activity group in the middle, single message at end
    const messages = [msg('1', 'tool_use'), msg('2', 'response')];
    const groups = groupMessages(messages);
    // Last group is single (response), not activity
    expect(groups[groups.length - 1].type).toBe('single');
    const result = applyStreamingOverlay(groups, messages, '1');
    expect(result).toBe(groups);
  });

  it('marks last activity group isActive when streaming message is the last message', () => {
    const messages = [msg('1', 'response'), msg('2', 'tool_use'), msg('3', 'tool_use')];
    const groups = groupMessages(messages);

    // Verify baseline: last group is activity with isActive false
    const lastGroup = groups[groups.length - 1];
    expect(lastGroup.type).toBe('activity');
    if (lastGroup.type === 'activity') {
      expect(lastGroup.isActive).toBe(false);
    }

    const result = applyStreamingOverlay(groups, messages, '3');

    // Result should have isActive true on last group
    const resultLast = result[result.length - 1];
    expect(resultLast.type).toBe('activity');
    if (resultLast.type === 'activity') {
      expect(resultLast.isActive).toBe(true);
    }

    // Other groups unchanged
    expect(result[0]).toEqual(groups[0]);
  });

  it('does not mutate the original baseGroups array', () => {
    const messages = [msg('1', 'tool_use')];
    const groups = groupMessages(messages);
    const originalLength = groups.length;

    applyStreamingOverlay(groups, messages, '1');

    expect(groups.length).toBe(originalLength);
    if (groups[0].type === 'activity') {
      expect(groups[0].isActive).toBe(false); // unchanged
    }
  });

  it('works with multiple activity groups — only last gets overlay', () => {
    const messages = [
      msg('1', 'tool_use'),
      msg('2', 'response'),
      msg('3', 'tool_use'),
      msg('4', 'thinking'),
    ];
    const groups = groupMessages(messages);
    // [activity(1), single(2), activity(3,4)]
    expect(groups).toHaveLength(3);

    const result = applyStreamingOverlay(groups, messages, '4');

    // First activity group still inactive
    if (result[0].type === 'activity') {
      expect(result[0].isActive).toBe(false);
    }
    // Last activity group is active
    const last = result[result.length - 1];
    if (last.type === 'activity') {
      expect(last.isActive).toBe(true);
    }
  });
});
