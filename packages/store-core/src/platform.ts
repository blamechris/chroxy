/**
 * Platform adapters — dependency injection interfaces for platform-specific behavior.
 *
 * Mobile (React Native) and web (dashboard) provide different implementations
 * for alerts, haptics, push notifications, and persistent storage.
 */

export interface AlertButton {
  text: string
  style?: 'default' | 'cancel' | 'destructive'
  onPress?: () => void
}

export interface AlertAdapter {
  /** Show an alert dialog. On mobile: native Alert. On web: console.warn (no interactive dialog). */
  alert(title: string, message: string, buttons?: AlertButton[]): void
}

export interface HapticAdapter {
  /** Light haptic feedback (e.g., button press) */
  light(): void
  /** Medium haptic feedback (e.g., disconnect) */
  medium(): void
  /** Warning haptic feedback (e.g., permission deny) */
  warning(): void
  /** Success haptic feedback (e.g., auth success, model switch) */
  success(): void
}

export interface PushAdapter {
  /** Register push notification token with the server. No-op on web. */
  registerPushToken(socket: WebSocket): Promise<void>
}

export interface StorageAdapter {
  /** Save connection URL and token. */
  saveConnection(url: string, token: string): void | Promise<void>
  /** Load saved connection. Returns null if none saved. */
  loadConnection(): { url: string; token: string } | null | Promise<{ url: string; token: string } | null>
  /** Clear saved connection. */
  clearConnection(): void | Promise<void>
}

/** Combined platform adapters passed to the message handler factory. */
export interface PlatformAdapters {
  alert: AlertAdapter
  haptic: HapticAdapter
  push: PushAdapter
  storage: StorageAdapter
}

/** No-op adapters for web dashboard (or testing). */
export const noopHaptic: HapticAdapter = {
  light() {},
  medium() {},
  warning() {},
  success() {},
}

export const consoleAlert: AlertAdapter = {
  alert(title: string, message: string) {
    console.warn(`[chroxy] ${title}: ${message}`)
  },
}

export const noopPush: PushAdapter = {
  async registerPushToken() {},
}
