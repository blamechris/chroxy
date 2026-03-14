import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { ActivityState } from './store/session-activity';

const CHANNEL_ID = 'session-progress';
const THROTTLE_MS = 1000;

const ELAPSED_INTERVAL_MS = 30_000;

let currentNotifId: string | null = null;
let lastUpdateTime = 0;
let channelReady = false;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let currentTitle: string | null = null;
let currentStartedAt: number | null = null;

function formatElapsed(seconds: number): string {
  if (seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function ensureChannel(): Promise<void> {
  if (channelReady) return;
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Session Progress',
      importance: Notifications.AndroidImportance.LOW,
    });
    channelReady = true;
  } catch {
    // Best-effort — degrade to no-op if notifications unavailable
  }
}

export async function updateSessionNotification(
  state: ActivityState,
  title: string | undefined,
  elapsedSeconds: number,
): Promise<void> {
  if (Platform.OS !== 'android') return;

  // Dismiss on idle and reset throttle so next active state fires immediately
  if (state === 'idle') {
    await dismissSessionNotification();
    return;
  }

  // Throttle: skip if called within THROTTLE_MS of last update
  const now = Date.now();
  if (now - lastUpdateTime < THROTTLE_MS) return;
  lastUpdateTime = now;

  // Dismiss previous notification
  if (currentNotifId) {
    try {
      await Notifications.dismissNotificationAsync(currentNotifId);
    } catch {
      // Best-effort
    }
    currentNotifId = null;
  }

  await ensureChannel();

  const body = formatElapsed(elapsedSeconds);

  try {
    currentNotifId = await Notifications.scheduleNotificationAsync({
      content: {
        title: title ?? 'Session active',
        body: body || undefined,
        // Android-only: keeps notification persistent until explicitly dismissed.
        // Not in expo-notifications types but supported at runtime.
        ongoing: true,
      } as Notifications.NotificationContentInput & { ongoing: boolean },
      trigger: null,
    });
  } catch {
    // Best-effort — degrade to no-op if permissions denied or API unavailable
  }
}

export async function dismissSessionNotification(): Promise<void> {
  if (Platform.OS !== 'android') return;
  stopElapsedTimer();
  if (!currentNotifId) return;

  try {
    await Notifications.dismissNotificationAsync(currentNotifId);
  } catch {
    // Best-effort
  }
  currentNotifId = null;
  lastUpdateTime = 0;
}

/**
 * Starts a periodic timer that updates the notification with current elapsed
 * time every ELAPSED_INTERVAL_MS (30s). Call when session becomes active.
 * Automatically stops any existing timer before starting a new one.
 */
export function startElapsedTimer(title: string, startedAt: number): void {
  if (Platform.OS !== 'android') return;
  stopElapsedTimer();
  currentTitle = title;
  currentStartedAt = startedAt;

  elapsedTimer = setInterval(() => {
    if (currentStartedAt == null) return;
    const elapsed = Math.floor((Date.now() - currentStartedAt) / 1000);
    // Reset lastUpdateTime so the throttle doesn't block periodic updates
    lastUpdateTime = 0;
    void updateSessionNotification(
      'busy', // state doesn't matter for display, just needs to be non-idle
      currentTitle ?? 'Session active',
      elapsed,
    );
  }, ELAPSED_INTERVAL_MS);
}

/**
 * Stops the periodic elapsed-time update timer.
 */
export function stopElapsedTimer(): void {
  if (elapsedTimer != null) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  currentTitle = null;
  currentStartedAt = null;
}

/** Exposed for testing only */
export const _testInternals = {
  formatElapsed,
  ELAPSED_INTERVAL_MS,
  get elapsedTimer() { return elapsedTimer; },
  reset() {
    stopElapsedTimer();
    currentNotifId = null;
    lastUpdateTime = 0;
    channelReady = false;
  },
};
