import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  updateSessionNotification,
  dismissSessionNotification,
  _testInternals,
} from '../android-session-notification';
// Mock expo-notifications
jest.mock('expo-notifications', () => ({
  setNotificationChannelAsync: jest.fn().mockResolvedValue(undefined),
  scheduleNotificationAsync: jest.fn().mockResolvedValue('notif-id'),
  dismissNotificationAsync: jest.fn().mockResolvedValue(undefined),
  AndroidImportance: { LOW: 2 },
}));

// Helper to set Platform.OS for testing
const originalOS = Platform.OS;
function setPlatform(os: 'android' | 'ios') {
  Object.defineProperty(Platform, 'OS', { get: () => os, configurable: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  _testInternals.reset();
  setPlatform('android'); // default
});

afterAll(() => {
  Object.defineProperty(Platform, 'OS', { get: () => originalOS, configurable: true });
});

describe('updateSessionNotification', () => {
  it('creates an ongoing notification on Android when state is non-idle', async () => {
    setPlatform('android');

    await updateSessionNotification('thinking', 'Claude is thinking...', 60);

    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      'session-progress',
      expect.objectContaining({
        name: 'Session Progress',
      }),
    );
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          title: 'Claude is thinking...',
          ongoing: true,
        }),
        trigger: null,
      }),
    );
  });

  it('is a no-op on iOS', async () => {
    setPlatform('ios');

    await updateSessionNotification('thinking', 'Claude is thinking...', 60);

    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('dismisses existing notification before showing new one', async () => {
    setPlatform('android');
    jest.useFakeTimers();

    const p1 = updateSessionNotification('thinking', 'Thinking...', 30);
    jest.runAllTimers();
    await p1;

    // Advance past throttle window
    jest.advanceTimersByTime(1100);

    const p2 = updateSessionNotification('waiting', 'Needs permission', 60);
    jest.runAllTimers();
    await p2;

    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('notif-id');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  it('dismisses notification when state becomes idle', async () => {
    setPlatform('android');

    await updateSessionNotification('thinking', 'Thinking...', 30);
    await updateSessionNotification('idle', undefined, 0);

    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('notif-id');
    // Should NOT schedule a new one for idle
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('includes elapsed time in notification body', async () => {
    setPlatform('android');

    await updateSessionNotification('busy', 'Working...', 125);

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          body: expect.stringContaining('2m'),
        }),
      }),
    );
  });

  it('throttles updates to max 1 per second', async () => {
    setPlatform('android');
    jest.useFakeTimers();

    // First call goes through
    const p1 = updateSessionNotification('thinking', 'Thinking...', 10);
    jest.runAllTimers();
    await p1;

    // Second call within 1s is throttled
    const p2 = updateSessionNotification('thinking', 'Still thinking...', 11);
    jest.runAllTimers();
    await p2;

    // Only 1 schedule call (throttled second)
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });
});

describe('dismissSessionNotification', () => {
  it('dismisses active notification on Android', async () => {
    setPlatform('android');

    await updateSessionNotification('thinking', 'Thinking...', 30);
    await dismissSessionNotification();

    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('notif-id');
  });

  it('is a no-op when no notification is active', async () => {
    setPlatform('android');

    await dismissSessionNotification();

    expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled();
  });

  it('is a no-op on iOS', async () => {
    setPlatform('ios');

    await dismissSessionNotification();

    expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled();
  });
});

describe('formatElapsed', () => {
  it('formats seconds under a minute', () => {
    expect(_testInternals.formatElapsed(45)).toBe('45s');
  });

  it('formats minutes', () => {
    expect(_testInternals.formatElapsed(125)).toBe('2m 5s');
  });

  it('formats hours', () => {
    expect(_testInternals.formatElapsed(3661)).toBe('1h 1m');
  });

  it('returns empty string for zero', () => {
    expect(_testInternals.formatElapsed(0)).toBe('');
  });
});
