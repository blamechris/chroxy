import type { LiveActivityContentState } from '../src/ios-live-activity'

describe('Live Activity integration (full lifecycle)', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.doMock('react-native', () => ({
      Platform: { OS: 'ios', Version: '17.0' },
    }))
  })

  function requireBridge() {
    return require('../src/ios-live-activity')
  }

  function makeState(
    state: LiveActivityContentState['state'],
    elapsedSeconds = 0
  ): LiveActivityContentState {
    return { state, elapsedSeconds, sessionCount: 1 }
  }

  describe('full lifecycle: start → update(thinking) → update(writing) → update(waiting) → end', () => {
    it('completes the entire lifecycle without errors', async () => {
      const { startLiveActivity, updateLiveActivity, endLiveActivity } = requireBridge()

      // Start
      const activityId = await startLiveActivity(
        { sessionName: 'lifecycle-test' },
        makeState('thinking')
      )
      // Stub returns null, but the call should not throw
      expect(activityId).toBeNull()

      // Use a placeholder since stub returns null
      const id = activityId ?? 'placeholder-id'

      // Update through state transitions
      await expect(
        updateLiveActivity(id, makeState('thinking', 5))
      ).resolves.toBeUndefined()

      await expect(
        updateLiveActivity(id, makeState('writing', 15))
      ).resolves.toBeUndefined()

      await expect(
        updateLiveActivity(id, makeState('waiting', 30))
      ).resolves.toBeUndefined()

      // End
      await expect(endLiveActivity(id)).resolves.toBeUndefined()
    })
  })

  describe('short session: start → immediate end', () => {
    it('handles a session that ends immediately after starting', async () => {
      const { startLiveActivity, endLiveActivity } = requireBridge()

      const activityId = await startLiveActivity(
        { sessionName: 'short-session' },
        makeState('thinking')
      )
      expect(activityId).toBeNull()

      const id = activityId ?? 'placeholder-id'
      await expect(endLiveActivity(id)).resolves.toBeUndefined()
    })
  })

  describe('double-start', () => {
    it('handles two consecutive starts gracefully', async () => {
      const { startLiveActivity } = requireBridge()

      const first = await startLiveActivity(
        { sessionName: 'session-1' },
        makeState('thinking')
      )
      expect(first).toBeNull()

      // Second start should also not throw
      const second = await startLiveActivity(
        { sessionName: 'session-2' },
        makeState('idle')
      )
      expect(second).toBeNull()
    })
  })

  describe('update after end', () => {
    it('updating after ending is a no-op and does not throw', async () => {
      const { startLiveActivity, updateLiveActivity, endLiveActivity } = requireBridge()

      const activityId = await startLiveActivity(
        { sessionName: 'ended-session' },
        makeState('thinking')
      )
      const id = activityId ?? 'placeholder-id'

      await endLiveActivity(id)

      // Update after end should silently do nothing
      await expect(
        updateLiveActivity(id, makeState('writing', 10))
      ).resolves.toBeUndefined()

      await expect(
        updateLiveActivity(id, makeState('error', 20))
      ).resolves.toBeUndefined()
    })
  })

  describe('all state values in update', () => {
    it('accepts every LiveActivityState value without error', async () => {
      const { updateLiveActivity } = requireBridge()
      const states: LiveActivityContentState['state'][] = [
        'thinking',
        'writing',
        'waiting',
        'idle',
        'error',
      ]

      for (const state of states) {
        await expect(
          updateLiveActivity('test-id', makeState(state, 10))
        ).resolves.toBeUndefined()
      }
    })
  })

  describe('end called twice', () => {
    it('double-ending does not throw', async () => {
      const { endLiveActivity } = requireBridge()

      await expect(endLiveActivity('some-id')).resolves.toBeUndefined()
      await expect(endLiveActivity('some-id')).resolves.toBeUndefined()
    })
  })
})
