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
 * builds a fresh manager, so isolation comes free with no reset hook.
 *
 * ## Bounded by the LIVE session count, not the daemon's lifetime (#7450)
 *
 * A destroyed session's record is pruned by `forgetSurveyKey(owner, key)`,
 * called from `WsServer`'s `session_destroyed` handler — the same event
 * `SessionCiWatcher._state` already prunes on, with the same requirement: a
 * long-running daemon must not accumulate the id of every session it has ever
 * surveyed. `forgetSurveyKey` reaches EVERY throttle instance created via
 * `createSurveyThrottle()` through this one module-level registry, not just
 * whichever handler happened to wire it up first — the threads handler (#7430)
 * opens its own independent instance of this gate, and a per-instance prune
 * added to only one of them would be exactly the `docs/false-safety-guards.md`
 * "a guard wired to only some of its callers" shape.
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
 * Registry of every throttle created via `createSurveyThrottle()`, so
 * `forgetSurveyKey()` below can reach all of them through ONE call — see the
 * module doc's "bounded by the live session count" section. A plain `Set`, not
 * a `WeakSet`: each handler module creates exactly one instance at import time
 * and keeps it for the daemon's lifetime, and enumerating that (small, fixed)
 * set is the entire point.
 */
const throttleInstances = new Set()

/**
 * Create an independent throttle. Each handler owns one module-level instance,
 * so two handlers never share a window.
 *
 * @returns {{
 *   open: (owner: object, key: string, nowMs: number, minIntervalMs: number) => ThrottleGate,
 *   forget: (owner: object, key: string) => void,
 * }}
 */
export function createSurveyThrottle() {
  /** WeakMap<owner, Map<key, { at: number, snapshot: *, snapshotAt: number|null }>> */
  const byOwner = new WeakMap()

  /** The per-key record map for this owner. */
  function recordsFor(owner) {
    let m = byOwner.get(owner)
    if (!m) { m = new Map(); byOwner.set(owner, m) }
    return m
  }

  const throttle = {
    open(owner, key, nowMs, minIntervalMs) {
      const records = recordsFor(owner)
      const prior = records.get(key)
      if (prior && nowMs - prior.at < minIntervalMs) {
        return { admitted: false, cached: prior.snapshot ?? null }
      }
      // Carry the previous cache forward so a request that lands while THIS
      // survey is in flight still replays the last completed reading, and
      // stamp BEFORE the work starts — the window dates from when a survey
      // was admitted, not from when it finished. `snapshotAt` tracks WHEN the
      // survey that produced `.snapshot` was itself admitted — not this
      // record's own `.at` — so a later write-through (see `commit()`) can
      // tell a genuinely newer cached reading apart from one merely carried
      // forward under a more recent window.
      const record = { at: nowMs, snapshot: prior?.snapshot ?? null, snapshotAt: prior?.snapshotAt ?? null }
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
          if (records.get(key) === record) {
            // The common case: nothing superseded this admission between
            // `open()` and `commit()`.
            record.snapshot = snapshot
            record.snapshotAt = record.at
            return
          }
          // #7450 scope addition: this record was superseded by a LATER
          // `open()` for the same key before this survey finished — a survey
          // slower than the throttle window itself lets a third request land
          // outside the window while the first is still in flight. Writing
          // only to OUR closure-captured `record` would strand this completed
          // reading where nothing will ever read it again (see the module
          // doc's refusal-shape section) — a request in that gap would then
          // degrade with RATE_LIMITED_REASON despite a reading having
          // completed. Write THROUGH to whichever record is current now,
          // unless it already holds a reading admitted more recently than
          // this one: a superseding survey's OWN later commit must still win
          // over an older survey's late arrival.
          const current = records.get(key)
          // The key can be gone outright (forgetSurveyKey() pruned it, e.g. a
          // session_destroyed landing while both surveys were in flight) —
          // nothing to write through to, and recreating the entry would
          // resurrect a record for a session that no longer exists.
          if (!current) return
          if (current.snapshotAt !== null && current.snapshotAt >= record.at) return
          current.snapshot = snapshot
          current.snapshotAt = record.at
        },
        rollback() {
          if (records.get(key) !== record) return
          if (prior) records.set(key, prior)
          else records.delete(key)
        },
      }
    },
    /** Drop the record for (owner, key), if any. Called by `forgetSurveyKey()`. */
    forget(owner, key) {
      byOwner.get(owner)?.delete(key)
    },
    /** TEST-ONLY: how many records this owner currently holds, in THIS instance. */
    _testRecordCount(owner) {
      return byOwner.get(owner)?.size ?? 0
    },
  }
  throttleInstances.add(throttle)
  return throttle
}

/**
 * Prune the record for `(owner, key)` from EVERY throttle instance created via
 * `createSurveyThrottle()` — both of today's handlers (session-pr-status,
 * session-pr-threads) and any future one, through this one call. Called from
 * `WsServer`'s `session_destroyed` handler in `ws-server.js` (#7450).
 *
 * Safe to call for a key that was never opened, or that has already been
 * forgotten — both are silent no-ops.
 *
 * @param {object} owner - the session-manager instance the throttle was keyed on.
 * @param {string} key - the session id.
 */
export function forgetSurveyKey(owner, key) {
  for (const throttle of throttleInstances) {
    throttle.forget(owner, key)
  }
}

/**
 * TEST-ONLY: total record count for one owner, summed across every throttle
 * instance. Used by the #7450 acceptance test to prove the bound holds no
 * matter which (or how many) handlers have opened a survey — a per-instance
 * count would only prove the property for whichever instance the test
 * happened to import.
 *
 * @param {object} owner
 * @returns {number}
 */
export function _testTotalRecordCount(owner) {
  let total = 0
  for (const throttle of throttleInstances) {
    total += throttle._testRecordCount(owner)
  }
  return total
}
