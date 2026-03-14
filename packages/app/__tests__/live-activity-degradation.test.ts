import type {
  LiveActivityState,
  LiveActivityAttributes,
  LiveActivityContentState,
} from '../src/ios-live-activity'

describe('Live Activity degradation', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  function requireBridge() {
    return require('../src/ios-live-activity')
  }

  function mockPlatform(os: string, version: string | number) {
    jest.doMock('react-native', () => ({
      Platform: { OS: os, Version: version },
    }))
  }

  const attrs: LiveActivityAttributes = { sessionName: 'test-session' }
  const contentState: LiveActivityContentState = {
    state: 'thinking',
    elapsedSeconds: 0,
    sessionCount: 1,
  }

  describe('Android platform (all bridge functions are no-ops)', () => {
    beforeEach(() => {
      mockPlatform('android', 34)
    })

    it('isLiveActivitySupported returns false', () => {
      const { isLiveActivitySupported } = requireBridge()
      expect(isLiveActivitySupported()).toBe(false)
    })

    it('startLiveActivity returns null', async () => {
      const { startLiveActivity } = requireBridge()
      const result = await startLiveActivity(attrs, contentState)
      expect(result).toBeNull()
    })

    it('updateLiveActivity is a no-op', async () => {
      const { updateLiveActivity } = requireBridge()
      await expect(
        updateLiveActivity('any-id', contentState)
      ).resolves.toBeUndefined()
    })

    it('endLiveActivity is a no-op', async () => {
      const { endLiveActivity } = requireBridge()
      await expect(endLiveActivity('any-id')).resolves.toBeUndefined()
    })
  })

  describe('iOS < 16.2 (all bridge functions are no-ops)', () => {
    const oldVersions = ['15.0', '16.0', '16.1']

    oldVersions.forEach((version) => {
      describe(`iOS ${version}`, () => {
        beforeEach(() => {
          mockPlatform('ios', version)
        })

        it('isLiveActivitySupported returns false', () => {
          const { isLiveActivitySupported } = requireBridge()
          expect(isLiveActivitySupported()).toBe(false)
        })

        it('startLiveActivity returns null', async () => {
          const { startLiveActivity } = requireBridge()
          const result = await startLiveActivity(attrs, contentState)
          expect(result).toBeNull()
        })

        it('updateLiveActivity is a no-op', async () => {
          const { updateLiveActivity } = requireBridge()
          await expect(
            updateLiveActivity('activity-1', contentState)
          ).resolves.toBeUndefined()
        })

        it('endLiveActivity is a no-op', async () => {
          const { endLiveActivity } = requireBridge()
          await expect(endLiveActivity('activity-1')).resolves.toBeUndefined()
        })
      })
    })
  })

  describe('null activityId handling', () => {
    beforeEach(() => {
      mockPlatform('ios', '17.0')
    })

    it('updateLiveActivity with null activityId does not crash', async () => {
      const { updateLiveActivity } = requireBridge()
      await expect(
        updateLiveActivity(null as unknown as string, contentState)
      ).resolves.toBeUndefined()
    })

    it('endLiveActivity with null activityId does not crash', async () => {
      const { endLiveActivity } = requireBridge()
      await expect(
        endLiveActivity(null as unknown as string)
      ).resolves.toBeUndefined()
    })
  })

  describe('rapid state changes', () => {
    beforeEach(() => {
      mockPlatform('ios', '17.0')
    })

    it('100 rapid updateLiveActivity calls resolve without error', async () => {
      const { updateLiveActivity } = requireBridge()
      const states: LiveActivityState[] = ['thinking', 'writing', 'waiting', 'idle', 'error']
      const promises: Promise<void>[] = []

      for (let i = 0; i < 100; i++) {
        promises.push(
          updateLiveActivity('activity-rapid', {
            state: states[i % states.length],
            elapsedSeconds: i,
            sessionCount: 1,
          })
        )
      }

      await expect(Promise.all(promises)).resolves.toBeDefined()
    })
  })

  describe('type exports', () => {
    it('LiveActivityState type accepts all valid values', () => {
      const states: LiveActivityState[] = ['thinking', 'writing', 'waiting', 'idle', 'error']
      expect(states).toHaveLength(5)
    })

    it('LiveActivityAttributes type has sessionName', () => {
      const a: LiveActivityAttributes = { sessionName: 'my-session' }
      expect(a.sessionName).toBe('my-session')
    })

    it('LiveActivityContentState type has required and optional fields', () => {
      const withoutDetail: LiveActivityContentState = {
        state: 'idle',
        elapsedSeconds: 0,
        sessionCount: 1,
      }
      expect(withoutDetail.detail).toBeUndefined()

      const withDetail: LiveActivityContentState = {
        state: 'writing',
        detail: 'Reading file.ts',
        elapsedSeconds: 30,
        sessionCount: 2,
      }
      expect(withDetail.detail).toBe('Reading file.ts')
    })
  })
})
