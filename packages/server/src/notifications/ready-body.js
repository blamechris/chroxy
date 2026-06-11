/**
 * #5438 — ready-for-input notification body, enriched with the #5436
 * background-task snapshot.
 *
 * The idle push ("session finished a turn, waiting on you") is composed once
 * in PushNotificationHandler and fans out through PushManager to every sink:
 * the Expo sink delivers `body` as the OS notification text, and the
 * DiscordWebhookSink renders `notification.body` as its status embed's
 * Status field. Enriching the body HERE is therefore the single point that
 * covers both sinks — no per-sink special-casing.
 *
 * Snapshot contract (mirrors the `claude_ready` wire fields from #5436):
 *   - absent (null/undefined) = no information → today's plain body
 *   - present, even `{ backgroundTasks: [] }`, = authoritative → an empty
 *     snapshot also yields the plain body (nothing outstanding to surface)
 *
 * Wording is kept consistent with the dashboard ActivityIndicator chips
 * (#5436): most-recent task by `startedAt`, `description || toolUseId`
 * detail, `+N more` overflow — and the same priority order: outstanding
 * tasks win over an armed wakeup, because a still-running watcher is the
 * thing the user is most likely waiting on (the wakeup will re-busy the
 * session on its own anyway).
 *
 * Wakeup time is rendered RELATIVE ("resumes in 12m"), not as a clock time
 * (#5474). The push body is delivered to an OS tray / Discord embed with no
 * timezone context, and chroxy may run in a different zone than the viewer
 * (e.g. a UTC container vs. an AEST user) — an absolute HH:MM in the server's
 * zone misleads. A relative offset is timezone- and DST-proof, and reads
 * naturally in a notification tray. (The dashboard chip keeps "Resumes at
 * HH:MM" — its `getHours()` runs in the *browser*, i.e. viewer-local, so it
 * is correct as-is; only the push body needed fixing.)
 */

/** Today's plain idle-push body — unchanged when the snapshot has nothing. */
export const DEFAULT_READY_BODY = 'Ready for next message'

// Practical ceiling for push-notification bodies: iOS/Android tray text and
// the Expo payload both render ~1-2 lines; past ~140 chars the tail is never
// visible. The Discord embed field has its own 1000-char truncate, so this
// shared clamp is the binding one.
export const READY_BODY_MAX_LENGTH = 140

// Task descriptions and wakeup reasons come from the session transcript's
// tool_use input — model-authored text, NOT raw PTY bytes. Newlines are
// routine (the scanner's Agent fallback is `prompt.slice(0, 80)`, and
// prompts are usually multi-line); embedded escape/control bytes are
// implausible but cheap to defend against. Push trays and the Discord
// Status field render the body as flowed text, so: drop ANSI CSI/ESC
// sequences outright, turn remaining C0/C1 controls into spaces, then
// collapse all whitespace to single spaces.
function sanitizeDetail(text) {
  return String(text)
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '') // ANSI CSI sequences
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ') // remaining C0/C1 controls
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Clamp `detail` so `prefix + detail + suffix` fits READY_BODY_MAX_LENGTH.
 * The suffix (`+N more`) always survives — it carries the "there is more
 * going on than this one line" signal that a blind tail-truncate would eat.
 */
function clampDetail(prefix, detail, suffix = '') {
  const budget = READY_BODY_MAX_LENGTH - prefix.length - suffix.length
  if (detail.length > budget) {
    let cut = detail.slice(0, Math.max(0, budget - 1))
    // Never cut through a surrogate pair — a half emoji is an ill-formed
    // string in the push/Discord JSON payload (renders as U+FFFD at best).
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
    detail = `${cut}…`
  }
  return `${prefix}${detail}${suffix}`
}

