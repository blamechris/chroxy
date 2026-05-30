/**
 * #4569: shared curated IANA timezone short-list for the notification
 * quiet-hours editor. Both the dashboard `SettingsPanel` and the mobile
 * `SettingsScreen` import this list so they cannot drift when one
 * platform extends the picker without the other.
 *
 * The full IANA database has hundreds of entries; we surface a curated
 * subset that covers the most common operator timezones. UI code is
 * expected to prepend the device's resolved zone (see
 * `buildQuietHoursTimezoneList`) so the user can always pick "this
 * device" without scrolling.
 *
 * The wire value sent to the server is the raw IANA name
 * (e.g. `America/Los_Angeles`); labels are derived by the UI.
 */
export const QUIET_HOURS_TIMEZONE_CHOICES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
  'Pacific/Auckland',
] as const

/**
 * Compose the picker list for the quiet-hours timezone control.
 *
 * Returns a fresh array (never the source constant) so callers can
 * safely mutate it. When `deviceTimezone` is missing or already in the
 * curated list, the list is returned unchanged; otherwise the device
 * zone is prepended so it appears first in the picker.
 */
export function buildQuietHoursTimezoneList(
  deviceTimezone: string | null | undefined,
): string[] {
  const list: string[] = [...QUIET_HOURS_TIMEZONE_CHOICES]
  if (deviceTimezone && !list.includes(deviceTimezone)) {
    list.unshift(deviceTimezone)
  }
  return list
}
