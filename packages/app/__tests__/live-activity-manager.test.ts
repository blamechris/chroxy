import { LiveActivityManager, mapActivityState } from '../src/ios-live-activity/live-activity-manager';
import type { ActivityState } from '../src/store/session-activity';
import type { LiveActivityState } from '../src/ios-live-activity/types';

// Mock the bridge module
const mockIsSupported = jest.fn<boolean, []>().mockReturnValue(true);
const mockStart = jest.fn<Promise<string | null>, [unknown, unknown]>().mockResolvedValue('activity-123');
const mockUpdate = jest.fn<Promise<void>, [string, unknown]>().mockResolvedValue(undefined);
const mockEnd = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);

jest.mock('../src/ios-live-activity/live-activity-bridge', () => ({
  isLiveActivitySupported: () => mockIsSupported(),
  startLiveActivity: (...args: unknown[]) => mockStart(...args as [unknown, unknown]),
  updateLiveActivity: (...args: unknown[]) => mockUpdate(...args as [string, unknown]),
  endLiveActivity: (...args: unknown[]) => mockEnd(...args as [string]),
}));

describe('mapActivityState', () => {
  const cases: [ActivityState, LiveActivityState][] = [
    ['idle', 'active'],
    ['thinking', 'thinking'],
    ['busy', 'active'],
    ['waiting', 'waiting'],
    ['error', 'error'],
  ];

  test.each(cases)('maps %s to %s', (input, expected) => {
    expect(mapActivityState(input)).toBe(expected);
  });
});

describe('LiveActivityManager', () => {
  let manager: LiveActivityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSupported.mockReturnValue(true);
    mockStart.mockResolvedValue('activity-123');
  });

  function createManager(): LiveActivityManager {
    return new LiveActivityManager();
  }

  describe('constructor', () => {
    it('checks platform support on creation', () => {
      manager = createManager();
      expect(manager.isSupported).toBe(true);
      expect(manager.isActive).toBe(false);
    });

    it('reports unsupported when bridge says so', () => {
      mockIsSupported.mockReturnValue(false);
      manager = createManager();
      expect(manager.isSupported).toBe(false);
    });
  });

  describe('start', () => {
    it('starts a Live Activity and stores the ID', async () => {
      manager = createManager();
      await manager.start('My Session');

      expect(mockStart).toHaveBeenCalledWith(
        { sessionName: 'My Session' },
        { state: 'active', elapsedSeconds: 0 },
      );
      expect(manager.isActive).toBe(true);
      expect(manager.activityId).toBe('activity-123');
    });

    it('no-ops when unsupported', async () => {
      mockIsSupported.mockReturnValue(false);
      manager = createManager();
      await manager.start('My Session');

      expect(mockStart).not.toHaveBeenCalled();
      expect(manager.isActive).toBe(false);
    });

    it('no-ops when already active', async () => {
      manager = createManager();
      await manager.start('Session 1');
      await manager.start('Session 2');

      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    it('handles null activity ID gracefully (bridge stub)', async () => {
      mockStart.mockResolvedValue(null);
      manager = createManager();
      await manager.start('My Session');

      expect(mockStart).toHaveBeenCalled();
      expect(manager.isActive).toBe(false);
      expect(manager.activityId).toBeNull();
    });
  });

  describe('update', () => {
    it('updates the Live Activity with state and elapsed time', async () => {
      manager = createManager();
      await manager.start('Session');

      // Advance time slightly for elapsed
      await manager.update('thinking', 'Processing...');

      expect(mockUpdate).toHaveBeenCalledWith('activity-123', {
        state: 'thinking',
        elapsedSeconds: expect.any(Number),
        detail: 'Processing...',
      });
    });

    it('no-ops when unsupported', async () => {
      mockIsSupported.mockReturnValue(false);
      manager = createManager();
      await manager.update('thinking');

      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('no-ops when no active activity', async () => {
      manager = createManager();
      await manager.update('thinking');

      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('throttles rapid updates', async () => {
      manager = createManager();
      await manager.start('Session');

      await manager.update('thinking');
      await manager.update('waiting');
      await manager.update('error');

      // Only the first update should go through (throttle)
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop', () => {
    it('ends the Live Activity and clears state', async () => {
      manager = createManager();
      await manager.start('Session');
      await manager.stop();

      expect(mockEnd).toHaveBeenCalledWith('activity-123');
      expect(manager.isActive).toBe(false);
      expect(manager.activityId).toBeNull();
    });

    it('no-ops when unsupported', async () => {
      mockIsSupported.mockReturnValue(false);
      manager = createManager();
      await manager.stop();

      expect(mockEnd).not.toHaveBeenCalled();
    });

    it('no-ops when no active activity', async () => {
      manager = createManager();
      await manager.stop();

      expect(mockEnd).not.toHaveBeenCalled();
    });

    it('allows starting again after stop', async () => {
      manager = createManager();
      await manager.start('Session 1');
      await manager.stop();
      await manager.start('Session 2');

      expect(mockStart).toHaveBeenCalledTimes(2);
      expect(manager.isActive).toBe(true);
    });
  });

  describe('elapsedSeconds', () => {
    it('returns 0 when not started', () => {
      manager = createManager();
      expect(manager.elapsedSeconds).toBe(0);
    });

    it('tracks elapsed time from start', async () => {
      manager = createManager();

      // Mock Date.now to control elapsed time
      const originalNow = Date.now;
      const startTime = 1000000;
      Date.now = jest.fn().mockReturnValue(startTime);

      await manager.start('Session');

      // Advance time by 30 seconds
      (Date.now as jest.Mock).mockReturnValue(startTime + 30000);
      expect(manager.elapsedSeconds).toBe(30);

      Date.now = originalNow;
    });

    it('resets to 0 after stop', async () => {
      manager = createManager();
      await manager.start('Session');
      await manager.stop();
      expect(manager.elapsedSeconds).toBe(0);
    });
  });

  describe('_reset', () => {
    it('clears all internal state', async () => {
      manager = createManager();
      await manager.start('Session');
      manager._reset();

      expect(manager.isActive).toBe(false);
      expect(manager.activityId).toBeNull();
      expect(manager.elapsedSeconds).toBe(0);
    });
  });
});