/**
 * Format the gap from `now` to a future wakeup `at` (both epoch ms) as a short
 * relative offset for the push body — timezone- and DST-proof (#5474).
 *
 * Units climb sensibly so the string stays compact under the 140-char clamp:
 *   - < 60s        → "<1m"          (sub-minute precision isn't useful in a tray)
 *   - 1–89 minutes → "Nm"          (e.g. "12m")
 *   - ≥ 90 minutes → "Hh" / "HhMm" (e.g. "2h", "2h05m")
 *
 * Returns null when `at` is non-finite or already in the past (the caller then
 * degrades to the plain body — an offset of "in 0m" / a negative value would
 * be noise, and a stale wakeup carries no useful "resumes in" signal).
 */
function formatRelativeWakeup(at, now) {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return null
  const deltaMs = at - now
  if (deltaMs <= 0) return null

  const totalSeconds = Math.round(deltaMs / 1000)
  if (totalSeconds < 60) return '<1m'

  const totalMinutes = Math.round(totalSeconds / 60)
  if (totalMinutes < 90) return `${totalMinutes}m`

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours}h` : `${hours}h${String(minutes).padStart(2, '0')}m`
}

/**
 * Compose the idle-push body from a background-task snapshot.
 *
 * @param {{ backgroundTasks?: Array<{toolUseId:string, description?:string, startedAt?:number}>,
 *           scheduledWakeup?: { at:number, reason?:string } | null } | null | undefined} snapshot
 *   Output of `getBackgroundTaskSnapshot()` (#5436), or null when the session
 *   type doesn't expose one / the transcript scan degraded.
 * @param {number} [now] Reference epoch ms for the relative wakeup offset —
 *   defaults to `Date.now()`. Parameterized so tests can pin the offset against
 *   a fixed `at` without freezing the global clock.
 * @returns {string} the notification body — DEFAULT_READY_BODY when there is
 *   nothing outstanding, otherwise the enriched still-watching / resumes-in
 *   line, clamped to READY_BODY_MAX_LENGTH.
 */
export function composeReadyNotificationBody(snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== 'object') return DEFAULT_READY_BODY

  const tasks = Array.isArray(snapshot.backgroundTasks) ? snapshot.backgroundTasks : []
  if (tasks.length > 0) {
    // Most recent task by startedAt — same pick as the dashboard chip.
    let newest = tasks[0]
    for (let i = 1; i < tasks.length; i++) {
      if ((tasks[i]?.startedAt ?? 0) > (newest?.startedAt ?? 0)) newest = tasks[i]
    }
    // Sanitize each candidate BEFORE the fallback chain so a whitespace-only
    // description still falls through to the toolUseId.
    const detail =
      sanitizeDetail(newest?.description ?? '') ||
      sanitizeDetail(newest?.toolUseId ?? '') ||
      'background task'
    const suffix = tasks.length > 1 ? ` +${tasks.length - 1} more` : ''
    return clampDetail('Ready for input — still watching: ', detail, suffix)
  }

  const wakeup = snapshot.scheduledWakeup
  if (wakeup && typeof wakeup === 'object') {
    // Relative offset, not an absolute clock time (#5474): the body has no
    // timezone context and the server may run in a different zone than the
    // viewer. A past/unparsable `at` degrades to the plain body, exactly as a
    // NaN time did before.
    const rel = formatRelativeWakeup(Number(wakeup.at), now)
    if (rel === null) return DEFAULT_READY_BODY
    const reason = sanitizeDetail(typeof wakeup.reason === 'string' ? wakeup.reason : '')
    if (!reason) return `Ready for input — resumes in ${rel}`
    return clampDetail(`Ready for input — resumes in ${rel}: `, reason)
  }

  return DEFAULT_READY_BODY
}

/**
 * Read a session's background-task snapshot for notification enrichment.
 * Returns null (= "no information", body unchanged) when the session type
 * doesn't implement `getBackgroundTaskSnapshot()` or the read throws —
 * the same degrade-to-plain-ready posture as event-normalizer's
 * backgroundTaskFields().
 */
export function readBackgroundTaskSnapshot(session) {
  try {
    return typeof session?.getBackgroundTaskSnapshot === 'function'
      ? session.getBackgroundTaskSnapshot()
      : null
  } catch {
    return null
  }
}
