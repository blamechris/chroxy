/**
 * DiscordCiSink — one fresh Discord message per CI run (#7428).
 *
 * #7424/#7426 added the `ci_complete` push category (a CI run settling on the
 * pull request a session opened) and wired the Expo sink to deliver it. The
 * per-project status sink (`discord-webhook-sink.js`) does not: `ci_complete`
 * has no entry in its `STATE_FOR_CATEGORY` map, so its `send()` returns
 * `true` — a silent no-op indistinguishable from delivery (#7428's original
 * bug report). CI completion is not a session-lifecycle state; folding it
 * into the status embed would repaint whatever the session's actual state is
 * (idle/online/...) with a CI verdict from a run that may have settled long
 * after the session moved on to something else.
 *
 * Decided (#7428, option 2 — Chris, 2026-09-28): **one Discord message per CI
 * run**, always a fresh POST, never an edit. Unlike `discord-billing-sink.js`
 * (its precedent for "an event that is not a session state" — one tracked
 * global message, re-pinged on change) this sink keeps NO state file at all:
 * two `ci_complete` events for the same PR (a re-push settling a second time)
 * are two distinct completions and get two distinct messages. Editing the
 * first message in place would erase the fact that a second run happened.
 *
 * The embed only ever uses fields the `ci_complete` payload
 * (`ciCompletionPush` in session-ci-watcher.js) actually carries today: the
 * PR number and link (`data.prNumber` / `data.prUrl`), a ✅/❌ conclusion
 * (`data.verdict`), and the human-readable title/body chroxy already built
 * (`describeCiCompletion` — check counts, merge state, and the PR title as a
 * trailing " — <title>" clause). That payload carries no duration/timing
 * field at all yet, so a duration is rendered only when the notification
 * happens to carry a numeric `data.durationSeconds` — never fabricated — and
 * omitted otherwise (see `_buildPayload`).
 *
 * A PR title is GitHub-authored free text, so it goes through the same
 * markdown escaping (`escapeAndCap`) every other Discord sink applies to
 * user/transcript content (#5475), plus mention neutralization
 * (`neutralizeMentions`, discord-webhook-client.js) so an `@everyone` /
 * `@here` / role-or-user mention in a PR title can't read as a live ping.
 */

import { createLogger } from '../logger.js'
import { sleep } from '../utils/sleep.js'
import { NotificationSink } from './sink.js'
import {
  cachedResolveDiscordWebhookUrl,
  isValidDiscordWebhookUrl,
} from '../discord-credentials.js'
import {
  DEFAULT_PROJECT_COLOR,
  DEFAULT_ERROR_COLOR,
  DEFAULT_ONLINE_COLOR,
  DEFAULT_ALLOWED_MENTIONS,
  MAX_EMBED_TITLE_CHARS,
  isValidColor,
  escapeAndCap,
  neutralizeMentions,
  formatDuration,
  apiBase,
  fetchWithDiscordRetry,
} from './discord-webhook-client.js'

const log = createLogger('discord')

const CI_CATEGORY = 'ci_complete'

export class DiscordCiSink extends NotificationSink {
  /**
   * @param {object} [opts]
   * @param {string} [opts.botName] - Webhook display name + footer label.
   * @param {boolean} [opts.ciAlerts] - Kill-switch
   *   (notifications.discord.ciAlerts). Default ON when a webhook resolves;
   *   set false to keep CI-completion notices off Discord while the status
   *   sink / billing sink stay on.
   * @param {number} [opts.successColor] - Sidebar color for a passing run
   *   (default: green, same as the status sink's online color).
   * @param {number} [opts.failureColor] - Sidebar color for a failing run
   *   (default: red).
   * @param {number} [opts.unknownColor] - Sidebar color for a verdict this
   *   daemon does not recognise (default: blurple — neutral, not a false
   *   "passed" or "failed").
   * @param {Function} [opts.resolveWebhookUrl] - Injection seam for tests;
   *   defaults to the env > 0600-credentials.json resolver.
   * @param {Function} [opts.sleepImpl] - Injection seam for tests (429/backoff waits).
   * @param {Function} [opts.now] - Clock seam for tests; defaults to Date.now.
   */
  constructor({
    botName = 'Chroxy',
    ciAlerts = true,
    successColor = DEFAULT_ONLINE_COLOR,
    failureColor = DEFAULT_ERROR_COLOR,
    unknownColor = DEFAULT_PROJECT_COLOR,
    resolveWebhookUrl = cachedResolveDiscordWebhookUrl,
    sleepImpl = sleep,
    now = Date.now,
  } = {}) {
    super({ name: 'discord-ci' })
    this._botName = typeof botName === 'string' && botName.length > 0 ? botName.slice(0, 80) : 'Chroxy'
    this._enabled = ciAlerts !== false
    this._successColor = isValidColor(successColor) ? successColor : DEFAULT_ONLINE_COLOR
    this._failureColor = isValidColor(failureColor) ? failureColor : DEFAULT_ERROR_COLOR
    this._unknownColor = isValidColor(unknownColor) ? unknownColor : DEFAULT_PROJECT_COLOR
    this._resolveWebhookUrl = resolveWebhookUrl
    this._sleep = sleepImpl
    this._now = now
  }

