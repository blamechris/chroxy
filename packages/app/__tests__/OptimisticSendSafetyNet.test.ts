/**
 * #5633 — the optimistic-send safety net must fire against the session that
 * armed it, not whatever session happens to be active when the timer fires.
 *
 * Previously the ~5s setTimeout re-read get().activeSessionId at FIRE time, so
 * switching sessions (or a slow stream_start on cellular) let it null
 * `streamingMessageId` and wipe the "thinking" indicator for the wrong/live
 * turn. The fix captures activeSessionId at arm time and only clears that exact
 * session while it's still 'pending'.
 */
import { useConnectionStore } from '../src/store/connection';
import { useConnectionLifecycleStore } from '../src/store/connection-lifecycle';
import { createEmptySessionState } from '../src/store/utils';
import type { SessionState } from '../src/store/types';

function seedSessions(activeId: string, ids: string[], overrides: Record<string, Partial<SessionState>> = {}) {
  const sessionStates: Record<string, SessionState> = {};
  for (const id of ids) {
    sessionStates[id] = { ...createEmptySessionState(), ...(overrides[id] ?? {}) };
  }
  useConnectionStore.setState({
    activeSessionId: activeId,
    sessions: ids.map((id) => ({ sessionId: id, name: id, provider: 'claude-sdk' })) as any,
    sessionStates,
  });
}

describe('optimistic-send safety net targets the arming session (#5633)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Default: no server-advertised stall window → 5s fallback.
    useConnectionLifecycleStore.setState({ streamStallTimeoutMs: null });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('clears the arming session when no stream_start arrives', () => {
    seedSessions('sess-a', ['sess-a']);
    useConnectionStore.getState().addUserMessage('hello', undefined, { clientMessageId: 'u1' });

    expect(useConnectionStore.getState().sessionStates['sess-a'].streamingMessageId).toBe('pending');

    jest.advanceTimersByTime(5_000);

    const ss = useConnectionStore.getState().sessionStates['sess-a'];
    expect(ss.streamingMessageId).toBeNull();
    // "thinking" placeholder removed.
    expect(ss.messages.some((m) => m.id === 'thinking')).toBe(false);
  });

  it('does NOT wipe a DIFFERENT session the user switched to', () => {
    seedSessions('sess-a', ['sess-a', 'sess-b']);

    // Arm the safety net on sess-a.
    useConnectionStore.getState().addUserMessage('on A', undefined, { clientMessageId: 'a1' });
    expect(useConnectionStore.getState().sessionStates['sess-a'].streamingMessageId).toBe('pending');

    // User switches to sess-b and that session begins streaming a live turn.
    useConnectionStore.setState((s) => ({
      activeSessionId: 'sess-b',
      sessionStates: {
        ...s.sessionStates,
        'sess-b': { ...s.sessionStates['sess-b'], streamingMessageId: 'pending' },
      },
    }));

    // sess-a's timer fires.
    jest.advanceTimersByTime(5_000);

    // sess-b (the live, currently-active turn) must be untouched.
    expect(useConnectionStore.getState().sessionStates['sess-b'].streamingMessageId).toBe('pending');
    // sess-a (the one that armed the net) is cleared.
    expect(useConnectionStore.getState().sessionStates['sess-a'].streamingMessageId).toBeNull();
  });

  it('does NOT clear when the arming session has since started streaming', () => {
    seedSessions('sess-a', ['sess-a']);
    useConnectionStore.getState().addUserMessage('hi', undefined, { clientMessageId: 'x1' });

    // stream_start landed: streamingMessageId is now a real id, not 'pending'.
    useConnectionStore.setState((s) => ({
      sessionStates: {
        ...s.sessionStates,
        'sess-a': { ...s.sessionStates['sess-a'], streamingMessageId: 'resp-1' },
      },
    }));

    jest.advanceTimersByTime(5_000);

    // The live stream id must survive — the net only clears a stuck 'pending'.
    expect(useConnectionStore.getState().sessionStates['sess-a'].streamingMessageId).toBe('resp-1');
  });

  it('honours the server-advertised stream-stall window over the 5s fallback', () => {
    useConnectionLifecycleStore.setState({ streamStallTimeoutMs: 12_000 });
    seedSessions('sess-a', ['sess-a']);
    useConnectionStore.getState().addUserMessage('slow net', undefined, { clientMessageId: 's1' });

    // At 5s the old hardcoded net would have fired; with a 12s server window it must not.
    jest.advanceTimersByTime(5_000);
    expect(useConnectionStore.getState().sessionStates['sess-a'].streamingMessageId).toBe('pending');

    // After the full advertised window it clears.
    jest.advanceTimersByTime(7_000);
    expect(useConnectionStore.getState().sessionStates['sess-a'].streamingMessageId).toBeNull();
  });
});
