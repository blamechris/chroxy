/**
 * useNotificationPermission (#7351) — own the OS-notification permission
 * lifecycle: probe it, request it once, and expose the result so the UI can
 * say out loud when notifications are off.
 *
 * ## The bug this closes
 *
 * `usePermissionNotification` guarded on `Notification.permission === 'granted'`
 * while **nothing in chroxy ever called `Notification.requestPermission()`**.
 * The permission stayed `'default'`, the guard returned every time, and the
 * dashboard's only `new Notification` call was unreachable in production. See
 * `utils/native-notifications.ts` for the full write-up.
 *
 * ## Why the automatic request is Tauri-only
 *
 * Requesting is not symmetrical between the two backends:
 *
 * - **Tauri** — `requestPermission()` raises an OS dialog. There is no user-
 *   gesture requirement, so a first-run request is both possible and the
 *   normal thing a desktop app does.
 * - **Browser** — every current browser requires transient activation.
 *   Requesting on mount does not merely fail, it fails *badly*: Chrome rejects
 *   the promise, and a rejected/ignored prompt is remembered against the
 *   origin, which can burn the one chance to ask. So on the web backend the
 *   request is made only from a real click — the "Enable notifications" button
 *   in Settings → Dashboard, which passes through `request()` below.
 *
 * The alternative (auto-request everywhere) is what makes notification
 * permission prompts the most-blocked permission on the web; it would also be
 * the third time this feature shipped in a state that cannot work.
 *
 * ## Asking once, and only once
 *
 * The auto-request fires when the backend is Tauri, the permission is still
 * `'default'`, `autoRequest` is true, and this device has not been asked
 * before (`loadNotificationPermissionAsked()`). The persisted flag is what
 * covers the case neither backend can report: a user who dismissed the prompt
 * without choosing leaves the state at `'default'` forever, and without the
 * flag we would re-prompt on every page load. `hasRequestedRef` covers the
 * same thing within a single page lifetime, before the async request resolves.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getNotificationBackend,
  getNotificationPermission,
  refreshNotificationPermission,
  requestNativeNotificationPermission,
  type NativeNotificationBackend,
  type NativeNotificationPermission,
} from '../utils/native-notifications'
import {
  loadNotificationPermissionAsked,
  persistNotificationPermissionAsked,
} from '../store/persistence'

export interface UseNotificationPermissionOptions {
  /**
   * Whether there is now something worth notifying about — the caller passes
   * "a session exists". Gating on this rather than on mount means we ask at
   * the moment the permission becomes useful, instead of interrupting someone
   * who opened the app to change a setting.
   */
  autoRequest: boolean
}

export interface UseNotificationPermissionResult {
  backend: NativeNotificationBackend
  permission: NativeNotificationPermission
  /**
   * Prompt the user. **Must be called from a user gesture** on the web
   * backend. Always prompts when invoked — an explicit click is a deliberate
   * ask, so it ignores the "already asked" flag.
   */
  request: () => Promise<NativeNotificationPermission>
}

export function useNotificationPermission(
  { autoRequest }: UseNotificationPermissionOptions,
): UseNotificationPermissionResult {
  const [backend] = useState<NativeNotificationBackend>(() => getNotificationBackend())
  const [permission, setPermission] = useState<NativeNotificationPermission>(() =>
    getNotificationPermission(),
  )
  const hasRequestedRef = useRef(false)
  /**
   * Whether the initial permission probe has completed.
   *
   * Load-bearing for the Tauri backend, whose `isPermissionGranted()` is
   * async: until it resolves, `getNotificationPermission()` reports
   * `'default'` (it fails closed by design). Auto-requesting off that
   * provisional value would re-prompt on every launch of an install where the
   * user ALREADY granted permission — and would spend the persisted
   * "asked" flag doing it. So the request waits for a real answer.
   */
  const [probed, setProbed] = useState(false)

  // Prime the cached Tauri permission (its probe is async) and pick up a
  // grant/denial made outside this tab.
  useEffect(() => {
    let cancelled = false
    refreshNotificationPermission().then(next => {
      if (cancelled) return
      setPermission(next)
      setProbed(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const request = useCallback(async (): Promise<NativeNotificationPermission> => {
    hasRequestedRef.current = true
    persistNotificationPermissionAsked()
    const next = await requestNativeNotificationPermission()
    setPermission(next)
    return next
  }, [])

  useEffect(() => {
    if (!autoRequest) return
    // Web: no automatic request — see the header. The Settings button is the
    // only path, because only a click carries the transient activation the
    // browser demands.
    if (backend !== 'tauri') return
    // Never ask off the pre-probe placeholder — see `probed`.
    if (!probed) return
    if (permission !== 'default') return
    if (hasRequestedRef.current) return
    if (loadNotificationPermissionAsked()) return
    void request()
  }, [autoRequest, backend, probed, permission, request])

  return { backend, permission, request }
}