  /**
   * Sink contract: configured iff CI alerts are enabled AND a syntactically
   * valid webhook URL resolves. Off when either is missing — the registry
   * then never asks this sink to send.
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

  // -- Sink contract --------------------------------------------------------

  /**
   * Deliver one `ci_complete` notification as a brand-new Discord message.
   * Only the `ci_complete` category is handled; everything else is skipped so
   * the status sink keeps sole ownership of session-lifecycle events (the
   * same "not ours" no-op the billing sink applies to non-billing
   * categories).
   *
   * Resolves `false` ONLY on a hard channel failure (final non-2xx, network
   * throw), per the sink contract. The per-DEVICE context evaluators are run
   * once with `deviceId = null` (a webhook has no device identity), matching
   * the other two Discord sinks.
   */
  async send(notification, context = {}) {
    if (notification?.category !== CI_CATEGORY) return true // not ours — skip

    const webhookUrl = this._configuredUrl()
    if (!webhookUrl || !this._enabled) return true // unconfigured — registry normally skips us anyway

    const now0 = context.now ?? this._now()
    const isCategoryEnabled = context.isCategoryEnabled ?? (() => true)
    const isInQuietHours = context.isInQuietHours ?? (() => false)
    const shouldBypassQuietHours = context.shouldBypassQuietHours ?? (() => false)
    if (!isCategoryEnabled(CI_CATEGORY, null)) return true
    if (isInQuietHours(now0, null) && !shouldBypassQuietHours(CI_CATEGORY, null)) return true

    try {
      const payload = this._buildPayload(notification)
      const res = await this._discordFetch(`${apiBase(webhookUrl)}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        log.error(`Discord CI-completion POST failed (HTTP ${res.status})`)
        return false
      }
      return true
    } catch (err) {
      log.error(`Discord CI-completion alert failed: ${err?.message || err}`)
      return false
    }
  }

  /** Delegate to the shared client's fetch policy, passing the injected sleep seam. */
  async _discordFetch(url, options) {
    return fetchWithDiscordRetry(url, options, { sleepImpl: this._sleep })
  }

  // -- Embed building ---------------------------------------------------------

  /**
   * Build the one-shot embed from whatever the `ci_complete` payload actually
   * carries. Every field is read defensively (wrong type / missing → treated
   * as absent) since a notification object is, in the end, caller-supplied
   * data, not a trusted internal type.
   */
  _buildPayload(notification) {
    const data = notification?.data && typeof notification.data === 'object' && !Array.isArray(notification.data)
      ? notification.data
      : {}
    const verdict = typeof data.verdict === 'string' ? data.verdict : null
    const prNumber = Number.isInteger(data.prNumber) ? data.prNumber : null
    const prUrl = typeof data.prUrl === 'string' && data.prUrl.length > 0 ? data.prUrl : null
    // The producer (session-ci-watcher.js ciCompletionPush) carries no timing
    // field today — render gracefully rather than assume that never changes.
    const durationSeconds = Number.isFinite(data.durationSeconds) ? data.durationSeconds : null

    const emoji = verdict === 'failure' ? '\u{274C}' : verdict === 'success' ? '\u{2705}' : '\u{2753}'
    const color = verdict === 'failure' ? this._failureColor : verdict === 'success' ? this._successColor : this._unknownColor

    // `notification.title` (describeCiCompletion) already reads "CI passed on
    // #1234" / "CI failed on #1234" / "CI finished on #1234 with unrecognised
    // checks" — chroxy-authored, but still sanitized defensively since a
    // notification object is caller-supplied. Missing/malformed → fall back
    // to a title built from the one field we know is safe (an integer).
    const rawTitle = typeof notification?.title === 'string' && notification.title.length > 0
      ? notification.title
      : (prNumber != null ? `CI finished on #${prNumber}` : 'CI finished')
    const title = escapeAndCap(neutralizeMentions(`${emoji} ${rawTitle}`), MAX_EMBED_TITLE_CHARS)

    // `notification.body` carries the check-count summary plus, when GitHub
    // reports one, a trailing " — <PR title>" clause (describeCiCompletion) —
    // the one place the actual (GitHub-authored) PR title text shows up.
    const description = typeof notification?.body === 'string' && notification.body.length > 0
      ? escapeAndCap(neutralizeMentions(notification.body))
      : undefined

    const fields = []
    if (durationSeconds != null) {
      fields.push({ name: 'Duration', value: formatDuration(durationSeconds), inline: true })
    }

    const embed = {
      title,
      color,
      fields,
      footer: { text: this._botName },
      timestamp: new Date(this._now()).toISOString(),
    }
    if (description) embed.description = description
    // Makes the embed title a clickable link to the PR — the "link" the
    // decision comment asks for — without inventing a separate field for it.
    if (prUrl) embed.url = prUrl

    return {
      username: this._botName,
      embeds: [embed],
      // Server-side backstop for neutralizeMentions() (#8105: now the shared
      // default every Discord sink sets — see DEFAULT_ALLOWED_MENTIONS):
      // Discord itself parses no mentions from this message, so nothing in a
      // GitHub-authored PR title can ping anyone even if a mention form slips
      // past the text transform.
      allowed_mentions: DEFAULT_ALLOWED_MENTIONS,
    }
  }
}
