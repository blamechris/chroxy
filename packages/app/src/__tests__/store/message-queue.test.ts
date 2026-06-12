/**
 * Offline message queue coverage (#5635).
 *
 * The queue buffers user-originated messages while the socket is down and
 * flushes them on reconnect. The decision rules — which types are queueable,
 * the QUEUE_MAX_SIZE overflow cap, and the per-type TTL drop on drain — live in
 * `enqueueMessage` / `drainMessageQueue` (message-handler.ts ~895-920) and are
 * exercised here through the real `_testQueueInternals` export, NOT a
 * re-implementation. connection.test.ts already covers TTL/drain via sendInput;
 * this file pins the rules the issue called out directly against the internals:
 * excluded types, the QUEUE_MAX_SIZE overflow, TTL-expiry on drain, and an
 * in-order flush on reconnect.
 */

import { _testQueueInternals } from '../../store/message-handler';

/** A socket that records every JSON payload sent through wsSend. */
function recordingSocket(): { socket: WebSocket; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const socket = {
    readyState: 1,
    send: (data: string) => {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    },
  } as unknown as WebSocket;
  return { socket, sent };
}

describe('offline message queue (#5635)', () => {
  beforeEach(() => {
    _testQueueInternals.clear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    _testQueueInternals.clear();
  });

  // -- excluded message types are never queued -------------------------------

  describe('QUEUE_EXCLUDED', () => {
    it.each(['set_model', 'set_permission_mode', 'mode', 'resize'])(
      'does not queue excluded type %s (returns false, queue stays empty)',
      (type) => {
        expect(_testQueueInternals.enqueue(type, { type })).toBe(false);
        expect(_testQueueInternals.getQueue()).toHaveLength(0);
      },
    );

    it('does not queue an unknown type with no configured TTL', () => {
      // Only types in QUEUE_TTLS are queueable; anything else is a no-op even
      // when it is not explicitly excluded.
      expect(_testQueueInternals.enqueue('some_unlisted_type', { type: 'x' })).toBe(false);
      expect(_testQueueInternals.getQueue()).toHaveLength(0);
    });

    it('still queues a permitted type (input) — confirms the exclusion is selective', () => {
      expect(_testQueueInternals.enqueue('input', { type: 'input', data: 'hi' })).toBe('queued');
      expect(_testQueueInternals.getQueue()).toHaveLength(1);
    });
  });

  // -- QUEUE_MAX_SIZE overflow ----------------------------------------------

  describe('QUEUE_MAX_SIZE overflow', () => {
    it('accepts exactly 10 messages and drops the 11th', () => {
      for (let i = 0; i < 10; i++) {
        expect(_testQueueInternals.enqueue('input', { type: 'input', data: `m${i}` })).toBe('queued');
      }
      expect(_testQueueInternals.getQueue()).toHaveLength(10);

      // The 11th overflows: returns false and is NOT appended.
      expect(_testQueueInternals.enqueue('input', { type: 'input', data: 'overflow' })).toBe(false);
      expect(_testQueueInternals.getQueue()).toHaveLength(10);

      // The dropped message is the overflow one, not a previously-queued item.
      const datas = _testQueueInternals.getQueue().map((m) => (m.payload as { data: string }).data);
      expect(datas).not.toContain('overflow');
      expect(datas).toEqual([
        'm0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9',
      ]);
    });

    it('excluded types do not consume queue capacity', () => {
      // Fill to 9 real messages.
      for (let i = 0; i < 9; i++) {
        expect(_testQueueInternals.enqueue('input', { type: 'input', data: `m${i}` })).toBe('queued');
      }
      // An excluded type must not occupy a slot.
      expect(_testQueueInternals.enqueue('resize', { type: 'resize', cols: 80 })).toBe(false);
      // So the 10th real message still fits…
      expect(_testQueueInternals.enqueue('input', { type: 'input', data: 'm9' })).toBe('queued');
      expect(_testQueueInternals.getQueue()).toHaveLength(10);
      // …and only the 11th real one overflows.
      expect(_testQueueInternals.enqueue('input', { type: 'input', data: 'm10' })).toBe(false);
    });
  });

  // -- TTL-expiry on drain ---------------------------------------------------

  describe('TTL expiry on drain', () => {
    it('drops a message whose per-type TTL has elapsed (input = 60s)', () => {
      _testQueueInternals.enqueue('input', { type: 'input', data: 'stale' });
      // Advance past the 60s input TTL.
      jest.advanceTimersByTime(61_000);

      const { socket, sent } = recordingSocket();
      _testQueueInternals.drain(socket);

      // Nothing sent, and the queue is cleared regardless.
      expect(sent).toHaveLength(0);
      expect(_testQueueInternals.getQueue()).toHaveLength(0);
    });

    it('drops only the entries past their own TTL (interrupt 5s vs input 60s)', () => {
      _testQueueInternals.enqueue('interrupt', { type: 'interrupt' });
      _testQueueInternals.enqueue('input', { type: 'input', data: 'fresh' });

      // Past interrupt's 5s TTL but well within input's 60s TTL.
      jest.advanceTimersByTime(6_000);

      const { socket, sent } = recordingSocket();
      _testQueueInternals.drain(socket);

      // Only the still-valid input survives; the interrupt is dropped.
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({ type: 'input', data: 'fresh' });
      expect(_testQueueInternals.getQueue()).toHaveLength(0);
    });

    it('clears the queue even when every entry is expired', () => {
      _testQueueInternals.enqueue('interrupt', { type: 'interrupt' });
      jest.advanceTimersByTime(10_000);

      const { socket, sent } = recordingSocket();
      _testQueueInternals.drain(socket);

      expect(sent).toHaveLength(0);
      expect(_testQueueInternals.getQueue()).toHaveLength(0);
    });
  });

  // -- in-order flush on reconnect ------------------------------------------

  describe('flush on reconnect', () => {
    it('sends all valid queued messages in FIFO order and empties the queue', () => {
      _testQueueInternals.enqueue('input', { type: 'input', data: 'first' });
      _testQueueInternals.enqueue('permission_response', { type: 'permission_response', allow: true });
      _testQueueInternals.enqueue('input', { type: 'input', data: 'second' });

      // Within all TTLs.
      jest.advanceTimersByTime(1_000);

      const { socket, sent } = recordingSocket();
      _testQueueInternals.drain(socket);

      expect(sent).toEqual([
        { type: 'input', data: 'first' },
        { type: 'permission_response', allow: true },
        { type: 'input', data: 'second' },
      ]);
      expect(_testQueueInternals.getQueue()).toHaveLength(0);
    });

    it('is a no-op on an empty queue (no send, no throw)', () => {
      const { socket, sent } = recordingSocket();
      expect(() => _testQueueInternals.drain(socket)).not.toThrow();
      expect(sent).toHaveLength(0);
    });
  });
});
