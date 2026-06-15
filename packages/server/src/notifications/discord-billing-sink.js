/**
 * DiscordBillingSink — daemon-global billing-alert message for Discord (#5828).
 *
 * The billing canary (doctor-billing.js / billing-canary-monitor.js) is about
 * the DAEMON's billing posture — a silently-metered default provider, a
 * datacenter egress ban-signal, a claude-tui session reclassified to metered
 * credits. That is NOT a per-session lifecycle state, so it must NOT go through
 * DiscordWebhookSink's per-project status state machine (idle/online/offline/…):
 * a billing warning has no project, and routing it there would clobber a live
 * session's status embed.
 *
 * This sink is therefore a separate, self-contained delivery channel that keeps
 * ONE global "billing alert" message, independent of any session:
 *
 *   - a new / changed non-empty warning set → DELETE the old message + POST a
 *     new one (re-ping, so Discord re-notifies and the alert surfaces at the
 *     bottom of the channel)
 *   - the same warning set again → no-op (dedup; the monitor already fires once
 *     per distinct set, this is defense-in-depth against a double fan-out from a
 *     supervisor + server both running a PushManager)
 *   - all-clear (`data.resolved`) → PATCH the message to a green "resolved"
 *     embed so the channel reflects the cleared state in place
 *
 * It plugs into the same SinkRegistry fan-out as the other sinks, so it inherits
 * PushManager's shared gating (the `billing_warning` category prefs, quiet
 * hours, rate limit) for free — no pipeline change. It only ever handles the
 * `billing_warning` category; every other notification is skipped, so it never
 * double-handles a session event the status sink owns.
 *
 * State (one global message, NOT per-project) lives in its own tiny JSON file
 * under ~/.chroxy/, read fresh per send so a supervisor's short-lived
 * PushManager and the long-lived server converge on the same message id rather
 * than fighting over a cached copy — the same convergence trick the status sink
 * uses. The webhook URL is a SECRET, sourced from the env / 0600
 * credentials.json via discord-credentials.js, never from config.json, never
 * logged.
 */

import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileRestricted } from '../platform.js'
import { createLogger } from '../logger.js'
import { sleep } from '../utils/sleep.js'
import { NotificationSink } from './sink.js'
import {
  cachedResolveDiscordWebhookUrl,
  isValidDiscordWebhookUrl,
} from '../discord-credentials.js'
import {
  DEFAULT_ERROR_COLOR,
  DEFAULT_ONLINE_COLOR,
  isValidColor,
  escapeAndCap,
  apiBase,
  fetchWithDiscordRetry,
} from './discord-webhook-client.js'

const log = createLogger('discord')

const BILLING_CATEGORY = 'billing_warning'

export class DiscordBillingSink extends NotificationSink {
  /**
   * @param {object} [opts]
   * @param {string} [opts.statePath] - Billing-message state file. Defaults to
   *   ~/.chroxy/discord-billing-state.json (resolved lazily so tests that mutate
   *   HOME, and the test sandbox guard, behave). Tests MUST inject a temp path.
   * @param {string} [opts.botName] - Webhook display name + footer label.
   * @param {boolean} [opts.billingAlerts] - Kill-switch
   *   (notifications.discord.billingAlerts). Default ON when a webhook resolves;
   *   set false to keep billing alerts off Discord while the status sink stays on.
   * @param {number} [opts.alertColor] - Sidebar color for an active alert
   *   (default: red).
   * @param {number} [opts.resolvedColor] - Sidebar color for the cleared embed
   *   (default: green).
   * @param {Function} [opts.resolveWebhookUrl] - Injection seam for tests;
   *   defaults to the env > 0600-credentials.json resolver.
   * @param {Function} [opts.sleepImpl] - Injection seam for tests (429/backoff waits).
   * @param {Function} [opts.now] - Clock seam for tests; defaults to Date.now.
   */
  constructor({
    statePath = null,
    botName = 'Chroxy',
    billingAlerts = true,
    alertColor = DEFAULT_ERROR_COLOR,
    resolvedColor = DEFAULT_ONLINE_COLOR,
    resolveWebhookUrl = cachedResolveDiscordWebhookUrl,
    sleepImpl = sleep,
    now = Date.now,
  } = {}) {
    super({ name: 'discord-billing' })
    this._statePath = statePath || null
    this._botName = typeof botName === 'string' && botName.length > 0 ? botName.slice(0, 80) : 'Chroxy'
    this._enabled = billingAlerts !== false
    this._alertColor = isValidColor(alertColor) ? alertColor : DEFAULT_ERROR_COLOR
    this._resolvedColor = isValidColor(resolvedColor) ? resolvedColor : DEFAULT_ONLINE_COLOR
    this._resolveWebhookUrl = resolveWebhookUrl
    this._sleep = sleepImpl
    this._now = now
  }

