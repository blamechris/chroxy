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
 * ## Ownership is tracked by a TOKEN, not by object identity (#8091)
 *
 * Every record carries a `token` — a fresh, unique marker minted at `open()`
 * time — because object identity alone cannot carry the "is this still mine"
 * question once a write-through exists. #7450's original write-through
 * MUTATED the current record in place, so `rollback()`'s plain identity check
 * (`records.get(key) !== record`) could not tell "nothing has happened since I
 * was admitted" apart from "my record was silently enriched by an unrelated,
 * OLDER survey's write-through" — both left the same object sitting in the
 * map. Reproduced directly: admit A, admit B (supersedes A), A completes and
 * write-throughs into B's record, B's own survey later throws and rolls back —
 * the identity check passed, so `rollback()` blindly restored `prior` (the
 * record as it was BEFORE A's write-through), discarding A's completed
 * reading AND reopening the window on A's much older stamp.
 *
 * The fix: `commit()` never mutates a record in place — every commit,
 * write-through included, REPLACES the current record with a new object that
 * carries the SAME `.token` (and window-start `.at`) forward. `rollback()`
 * keys on that token: `records.get(key)?.token === token` means "I am still
 * the admission this slot belongs to, however it has been enriched since,"
 * while a mismatch means a NEWER admission has genuinely taken over and this
 * rollback is stale — a no-op, exactly like the pre-#8091 identity check
 * intended, but now correct in the presence of a write-through.
 *
 * A rollback that IS current restores `{ at: prior.at, snapshot:
 * newest(current, prior) }` (comparing `snapshotAt`, never regressing to an
 * older reading than what is already there) — deleting the record outright
 * only when there is neither a `prior` to fall back to nor any snapshot worth
 * keeping. This means a rollback fully undoes ITS OWN admission window (the
 * next request's throttle reverts to whatever was true before this admission
 * — consistent with "a survey that spent nothing must not cost the next
 * retry"), while a completed reading is NEVER discarded — it is simply
 * carried forward as the next admission's own replay-cache. See
 * `survey-throttle.test.js`'s "#8091 (C1)" tests for the worked interleaving.
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
 * A destroyed session's record is pruned by `forgetSurveyKey(owner, key)` —
 * the SAME problem class `SessionCiWatcher._state` already guards against
 * (a long-running daemon must not accumulate the id of every session it has
 * ever surveyed), but by a DIFFERENT mechanism: that watcher prunes via a
 * periodic `tick()` sweep that diffs its state map against a fresh
 * live-session list, not an event listener (`session-ci-watcher.js`'s own
 * `tick()`). Event-based pruning has a gap a live-session sweep does not —
 * see #8092 — so `forgetSurveyKey` is called from `SessionManager`'s
 * `_cleanupSessionMaps()` (the sole `_sessions.delete` site, `destroyAll()`
 * excepted, which calls it too) rather than from a `session_destroyed`
 * listener, precisely so every teardown path is covered through the removal
 * itself rather than through whichever events happen to be wired up.
 * `forgetSurveyKey` reaches EVERY throttle instance created via
 * `createSurveyThrottle()` through this one module-level registry, not just
 * whichever handler happened to wire it up first — the threads handler (#7430)
 * opens its own independent instance of this gate, and a per-instance prune
 * added to only one of them would be exactly the `docs/false-safety-guards.md`
 * "a guard wired to only some of its callers" shape.
 *
 * ## A `forget()` + reused-id straggler cannot write through into the new incarnation (#8094)
 *
 * `commit()`'s write-through guard (`cur.snapshotAt !== null && cur.snapshotAt
 * >= myAt`) orders write-throughs by `snapshotAt` alone, and a record with NO
 * reading yet (`snapshotAt: null`) passes it unconditionally — that escape
 * hatch is what lets the FIRST-ever survey of a session write through onto a
 * record that has not committed anything of its own (the #7450 scope
 * addition, see above). But `forget()` (a session_destroyed prune) deletes a
 * record outright, and a session id can be REUSED afterward (`preserveId`
 * restore/rebind) — the new admission's record also starts with `snapshotAt:
 * null`. A survey admitted under the FORGOTTEN (prior) incarnation that
 * finally resolves after the reuse then satisfies the same guard: from
 * `commit()`'s point of view it is indistinguishable from an ordinary
 * straggler writing through onto its own still-live successor. Nothing in
 * `.at`/`.token` tells "superseded, same session" apart from "superseded by a
 * forget()+reuse, a DIFFERENT incarnation" — both look like "some earlier
 * admission, now superseded."
 *
 * Every record therefore also carries a `lineage` — a fresh, unique marker
 * that a new admission COPIES from `prior` when one exists (an ordinary
 * supersede: the session is still live, so the incarnation is unchanged) and
 * MINTS FRESH only when there is no `prior` to copy from, which happens
 * exactly when the key was just `forget()`-ed. `commit()`'s write-through
 * additionally requires `cur.lineage === myLineage`: a straggler from a
 * forgotten incarnation carries the OLD lineage forward in its own closure,
 * so it can never match a freshly-minted one, however the `snapshotAt`
 * ordering alone would have let it through. Lineage lives only inside a
 * record (carried forward exactly like `.token`), so it does not reintroduce
 * the unbounded map #7450 removed — it costs nothing once the record itself
 * is gone.
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
  /**
   * WeakMap<owner, Map<key, {
   *   at: number, token: object, lineage: object, snapshot: *, snapshotAt: number|null
   * }>>
   *
   * `token` is a fresh, unique marker minted per `open()` call — see the
   * module doc's "ownership is tracked by a TOKEN, not by object identity"
   * section (#8091). A record's `token` is carried forward by `commit()`'s
   * write-through and by `rollback()`'s restore; it changes ONLY when a NEW
   * `open()` call supersedes the current admission.
   *
   * `lineage` is a fresh, unique marker minted only when an admission has NO
   * `prior` record to copy it from — i.e. right after a `forget()` — and
   * copied forward from `prior` otherwise. See the module doc's "a forget() +
   * reused-id straggler cannot write through" section (#8094). Distinct from
   * `token`: `token` identifies the CURRENT admission (changes on every
   * supersede); `lineage` identifies the INCARNATION (changes only across a
   * forget()+reuse).
   */
  const byOwner = new WeakMap()

  /** The per-key record map for this owner. */
  function recordsFor(owner) {
    let m = byOwner.get(owner)
    if (!m) { m = new Map(); byOwner.set(owner, m) }
    return m
  }

  /** Whichever of two (snapshot, snapshotAt) pairs is newer; a tie keeps `a`. */
  function newerOf(aSnapshot, aSnapshotAt, bSnapshot, bSnapshotAt) {
    if (aSnapshotAt === null) return { snapshot: bSnapshot, snapshotAt: bSnapshotAt }
    if (bSnapshotAt === null) return { snapshot: aSnapshot, snapshotAt: aSnapshotAt }
    return aSnapshotAt >= bSnapshotAt
      ? { snapshot: aSnapshot, snapshotAt: aSnapshotAt }
      : { snapshot: bSnapshot, snapshotAt: bSnapshotAt }
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
      // forward under a more recent window. `token` is this admission's own
      // fresh identity — see the module doc (#8091). `lineage` identifies the
      // INCARNATION this admission belongs to: copied from `prior` when one
      // exists (still the same, live session) and minted fresh only when
      // there is none (the key was just `forget()`-ed — a reused id starts a
      // new incarnation) — see the module doc (#8094).
      const myAt = nowMs
      const token = {}
      const lineage = prior?.lineage ?? {}
      records.set(key, { at: myAt, token, lineage, snapshot: prior?.snapshot ?? null, snapshotAt: prior?.snapshotAt ?? null })
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
          const cur = records.get(key)
          // The key can be gone outright (forgetSurveyKey() pruned it, e.g. a
          // session_destroyed landing while this survey was in flight) —
          // nothing to write to, and recreating the entry would resurrect a
          // record for a session that no longer exists.
          if (!cur) return
          // The record can also belong to a DIFFERENT incarnation than the
          // one this survey was admitted under: a forget() + reused-id
          // straggler passes every check below (its `cur` exists, and a
          // fresh incarnation's `snapshotAt` is null, same as an ordinary
          // not-yet-committed successor) unless lineage is checked explicitly
          // (#8094). This must run BEFORE the snapshotAt guard, which cannot
          // tell the two cases apart on its own.
          if (cur.lineage !== lineage) return
          // One rule, whether this is the common (untouched-since-admission)
          // case or a write-through onto a record someone else has since
          // superseded: never let a reading older than what is already
          // recorded win (#7450 / #8091's outcome 3). `cur.snapshotAt` — a
          // FRESHLY admitted record carries it forward from `prior`, so this
          // also correctly refuses an admission whose predecessor already
          // held a newer reading than this one, in the ordinary sequential
          // case. `>=`, not `>` — an EXACT tie keeps the CURRENT reading
          // (pinned by the "S3" test in survey-throttle.test.js).
          if (cur.snapshotAt !== null && cur.snapshotAt >= myAt) return
          // REPLACE, never mutate in place (#8091) — carrying `cur.token`,
          // `cur.lineage` and `cur.at` forward unchanged is what lets a later
          // `rollback()` (see below) still recognise this slot as belonging
          // to whichever admission currently owns it, however the SNAPSHOT
          // has been enriched since.
          records.set(key, { at: cur.at, token: cur.token, lineage: cur.lineage, snapshot, snapshotAt: myAt })
        },
        rollback() {
          const cur = records.get(key)
          // Stale: a NEWER admission has since taken over this slot (whether
          // or not it has committed anything of its own yet) — a no-op,
          // exactly like the pre-#8091 identity check intended (#7450 scope
          // addition's "a stale rollback... stays a no-op").
          if (!cur || cur.token !== token) return
          // Undo MY OWN admission in full: the window reverts to whatever was
          // true before I was ever admitted — a survey that spent nothing
          // must not cost the next retry (#8091's outcome 2) — but the
          // SNAPSHOT never regresses: keep whichever of what I'm currently
          // holding (possibly enriched by someone ELSE's write-through while
          // I was still current) and what `prior` already had is newer.
          const survivor = newerOf(cur.snapshot, cur.snapshotAt, prior?.snapshot ?? null, prior?.snapshotAt ?? null)
          if (!prior && survivor.snapshotAt === null) {
            records.delete(key)
            return
          }
          records.set(key, {
            at: prior ? prior.at : -Infinity,
            token: prior ? prior.token : {},
            // Restore `prior`'s lineage along with its token when there is a
            // `prior` to revert to. When there is none, this admission was
            // itself the first of a fresh incarnation, so any survivor
            // snapshot came from a write-through that already had to match
            // THIS lineage (#8094) — keep it rather than minting yet another
            // one, which would strand the survivor behind a lineage nothing
            // still admitted holds.
            lineage: prior ? prior.lineage : lineage,
            snapshot: survivor.snapshot,
            snapshotAt: survivor.snapshotAt,
          })
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
 * `SessionManager`'s `_cleanupSessionMaps()` (#7450) and `destroyAll()`
 * (#8092) in `session-manager.js` — the removal itself, not a lifecycle
 * event, so every teardown path is covered rather than only the ones that
 * happen to emit `session_destroyed`.
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
