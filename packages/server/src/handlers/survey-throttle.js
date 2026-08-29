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
 * ## `commit()` requires an explicit `replayable` decision, and THROWS without one
 *
 * Replaying is only right for a reading worth replaying. A survey that reached
 * the CLI and came back unusable must not be handed to every client of the
 * session for the rest of the window — that is one transient error amplified,
 * long after the condition cleared.
 *
 * Deciding that is DOMAIN knowledge, and this module deliberately has none: it
 * cannot know that a PR status is worth replaying when `reason` is null (an
 * `indeterminate` fork bail-out included, since that is display-identical to a
 * fresh reply) while a thread count additionally needs an actual number. So the
 * decision belongs to the caller — but it must not be OPTIONAL, and that is the
 * part worth spelling out.
 *
 * #7430 first implemented this rule at one of the two call sites. The other
 * kept committing unconditionally, and a security doc had already been written
 * claiming the property for both. That is `docs/false-safety-guards.md`'s "a
 * guard wired to only some of its callers" — correct for every input it sees,
 * never reached by the rest. A second call-site guard would share the failure
 * mode of the first, so the decision moved in here as a REQUIRED argument:
 * `commit(snapshot, { replayable })` throws unless `replayable` is a boolean.
 * Forgetting is now a crash on the first survey rather than a silent cache, and
 * a third caller cannot inherit the defect by omission.
 *
 * `replayable: false` does NOT clear the cache — it leaves the previously
 * retained good reading in place. A transient failure must not blank a reading
 * other clients are looking at, which is #7445's Critical 1 arriving by a
 * different route.
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
 * @property {(snapshot: *, opts: { replayable: boolean }) => void} [commit] -
 *   on an ADMISSION: record the completed reading so later refusals can replay
 *   it. `replayable` is REQUIRED and must be a boolean — see the module doc;
 *   `false` keeps any previously retained reading rather than caching this one.
 *   Throws a `TypeError` when the decision is missing, so a caller cannot
 *   silently inherit the permissive behaviour.
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
        commit(snapshot, opts) {
          const replayable = opts?.replayable
          // Fail CLOSED and LOUD. A default — either way — would let a caller
          // that never considered the question inherit a policy silently, which
          // is exactly how #7430's rule ended up on one call site out of two.
          if (typeof replayable !== 'boolean') {
            throw new TypeError('survey-throttle: commit() requires an explicit boolean `replayable` — decide whether this reading is worth replaying to other clients inside the window')
          }
          // Not replayable: keep whatever good reading `open()` carried
          // forward. Overwriting it with a failure would blank a display other
          // clients are using; clearing it would do the same more quietly.
          if (!replayable) return
          record.snapshot = snapshot
        },
        rollback() {
          if (records.get(key) !== record) return
          if (prior) records.set(key, prior)
          else records.delete(key)
        },
      }
    },
  }
}
