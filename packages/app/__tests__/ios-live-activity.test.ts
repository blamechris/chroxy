import type {
  LiveActivityState,
  LiveActivityAttributes,
  LiveActivityContentState,
} from '../src/ios-live-activity'

describe('ios-live-activity', () => {
  beforeEach(() => {
    jest.resetModules()
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
    })

    it('returns null on supported iOS (stub)', async () => {
      mockPlatform('ios', '17.0')
      const { startLiveActivity } = requireBridge()
      const result = await startLiveActivity(
        { sessionName: 'test' },
        { state: 'thinking', elapsedSeconds: 0 }
      )
      expect(result).toBeNull()
    })
  })

  describe('updateLiveActivity', () => {
    it('resolves without error when unsupported', async () => {
      mockPlatform('android', 34)
      const { updateLiveActivity } = requireBridge()
      await expect(
        updateLiveActivity('activity-123', { state: 'active', elapsedSeconds: 5 })
      ).resolves.toBeUndefined()
    })
  })

  describe('endLiveActivity', () => {
    it('resolves without error when unsupported', async () => {
      mockPlatform('android', 34)
      const { endLiveActivity } = requireBridge()
      await expect(endLiveActivity('activity-123')).resolves.toBeUndefined()
    })
  })
})
