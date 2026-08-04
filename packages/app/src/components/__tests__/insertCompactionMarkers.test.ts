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

function activityGroup(messages: ChatMessage[]): DisplayGroup {
  return {
    type: 'activity',
    messages,
    isActive: false,
    key: `activity-${messages[0].id}`,
  };
}

function ids(groups: DisplayGroup[]): string[] {
  return groups.map((g) => (g.type === 'single' ? g.message.id : g.key));
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

  // #6993 — the timestamp tie-break. Placement scans for the first group
  // whose timestamp is STRICTLY greater than the marker's, so a marker that
  // ties with an existing row lands immediately AFTER that row. Timestamps
  // collide in practice (same-millisecond emission), and "after" is the
  // right answer: the compaction boundary happened once that row existed.
  // Every other fixture in this file uses distinct timestamps, so these are
  // the only cases pinning the `>` (rather than `>=`) comparison.
  describe('equal timestamps (tie-break)', () => {
    const tieMeta: ChatMessage['compactMetadata'] = {
      trigger: 'auto',
      preTokens: 100,
      postTokens: 10,
      durationMs: 50,
    };

    it('places a marker AFTER an existing row sharing its exact timestamp', () => {
      const tied = msg({ id: 'u1', type: 'user_input', content: 'hi', timestamp: 5 });
      const later = msg({ id: 'r1', type: 'response', content: 'hello', timestamp: 10 });
      const marker = msg({
        id: 'sys1',
        type: 'system',
        content: 'Context compacted',
        timestamp: 5,
        compactMetadata: tieMeta,
      });
      const out = insertCompactionMarkers(
        [singleGroup(tied), singleGroup(later)],
        [tied, marker, later],
      );
      // NOT ['sys1', 'u1', 'r1'] — the tied row keeps its place ahead of the marker.
      expect(ids(out)).toEqual(['u1', 'sys1', 'r1']);
    });

    it('places a marker AFTER the last row when it ties with that row', () => {
      const early = msg({ id: 'u1', type: 'user_input', content: 'hi', timestamp: 1 });
      const tiedLast = msg({ id: 'r1', type: 'response', content: 'hello', timestamp: 7 });
      const marker = msg({
        id: 'sys1',
        type: 'system',
        content: 'Context compacted',
        timestamp: 7,
        compactMetadata: tieMeta,
      });
      const out = insertCompactionMarkers(
        [singleGroup(early), singleGroup(tiedLast)],
        [early, tiedLast, marker],
      );
      expect(ids(out)).toEqual(['u1', 'r1', 'sys1']);
    });

    it('ties against an activity group using its FIRST message timestamp, landing after the whole group', () => {
      // groupTimestamp() reads messages[0] for an activity group, so a marker
      // tying with the group's opening tool_use lands after the entire group —
      // never spliced into the middle of a tool run.
      const toolA = msg({ id: 't1', type: 'tool_use', content: 'Read', timestamp: 4 });
      const toolB = msg({ id: 't2', type: 'tool_use', content: 'Grep', timestamp: 9 });
      const later = msg({ id: 'r1', type: 'response', content: 'done', timestamp: 12 });
      const marker = msg({
        id: 'sys1',
        type: 'system',
        content: 'Context compacted',
        timestamp: 4,
        compactMetadata: tieMeta,
      });
      const out = insertCompactionMarkers(
        [activityGroup([toolA, toolB]), singleGroup(later)],
        [toolA, toolB, marker, later],
      );
      expect(ids(out)).toEqual(['activity-t1', 'sys1', 'r1']);
    });
  });
});
