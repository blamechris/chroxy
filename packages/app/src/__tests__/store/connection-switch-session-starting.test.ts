/**
 * #8875 — the mobile store's `switchSession` refuses a LISTED session whose
 * provider `start()` has not settled (`starting: true`, #8874), unless the caller
 * opts out with `allowStarting` (checkpoint restore, follow-mode, permission
 * auto-switch). Operator doors get the refusal for free.
 */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

const mockHapticLight = jest.fn();
jest.mock('../../utils/haptics', () => ({
  hapticLight: (...a: unknown[]) => mockHapticLight(...a),
  hapticMedium: jest.fn(),
  hapticWarning: jest.fn(),
  hapticSuccess: jest.fn(),
}));

import { useConnectionStore } from '../../store/connection';

function seed(): { send: jest.Mock } {
  const send = jest.fn();
  useConnectionStore.setState({
    socket: { readyState: 1, send } as unknown as WebSocket,
    activeSessionId: 'a',
    sessions: [
      { sessionId: 'a', name: 'a' },
      { sessionId: 's', name: 's', starting: true },
      { sessionId: 'ok', name: 'ok' },
    ],
    sessionNotifications: [],
  } as never);
  return { send };
}

const switches = (send: jest.Mock) =>
  send.mock.calls.filter(([raw]) => JSON.parse(raw as string).type === 'switch_session');

describe('mobile switchSession and a starting session (#8875)', () => {
  beforeEach(() => mockHapticLight.mockClear());

  it('refuses a starting id: no state change, no wire message, no haptic', () => {
    const { send } = seed();
    useConnectionStore.getState().switchSession('s');
    expect(useConnectionStore.getState().activeSessionId).toBe('a');
    expect(switches(send)).toHaveLength(0);
    expect(mockHapticLight).not.toHaveBeenCalled();
  });

  it('CONTROL: an ordinary listed session still switches', () => {
    const { send } = seed();
    useConnectionStore.getState().switchSession('ok');
    expect(useConnectionStore.getState().activeSessionId).toBe('ok');
    expect(switches(send)).toHaveLength(1);
  });

  it('allowStarting switches to a starting id', () => {
    const { send } = seed();
    useConnectionStore.getState().switchSession('s', { allowStarting: true });
    expect(useConnectionStore.getState().activeSessionId).toBe('s');
    expect(switches(send)).toHaveLength(1);
  });

  it('the already-active id is a no-op even when it is starting', () => {
    seed();
    useConnectionStore.setState({ activeSessionId: 's' } as never);
    useConnectionStore.getState().switchSession('s');
    expect(useConnectionStore.getState().activeSessionId).toBe('s');
  });
});
