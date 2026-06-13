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
 *     each LIVE embed so the elapsed-time footer stays current — not a
 *     forked bash daemon with a PID file. Offline embeds are final and are
 *     skipped; entries untouched longer than `pruneAfterMs` are pruned from
 *     the state store at load time (#5429/#5434), keeping both the file and
 *     the heartbeat's per-tick work bounded to live projects.
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

// #5429/#5434: retention for state-store entries. Project keys fall back to
// session ids (and Phase 3 ingest accepts arbitrary project names), so
// without pruning the store grows one entry per key forever — and the
// heartbeat's per-tick work grows with it. Entries untouched for longer than
// this are dropped at load time; the Discord message itself is KEPT (an
// offline embed is a final record — only the tracking stops).
const DEFAULT_PRUNE_AFTER_MS = 86_400_000 // 24h
// #5457: sanity floor. A retention shorter than the gap between consecutive
// events prunes the entry (and its messageId) in between, so every event
// takes the no-`prev` path and POSTs a brand-new message — message-per-event
// spam instead of one embed PATCHed in place. Anything below updateThrottleMs
// is definitely pathological; 60s is the conservative line. 0 stays the
// documented disable (parity with the heartbeatIntervalMs 10s floor).
const MIN_PRUNE_AFTER_MS = 60_000 // 60s

// #5676: two-stage staleness watchdog for the heartbeat. A hook-based external
// session (chroxy-hooks) that dies WITHOUT emitting session_end — kill -9,
// crash, OOM, terminal closed, laptop sleep, daemon restart mid-session — never
// fires session_offline, so its `online` embed would stay "🟢 working" forever
// while the heartbeat keeps re-rendering it as alive. The internal session
// types emit `inactivity_warning` to cover this; the ingest hook path has no
// equivalent. The heartbeat therefore watches silence = now - lastUpdateTs (the
// last REAL event, NOT a heartbeat tick) and downgrades a quiet embed:
//   online → stale  after STALE_AFTER_MS of silence,
//   stale  → offline after OFFLINE_AFTER_MS of silence (final).
// idle/permission are spared — those are legitimately waiting on the human, not
// dead. A real event takes the normal update() path and restores the true
// state, resetting the silence clock automatically.
const DEFAULT_STALE_AFTER_MS = 10 * 60_000   // 10m
const DEFAULT_OFFLINE_AFTER_MS = 30 * 60_000 // 30m

// Embed sidebar color defaults — ported from claude-code-notify
// (colors.conf.example + the CLAUDE_NOTIFY_*_COLOR defaults).
const DEFAULT_PROJECT_COLOR = 5793266   // Discord blurple #5865F2
const DEFAULT_PERMISSION_COLOR = 16753920 // orange #FFA500
const DEFAULT_ERROR_COLOR = 15158332    // red #E74C3C
// #5413 Phase 3 — session lifecycle states (bash CLAUDE_NOTIFY_*_COLOR defaults)
const DEFAULT_ONLINE_COLOR = 3066993    // green #2ECC71
const DEFAULT_OFFLINE_COLOR = 15158332  // red #E74C3C
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
//   online     — session started / working (#5413 Phase 3 ingest). The bash
//                original's SessionStart: DELETE the previous message (incl.
//                a lingering offline one) + POST fresh; session_activity
//                events keep it fresh via routine PATCH.
//   offline    — session ended (bash SessionEnd: routine PATCH in place;
//                no-op when nothing is tracked or already offline)
const STATE_FOR_CATEGORY = {
  activity_update: 'idle',
  result: 'idle',
  permission: 'permission',
  activity_waiting: 'permission',
  activity_error: 'error',
  inactivity_warning: 'stale',
  session_online: 'online',
  session_offline: 'offline',
  session_activity: 'online',
}

// States that re-ping: DELETE the old message + POST a new one.
const PING_STATES = new Set(['idle', 'permission'])

const STATE_TITLES = {
  idle: (project) => `\u{1F980} ${project} — Ready for input`,
  permission: (project) => `\u{1F510} ${project} — Needs Approval`,
  error: (project) => `\u{2757} ${project} — Session Error`,
  stale: (project) => `\u{23F3} ${project} — Quiet for a while`,
  online: (project) => `\u{1F7E2} ${project} — Session Online`,
  offline: (project) => `\u{1F534} ${project} — Session Offline`,
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

/**
 * Escape Discord markdown metacharacters so free-text user/transcript content
 * (task descriptions, ScheduleWakeup reasons, session names) renders literally
 * in an embed field instead of being styled or swallowed (#5475).
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
function escapeMarkdown(text) {
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
function escapeAndCap(text, max = 1000) {
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
   * @param {number} [opts.pruneAfterMs] - Retention for state-store entries
   *   (#5429/#5434): entries whose lastUpdateTs is older than this are
   *   dropped at load time (the first load after init is the startup sweep).
   *   0 disables pruning; invalid values and values below 60s fall back to
   *   the 24h default (#5457 — a tiny retention prunes the messageId between
   *   events and turns the status embed into message-per-event spam).
   * @param {number} [opts.staleAfterMs] - #5676 watchdog: silence after which
   *   an `online` embed is downgraded to `stale` in a heartbeat tick. Injected
   *   small for tests; defaults to 10m.
   * @param {number} [opts.offlineAfterMs] - #5676 watchdog: silence after which
   *   a `stale` embed is downgraded to `offline` (final). Injected small for
   *   tests; defaults to 30m.
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
    pruneAfterMs = DEFAULT_PRUNE_AFTER_MS,
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    offlineAfterMs = DEFAULT_OFFLINE_AFTER_MS,
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
    if (!Number.isFinite(pruneAfterMs) || pruneAfterMs < 0) pruneAfterMs = DEFAULT_PRUNE_AFTER_MS
    if (pruneAfterMs > 0 && pruneAfterMs < MIN_PRUNE_AFTER_MS) pruneAfterMs = DEFAULT_PRUNE_AFTER_MS
    this._pruneAfterMs = pruneAfterMs
    // #5676 watchdog thresholds. Invalid values fall back to the defaults so a
    // bad config can never disable the dead-session guard.
    this._staleAfterMs = Number.isFinite(staleAfterMs) && staleAfterMs >= 0 ? staleAfterMs : DEFAULT_STALE_AFTER_MS
    this._offlineAfterMs = Number.isFinite(offlineAfterMs) && offlineAfterMs >= 0 ? offlineAfterMs : DEFAULT_OFFLINE_AFTER_MS
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
    let store = { version: 1, projects: {} }
    try {
      const data = JSON.parse(readFileSync(this._resolvedStatePath(), 'utf-8'))
      // Arrays are rejected too: `typeof [] === 'object'`, but string-keyed
      // entries assigned onto an array are silently dropped by
      // JSON.stringify, so a corrupt `projects: []` would wedge tracking
      // (every persist loses the messageId) — fall back to a fresh map.
      if (data && typeof data === 'object' && data.projects && typeof data.projects === 'object' && !Array.isArray(data.projects)) {
        store = { version: 1, projects: data.projects }
      }
    } catch {
      // Missing or corrupt — start fresh; the next successful send rewrites it.
    }
    // #5429/#5434: retention sweep on every load — the first load after init
    // doubles as the startup sweep, and every send/heartbeat afterwards keeps
    // the store (and the heartbeat's per-tick work) bounded to live projects.
    // Persisting here reuses the atomic 0600 path, so the pruned file is
    // durable even when the caller's own persist never fires (throttled
    // sends, no-op heartbeat ticks).
    if (this._pruneStale(store)) this._persistState(store)
    return store
  }

  /**
   * Drop entries untouched for longer than the retention (and entries with
   * no usable lastUpdateTs — corrupt slots must not accumulate forever).
   * The Discord message is deliberately NOT deleted: a pruned entry's last
   * embed (typically a final offline one) stays in the channel as a record;
   * chroxy just stops tracking and refreshing it. Returns true when the
   * store was mutated. Disabled when pruneAfterMs is 0.
   */
  _pruneStale(store) {
    if (this._pruneAfterMs === 0) return false
    const now = this._now()
    let pruned = false
    for (const [project, entry] of Object.entries(store.projects)) {
      const last = entry?.lastUpdateTs
      if (!Number.isFinite(last) || now - last > this._pruneAfterMs) {
        delete store.projects[project]
        pruned = true
      }
    }
    return pruned
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
      // #5413 Phase 3 — session lifecycle (bash SessionStart/SessionEnd port).
      if (notification.category === 'session_online') {
        // Clean slate: DELETE whatever message lingers (typically the
        // previous session's offline embed) + POST fresh, resetting the
        // elapsed-time epoch and the subagent count — parity with the bash
        // SessionStart's delete-old-message + clear_status_files.
        entry.firstSeenTs = now
        entry.lastStateChangeTs = now
        entry.subagents = Number.isFinite(data.subagents) ? data.subagents : 0
        return await this._repost(webhookUrl, project, entry, store, prev?.messageId)
      }
      if (state === 'offline') {
        // SessionEnd PATCHes in place — and only when there is something to
        // mark offline (bash: skip when state is empty or already offline).
        // #5439 GAP D: if the tracked message was deleted externally, do NOT
        // POST a fresh offline embed (bash no_post_on_404) — just drop the id.
        if (!prev?.messageId || prev.state === 'offline') return true
        return await this._patchOrPost(webhookUrl, project, entry, store, { noPostOn404: true })
      }

      // #5439 GAP C — subagent/idle interplay (port of claude-notify.sh
      // :528-539 and :383-384), rescoped by #5541 turn edges.
      //
      // The bash rule held the idle/permission embed while subagents ran on
      // the assumption "idle + subagents = the user is still being waited on".
      // That assumption is only correct BETWEEN turns: while a turn is in
      // flight (UserPromptSubmit seen, no Stop yet) the MAIN agent is busy,
      // and SubagentStart usually means it's actively working — so holding
      // idle is wrong and the count→0 re-ping ("Ready for input") would
      // falsely interrupt a turn the agent is still synthesizing.
      //
      // `turnInFlight` (server-side TurnTracker, #5541) is the per-project
      // gate. It defaults to false — a missing flag (old pipeline, or the
      // daemon restarting and losing its in-memory turn state) keeps today's
      // GAP C behavior, which is the safe fallback.
      //
      //   turn in flight → online-mapped events flip idle→online normally;
      //                    when subagents > 0 the Status line reads
      //                    "Working — N subagents" (or the lone subagent's
      //                    agentType when count is 1). No count→0 re-ping.
      //   no turn        → the original hold-idle / count→0-reping behavior:
      //                    keep the waiting state and text, refresh only the
      //                    live fields; re-ping 🦀 "Ready for input" when the
      //                    LAST subagent finishes while idle. Permission +
      //                    count→0 falls through to online (row-20 diff).
      //   The turnInFlight rescope applies ONLY to the `idle` hold. A
      //   `permission` embed is an approval request the user must act on, and
      //   permission prompts fire MID-turn (an agent hits a tool-approval gate
      //   while working) — so turnInFlight is true with subagents running. If
      //   the flip-to-online branch fired here it would hide the approval. The
      //   `permission` hold therefore keeps its original pre-#5541 behavior
      //   UNCONDITIONALLY: while subagents > 0 the permission state/text is
      //   held (live fields refreshed); count→0 falls through to online (the
      //   intentional row-20 "approval cleared by next activity" diff).
      const turnInFlight = data.turnInFlight === true
      if (state === 'online' && turnInFlight && entry.subagents > 0 && prev?.state !== 'permission') {
        // Mid-turn with live subagents (and NOT a permission prompt): surface
        // the work in the online embed (Status line) instead of holding idle.
        // (Plain online with no subagents falls through to the routine path
        // below, flipping to "Session Online".)
        entry.body = this._workingDetail(entry.subagents, data.agentType)
      } else if (
        state === 'online' &&
        prev?.messageId &&
        ((prev.state === 'idle' && !turnInFlight) || prev.state === 'permission')
      ) {
        const allDone = entry.subagents === 0 && Number.isFinite(prev.subagents) && prev.subagents > 0
        if (entry.subagents > 0 || (allDone && prev.state === 'idle')) {
          entry.state = prev.state
          if (typeof prev.body === 'string' && prev.body.length > 0) entry.body = prev.body
          entry.detail = prev.detail ?? entry.detail
          entry.lastStateChangeTs = prev.lastStateChangeTs ?? now
          if (allDone) {
            return await this._repost(webhookUrl, project, entry, store, prev.messageId)
          }
          if (Number.isFinite(prev.lastUpdateTs) && now - prev.lastUpdateTs < this._updateThrottleMs) {
            return true
          }
          return await this._patchOrPost(webhookUrl, project, entry, store)
        }
      }

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

  /**
   * PATCH the existing message; self-heal on 404 / missing id by POSTing.
   * `noPostOn404` (#5439 GAP D, port of bash no_post_on_404) suppresses the
   * healing POST — used by the offline path, where re-creating a message
   * that was deleted externally would just leave an orphan offline embed.
   */
  async _patchOrPost(webhookUrl, project, entry, store, { noPostOn404 = false } = {}) {
    const base = this._apiBase(webhookUrl)
    if (!entry.messageId) {
      if (noPostOn404) return true
      return await this._post(base, project, entry, store)
    }
    const payload = this._buildPayload(project, entry)
    const res = await this._discordFetch(`${base}/messages/${entry.messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.status === 404) {
      // Message deleted externally — re-POST (parity with the bash self-heal)
      // unless suppressed: then just drop the id so the next session POSTs.
      entry.messageId = null
      if (noPostOn404) {
        store.projects[project] = entry
        this._persistState(store)
        return true
      }
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
    if (state === 'online') return DEFAULT_ONLINE_COLOR
    if (state === 'offline') return DEFAULT_OFFLINE_COLOR
    const override = this._colors[project]
    return isValidColor(override) ? override : this._defaultColor
  }

  /**
   * #5541: the "Working — …" Status line shown on the online embed while a
   * turn is in flight with live subagents. Names the single subagent's
   * agentType when count is 1 and one is available; otherwise a count
   * ("Working — 2 subagents", singular for 1).
   */
  _workingDetail(subagents, agentType) {
    if (subagents === 1 && typeof agentType === 'string' && agentType.length > 0) {
      return `Working — ${agentType}`
    }
    return `Working — ${subagents} subagent${subagents === 1 ? '' : 's'}`
  }

  _buildPayload(project, entry) {
    const titleFor = STATE_TITLES[entry.state] || STATE_TITLES.idle
    const fields = []
    // Free-text user/transcript fields (#5475): escape markdown so a body like
    // `watch dist/*_test.js` renders literally. escapeAndCap truncates first,
    // escapes, then clamps the FINAL escaped string so it can't blow past
    // Discord's 1024-char field limit (see escapeAndCap).
    if (entry.body) {
      fields.push({ name: 'Status', value: escapeAndCap(entry.body), inline: false })
    }
    if (entry.detail) {
      fields.push({ name: 'Detail', value: escapeAndCap(entry.detail), inline: false })
    }
    if (entry.sessionName) {
      fields.push({ name: 'Session', value: escapeAndCap(entry.sessionName, 100), inline: true })
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

  /**
   * One heartbeat pass: refresh each LIVE project's embed in place, and run the
   * #5676 staleness watchdog so a dead external session doesn't sit "🟢 online"
   * forever.
   *
   * Offline entries are skipped (#5434) — the offline embed is final, and
   * re-PATCHing it would both keep its elapsed-time footer counting up forever
   * and spend a Discord call per dead project per tick. Entries pruned by
   * retention never even reach the loop: _loadState drops them.
   *
   * Watchdog (before the routine footer PATCH), measuring silence against
   * `lastUpdateTs` — the last REAL event time, which the heartbeat NEVER writes,
   * so repeated ticks let the clock keep climbing until it trips:
   *   - `online` silent > staleAfterMs   → downgrade to `stale`
   *   - `stale`  silent > offlineAfterMs → downgrade to `offline` (final)
   * `idle` and `permission` are spared — they are legitimately waiting on the
   * human, not dead. A downgraded state is rebuilt into the PATCH payload so the
   * embed shows the new title/color. A real event (update()) restores the true
   * state and resets `lastUpdateTs`, so recovery is automatic.
   */
  async _heartbeatTick() {
    const webhookUrl = this._configuredUrl()
    if (!webhookUrl) return
    const base = this._apiBase(webhookUrl)
    const store = this._loadState()
    const now = this._now()
    let mutated = false
    for (const [project, entry] of Object.entries(store.projects)) {
      if (!entry?.messageId || entry.state === 'offline') continue

      // #5676: staleness downgrade. Only `online`/`stale` decay; idle/permission
      // are left to their normal footer refresh. silence reads lastUpdateTs (the
      // last real event), which the heartbeat does not bump — so a long-silent
      // entry eventually trips even with ticks firing in between.
      const last = entry.lastUpdateTs
      const silence = Number.isFinite(last) ? now - last : Infinity
      if (entry.state === 'online' && silence > this._staleAfterMs) {
        entry.state = 'stale'
        entry.lastStateChangeTs = now
        mutated = true
      } else if (entry.state === 'stale' && silence > this._offlineAfterMs) {
        entry.state = 'offline'
        entry.lastStateChangeTs = now
        mutated = true
      }

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