  /**
   * Sink contract: configured iff billing alerts are enabled AND a syntactically
   * valid webhook URL resolves. Off when either is missing — the registry then
   * never asks this sink to send.
   */
  isConfigured() {
    return this._enabled && this._configuredUrl() != null
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

  // -- State persistence ----------------------------------------------------

  _resolvedStatePath() {
    return this._statePath || join(homedir(), '.chroxy', 'discord-billing-state.json')
  }

  /** Load the single-message store fresh from disk (read-per-send). */
  _loadState() {
    try {
      const data = JSON.parse(readFileSync(this._resolvedStatePath(), 'utf-8'))
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return {
          messageId: typeof data.messageId === 'string' ? data.messageId : null,
          warnSignature: typeof data.warnSignature === 'string' ? data.warnSignature : null,
          firstSeenTs: Number.isFinite(data.firstSeenTs) ? data.firstSeenTs : null,
        }
      }
    } catch {
      // Missing or corrupt — start fresh; the next successful send rewrites it.
    }
    return { messageId: null, warnSignature: null, firstSeenTs: null }
  }

  /** Atomic persist (temp+rename, 0600) — mirrors how push.js persists tokens. */
  _persistState(state) {
    try {
      const path = this._resolvedStatePath()
      mkdirSync(dirname(path), { recursive: true })
      writeFileRestricted(path, JSON.stringify({ version: 1, ...state }))
    } catch (err) {
      // State-file failure must not fail delivery — worst case the next event
      // POSTs a duplicate alert message instead of PATCHing.
      log.error(`Failed to persist Discord billing state: ${err.message}`)
    }
  }

  /**
   * Stable signature of a warning set, used to dedup repeat fan-outs of the
   * same alert. Includes the codes AND the message body so a same-code meaning
   * change (a new egress IP, a different metered provider) re-pings — mirrors
   * the billing-canary monitor's own notify change-detection.
   */
  _signature(codes, body) {
    const codePart = Array.isArray(codes)
      ? codes.filter((c) => typeof c === 'string').slice().sort().join(',')
      : ''
    return `${codePart}|${typeof body === 'string' ? body : ''}`
  }

  // -- Sink contract --------------------------------------------------------

  /**
   * Deliver a billing alert (or its all-clear). Only the `billing_warning`
   * category is handled; everything else is skipped so the status sink keeps
   * sole ownership of session lifecycle events.
   *
   * Resolves `false` ONLY on a hard channel failure (final non-2xx, network
   * throw), per the sink contract. The per-DEVICE context evaluators are run
   * once with `deviceId = null` (a webhook has no device identity), matching how
   * the status sink applies the global mute / quiet-hours setting.
   */
  async send(notification, context = {}) {
    if (notification?.category !== BILLING_CATEGORY) return true // not ours — skip

    const webhookUrl = this._configuredUrl()
    if (!webhookUrl || !this._enabled) return true // unconfigured — registry normally skips us anyway

    const now0 = context.now ?? this._now()
    const isCategoryEnabled = context.isCategoryEnabled ?? (() => true)
    const isInQuietHours = context.isInQuietHours ?? (() => false)
    const shouldBypassQuietHours = context.shouldBypassQuietHours ?? (() => false)
    if (!isCategoryEnabled(BILLING_CATEGORY, null)) return true
    if (isInQuietHours(now0, null) && !shouldBypassQuietHours(BILLING_CATEGORY, null)) return true

    const data = notification.data || {}
    const resolved = data.resolved === true
    const state = this._loadState()

    try {
      if (resolved) {
        // All-clear. Nothing tracked → nothing to repaint.
        if (!state.messageId) return true
        return await this._patchResolved(webhookUrl, notification, state)
      }

      const signature = this._signature(data.codes, notification.body)
      // Same alert already showing → no-op (dedup against a double fan-out).
      if (state.messageId && state.warnSignature === signature) return true
      // New / changed alert → re-ping (delete old + POST new).
      return await this._repost(webhookUrl, notification, state, signature)
    } catch (err) {
      log.error(`Discord billing alert failed: ${err?.message || err}`)
      return false
    }
  }

