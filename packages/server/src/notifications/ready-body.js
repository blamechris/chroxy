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
 * detail, `+N more` overflow, HH:MM local wakeup time — and the same
 * priority order: outstanding tasks win over an armed wakeup, because a
 * still-running watcher is the thing the user is most likely waiting on
 * (the wakeup will re-busy the session on its own anyway).
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
 * Compose the idle-push body from a background-task snapshot.
 *
 * @param {{ backgroundTasks?: Array<{toolUseId:string, description?:string, startedAt?:number}>,
 *           scheduledWakeup?: { at:number, reason?:string } | null } | null | undefined} snapshot
 *   Output of `getBackgroundTaskSnapshot()` (#5436), or null when the session
 *   type doesn't expose one / the transcript scan degraded.
 * @returns {string} the notification body — DEFAULT_READY_BODY when there is
 *   nothing outstanding, otherwise the enriched still-watching / resumes-at
 *   line, clamped to READY_BODY_MAX_LENGTH.
 */
export function composeReadyNotificationBody(snapshot) {
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
    const at = new Date(wakeup.at)
    if (!Number.isFinite(at.getTime())) return DEFAULT_READY_BODY
    // Server-local HH:MM — same formatting as the dashboard's wakeup chip.
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    const reason = sanitizeDetail(typeof wakeup.reason === 'string' ? wakeup.reason : '')
    if (!reason) return `Ready for input — resumes at ${hhmm}`
    return clampDetail(`Ready for input — resumes at ${hhmm}: `, reason)
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
