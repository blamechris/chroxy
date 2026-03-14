import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import type { ActivityState } from './store/session-activity'

const CHANNEL_ID = 'session-progress'
const THROTTLE_MS = 1000

let currentNotifId: string | null = null
let lastUpdateTime = 0

function formatElapsed(seconds: number): string {
  if (seconds <= 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

async function ensureChannel(): Promise<void> {
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Session Progress',
    importance: Notifications.AndroidImportance.LOW,
  })
}

export async function updateSessionNotification(
  state: ActivityState,
  detail: string | undefined,
  elapsedSeconds: number,
): Promise<void> {
  if (Platform.OS !== 'android') return

  // Dismiss on idle
  if (state === 'idle') {
    await dismissSessionNotification()
    return
  }

  // Throttle: skip if called within THROTTLE_MS of last update
  const now = Date.now()
  if (now - lastUpdateTime < THROTTLE_MS) return
  lastUpdateTime = now

  // Dismiss previous notification
  if (currentNotifId) {
    await Notifications.dismissNotificationAsync(currentNotifId)
    currentNotifId = null
  }

  await ensureChannel()

  const body = formatElapsed(elapsedSeconds)

  currentNotifId = await Notifications.scheduleNotificationAsync({
    content: {
      title: detail ?? 'Session active',
      body: body || undefined,
      ongoing: true,
    },
    trigger: null,
  })
}

export async function dismissSessionNotification(): Promise<void> {
  if (Platform.OS !== 'android') return
  if (!currentNotifId) return

  await Notifications.dismissNotificationAsync(currentNotifId)
  currentNotifId = null
}

/** Exposed for testing only */
export const _testInternals = {
  formatElapsed,
  reset() {
    currentNotifId = null
    lastUpdateTime = 0
  },
}
