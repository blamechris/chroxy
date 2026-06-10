/**
 * DiscordWebhookSink — per-project Discord status embed (#5413 Phase 2).
 *
 * A behavior port of claude-code-notify's bash state machine to a
 * NotificationSink (see sink.js for the contract). One status message per
 * project, kept fresh in place:
 *
 *   - routine state updates  → PATCH the existing message (no ping)
 *   - ping-worthy states     → DELETE the old message + POST a new one, so
 *     Discord re-notifies and the message moves to the bottom of the channel
 *     (idle / needs-approval — the states the user actually waits on)
 *   - PATCH 404 (message deleted externally) → self-heal by POSTing fresh
 *   - per-project embed sidebar colors (config), per-state title/emoji
 *   - throttle window between same-state routine updates
 *
 * What moved vs the bash original:
 *   - State (message id, current state, subagent count, timestamps) lives in
 *     ONE JSON file under ~/.chroxy/ written atomically (temp+rename via
 *     writeFileRestricted) — not a pile of /tmp files with mkdir locking.
 *     The /tmp state machine was the root cause of the reliability pain the
 *     epic exists to fix.
 *   - The heartbeat is a single unref'd in-process setInterval that PATCHes
 *     each tracked embed so the elapsed-time footer stays current — not a
 *     forked bash daemon with a PID file.
 *   - Driven by chroxy's own notification pipeline categories (Phase 2).
 *     External Claude Code hook ingest is Phase 3; subagent counting from
 *     hooks is Phase 4 — until then the embed reflects what chroxy-launched
 *     sessions expose (`data.subagents` when a caller provides it).
 *
 * The webhook URL is a SECRET (posting + message-delete capability on the
 * channel). It is sourced from the env / 0600 credentials.json via
 * discord-credentials.js, never from config.json, and never logged (the
 * logger redacts discord webhook URLs as a second layer).
 *
 * Discord rate limits: webhook endpoints return 429 with a `retry_after`
 * (seconds) in the JSON body and a Retry-After header. fetchWithRetry
 * (push.js) treats all 4xx as non-retryable, so this sink carries its own
 * fetch helper that respects retry_after instead of hammering.
 */

import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileRestricted } from '../platform.js'
import { createLogger } from '../logger.js'
import { sleep, backoffDelay } from '../utils/sleep.js'
import { NotificationSink } from './sink.js'
import {
  cachedResolveDiscordWebhookUrl,
  isValidDiscordWebhookUrl,
  extractWebhookIdToken,
} from '../discord-credentials.js'

const log = createLogger('discord')

// Same envelope as the Expo sink's fetch policy; the 429 handling is the
// Discord-specific addition.
const FETCH_TIMEOUT_MS = 10_000
const MAX_RETRIES = 3
const BACKOFF_BASE_MS = 1_000
// Ceiling on how long a single 429 retry_after is honoured. Discord webhook
// buckets are normally sub-second; a multi-minute retry_after means we're
// globally limited and should give up (send() resolves false; the pipeline
// retries on the next event) rather than hold the fan-out hostage.
const MAX_RETRY_AFTER_MS = 30_000

// Embed sidebar color defaults — ported from claude-code-notify
// (colors.conf.example + the CLAUDE_NOTIFY_*_COLOR defaults).
const DEFAULT_PROJECT_COLOR = 5793266   // Discord blurple #5865F2
const DEFAULT_PERMISSION_COLOR = 16753920 // orange #FFA500
const DEFAULT_ERROR_COLOR = 15158332    // red #E74C3C
const MAX_COLOR = 16777215              // 24-bit RGB

// Pipeline notification category → embed state. Phase 2 maps chroxy's own
// session events (the categories PushManager.send is called with). The
// bash original's hook-driven states (online/offline/idle_busy/approved)
// return with Phase 3 ingest + Phase 4 hooks.
//
//   idle       — session finished a turn / waiting for input (🦀 in the
//                original; ping-worthy: DELETE + POST so Discord notifies)
//   permission — needs approval / has a question (ping-worthy)
//   error      — session error (routine PATCH; new vs bash, which had no
//                error surface — deliberate addition, documented in the PR)
//   stale      — inactivity warning: busy but silent for a long time
//                (routine PATCH; replaces the bash "(stale?)" title suffix)
const STATE_FOR_CATEGORY = {
  activity_update: 'idle',
  result: 'idle',
  permission: 'permission',
  activity_waiting: 'permission',
  activity_error: 'error',
  inactivity_warning: 'stale',
}

