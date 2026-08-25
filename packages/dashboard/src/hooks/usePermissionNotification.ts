/**
 * usePermissionNotification — fire native notifications for permission requests
 * when the browser/Tauri window is not focused.
 *
 * Sends through `utils/native-notifications`, which picks the Tauri plugin
 * when available and the Web Notification API otherwise. It does NOT touch
 * `window.Notification` directly: before #7351 it did, behind a
 * `Notification.permission === 'granted'` guard that nothing ever satisfied,
 * because `Notification.requestPermission()` was never called anywhere in
 * chroxy. The permission lifecycle now lives in `useNotificationPermission`,
 * and dispatch lives in the backend module — this hook only decides *which*
 * prompts deserve a notification.
 */
import { useRef, useEffect } from 'react'
import {
  getNotificationPermission,
  sendNativeNotification,
  type NativeNotificationPermission,
} from '../utils/native-notifications'

export interface PermissionPromptInfo {
  id: string
  requestId: string
  tool: string
  description: string
  expiresAt: number
  answered: string | undefined
}

/**
 * @param prompts     Active permission prompts, newest state each render.
 * @param permission  Live permission state from `useNotificationPermission`.
 *   Passing it makes a mid-session grant take effect immediately for prompts
 *   that are still pending, instead of waiting for the next change to
 *   `prompts` to re-run the effect. Omitted (tests, other call sites) it is
 *   read from the backend at effect time.
 */
export function usePermissionNotification(
  prompts: PermissionPromptInfo[],
  permission?: NativeNotificationPermission,
) {
  const notifiedRef = useRef(new Set<string>())

  useEffect(() => {
    const current = permission ?? getNotificationPermission()
    if (current !== 'granted') return

    // Prune stale IDs no longer in the active prompts list
    const activeIds = new Set(prompts.map(p => p.requestId))
    for (const id of notifiedRef.current) {
      if (!activeIds.has(id)) notifiedRef.current.delete(id)
    }

    for (const prompt of prompts) {
      // Skip answered or expired prompts
      if (prompt.answered) continue
      // #3619: `prompt.expiresAt` is captured wall-clock at receipt time
      // (`Date.now() + remainingMs`); comparing against `Date.now()` keeps
      // both sides on the same clock. Switching to `performance.now()`
      // here would mix clocks with the receipt-time anchor and break the
      // expiry check. The PermissionPrompt's *visible countdown* uses the
      // monotonic clock independently — see PermissionPrompt.tsx (#3619).
      if (prompt.expiresAt <= Date.now()) continue
      // Skip already-notified
      if (notifiedRef.current.has(prompt.requestId)) continue
      // Only notify when window is not focused
      if (document.hasFocus()) continue

      // Marked before dispatch, and regardless of whether dispatch succeeds:
      // a backend that throws must not be retried on every subsequent render.
      notifiedRef.current.add(prompt.requestId)

      sendNativeNotification('Chroxy: Permission Requested', {
        body: prompt.description,
        tag: `chroxy-perm-${prompt.requestId}`,
      })
    }
  }, [prompts, permission])
}
