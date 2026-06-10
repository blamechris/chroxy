/**
 * SinkRegistry — holds the configured NotificationSinks and fans one
 * notification out to all of them (#5413 Phase 1).
 *
 * This is the pipeline's fan-out point: PushManager applies the shared
 * gating (category prefs, quiet hours, rate limits) ONCE, then hands the
 * approved notification here. Today the registry holds a single
 * ExpoPushSink; DiscordWebhookSink registers alongside it in Phase 2 with
 * no pipeline changes.
 *
 * Semantics:
 * - Unconfigured sinks (isConfigured() === false) are skipped entirely —
 *   they are never asked to send.
 * - Sinks are invoked sequentially in registration order (deterministic;
 *   revisit if a slow sink ever needs to stop delaying the others).
 * - fanOut resolves `true` when every configured sink resolved `true`
 *   (including the no-configured-sinks case), `false` when ANY configured
 *   sink hard-failed. One failing sink does not prevent the others from
 *   receiving the notification.
 * - A sink that throws (contract violation — sinks must catch their own
 *   delivery errors) is logged and treated as a hard failure, so a buggy
 *   sink can't take the pipeline down.
 */

export class SinkRegistry {
  constructor({ logger = null } = {}) {
    this._sinks = []
    this._log = logger
  }

  /**
   * Register a sink. Validates the minimal contract shape up front so a
   * malformed sink fails at wiring time, not on the first notification.
   */
  register(sink) {
    if (!sink || typeof sink.send !== 'function' || typeof sink.isConfigured !== 'function') {
      throw new TypeError('SinkRegistry.register: sink must implement send() and isConfigured()')
    }
    if (typeof sink.name !== 'string' || sink.name.length === 0) {
      throw new TypeError('SinkRegistry.register: sink must have a non-empty name')
    }
    this._sinks.push(sink)
    return sink
  }

  /** Snapshot of registered sinks (registration order). */
  get sinks() {
    return [...this._sinks]
  }

  /** True when at least one registered sink is currently configured. */
  hasConfigured() {
    return this._sinks.some((sink) => sink.isConfigured())
  }

  /**
   * Fan one approved notification out to every configured sink.
   * @param {{ category: string, title: string, body: string, data?: object, categoryId?: string }} notification
   * @param {object} [context] - Pipeline-supplied evaluators (see sink.js)
   * @returns {Promise<boolean>} `true` iff no configured sink hard-failed
   */
  async fanOut(notification, context = {}) {
    let ok = true
    for (const sink of this._sinks) {
      if (!sink.isConfigured()) continue
      try {
        const result = await sink.send(notification, context)
        if (result === false) ok = false
      } catch (err) {
        // Contract violation — sinks must resolve false on delivery
        // failure, not throw. Contain it so the other sinks still deliver.
        this._log?.error?.(`Sink '${sink.name}' threw during send: ${err?.message || err}`)
        ok = false
      }
    }
    return ok
  }
}
