import { useConnectionStore } from '../connection';
import { createEmptySessionState } from '../utils';

/**
 * #6451 — when a send fails outright (wsSend false AND the offline queue full),
 * the optimistic 'Queued' badge would otherwise linger forever (no server
 * message_queued/dequeued reconciles it). clearOptimisticQueuedMessage drops the
 * stale badge locally while keeping the user's message bubble + other entries.
 */
describe('clearOptimisticQueuedMessage (#6451)', () => {
  it('drops the badge by clientMessageId, keeping other entries + the user message', () => {
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          messages: [{ id: 'u1', type: 'user', content: 'hi', timestamp: 1 }],
          queuedMessages: [
            { clientMessageId: 'u1', text: 'hi', queuedAt: 1 },
            { clientMessageId: 'u2', text: 'yo', queuedAt: 2 },
          ],
        },
      },
    } as never);

    useConnectionStore.getState().clearOptimisticQueuedMessage('u1');

    const ss = useConnectionStore.getState().sessionStates.s1;
    expect(ss.queuedMessages?.find((q) => q.clientMessageId === 'u1')).toBeUndefined();
    expect(ss.queuedMessages?.find((q) => q.clientMessageId === 'u2')).toBeDefined(); // other badge kept
    expect(ss.messages.find((m) => m.id === 'u1')).toBeDefined(); // user's text bubble kept
  });

  it('is a no-op for an unknown / missing session', () => {
    useConnectionStore.setState({ activeSessionId: null, sessionStates: {} } as never);
    expect(() => useConnectionStore.getState().clearOptimisticQueuedMessage('nope')).not.toThrow();
  });
});