// States that re-ping: DELETE the old message + POST a new one.
const PING_STATES = new Set(['idle', 'permission'])

const STATE_TITLES = {
  idle: (project) => `\u{1F980} ${project} — Ready for input`,
  permission: (project) => `\u{1F510} ${project} — Needs Approval`,
  error: (project) => `\u{2757} ${project} — Session Error`,
  stale: (project) => `\u{23F3} ${project} — Quiet for a while`,
}

/** Format seconds into a human-readable duration (port of format_duration). */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s'
  seconds = Math.floor(seconds)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function isValidColor(color) {
  return Number.isInteger(color) && color >= 0 && color <= MAX_COLOR
}

function truncate(text, max = 1000) {
  if (typeof text !== 'string') return ''
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

export class DiscordWebhookSink extends NotificationSink {
  /**
   * @param {object} [opts]
   * @param {string} [opts.statePath] - Status-message state file. Defaults to
   *   ~/.chroxy/discord-webhook-state.json (resolved lazily so tests that
   *   mutate HOME, and the test sandbox guard, behave). Tests MUST inject a
   *   temp path.
   * @param {string} [opts.botName] - Webhook display name + footer label.
   * @param {Record<string, number>} [opts.colors] - Per-project sidebar color
   *   overrides (decimal 24-bit RGB), from config notifications.discord.colors.
   * @param {number} [opts.defaultColor] - Sidebar color for projects without
   *   an override (default: Discord blurple).
   * @param {number} [opts.permissionColor] - Sidebar color for the
   *   needs-approval state.
   * @param {number} [opts.errorColor] - Sidebar color for the error state.
   * @param {number} [opts.updateThrottleMs] - Minimum interval between
   *   same-state routine PATCHes per project (state CHANGES always go out).
   * @param {number} [opts.heartbeatIntervalMs] - Elapsed-time refresh PATCH
   *   interval. 0 disables; values below 10s fall back to the default
   *   (parity with the bash heartbeat's interval clamp).
   * @param {Function} [opts.resolveWebhookUrl] - Injection seam for tests;
   *   defaults to the env > 0600-credentials.json resolver.
   * @param {Function} [opts.sleepImpl] - Injection seam for tests (429/backoff
   *   waits); defaults to utils/sleep.
   * @param {Function} [opts.now] - Clock seam for tests; defaults to Date.now.
   */
  constructor({
    statePath = null,
    botName = 'Chroxy',
    colors = {},
    defaultColor = DEFAULT_PROJECT_COLOR,
    permissionColor = DEFAULT_PERMISSION_COLOR,
    errorColor = DEFAULT_ERROR_COLOR,
    updateThrottleMs = 15_000,
    heartbeatIntervalMs = 300_000,
    // Cached by default (#5427 review): isConfigured() is probed per
    // notification; the cache only re-reads credentials.json when its
    // mtime/size/mode or the env var changes.
    resolveWebhookUrl = cachedResolveDiscordWebhookUrl,
    sleepImpl = sleep,
    now = Date.now,
  } = {}) {
    super({ name: 'discord-webhook' })
    this._statePath = statePath || null
    this._botName = typeof botName === 'string' && botName.length > 0 ? botName.slice(0, 80) : 'Chroxy'
    this._colors = colors && typeof colors === 'object' && !Array.isArray(colors) ? colors : {}
    this._defaultColor = isValidColor(defaultColor) ? defaultColor : DEFAULT_PROJECT_COLOR
    this._permissionColor = isValidColor(permissionColor) ? permissionColor : DEFAULT_PERMISSION_COLOR
    this._errorColor = isValidColor(errorColor) ? errorColor : DEFAULT_ERROR_COLOR
    this._updateThrottleMs = Number.isFinite(updateThrottleMs) && updateThrottleMs >= 0 ? updateThrottleMs : 15_000
    if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs < 0) heartbeatIntervalMs = 300_000
    if (heartbeatIntervalMs > 0 && heartbeatIntervalMs < 10_000) heartbeatIntervalMs = 300_000
    this._heartbeatIntervalMs = heartbeatIntervalMs
    this._resolveWebhookUrl = resolveWebhookUrl
    this._sleep = sleepImpl
    this._now = now
    this._heartbeatTimer = null
    this._destroyed = false
  }

  /**
   * Sink contract: configured iff a syntactically valid webhook URL resolves
   * from the env or the 0600 credentials file. Off by default — no URL means
   * the registry never asks this sink to send (the epic's bloat guard).
   */
  isConfigured() {
    return this._configuredUrl() != null
  }

  /** Resolve + validate the webhook URL, or null. Never throws, never logs the URL. */
  _configuredUrl() {
    let resolved
    try {
      resolved = this._resolveWebhookUrl()
    } catch {
      return null
    }
    const url = resolved?.url
    return typeof url === 'string' && isValidDiscordWebhookUrl(url) ? url : null
  }

  /** Stop the heartbeat timer. Safe to call multiple times. */
  destroy() {
    this._destroyed = true
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }

  // -- State persistence (the /tmp → ~/.chroxy move) -----------------------

  _resolvedStatePath() {
    // Lazy like discord-credentials.credentialsFilePath so tests that mutate
    // HOME (and the sandbox guard) see the current home, not a frozen one.
    return this._statePath || join(homedir(), '.chroxy', 'discord-webhook-state.json')
  }

  /**
   * Load the status-message store fresh from disk. Read-per-send (the file
   * is tiny) so the supervisor's short-lived PushManager and the long-lived
   * server process converge on the same message ids instead of fighting
   * over cached copies.
   */
  _loadState() {
    try {
      const data = JSON.parse(readFileSync(this._resolvedStatePath(), 'utf-8'))
      if (data && typeof data === 'object' && data.projects && typeof data.projects === 'object') {
        return { version: 1, projects: data.projects }
      }
    } catch {
      // Missing or corrupt — start fresh; the next successful send rewrites it.
    }
    return { version: 1, projects: {} }
  }

  /** Atomic persist (temp+rename, 0600) — mirrors how push.js persists tokens. */
  _persistState(store) {
    try {
      const path = this._resolvedStatePath()
      mkdirSync(dirname(path), { recursive: true })
      writeFileRestricted(path, JSON.stringify(store))
    } catch (err) {
      // State-file failure must not fail delivery — worst case the next
      // event POSTs a duplicate status message instead of PATCHing.
      log.error(`Failed to persist Discord status state: ${err.message}`)
    }
  }

  // -- Project keying -------------------------------------------------------

  /**
   * One status message per project. Phase 2 derives the key from what the
   * pipeline notification carries (Phase 3 ingest events will carry an
   * explicit `project`). Sanitized the same way the bash original sanitized
   * project names so state keys stay filesystem/log safe.
   */
  _projectKey(notification) {
    const data = notification?.data || {}
    const raw = data.project || data.sessionName || data.sessionId || 'chroxy'
    const sanitized = String(raw).replace(/[^A-Za-z0-9._-]/g, '')
    return sanitized.length > 0 ? sanitized : 'unknown'
  }

  // -- Sink contract --------------------------------------------------------

  /**
   * Deliver one approved notification by updating (or re-posting) the
   * project's status embed. Resolves `false` ONLY on hard channel failure
   * (final non-2xx after retries, network throw) — per the sink contract the
   * #3870-style latch handling is the pipeline's job, not ours.
   *
   * The context evaluators are per-DEVICE hooks; a webhook has no device
   * identity, so they're evaluated once with `deviceId = null` — which the
   * prefs resolvers treat as "the global setting". A globally muted
   * category (or global quiet hours without a bypass) therefore silences
   * the Discord embed update too, matching the pipeline's intent. Missing
   * evaluators fail open per the contract.
   */
  async send(notification, context = {}) {
    const webhookUrl = this._configuredUrl()
    if (!webhookUrl) return true // unconfigured — registry normally skips us anyway

    const state = STATE_FOR_CATEGORY[notification?.category]
    if (!state) return true // unmapped category (parity: bash skipped unknown notification types)

    const now0 = context.now ?? this._now()
    const isCategoryEnabled = context.isCategoryEnabled ?? (() => true)
    const isInQuietHours = context.isInQuietHours ?? (() => false)
    const shouldBypassQuietHours = context.shouldBypassQuietHours ?? (() => false)
    if (!isCategoryEnabled(notification.category, null)) return true
    if (isInQuietHours(now0, null) && !shouldBypassQuietHours(notification.category, null)) return true

    const project = this._projectKey(notification)
    const now = this._now()
    const store = this._loadState()
    const prev = store.projects[project]

    const data = notification.data || {}
    const entry = {
      messageId: prev?.messageId ?? null,
      state,
      body: typeof notification.body === 'string' ? notification.body : '',
      detail: typeof data.detail === 'string' ? data.detail : (typeof data.tool === 'string' ? data.tool : null),
      sessionName: typeof data.sessionName === 'string' ? data.sessionName : (prev?.sessionName ?? null),
      // Phase 4 fills this from the hook event stream; until then callers
      // may pass a count and we surface it.
      subagents: Number.isFinite(data.subagents) ? data.subagents : (prev?.subagents ?? 0),
      firstSeenTs: prev?.firstSeenTs ?? now,
      lastUpdateTs: now,
      lastStateChangeTs: prev?.state === state ? (prev?.lastStateChangeTs ?? now) : now,
    }

    try {
      if (PING_STATES.has(state)) {
        // Parity: an embed already sitting in `idle` is NOT re-posted for
        // another idle event (`[ "$CURRENT_STATE" = "idle" ] && exit 0`) —
        // re-pinging "still ready" is noise. `permission` always re-posts:
        // each new approval request deserves a fresh ping.
        if (state === 'idle' && prev?.state === 'idle' && prev?.messageId) return true
        return await this._repost(webhookUrl, project, entry, store, prev?.messageId)
      }

      // Routine update. Same-state updates inside the throttle window are
      // suppressed; a state CHANGE always goes out (the bash throttle only
      // ever gated repeat activity updates, never transitions).
      if (
        prev?.state === state &&
        Number.isFinite(prev?.lastUpdateTs) &&
        now - prev.lastUpdateTs < this._updateThrottleMs
      ) {
        return true
      }
      return await this._patchOrPost(webhookUrl, project, entry, store)
    } catch (err) {
      log.error(`Discord status update failed for ${project}: ${err?.message || err}`)
      return false
    }
  }

  // -- Discord message operations -------------------------------------------

  _apiBase(webhookUrl) {
    const parts = extractWebhookIdToken(webhookUrl)
    // _configuredUrl() already validated the shape; belt-and-braces.
    if (!parts) throw new Error('webhook URL failed id/token extraction')
    return `https://discord.com/api/webhooks/${parts.id}/${parts.token}`
  }

  /** DELETE the old status message (best effort) + POST a fresh one → re-ping. */
  async _repost(webhookUrl, project, entry, store, oldMessageId) {
    const base = this._apiBase(webhookUrl)
    if (oldMessageId) {
      try {
        // Single attempt, failures ignored — parity with the bash `|| true`.
        // Worst case the old message lingers; the new POST still pings.
        await this._discordFetch(`${base}/messages/${oldMessageId}`, { method: 'DELETE' }, { retries: 1 })
      } catch {
        // best-effort
      }
      // Drop the id NOW, before the re-POST (#5427 review S2): if the POST
      // below hard-fails, a persisted {state:'idle', messageId:<deleted>}
      // would satisfy the idle→idle suppression and wedge the embed until
      // a state change or a heartbeat 404 (never, if heartbeat is off).
      // With the id cleared, the next event falls through to a fresh POST.
      if (store.projects[project]) {
        store.projects[project] = { ...store.projects[project], messageId: null }
        this._persistState(store)
      }
      entry.messageId = null
    }
    return await this._post(base, project, entry, store)
  }

  /** POST a new status message (?wait=true returns the created message). */
  async _post(base, project, entry, store) {
    const payload = this._buildPayload(project, entry)
    const res = await this._discordFetch(`${base}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      log.error(`Discord webhook POST failed for ${project} (HTTP ${res.status})`)
      return false
    }
    let messageId = null
    try {
      messageId = (await res.json())?.id ?? null
    } catch {
      // 204 / unparsable body — message likely posted but we can't track it;
      // treat as delivered, next event self-heals by POSTing fresh.
    }
    entry.messageId = messageId
    store.projects[project] = entry
    this._persistState(store)
    this._ensureHeartbeat()
    return true
  }

  /** PATCH the existing message; self-heal on 404 / missing id by POSTing. */
  async _patchOrPost(webhookUrl, project, entry, store) {
    const base = this._apiBase(webhookUrl)
    if (!entry.messageId) {
      return await this._post(base, project, entry, store)
    }
    const payload = this._buildPayload(project, entry)
    const res = await this._discordFetch(`${base}/messages/${entry.messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.status === 404) {
      // Message deleted externally — re-POST (parity with the bash self-heal).
      entry.messageId = null
      return await this._post(base, project, entry, store)
    }
    if (!res.ok) {
      log.error(`Discord webhook PATCH failed for ${project} (HTTP ${res.status})`)
      return false
    }
    store.projects[project] = entry
    this._persistState(store)
    this._ensureHeartbeat()
    return true
  }

  /**
   * Fetch with timeout + bounded retry, Discord flavor:
   *   - 429 → honour retry_after (JSON body seconds, or Retry-After header),
   *     capped at MAX_RETRY_AFTER_MS, then retry
   *   - 5xx / network error / timeout → exponential backoff retry
   *   - other 4xx → return immediately (not retryable)
   * Throws only when the LAST attempt threw (caller maps that to `false`).
   */
  async _discordFetch(url, options, { retries = MAX_RETRIES } = {}) {
    let res
    for (let attempt = 1; attempt <= retries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        res = await fetch(url, { ...options, signal: controller.signal })
      } catch (err) {
        clearTimeout(timer)
        if (attempt < retries) {
          await this._sleep(backoffDelay(attempt, BACKOFF_BASE_MS))
          continue
        }
        throw err
      }
      clearTimeout(timer)

      if (res.status === 429) {
        if (attempt < retries) {
          await this._sleep(await this._retryAfterMs(res))
          continue
        }
        return res
      }
      if (res.ok || (res.status >= 400 && res.status < 500)) return res
      // 5xx
      if (attempt < retries) {
        await this._sleep(backoffDelay(attempt, BACKOFF_BASE_MS))
        continue
      }
      return res
    }
    return res
  }

  /**
   * Extract the wait from a 429 response. Discord sends `retry_after` in
   * SECONDS (float) in the JSON body and a Retry-After header (also
   * seconds). Defaults to 2s when unparsable; clamped to MAX_RETRY_AFTER_MS.
   */
  async _retryAfterMs(res) {
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

  // -- Embed building --------------------------------------------------------

  _colorFor(project, state) {
    if (state === 'permission') return this._permissionColor
    if (state === 'error') return this._errorColor
    const override = this._colors[project]
    return isValidColor(override) ? override : this._defaultColor
  }

  _buildPayload(project, entry) {
    const titleFor = STATE_TITLES[entry.state] || STATE_TITLES.idle
    const fields = []
    if (entry.body) {
      fields.push({ name: 'Status', value: truncate(entry.body), inline: false })
    }
    if (entry.detail) {
      fields.push({ name: 'Detail', value: truncate(entry.detail), inline: false })
    }
    if (entry.sessionName) {
      fields.push({ name: 'Session', value: truncate(entry.sessionName, 100), inline: true })
    }
    if (Number.isFinite(entry.subagents) && entry.subagents > 0) {
      fields.push({ name: 'Subagents', value: String(entry.subagents), inline: true })
    }
    const elapsedSec = (this._now() - (entry.firstSeenTs || this._now())) / 1000
    return {
      username: this._botName,
      embeds: [{
        title: titleFor(project),
        color: this._colorFor(project, entry.state),
        fields,
        footer: { text: `${this._botName} · ${formatDuration(elapsedSec)}` },
        timestamp: new Date(this._now()).toISOString(),
      }],
    }
  }

  // -- Heartbeat (elapsed-time refresh) --------------------------------------

  /**
   * Start the heartbeat lazily after the first successful message write.
   * One unref'd interval per sink — it PATCHes every tracked embed so the
   * footer's elapsed time stays current (the epic's "keep — it's one
   * setInterval now" lean). Does nothing when unconfigured, never blocks
   * process exit, and destroy() stops it.
   */
  _ensureHeartbeat() {
    if (this._destroyed || this._heartbeatTimer || this._heartbeatIntervalMs === 0) return
    this._heartbeatTimer = setInterval(() => {
      this._heartbeatTick().catch((err) => {
        log.debug?.(`Discord heartbeat tick failed: ${err?.message || err}`)
      })
    }, this._heartbeatIntervalMs)
    this._heartbeatTimer.unref?.()
  }

  /** One heartbeat pass: refresh each tracked project's embed in place. */
  async _heartbeatTick() {
    const webhookUrl = this._configuredUrl()
    if (!webhookUrl) return
    const base = this._apiBase(webhookUrl)
    const store = this._loadState()
    let mutated = false
    for (const [project, entry] of Object.entries(store.projects)) {
      if (!entry?.messageId) continue
      try {
        const res = await this._discordFetch(`${base}/messages/${entry.messageId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this._buildPayload(project, entry)),
        })
        if (res.status === 404) {
          // Deleted externally — forget the id so the next real event POSTs.
          entry.messageId = null
          mutated = true
        }
      } catch {
        // Heartbeat is best-effort; the next real event takes the full path.
      }
    }
    if (mutated) this._persistState(store)
  }
}
