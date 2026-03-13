import { create } from 'zustand'
import type { ServerError, SessionNotification } from './types'

interface TimeoutWarning {
  sessionId: string
  sessionName: string
  remainingMs: number
  receivedAt: number
}

interface NotificationState {
  serverErrors: ServerError[]
  sessionNotifications: SessionNotification[]
  shutdownReason: 'restart' | 'shutdown' | 'crash' | null
  restartEtaMs: number | null
  restartingSince: number | null
  timeoutWarning: TimeoutWarning | null

  addServerError: (error: ServerError) => void
  dismissServerError: (id: string) => void
  addSessionNotification: (notification: SessionNotification) => void
  dismissSessionNotification: (id: string) => void
  setShutdown: (reason: 'restart' | 'shutdown' | 'crash', etaMs: number, since: number) => void
  setTimeoutWarning: (warning: TimeoutWarning | null) => void
  dismissTimeoutWarning: () => void
  reset: () => void
}

const initialState = {
  serverErrors: [] as ServerError[],
  sessionNotifications: [] as SessionNotification[],
  shutdownReason: null as NotificationState['shutdownReason'],
  restartEtaMs: null as number | null,
  restartingSince: null as number | null,
  timeoutWarning: null as TimeoutWarning | null,
}

export const useNotificationStore = create<NotificationState>((set) => ({
  ...initialState,

  addServerError: (error) =>
    set((state) => ({
      serverErrors: [...state.serverErrors, error].slice(-10),
    })),

  dismissServerError: (id) =>
    set((state) => ({
      serverErrors: state.serverErrors.filter((e) => e.id !== id),
    })),

  addSessionNotification: (notification) =>
    set((state) => {
      const filtered = state.sessionNotifications.filter(
        (n) => !(n.sessionId === notification.sessionId && n.eventType === notification.eventType),
      )
      return { sessionNotifications: [...filtered, notification] }
    }),

  dismissSessionNotification: (id) =>
    set((state) => ({
      sessionNotifications: state.sessionNotifications.filter((n) => n.id !== id),
    })),

  setShutdown: (reason, etaMs, since) =>
    set({ shutdownReason: reason, restartEtaMs: etaMs, restartingSince: since }),

  setTimeoutWarning: (warning) =>
    set({ timeoutWarning: warning }),

  dismissTimeoutWarning: () =>
    set({ timeoutWarning: null }),

  reset: () => set(initialState),
}))
