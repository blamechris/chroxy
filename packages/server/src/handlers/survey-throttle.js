/**
 * Per-key minimum-interval gate for a handler that shells out (#7436, #7430).
 *
 * The problem it solves is shared by every on-demand survey handler: the reply
 * costs a git/`gh` subprocess, so an un-throttled client can fan one out per
 * click, and since #7427 the PR-status survey also MUTATES daemon watch state
 * on its way out. An in-flight guard only bars CONCURRENT work; back-to-back
 * work needs a clock.
 *
 * ## The refusal shape is the interesting part
 *
 * A throttled request is answered by REPLAYING the last completed reading, not
 * by degrading. The review on #7445 established why: the dashboard writes any
 * reply wholesale and renders a `reason` as "unavailable", with nothing
 * scheduled to repair it — so a degraded reply BLANKS the chip the user is
 * looking at. The throttle's job is bounding subprocesses, never punishing the
 * click. Only before the FIRST completed reading is there nothing to replay,
 * and that is the one case a caller must degrade for itself.
 *
 * ## Why the record is compare-and-restore rather than delete
 *
 * A survey that THREW did not spend the subprocess budget the throttle
 * protects, so the retry the user reaches for next must not be refused for it —
 * hence `rollback()`. But it must roll back only ITS OWN record: in-flight
 * guards are per-CLIENT, so client A's slow survey and client B's later
 * admitted one can overlap, and an unconditional delete destroys B's newer
 * stamp and cache when A fails late (#7445 review, reproduced).
 *
 * ## Why the map is keyed on an OWNER object
 *
 * The stamps live in a `WeakMap` keyed on a long-lived object the caller
 * supplies — in production the daemon-lifetime `SessionManager` singleton, so
 * records survive the per-message shallow ctx copies; in tests every mock ctx
 * builds a fresh manager, so isolation comes free with no reset hook. A
 * destroyed session's record lingers until the owner itself is collected — one
 * small record per ever-surveyed key (pruning on session_destroyed is #7450).
 */

/**
 * @typedef {object} ThrottleGate
 * @property {boolean} admitted - false when the request fell inside the window.
 * @property {*} [cached] - on a REFUSAL: the last completed reading to replay,
 *   or null when none exists yet (the caller must degrade).
 * @property {(snapshot: *) => void} [commit] - on an ADMISSION: record the
 *   completed reading so later refusals can replay it.
 * @property {() => void} [rollback] - on an ADMISSION: undo this request's
 *   stamp after a failure that spent no budget. Compare-and-restore: a no-op
 *   once a newer request has re-stamped the key.
 */

/**
 * Create an independent throttle. Each handler owns one module-level instance,
 * so two handlers never share a window.
 *
 * @returns {{ open: (owner: object, key: string, nowMs: number, minIntervalMs: number) => ThrottleGate }}
 */
export function createSurveyThrottle() {
  /** WeakMap<owner, Map<key, { at: number, snapshot: * }>> */
  const byOwner = new WeakMap()

  /** The per-key record map for this owner. */
  function recordsFor(owner) {
    let m = byOwner.get(owner)
    if (!m) { m = new Map(); byOwner.set(owner, m) }
    return m
  }

  return {
    open(owner, key, nowMs, minIntervalMs) {
      const records = recordsFor(owner)
      const prior = records.get(key)
      if (prior && nowMs - prior.at < minIntervalMs) {
        return { admitted: false, cached: prior.snapshot ?? null }
      }
      // Carry the previous cache forward so a request that lands while THIS
      // survey is in flight still replays the last completed reading, and
      // stamp BEFORE the work starts — the window dates from when a survey
      // was admitted, not from when it finished.
      const record = { at: nowMs, snapshot: prior?.snapshot ?? null }
      records.set(key, record)
      return {
        admitted: true,
        commit(snapshot) { record.snapshot = snapshot },
        rollback() {
          if (records.get(key) !== record) return
          if (prior) records.set(key, prior)
          else records.delete(key)
        },
      }
    },
  }
}
