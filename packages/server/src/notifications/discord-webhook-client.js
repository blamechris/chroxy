/**
 * discord-webhook-client.js — channel-level Discord webhook primitives shared
 * by every Discord sink (#5828).
 *
 * Extracted verbatim from discord-webhook-sink.js so the per-project status sink
 * and the daemon-global billing-alert sink share ONE tested implementation of
 * the fetch policy, retry/429 handling, id/token extraction, and the markdown
 * escaping used to render free-text into embed fields. This is a pure-swap
 * extraction: the behaviour is byte-for-byte the status sink's previous private
 * helpers — the status sink now delegates to these.
 *
 * None of this touches sink state (no per-project store, no heartbeat) — it is
 * just the wire layer, so a sink with a completely different lifecycle (the
 * billing sink keeps a single global message, not a per-project state machine)
 * can reuse it without inheriting the status state machine.
 */

import { sleep, backoffDelay } from '../utils/sleep.js'
import { extractWebhookIdToken } from '../discord-credentials.js'

// Same envelope as the Expo sink's fetch policy; the 429 handling is the
// Discord-specific addition.
export const FETCH_TIMEOUT_MS = 10_000
export const MAX_RETRIES = 3
export const BACKOFF_BASE_MS = 1_000
// Ceiling on how long a single 429 retry_after is honoured. Discord webhook
// buckets are normally sub-second; a multi-minute retry_after means we're
// globally limited and should give up (the call resolves with the 429 response;
// the pipeline retries on the next event) rather than hold the fan-out hostage.
export const MAX_RETRY_AFTER_MS = 30_000

// Embed sidebar color defaults — ported from claude-code-notify
// (colors.conf.example + the CLAUDE_NOTIFY_*_COLOR defaults).
export const DEFAULT_PROJECT_COLOR = 5793266    // Discord blurple #5865F2
export const DEFAULT_PERMISSION_COLOR = 16753920 // orange #FFA500
export const DEFAULT_ERROR_COLOR = 15158332     // red #E74C3C
export const DEFAULT_ONLINE_COLOR = 3066993     // green #2ECC71
export const DEFAULT_OFFLINE_COLOR = 15158332   // red #E74C3C
export const MAX_COLOR = 16777215               // 24-bit RGB

/** Format seconds into a human-readable duration (port of format_duration). */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s'
  seconds = Math.floor(seconds)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

export function isValidColor(color) {
  return Number.isInteger(color) && color >= 0 && color <= MAX_COLOR
}

