/**
 * usePermissionNotification — fire native notifications for permission requests
 * when the browser/Tauri window is not focused.
 *
 * Uses the Web Notification API (supported in both browsers and Tauri WKWebView).
 */
import { useRef, useEffect } from 'react'

export interface PermissionPromptInfo {
  id: string
  requestId: string
  tool: string
  description: string
  expiresAt: number
  answered: string | undefined
}

export function usePermissionNotification(prompts: PermissionPromptInfo[]) {
  const notifiedRef = useRef(new Set<string>())

  useEffect(() => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return

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

      notifiedRef.current.add(prompt.requestId)

      new Notification('Chroxy: Permission Requested', {
        body: prompt.description,
        tag: `chroxy-perm-${prompt.requestId}`,
      })
    }
  }, [prompts])
}
