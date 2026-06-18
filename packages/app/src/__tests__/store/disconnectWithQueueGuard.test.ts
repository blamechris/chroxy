/**
 * disconnectWithQueueGuard logic tests (#6081).
 *
 * The helper reads queuedMessageCount from the store imperatively and either:
 *   a) disconnects immediately when no messages are queued, or
 *   b) shows a confirmation Alert when messages are queued, disconnecting only
 *      if the user chooses the destructive "Disconnect" action.
 *
 * Tests run against the real helper with store + Alert.alert mocked so we can
 * assert on call arguments without a native runtime.
 */

import { Alert } from 'react-native';

// We need to mock the connection store before importing the helper,
// so the helper's module-level getState() picks up the mock.
jest.mock('react-native', () => {
  const rn = jest.requireActual('react-native');
  return { ...rn, Alert: { alert: jest.fn() } };
});

const mockDisconnect = jest.fn();
let _queuedMessageCount = 0;

jest.mock('../../store/connection', () => ({
  useConnectionStore: {
    getState: () => ({
      disconnect: mockDisconnect,
      queuedMessageCount: _queuedMessageCount,
    }),
  },
}));

// Import AFTER mocks are set up.
import { disconnectWithQueueGuard } from '../../store/disconnectWithQueueGuard';

// Cast for convenience — jest.mock replaces the real Alert.alert.
const mockAlertAlert = Alert.alert as jest.Mock;

describe('disconnectWithQueueGuard (#6081)', () => {
  beforeEach(() => {
    _queuedMessageCount = 0;
    mockDisconnect.mockClear();
    mockAlertAlert.mockClear();
  });

  describe('when the queue is empty (queuedMessageCount === 0)', () => {
    it('calls disconnect() immediately without showing an Alert', () => {
      _queuedMessageCount = 0;
      disconnectWithQueueGuard();
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
      expect(mockAlertAlert).not.toHaveBeenCalled();
    });
  });

  describe('when messages are queued (queuedMessageCount > 0)', () => {
    it('shows the "Discard unsent messages?" Alert and does NOT disconnect immediately', () => {
      _queuedMessageCount = 2;
      disconnectWithQueueGuard();
      expect(mockAlertAlert).toHaveBeenCalledTimes(1);
      expect(mockAlertAlert.mock.calls[0][0]).toBe('Discard unsent messages?');
      expect(mockDisconnect).not.toHaveBeenCalled();
    });

    it('Alert title is "Discard unsent messages?" with correct body for plural count', () => {
      _queuedMessageCount = 3;
      disconnectWithQueueGuard();
      const [title, body] = mockAlertAlert.mock.calls[0] as [string, string];
      expect(title).toBe('Discard unsent messages?');
      expect(body).toContain('3 unsent messages');
      expect(body).toContain('them');
    });

    it('Alert body uses singular grammar for exactly 1 queued message', () => {
      _queuedMessageCount = 1;
      disconnectWithQueueGuard();
      const [, body] = mockAlertAlert.mock.calls[0] as [string, string];
      expect(body).toContain('1 unsent message');
      expect(body).not.toContain('messages waiting');
      expect(body).toContain('it');
    });

    it('Alert has a "Keep waiting" cancel button and a "Disconnect" destructive button', () => {
      _queuedMessageCount = 1;
      disconnectWithQueueGuard();
      const buttons = mockAlertAlert.mock.calls[0][2] as Array<{ text: string; style: string; onPress?: () => void }>;
      expect(buttons).toHaveLength(2);
      const keep = buttons.find((b) => b.text === 'Keep waiting');
      const disc = buttons.find((b) => b.text === 'Disconnect');
      expect(keep).toBeDefined();
      expect(keep!.style).toBe('cancel');
      expect(disc).toBeDefined();
      expect(disc!.style).toBe('destructive');
    });

    it('"Disconnect" button onPress calls disconnect()', () => {
      _queuedMessageCount = 1;
      disconnectWithQueueGuard();
      const buttons = mockAlertAlert.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
      const disc = buttons.find((b) => b.text === 'Disconnect');
      expect(disc!.onPress).toBeDefined();
      disc!.onPress!();
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
    });

    it('"Keep waiting" does not call disconnect()', () => {
      _queuedMessageCount = 1;
      disconnectWithQueueGuard();
      const buttons = mockAlertAlert.mock.calls[0][2] as Array<{ text: string; style: string; onPress?: () => void }>;
      const keep = buttons.find((b) => b.text === 'Keep waiting');
      // cancel-style buttons have no onPress (or it is undefined/void) — just
      // confirm disconnect was NOT called after showing the alert.
      keep?.onPress?.();
      expect(mockDisconnect).not.toHaveBeenCalled();
    });
  });
});