export function truncate(text, max = 1000) {
  if (typeof text !== 'string') return ''
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

/**
 * Escape Discord markdown metacharacters so free-text user/transcript content
 * (task descriptions, ScheduleWakeup reasons, session names, billing messages)
 * renders literally in an embed field instead of being styled or swallowed
 * (#5475).
 *
 * Example: a task described as `watch dist/*_test.js` would otherwise render
 * with the `*…*`/`_…_` runs interpreted as italics, eating characters.
 *
 * The sink is webhook-based and intentionally dependency-free, so this is a
 * local 5-liner rather than pulling in discord.js's escapeMarkdown. We escape
 * the inline-format set (`\\ * _ ~ \` |`) plus a leading `>` (blockquote — only
 * meaningful at line start; we escape every `>` for simplicity, which is
 * harmless mid-line). Backslash is escaped FIRST so we don't double-escape the
 * escapes we then insert.
 *
 * Escaping the already-truncated string keeps every inserted `\X` pair intact
 * (escaping first could split a `\X` across the cut and leave a dangling `\`),
 * so callers truncate FIRST and escape SECOND — see escapeAndCap.
 */
export function escapeMarkdown(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/[\\*_~`|>]/g, '\\$&')
}

/**
 * Truncate a free-text field, escape its markdown, and clamp the FINAL escaped
 * string to `max` chars — the value that actually goes on the wire (#5475).
 *
 * Escaping after truncation can up to double the length (all-metachar input →
 * ~2×). Discord's embed-field hard limit is 1024, so an un-clamped escaped
 * value could exceed it and get the whole webhook PATCH/POST rejected with a
 * 400. We re-truncate the escaped result to `max`; if the cut lands on a lone
 * `\` inserted by escaping (i.e. the escape backslash without its metachar),
 * we drop it so the field never ends in a dangling backslash.
 *
 * The inner truncate() appends a plain `...` marker (no metacharacters), so it
 * is neither escaped nor split by the re-truncate.
 */
export function escapeAndCap(text, max = 1000) {
  const escaped = escapeMarkdown(truncate(text, max))
  if (escaped.length <= max) return escaped
  const cut = escaped.slice(0, max)
  // escapeMarkdown emits `\` only immediately before a metacharacter, so every
  // backslash in `escaped` belongs to a `\X` pair. A run of trailing backslashes
  // of ODD length means the final `\` is a lone escape whose metachar fell past
  // the cut; drop it so the field never ends in a dangling escape. An EVEN run
  // is whole `\\` pairs (escaped literal backslashes) and stays intact.
  const trailing = cut.length - cut.replace(/\\+$/, '').length
  return trailing % 2 === 1 ? cut.slice(0, -1) : cut
}

/** Build the Discord webhook API base from a validated webhook URL. */
export function apiBase(webhookUrl) {
  const parts = extractWebhookIdToken(webhookUrl)
  // Callers validate the URL shape up front; belt-and-braces.
  if (!parts) throw new Error('webhook URL failed id/token extraction')
  return `https://discord.com/api/webhooks/${parts.id}/${parts.token}`
}

/**
 * Extract the wait from a 429 response. Discord sends `retry_after` in
 * SECONDS (float) in the JSON body and a Retry-After header (also seconds).
 * Defaults to 2s when unparsable; clamped to MAX_RETRY_AFTER_MS.
 */
export async function retryAfterMs(res) {
  let seconds = NaN
  try {
    const header = res.headers?.get?.('retry-after')
    if (header != null) seconds = Number.parseFloat(header)
  } catch { /* fall through to body */ }
  if (!Number.isFinite(seconds)) {
    try {
      seconds = Number.parseFloat((await res.json())?.retry_after)
    } catch { /* fall through to default */ }
  }
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 2
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
}

/**
 * Fetch with timeout + bounded retry, Discord flavor:
 *   - 429 → honour retry_after (JSON body seconds, or Retry-After header),
 *     capped at MAX_RETRY_AFTER_MS, then retry
 *   - 5xx / network error / timeout → exponential backoff retry
 *   - other 4xx → return immediately (not retryable)
 * Throws only when the LAST attempt threw (caller maps that to `false`).
 *
 * @param {string} url
 * @param {object} options - fetch init (method/headers/body)
 * @param {object} [opts]
 * @param {number} [opts.retries] - max attempts (default MAX_RETRIES).
 * @param {Function} [opts.sleepImpl] - injection seam for tests (429/backoff waits).
 * @param {Function} [opts.fetchImpl] - injection seam for tests (defaults to global fetch).
 */
export async function fetchWithDiscordRetry(url, options, { retries = MAX_RETRIES, sleepImpl = sleep, fetchImpl = fetch } = {}) {
  let res
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      res = await fetchImpl(url, { ...options, signal: controller.signal })
    } catch (err) {
      clearTimeout(timer)
      if (attempt < retries) {
        await sleepImpl(backoffDelay(attempt, BACKOFF_BASE_MS))
        continue
      }
      throw err
    }
    clearTimeout(timer)

    if (res.status === 429) {
      if (attempt < retries) {
        await sleepImpl(await retryAfterMs(res))
        continue
      }
      return res
    }
    if (res.ok || (res.status >= 400 && res.status < 500)) return res
    // 5xx
    if (attempt < retries) {
      await sleepImpl(backoffDelay(attempt, BACKOFF_BASE_MS))
      continue
    }
    return res
  }
  return res
}
