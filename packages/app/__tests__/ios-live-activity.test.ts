import type {
  LiveActivityState,
  LiveActivityAttributes,
  LiveActivityContentState,
} from '../src/ios-live-activity'

// Mock expo-live-activity native module
const mockStartActivity = jest.fn<string | void, [unknown, unknown?]>().mockReturnValue('native-activity-1');
const mockUpdateActivity = jest.fn();
const mockStopActivity = jest.fn();

jest.mock('expo-live-activity', () => ({
  startActivity: (...args: unknown[]) => mockStartActivity(...args as [unknown, unknown?]),
  updateActivity: (...args: unknown[]) => mockUpdateActivity(...args),
  stopActivity: (...args: unknown[]) => mockStopActivity(...args),
}));

describe('ios-live-activity', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    mockStartActivity.mockReturnValue('native-activity-1')
  })

  function requireBridge() {
    return require('../src/ios-live-activity/live-activity-bridge')
  }

  function mockPlatform(os: string, version: string | number) {
    jest.doMock('react-native', () => ({
      Platform: { OS: os, Version: version },
    }))
  }

  describe('types', () => {
    it('LiveActivityState accepts valid values', () => {
      const states: LiveActivityState[] = ['active', 'thinking', 'waiting', 'error', 'ended']
      expect(states).toHaveLength(5)
    })

    it('LiveActivityAttributes has sessionName', () => {
      const attrs: LiveActivityAttributes = { sessionName: 'test-session' }
      expect(attrs.sessionName).toBe('test-session')
    })

    it('LiveActivityContentState has required and optional fields', () => {
      const state: LiveActivityContentState = {
        state: 'thinking',
        elapsedSeconds: 42,
      }
      expect(state.detail).toBeUndefined()

      const stateWithDetail: LiveActivityContentState = {
        state: 'active',
        detail: 'Editing main.ts',
        elapsedSeconds: 10,
      }
      expect(stateWithDetail.detail).toBe('Editing main.ts')
    })
  })

  describe('isLiveActivitySupported', () => {
    it('returns false on Android', () => {
      mockPlatform('android', 34)
      const { isLiveActivitySupported } = requireBridge()
      expect(isLiveActivitySupported()).toBe(false)
    })

    it('returns false on iOS < 16', () => {
      mockPlatform('ios', '15.7')
      const { isLiveActivitySupported } = requireBridge()
      expect(isLiveActivitySupported()).toBe(false)
    })

    it('returns true on iOS 16.2', () => {
      mockPlatform('ios', '16.2')
      const { isLiveActivitySupported } = requireBridge()
      expect(isLiveActivitySupported()).toBe(true)
    })

    it('returns true on iOS 17.0', () => {
      mockPlatform('ios', '17.0')
      const { isLiveActivitySupported } = requireBridge()
      expect(isLiveActivitySupported()).toBe(true)
    })
  })

  describe('startLiveActivity', () => {
    it('returns null when unsupported (Android)', async () => {
      mockPlatform('android', 34)
      const { startLiveActivity } = requireBridge()
      const result = await startLiveActivity(
        { sessionName: 'test' },
        { state: 'thinking', elapsedSeconds: 0 }
      )
      expect(result).toBeNull()
      expect(mockStartActivity).not.toHaveBeenCalled()
    })

    it('calls native startActivity with mapped state on iOS', async () => {
      mockPlatform('ios', '17.0')
      const { startLiveActivity } = requireBridge()
      const result = await startLiveActivity(
        { sessionName: 'My Session' },
        { state: 'thinking', elapsedSeconds: 0 }
      )
      expect(result).toBe('native-activity-1')
      expect(mockStartActivity).toHaveBeenCalledWith(
        { title: 'My Session', subtitle: 'Thinking...' },
        expect.objectContaining({ backgroundColor: '#0f0f1a', deepLinkUrl: 'chroxy://' }),
      )
    })

    it('uses detail as subtitle when provided', async () => {
      mockPlatform('ios', '17.0')
      const { startLiveActivity } = requireBridge()
      await startLiveActivity(
        { sessionName: 'Session' },
        { state: 'active', elapsedSeconds: 5, detail: 'Editing 3 files' }
      )
      expect(mockStartActivity).toHaveBeenCalledWith(
        { title: 'Session', subtitle: 'Editing 3 files' },
        expect.any(Object),
      )
    })

    it('returns null when native module throws', async () => {
      mockPlatform('ios', '17.0')
      mockStartActivity.mockImplementation(() => { throw new Error('ActivityKit unavailable') })
      const { startLiveActivity } = requireBridge()
      const result = await startLiveActivity(
        { sessionName: 'test' },
        { state: 'active', elapsedSeconds: 0 }
      )
      expect(result).toBeNull()
    })

    it('returns null when native module returns undefined', async () => {
      mockPlatform('ios', '17.0')
      mockStartActivity.mockReturnValue(undefined)
      const { startLiveActivity } = requireBridge()
      const result = await startLiveActivity(
        { sessionName: 'test' },
        { state: 'active', elapsedSeconds: 0 }
      )
      expect(result).toBeNull()
    })
  })

  describe('updateLiveActivity', () => {
    it('calls native updateActivity with mapped state', async () => {
      mockPlatform('ios', '17.0')
      const { updateLiveActivity } = requireBridge()
      await updateLiveActivity('activity-123', {
        state: 'waiting',
        elapsedSeconds: 30,
      })
      expect(mockUpdateActivity).toHaveBeenCalledWith('activity-123', {
        title: 'Chroxy',
        subtitle: 'Waiting for input',
      })
    })

    it('uses detail when provided', async () => {
      mockPlatform('ios', '17.0')
      const { updateLiveActivity } = requireBridge()
      await updateLiveActivity('activity-123', {
        state: 'active',
        elapsedSeconds: 10,
        detail: 'Writing main.ts',
      })
      expect(mockUpdateActivity).toHaveBeenCalledWith('activity-123', {
        title: 'Chroxy',
        subtitle: 'Writing main.ts',
      })
    })

    it('no-ops when unsupported', async () => {
      mockPlatform('android', 34)
      const { updateLiveActivity } = requireBridge()
      await updateLiveActivity('activity-123', { state: 'active', elapsedSeconds: 5 })
      expect(mockUpdateActivity).not.toHaveBeenCalled()
    })

    it('swallows errors from native module', async () => {
      mockPlatform('ios', '17.0')
      mockUpdateActivity.mockImplementation(() => { throw new Error('dismissed') })
      const { updateLiveActivity } = requireBridge()
      await expect(
        updateLiveActivity('activity-123', { state: 'active', elapsedSeconds: 5 })
      ).resolves.toBeUndefined()
    })
  })

  describe('endLiveActivity', () => {
    it('calls native stopActivity', async () => {
      mockPlatform('ios', '17.0')
      const { endLiveActivity } = requireBridge()
      await endLiveActivity('activity-123')
      expect(mockStopActivity).toHaveBeenCalledWith('activity-123', {
        title: 'Chroxy',
        subtitle: 'Session ended',
      })
    })

    it('no-ops when unsupported', async () => {
      mockPlatform('android', 34)
      const { endLiveActivity } = requireBridge()
      await endLiveActivity('activity-123')
      expect(mockStopActivity).not.toHaveBeenCalled()
    })

    it('swallows errors from native module', async () => {
      mockPlatform('ios', '17.0')
      mockStopActivity.mockImplementation(() => { throw new Error('already ended') })
      const { endLiveActivity } = requireBridge()
      await expect(endLiveActivity('activity-123')).resolves.toBeUndefined()
    })
  })
})
