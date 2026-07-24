/**
 * insertCompactionMarkers tests — #6972.
 *
 * Pins the mobile-only placement decision: buildChatViewMessages
 * (@chroxy/store-core, shared with the dashboard) filters ALL
 * `type: 'system'` messages off the Chat-tab derivation. Mobile has no
 * System-tab equivalent to show them on instead, so ChatView reinserts
 * only the `compactMetadata`-carrying subset back in, positioned by
 * timestamp. See the module's own doc comment for the full rationale
 * (including why widening the shared store-core filter was rejected).
 */
import type { DisplayGroup } from '@chroxy/store-core';
import type { ChatMessage } from '../../store/connection';
import { insertCompactionMarkers } from '../insertCompactionMarkers';

function msg(partial: Partial<ChatMessage> & { id: string; type: ChatMessage['type'] }): ChatMessage {
  return {
    content: '',
    timestamp: 0,
    ...partial,
  } as ChatMessage;
}

function singleGroup(message: ChatMessage): DisplayGroup {
  return { type: 'single', message };
}

describe('insertCompactionMarkers (#6972)', () => {
  it('returns the base groups unchanged when no message carries compactMetadata', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'u1', type: 'user_input', content: 'hi', timestamp: 1 }),
      msg({ id: 'r1', type: 'response', content: 'hello', timestamp: 2 }),
    ];
    const baseGroups = [singleGroup(messages[0]), singleGroup(messages[1])];
    const out = insertCompactionMarkers(baseGroups, messages);
    expect(out).toEqual(baseGroups);
  });

  it('does NOT insert a marker for a system message without compactMetadata (absent → no marker)', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'u1', type: 'user_input', content: 'hi', timestamp: 1 }),
      // Plain system chatter (e.g. a connected/disconnected notice) — no
      // compactMetadata, so it should stay filtered out exactly as
      // buildChatViewMessages already does for every non-compaction
      // system message.
      msg({ id: 's1', type: 'system', content: 'connected', timestamp: 2 }),
    ];
    const baseGroups = [singleGroup(messages[0])]; // buildChatViewMessages already dropped s1
    const out = insertCompactionMarkers(baseGroups, messages);
    expect(out).toEqual(baseGroups);
    expect(out.some((g) => g.type === 'single' && g.message.id === 's1')).toBe(false);
  });

  it('reinserts a compactMetadata system message at the end when it is the most recent', () => {
    const compactionMeta: ChatMessage['compactMetadata'] = {
      trigger: 'auto',
      preTokens: 128_000,
      postTokens: 12_000,
      durationMs: 2_500,
    };
    const messages: ChatMessage[] = [
      msg({ id: 'u1', type: 'user_input', content: 'hi', timestamp: 1 }),
      msg({ id: 'r1', type: 'response', content: 'hello', timestamp: 2 }),
      msg({ id: 'sys1', type: 'system', content: 'Context compacted', timestamp: 3, compactMetadata: compactionMeta }),
    ];
    // buildChatViewMessages would have already dropped sys1 from the base groups.
    const baseGroups = [singleGroup(messages[0]), singleGroup(messages[1])];
    const out = insertCompactionMarkers(baseGroups, messages);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual(singleGroup(messages[2]));
  });

  it('reinserts a compactMetadata system message in chronological order between existing rows', () => {
    const compactionMeta: ChatMessage['compactMetadata'] = {
      trigger: 'manual',
      preTokens: null,
      postTokens: null,
      durationMs: null,
    };
    const early = msg({ id: 'u1', type: 'user_input', content: 'hi', timestamp: 1 });
    const boundary = msg({ id: 'sys1', type: 'system', content: 'Context compacted', timestamp: 5, compactMetadata: compactionMeta });
    const late = msg({ id: 'r1', type: 'response', content: 'hello', timestamp: 10 });
    const messages: ChatMessage[] = [early, boundary, late];
    const baseGroups = [singleGroup(early), singleGroup(late)];
    const out = insertCompactionMarkers(baseGroups, messages);
    expect(out.map((g) => (g.type === 'single' ? g.message.id : g.key))).toEqual([
      'u1',
      'sys1',
      'r1',
    ]);
  });

  it('reinserts multiple compactMetadata markers, each in its own timestamp slot', () => {
    const metaA: ChatMessage['compactMetadata'] = { trigger: 'auto', preTokens: 100, postTokens: 10, durationMs: 100 };
    const metaB: ChatMessage['compactMetadata'] = { trigger: 'manual', preTokens: 200, postTokens: 20, durationMs: 200 };
    const first = msg({ id: 'sysA', type: 'system', content: 'a', timestamp: 2, compactMetadata: metaA });
    const middle = msg({ id: 'u1', type: 'user_input', content: 'hi', timestamp: 5 });
    const second = msg({ id: 'sysB', type: 'system', content: 'b', timestamp: 8, compactMetadata: metaB });
    const messages: ChatMessage[] = [first, middle, second];
    const baseGroups = [singleGroup(middle)];
    const out = insertCompactionMarkers(baseGroups, messages);
    expect(out.map((g) => (g.type === 'single' ? g.message.id : g.key))).toEqual([
      'sysA',
      'u1',
      'sysB',
    ]);
  });
});
