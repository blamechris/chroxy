import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  updateSessionNotification,
  dismissSessionNotification,
  startElapsedTimer,
  stopElapsedTimer,
  _testInternals,
} from '../src/android-session-notification';

jest.mock('expo-notifications', () => ({
  setNotificationChannelAsync: jest.fn().mockResolvedValue(undefined),
  scheduleNotificationAsync: jest.fn().mockResolvedValue('notif-id'),
  dismissNotificationAsync: jest.fn().mockResolvedValue(undefined),
  AndroidImportance: { LOW: 2 },
}));

const originalOS = Platform.OS;
function setPlatform(os: 'android' | 'ios') {
  Object.defineProperty(Platform, 'OS', { get: () => os, configurable: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  _testInternals.reset();
  setPlatform('android');
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  Object.defineProperty(Platform, 'OS', { get: () => originalOS, configurable: true });
});

describe('startElapsedTimer', () => {
  it('starts a periodic timer that updates the notification', async () => {
    // First create a notification so there's something to update
    await updateSessionNotification('thinking', 'Thinking...', 10);

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);

    const startedAt = Date.now() - 60_000; // started 60s ago
    startElapsedTimer('Working...', startedAt);

    // Advance past one interval (30s)
    jest.advanceTimersByTime(_testInternals.ELAPSED_INTERVAL_MS);
    // Allow the async updateSessionNotification to resolve
    await Promise.resolve();
    await Promise.resolve();

    // Should have scheduled another notification (the periodic update)
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2);

    // The second call should contain elapsed time
    const lastCall = (Notifications.scheduleNotificationAsync as jest.Mock).mock.calls[1][0];
    expect(lastCall.content.title).toBe('Working...');
    expect(lastCall.content.body).toMatch(/\d+m/);

    stopElapsedTimer(); // clean up
  });

  it('updates elapsed time correctly after multiple intervals', async () => {
    const now = Date.now();
    const startedAt = now - 120_000; // started 2 minutes ago
    startElapsedTimer('Session active', startedAt);

    // Advance through first interval
    jest.advanceTimersByTime(_testInternals.ELAPSED_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();

    // Advance through second interval
    jest.advanceTimersByTime(_testInternals.ELAPSED_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2);

    stopElapsedTimer(); // clean up
  });

  it('replaces existing timer when called again', () => {
    startElapsedTimer('First', Date.now());
    const firstTimer = _testInternals.elapsedTimer;
    expect(firstTimer).not.toBeNull();

    startElapsedTimer('Second', Date.now());
    const secondTimer = _testInternals.elapsedTimer;
    expect(secondTimer).not.toBeNull();
    // Timer reference should have changed (old one cleared, new one created)
    expect(secondTimer).not.toBe(firstTimer);
  });

  it('is a no-op on iOS', () => {
    setPlatform('ios');
    startElapsedTimer('Test', Date.now());
    expect(_testInternals.elapsedTimer).toBeNull();
  });
});

describe('stopElapsedTimer', () => {
  it('stops the periodic timer', () => {
    startElapsedTimer('Working...', Date.now());
    expect(_testInternals.elapsedTimer).not.toBeNull();

    stopElapsedTimer();
    expect(_testInternals.elapsedTimer).toBeNull();
  });

  it('is safe to call when no timer is running', () => {
    expect(() => stopElapsedTimer()).not.toThrow();
  });
});

describe('dismissSessionNotification stops timer', () => {
  it('stops the elapsed timer on dismiss', async () => {
    // Create a notification first
    const p = updateSessionNotification('thinking', 'Thinking...', 10);
    jest.runAllTimers();
    await p;

    startElapsedTimer('Working...', Date.now());
    expect(_testInternals.elapsedTimer).not.toBeNull();

    await dismissSessionNotification();
    expect(_testInternals.elapsedTimer).toBeNull();
  });

  it('stops the elapsed timer when state becomes idle', async () => {
    const p1 = updateSessionNotification('thinking', 'Thinking...', 10);
    jest.runAllTimers();
    await p1;

    startElapsedTimer('Thinking...', Date.now());
    expect(_testInternals.elapsedTimer).not.toBeNull();

    // Advance past throttle
    jest.advanceTimersByTime(1100);

    const p2 = updateSessionNotification('idle', undefined, 0);
    jest.runAllTimers();
    await p2;

    expect(_testInternals.elapsedTimer).toBeNull();
  });
});

describe('elapsed time formatting in timer updates', () => {
  it('formats minutes correctly', () => {
    expect(_testInternals.formatElapsed(90)).toBe('1m 30s');
  });

  it('formats hours and minutes', () => {
    expect(_testInternals.formatElapsed(3720)).toBe('1h 2m');
  });

  it('formats zero as empty string', () => {
    expect(_testInternals.formatElapsed(0)).toBe('');
  });
});