  // -- Discord message operations -------------------------------------------

  /** DELETE the old alert (best effort) + POST a fresh one → re-ping. */
  async _repost(webhookUrl, notification, state, signature) {
    const base = apiBase(webhookUrl)
    if (state.messageId) {
      try {
        await this._discordFetch(`${base}/messages/${state.messageId}`, { method: 'DELETE' }, { retries: 1 })
      } catch {
        // best-effort — worst case the old message lingers; the POST still pings.
      }
    }
    const now = this._now()
    const payload = this._buildPayload(notification, { resolved: false })
    const res = await this._discordFetch(`${base}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      log.error(`Discord billing POST failed (HTTP ${res.status})`)
      return false
    }
    let messageId = null
    try {
      messageId = (await res.json())?.id ?? null
    } catch {
      // 204 / unparsable — posted but untrackable; next event self-heals.
    }
    this._persistState({ messageId, warnSignature: signature, firstSeenTs: now })
    return true
  }

  /** PATCH the tracked alert to a green "resolved" embed. */
  async _patchResolved(webhookUrl, notification, state) {
    const base = apiBase(webhookUrl)
    const payload = this._buildPayload(notification, { resolved: true })
    const res = await this._discordFetch(`${base}/messages/${state.messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.status === 404) {
      // Message deleted externally — forget it so the next alert POSTs fresh.
      // No healing POST: re-creating a message just to mark it resolved would
      // leave an orphan green embed for an alert nobody saw.
      this._persistState({ messageId: null, warnSignature: null, firstSeenTs: null })
      return true
    }
    if (!res.ok) {
      log.error(`Discord billing PATCH failed (HTTP ${res.status})`)
      return false
    }
    // Clear the signature so the next warning (even an identical one) re-pings.
    this._persistState({ messageId: state.messageId, warnSignature: null, firstSeenTs: null })
    return true
  }

  /** Delegate to the shared client's fetch policy, passing the injected sleep seam. */
  async _discordFetch(url, options, opts = {}) {
    return fetchWithDiscordRetry(url, options, { sleepImpl: this._sleep, ...opts })
  }

  // -- Embed building --------------------------------------------------------

  _buildPayload(notification, { resolved }) {
    const body = typeof notification.body === 'string' ? notification.body : ''
    const codes = Array.isArray(notification?.data?.codes)
      ? notification.data.codes.filter((c) => typeof c === 'string')
      : []
    const fields = []
    if (body) {
      fields.push({ name: resolved ? 'Resolved' : 'Warnings', value: escapeAndCap(body), inline: false })
    }
    if (!resolved && codes.length > 0) {
      fields.push({ name: 'Codes', value: escapeAndCap(codes.join(', '), 200), inline: false })
    }
    const title = resolved
      ? `\u{2705} ${this._botName} — Billing alerts cleared`
      : codes.length > 1
        ? `\u{26A0}\u{FE0F} ${this._botName} — Billing alert (${codes.length})`
        : `\u{26A0}\u{FE0F} ${this._botName} — Billing alert`
    return {
      username: this._botName,
      embeds: [{
        title,
        color: resolved ? this._resolvedColor : this._alertColor,
        fields,
        footer: { text: this._botName },
        timestamp: new Date(this._now()).toISOString(),
      }],
    }
  }
}
