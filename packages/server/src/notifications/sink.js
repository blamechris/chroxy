/**
 * NotificationSink — the delivery-channel contract for chroxy notifications
 * (#5413 Phase 1).
 *
 * The notification pipeline is layered:
 *
 *   session events → category mapping (PushNotificationHandler)
 *     → prefs + rate limiting (PushManager — shared, sink-agnostic)
 *       → fan out to every configured sink (SinkRegistry)
 *         → channel-specific delivery (ExpoPushSink today,
 *           DiscordWebhookSink in #5413 Phase 2, ...)
 *
 * A sink is ONLY the last hop: it takes an already-approved notification and
 * delivers it over one channel. Category enable/disable, quiet hours, and the
 * per-category rate limits all happen upstream in PushManager so every sink
 * gets identical gating for free. The one exception is per-DEVICE prefs:
 * those are keyed by device identifiers only the sink knows about (Expo push
 * tokens), so the pipeline passes evaluator callbacks down via `context` and
 * the sink applies them to its own device list.
 *
 * Contract:
 *
 * - `name` — stable, unique, human-readable identifier (e.g. 'expo-push').
 *   Used in logs and (later) per-sink enable/disable config.
 *
 * - `isConfigured()` — synchronous, cheap, side-effect free. `true` when the
 *   sink currently has somewhere to deliver to (tokens registered, webhook
 *   URL configured, ...). The registry skips unconfigured sinks entirely, and
 *   the pipeline treats "no sink configured" as a silent no-op success.
 *
 * - `send(notification, context)` — deliver one notification. MUST NOT throw
 *   for ordinary delivery failures: catch them, log, and resolve `false`
 *   (the registry still guards against escapes defensively).
 *
 *   `notification` is channel-agnostic:
 *     { category, title, body, data, categoryId }
 *   where `category` is one of the pipeline's notification categories
 *   (see RATE_LIMITS in push.js), `data` is an arbitrary payload object and
 *   `categoryId` is an optional iOS action-button category (sinks without an
 *   equivalent concept simply ignore it).
 *
 *   `context` carries per-device prefs evaluators supplied by the pipeline:
 *     {
 *       now,                                        // ms epoch, for quiet hours
 *       isCategoryEnabled(category, deviceId),      // per-device mute
 *       isInQuietHours(now, deviceId),              // quiet-hours window
 *       shouldBypassQuietHours(category, deviceId), // bypass list
 *     }
 *   All evaluators are optional — a sink must treat a missing evaluator as
 *   "allowed" (fail open), matching the pipeline's defaults.
 *
 *   Resolves `true` when no hard delivery failure occurred (delivered, or
 *   nothing eligible to deliver — both are "no error" from the caller's
 *   view). Resolves `false` ONLY on a hard channel failure (non-2xx,
 *   network throw). Callers like the idle-push dedupe latch (#3870) rely on
 *   this distinction to retry later.
 */

export class NotificationSink {
  constructor({ name } = {}) {
    this.name = name || this.constructor.name
  }

  /**
   * Whether this sink currently has somewhere to deliver to. Subclasses
   * override; the base class is honest about having no channel.
   */
  isConfigured() {
    return false
  }

  /**
   * Deliver one notification. Subclasses must override.
   * @param {{ category: string, title: string, body: string, data?: object, categoryId?: string }} notification
   * @param {object} [context]
   * @returns {Promise<boolean>}
   */
  // eslint-disable-next-line no-unused-vars
  async send(notification, context = {}) {
    throw new Error(`NotificationSink '${this.name}' does not implement send()`)
  }
}
