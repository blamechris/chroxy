import { useNotificationStore } from '../../store/notifications'

describe('NotificationStore', () => {
  beforeEach(() => {
    useNotificationStore.getState().reset()
  })

  it('initializes with empty state', () => {
    const state = useNotificationStore.getState()
    expect(state.serverErrors).toEqual([])
    expect(state.sessionNotifications).toEqual([])
    expect(state.shutdownReason).toBeNull()
    expect(state.restartEtaMs).toBeNull()
    expect(state.restartingSince).toBeNull()
    expect(state.timeoutWarning).toBeNull()
  })

  it('adds a server error', () => {
    const error = {
      id: 'err-1',
      category: 'general',
      message: 'Something broke',
      recoverable: true,
      timestamp: Date.now(),
    }
    useNotificationStore.getState().addServerError(error)
    expect(useNotificationStore.getState().serverErrors).toEqual([error])
  })

  it('caps server errors at 10', () => {
    const store = useNotificationStore.getState()
    for (let i = 0; i < 12; i++) {
      store.addServerError({
        id: `err-${i}`,
        category: 'general',
        message: `Error ${i}`,
        recoverable: true,
        timestamp: Date.now(),
      })
    }
    expect(useNotificationStore.getState().serverErrors.length).toBe(10)
    expect(useNotificationStore.getState().serverErrors[0].id).toBe('err-2')
  })

  it('dismisses a server error by id', () => {
    const store = useNotificationStore.getState()
    store.addServerError({
      id: 'err-1',
      category: 'general',
      message: 'Error 1',
      recoverable: true,
      timestamp: Date.now(),
    })
    store.addServerError({
      id: 'err-2',
      category: 'tunnel',
      message: 'Error 2',
      recoverable: false,
      timestamp: Date.now(),
    })
    useNotificationStore.getState().dismissServerError('err-1')
    const errors = useNotificationStore.getState().serverErrors
    expect(errors.length).toBe(1)
    expect(errors[0].id).toBe('err-2')
  })

  it('adds a session notification', () => {
    const notification = {
      id: 'notif-1',
      sessionId: 'sess-a',
      sessionName: 'Test Session',
      eventType: 'completed',
      message: 'Task done',
      timestamp: Date.now(),
    }
    useNotificationStore.getState().addSessionNotification(notification)
    expect(useNotificationStore.getState().sessionNotifications).toEqual([notification])
  })

  it('replaces notification with same sessionId and eventType', () => {
    const store = useNotificationStore.getState()
    store.addSessionNotification({
      id: 'notif-1',
      sessionId: 'sess-a',
      sessionName: 'Test',
      eventType: 'permission',
      message: 'First',
      timestamp: 1000,
    })
    store.addSessionNotification({
      id: 'notif-2',
      sessionId: 'sess-a',
      sessionName: 'Test',
      eventType: 'permission',
      message: 'Second',
      timestamp: 2000,
    })
    const notifs = useNotificationStore.getState().sessionNotifications
    expect(notifs.length).toBe(1)
    expect(notifs[0].id).toBe('notif-2')
  })

  it('dismisses a session notification by id', () => {
    const store = useNotificationStore.getState()
    store.addSessionNotification({
      id: 'notif-1',
      sessionId: 'sess-a',
      sessionName: 'Test',
      eventType: 'completed',
      message: 'Done',
      timestamp: Date.now(),
    })
    useNotificationStore.getState().dismissSessionNotification('notif-1')
    expect(useNotificationStore.getState().sessionNotifications).toEqual([])
  })

  it('sets shutdown state', () => {
    useNotificationStore.getState().setShutdown('restart', 5000, 1000)
    const state = useNotificationStore.getState()
    expect(state.shutdownReason).toBe('restart')
    expect(state.restartEtaMs).toBe(5000)
    expect(state.restartingSince).toBe(1000)
  })

  it('sets timeout warning', () => {
    const warning = {
      sessionId: 'sess-a',
      sessionName: 'Test',
      remainingMs: 120000,
      receivedAt: Date.now(),
    }
    useNotificationStore.getState().setTimeoutWarning(warning)
    expect(useNotificationStore.getState().timeoutWarning).toEqual(warning)
  })

  it('dismisses timeout warning', () => {
    useNotificationStore.getState().setTimeoutWarning({
      sessionId: 'sess-a',
      sessionName: 'Test',
      remainingMs: 120000,
      receivedAt: Date.now(),
    })
    useNotificationStore.getState().dismissTimeoutWarning()
    expect(useNotificationStore.getState().timeoutWarning).toBeNull()
  })

  it('resets to initial state', () => {
    const store = useNotificationStore.getState()
    store.addServerError({
      id: 'err-1',
      category: 'general',
      message: 'Error',
      recoverable: true,
      timestamp: Date.now(),
    })
    store.setShutdown('crash', 0, Date.now())
    store.reset()
    const state = useNotificationStore.getState()
    expect(state.serverErrors).toEqual([])
    expect(state.sessionNotifications).toEqual([])
    expect(state.shutdownReason).toBeNull()
    expect(state.timeoutWarning).toBeNull()
  })
})
