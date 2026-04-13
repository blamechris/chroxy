import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ServerError, SessionNotification } from './types';

interface TimeoutWarning {
  sessionId: string;
  sessionName: string;
  remainingMs: number;
  receivedAt: number;
}

/** Persistent activity history entry (survives app kill). */
export interface ActivityEntry {
  id: string;
  sessionId: string;
  sessionName: string;
  eventType: SessionNotification['eventType'];
  message: string;
  timestamp: number;
}

const ACTIVITY_STORAGE_KEY = 'chroxy_activity_history';
const MAX_ACTIVITY_ENTRIES = 50;
const ACTIVITY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface NotificationState {
  serverErrors: ServerError[];
  sessionNotifications: SessionNotification[];
  shutdownReason: 'restart' | 'shutdown' | 'crash' | null;
  restartEtaMs: number | null;
  restartingSince: number | null;
  timeoutWarning: TimeoutWarning | null;
  activityHistory: ActivityEntry[];

  addServerError: (error: ServerError) => void;
  dismissServerError: (id: string) => void;
  addSessionNotification: (notification: SessionNotification) => void;
  dismissSessionNotification: (id: string) => void;
  setShutdown: (reason: 'restart' | 'shutdown' | 'crash', etaMs: number, since: number) => void;
  setTimeoutWarning: (warning: TimeoutWarning | null) => void;
  dismissTimeoutWarning: () => void;
  loadActivityHistory: () => Promise<void>;
  clearActivityHistory: () => Promise<void>;
  reset: () => void;
}

const initialState = {
  serverErrors: [] as ServerError[],
  sessionNotifications: [] as SessionNotification[],
  shutdownReason: null as NotificationState['shutdownReason'],
  restartEtaMs: null as number | null,
  restartingSince: null as number | null,
  timeoutWarning: null as TimeoutWarning | null,
  activityHistory: [] as ActivityEntry[],
};

/** Persist activity history to AsyncStorage (fire-and-forget). */
function persistActivity(entries: ActivityEntry[]) {
  AsyncStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(entries)).catch(() => {});
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
      );
      // UX landmine #7: persist to activity history (survives app kill)
      const entry: ActivityEntry = {
        id: notification.id,
        sessionId: notification.sessionId,
        sessionName: notification.sessionName,
        eventType: notification.eventType,
        message: notification.message,
        timestamp: notification.timestamp,
      };
      const cutoff = Date.now() - ACTIVITY_TTL_MS;
      const updated = [...state.activityHistory, entry]
        .filter((e) => e.timestamp > cutoff)
        .slice(-MAX_ACTIVITY_ENTRIES);
      persistActivity(updated);
      return { sessionNotifications: [...filtered, notification], activityHistory: updated };
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

  loadActivityHistory: async () => {
    try {
      const raw = await AsyncStorage.getItem(ACTIVITY_STORAGE_KEY);
      if (raw) {
        const entries: ActivityEntry[] = JSON.parse(raw);
        const cutoff = Date.now() - ACTIVITY_TTL_MS;
        set({ activityHistory: entries.filter((e) => e.timestamp > cutoff).slice(-MAX_ACTIVITY_ENTRIES) });
      }
    } catch {
      // Silently ignore — activity history is non-critical
    }
  },

  clearActivityHistory: async () => {
    set({ activityHistory: [] });
    await AsyncStorage.removeItem(ACTIVITY_STORAGE_KEY).catch(() => {});
  },

  reset: () => set((state) => ({
    ...initialState,
    // Preserve persistent activity history across disconnect/reset —
    // it's AsyncStorage-backed and should survive session transitions.
    activityHistory: state.activityHistory,
  })),
}));
