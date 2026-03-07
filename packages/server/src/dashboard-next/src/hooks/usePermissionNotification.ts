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

    for (const prompt of prompts) {
      // Skip answered or expired prompts
      if (prompt.answered) continue
      if (prompt.expiresAt <= Date.now()) continue
      // Skip already-notified
      if (notifiedRef.current.has(prompt.requestId)) continue
      // Only notify when window is not focused
      if (!document.hidden) continue

      notifiedRef.current.add(prompt.requestId)

      new Notification('Chroxy: Permission Requested', {
        body: prompt.description,
        tag: `chroxy-perm-${prompt.requestId}`,
      })
    }
  }, [prompts])
}
