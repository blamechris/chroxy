import { groupMessages } from '../src/components/ChatView';
import type { ChatMessage } from '../src/store/types';

function msg(overrides: Partial<ChatMessage> & { id: string; type: ChatMessage['type'] }): ChatMessage {
  return { content: '', timestamp: Date.now(), ...overrides };
}

describe('groupMessages (#1937)', () => {
  it('returns empty array for empty input', () => {
    expect(groupMessages([])).toEqual([]);
  });

  it('wraps a single response in a single group', () => {
    const messages = [msg({ id: 'm1', type: 'response' })];
    const groups = groupMessages(messages);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('single');
    if (groups[0].type === 'single') {
      expect(groups[0].message.id).toBe('m1');
    }
  });

  it('groups consecutive tool_use messages into an activity group', () => {
    const messages = [
      msg({ id: 't1', type: 'tool_use' }),
      msg({ id: 't2', type: 'tool_use' }),
      msg({ id: 't3', type: 'tool_use' }),
    ];
    const groups = groupMessages(messages);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('activity');
    if (groups[0].type === 'activity') {
      expect(groups[0].messages).toHaveLength(3);
      expect(groups[0].isActive).toBe(false);
      expect(groups[0].key).toBe('activity-t1');
    }
  });

  it('groups thinking messages into activity groups', () => {
    const messages = [
      msg({ id: 'th1', type: 'thinking' }),
      msg({ id: 't1', type: 'tool_use' }),
    ];
    const groups = groupMessages(messages);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('activity');
    if (groups[0].type === 'activity') {
      expect(groups[0].messages).toHaveLength(2);
    }
  });

  it('splits groups at non-tool/non-thinking messages', () => {
    const messages = [
      msg({ id: 't1', type: 'tool_use' }),
      msg({ id: 'r1', type: 'response' }),
      msg({ id: 't2', type: 'tool_use' }),
    ];
    const groups = groupMessages(messages);
    expect(groups).toHaveLength(3);
    expect(groups[0].type).toBe('activity');
    expect(groups[1].type).toBe('single');
    expect(groups[2].type).toBe('activity');
  });

  it('always sets isActive to false (pure structural grouping)', () => {
    const messages = [
      msg({ id: 't1', type: 'tool_use' }),
      msg({ id: 't2', type: 'tool_use' }),
      msg({ id: 'r1', type: 'response' }),
      msg({ id: 't3', type: 'tool_use' }),
    ];
    const groups = groupMessages(messages);
    for (const group of groups) {
      if (group.type === 'activity') {
        expect(group.isActive).toBe(false);
      }
    }
  });

  it('uses first message id as activity group key', () => {
    const messages = [
      msg({ id: 'tool-abc', type: 'tool_use' }),
      msg({ id: 'tool-def', type: 'tool_use' }),
    ];
    const groups = groupMessages(messages);
    expect(groups[0].type).toBe('activity');
    if (groups[0].type === 'activity') {
      expect(groups[0].key).toBe('activity-tool-abc');
    }
  });

  it('handles user messages as single groups', () => {
    const messages = [
      msg({ id: 'u1', type: 'user_input' }),
      msg({ id: 'r1', type: 'response' }),
    ];
    const groups = groupMessages(messages);
    expect(groups).toHaveLength(2);
    expect(groups[0].type).toBe('single');
    expect(groups[1].type).toBe('single');
  });
});
