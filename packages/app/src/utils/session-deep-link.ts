/**
 * Parse a Chroxy deep link for a session id (#6792).
 *
 * Handles the `chroxy://open?session=<id>` shape used by the iOS Live
 * Activity's `deepLinkUrl` (ios-live-activity/live-activity-bridge.ts) —
 * tapping the Live Activity on the Lock Screen / Dynamic Island now opens
 * this URL instead of a bare `chroxy://`, so App.tsx's Linking listener can
 * route straight back to the originating session.
 *
 * Returns null for anything that isn't the chroxy scheme, or that doesn't
 * carry a `session` query param — including the pairing flow's
 * `chroxy://host?pair=...` / `chroxy://host?token=...` URLs. Those CAN reach
 * App.tsx's global Linking listener (it's the app's only OS-level deep-link
 * handler; ConnectScreen parses pairing URLs from QR-scan/manual-entry via
 * `parseChroxyUrl`, not from the Linking API) — this null return is exactly
 * what makes the listener ignore them safely.
 */
export function extractSessionIdFromDeepLink(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith('chroxy://')) return null;
  try {
    const parsed = new URL(trimmed.replace('chroxy://', 'https://'));
    // `?session=` (present but empty) or `?session=%20%20` parses to '' /
    // whitespace — treat that as "no id" per the contract above rather than
    // returning a blank string a caller would switchSession() to.
    const sessionId = parsed.searchParams.get('session')?.trim();
    return sessionId ? sessionId : null;
  } catch {
    return null;
  }
}
