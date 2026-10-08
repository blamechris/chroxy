/**
 * selectChatMessages tests (#7201).
 *
 * These pin two invariants that were previously verified only by hand on a
 * booted simulator — which does not survive a refactor, and is exactly how
 * #7186 (the marker never rendering on mobile) went unnoticed for a month.
 */
import { selectChatMessages, selectSystemMessages, shouldShowInChat } from '../selectChatMessages';
import type { ChatMessage } from '../../store/connection';

// The real shared predicate, not a stand-in: if compact mode ever widens to
// include more types, this test should feel it.
import { isHiddenInCompactMode } from '@chroxy/store-core';

const msg = (over: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'type'>): ChatMessage =>
  ({ content: '', timestamp: 1, ...over }) as ChatMessage;

const marker = (id = 'compact1'): ChatMessage =>
  msg({
    id,
    type: 'system',
    content: 'Context compacted (auto): 128,000 → 12,000 tokens',
    compactMetadata: { trigger: 'auto', preTokens: 128_000, postTokens: 12_000, durationMs: 2_500 },
  } as Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'type'>);

const opts = (chatFilterCompact: boolean) => ({ chatFilterCompact, isHiddenInCompactMode });

describe('selectChatMessages', () => {
  describe('INVARIANT 1 — compaction markers survive, compact mode included', () => {
    it('keeps a compaction marker with compact mode OFF', () => {
      expect(shouldShowInChat(marker(), opts(false))).toBe(true);
    });

    // The regression this guards: the `system` branch returning BEFORE the
    // compact check. Reorder them and markers vanish whenever compact is on.
    it('keeps a compaction marker with compact mode ON', () => {
      expect(shouldShowInChat(marker(), opts(true))).toBe(true);
    });

    it('keeps the marker in a realistic conversation, compact ON', () => {
      const messages = [
        msg({ id: 'u1', type: 'user_input', content: 'hi' }),
        msg({ id: 't1', type: 'tool_use', content: 'ls' }),
        marker(),
        msg({ id: 'r1', type: 'response', content: 'hello' }),
      ];
      // tool_use is hidden by compact mode; the marker is not.
      expect(selectChatMessages(messages, opts(true)).map((m) => m.id)).toEqual([
        'u1',
        'compact1',
        'r1',
      ]);
    });

    // The ordering itself, isolated from today's isHiddenInCompactMode.
    //
    // Reordering the two checks is harmless RIGHT NOW only because
    // isHiddenInCompactMode never returns true for 'system' — a mutation test
    // against the real predicate passes either way and proves nothing (it did).
    // Injecting a predicate that DOES hide 'system' makes the ordering the only
    // thing keeping the marker alive, which is the invariant actually guarded:
    // if compact mode ever widens to cover system events, markers must survive.
    it('keeps the marker even if compact mode is widened to hide system events', () => {
      const hidesSystemToo = (type: ChatMessage['type']) =>
        type === 'tool_use' || type === 'thinking' || type === 'system';
      const widened = { chatFilterCompact: true, isHiddenInCompactMode: hidesSystemToo };

      expect(shouldShowInChat(marker(), widened)).toBe(true);
      // …and a plain system event is still excluded under that same predicate,
      // so the assertion above is about the marker, not a blanket pass.
      expect(
        shouldShowInChat(msg({ id: 's1', type: 'system', content: 'connected' }), widened),
      ).toBe(false);
    });
  });

  describe('INVARIANT 2 — every other system message is excluded', () => {
    it('drops a plain system event', () => {
      expect(shouldShowInChat(msg({ id: 's1', type: 'system', content: 'connected' }), opts(false))).toBe(false);
    });

    it('drops a system event whose compactMetadata is explicitly null', () => {
      const m = msg({ id: 's2', type: 'system', content: 'x' });
      (m as { compactMetadata?: unknown }).compactMetadata = null;
      expect(shouldShowInChat(m, opts(false))).toBe(false);
    });

    it('drops plain system events but keeps markers, in one pass', () => {
      const messages = [
        msg({ id: 's1', type: 'system', content: 'connected' }),
        marker(),
        msg({ id: 's2', type: 'system', content: 'resumed' }),
      ];
      expect(selectChatMessages(messages, opts(false)).map((m) => m.id)).toEqual(['compact1']);
    });
  });

  describe('compact mode still hides what it is supposed to', () => {
    it.each(['tool_use', 'thinking'] as const)('hides %s when compact is ON', (type) => {
      expect(shouldShowInChat(msg({ id: 'x', type }), opts(true))).toBe(false);
    });

    it.each(['tool_use', 'thinking'] as const)('shows %s when compact is OFF', (type) => {
      expect(shouldShowInChat(msg({ id: 'x', type }), opts(false))).toBe(true);
    });

    // Negative control: without this, a predicate that hid everything in
    // compact mode would pass every assertion above.
    it.each(['user_input', 'response', 'error', 'prompt'] as const)(
      'never hides %s, compact ON',
      (type) => {
        expect(shouldShowInChat(msg({ id: 'x', type }), opts(true))).toBe(true);
      },
    );
  });

  // #7326 -- a turn-outcome chip ("Reply cut off") describes the turn above it,
  // so it belongs in the Chat feed; the other system rows still do not.
  describe('turn-outcome chips (#7326)', () => {
    const chip = (outcome: 'truncated' | 'refused' | 'stopped' = 'truncated'): ChatMessage =>
      msg({ id: `chip-${outcome}`, type: 'system', content: 'Reply cut off', turnOutcome: outcome } as Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'type'>);

    it.each(['truncated', 'refused', 'stopped'] as const)('keeps the %s chip, compact mode on or off', (outcome) => {
      expect(shouldShowInChat(chip(outcome), opts(false))).toBe(true);
      expect(shouldShowInChat(chip(outcome), opts(true))).toBe(true);
    });

    it('still drops an ordinary system row sitting next to it', () => {
      const messages = [msg({ id: 's1', type: 'system', content: 'connected' }), chip()];
      expect(selectChatMessages(messages, opts(false)).map((m) => m.id)).toEqual(['chip-truncated']);
    });
  });
});

// #8461 -- the System tab (and its unread badge, which counts this list) lists
// `system` rows, but a turn-outcome chip belongs to the chat flow only.
describe('selectSystemMessages (#8461)', () => {
  const outcome = msg({ id: 'o1', type: 'system', content: 'Reply cut off', turnOutcome: 'truncated' } as Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'type'>);
  const plain = msg({ id: 'sys1', type: 'system', content: 'Connected' });

  it('keeps ordinary system events and compaction markers, drops turn-outcome chips', () => {
    const all = [msg({ id: 'r1', type: 'response', content: 'hi' }), plain, outcome, marker()];
    expect(selectSystemMessages(all).map((m) => m.id)).toEqual(['sys1', 'compact1']);
  });

  it('is the exact complement for chips: the chat tab keeps the chip the System tab drops', () => {
    expect(shouldShowInChat(outcome, opts(false))).toBe(true);
    expect(selectSystemMessages([outcome])).toEqual([]);
  });
});
