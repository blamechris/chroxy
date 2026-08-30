/**
 * #7562 — the ONE funnel for "destroy this environment", shared by both wire
 * paths (`destroy_environment` in feature-handlers.js and `containers_action`
 * with `action: 'destroy'` in control-room-handlers.js).
 *
 * POLICY (adjudicated 2026-08-30, recorded in
 * docs/decisions/2026-08-destroy-environment-live-sessions.md):
 *
 *   REFUSE when the environment has live sessions; `force: true` escapes, and
 *   force means CASCADE — destroy those sessions CLEANLY first, then the
 *   environment.
 *
 * Why cascade rather than detach: destroying an environment runs `docker rm -f`
 * on its container, which kills every process inside it. The attached sessions
 * die either way — the only question is whether they die cleanly (provider
 * teardown, synthetic `stream_end` for in-flight streams, `session_destroyed`
 * broadcast so clients drop the tab, state flushed, the environment tag
 * removed) or are left sitting in `SessionManager._sessions` pointing at a
 * container that no longer exists. "Detach and keep running" is not available:
 * a `docker-sdk` session whose container is gone cannot run, and one that
 * silently fell back to a fresh container would be #7561's containment escape.
 *
 * Why the refusal lives in `EnvironmentManager.destroy()` and not here: that is
 * the single chokepoint every caller reaches, including any future one. A check
 * duplicated per handler is the "guard wired to only some of its callers" shape
 * catalogued in docs/false-safety-guards.md — which is how `containers_action`
 * ended up with no guard at all while the dashboard had one.
 */
import { createLogger } from '../logger.js'

const log = createLogger('destroy-environment')

/**
 * `err.code` on the refusal thrown by `EnvironmentManager.destroy()` when the
 * environment still has sessions attached and `force` was not set. Also the
 * `code` echoed on the `environment_error` wire reply.
 */
export const ENVIRONMENT_HAS_LIVE_SESSIONS = 'ENVIRONMENT_HAS_LIVE_SESSIONS'

/**
 * How many times the cascade re-reads `env.sessions` before giving up on
 * draining it. A session can attach between the read and the destroy (nothing
 * holds the environment lock across `createSession`), so one snapshot is not
 * enough; an unbounded loop would let a client that creates sessions in a loop
 * wedge an operator's force-destroy. Bounded, then the destroy proceeds — the
 * operator asked for `force`, and a straggler is a session the container
 * teardown was going to kill anyway.
 */
export const MAX_CASCADE_PASSES = 5

/**
 * Build the structured refusal. Exported so `EnvironmentManager.destroy()` and
 * this module cannot drift on the shape the handlers destructure.
 * @param {{id: string, name?: string, sessions: string[]}} env
 * @returns {Error & {code: string, environmentId: string, sessions: string[]}}
 */
export function liveSessionsError(env) {
  const sessions = [...env.sessions]
  const err = new Error(
    `Environment "${env.name || env.id}" has ${sessions.length} live session(s) running in it ` +
    `(${sessions.join(', ')}). Destroying the container would kill them. ` +
    `Close the sessions first, or resend with force to destroy them and the environment together.`,
  )
  err.code = ENVIRONMENT_HAS_LIVE_SESSIONS
  err.environmentId = env.id
  err.sessions = sessions
  return err
}

/**
 * Destroy an environment, honouring the live-session policy.
 *
 * @param {object}   args
 * @param {object}   args.environmentManager - the live EnvironmentManager
 * @param {object|null} [args.sessionManager] - the live SessionManager; only needed for the cascade
 * @param {string}   args.environmentId
 * @param {boolean}  [args.force=false] - destroy the attached sessions first, then the environment
 * @returns {Promise<{destroyedSessions: string[]}>}
 * @throws the structured `ENVIRONMENT_HAS_LIVE_SESSIONS` refusal (unforced, sessions attached),
 *   or whatever `EnvironmentManager.destroy()` throws (unknown id, backend failure).
 */
export async function destroyEnvironmentWithSessions({
  environmentManager,
  sessionManager = null,
  environmentId,
  force = false,
}) {
  const destroyedSessions = []

  if (force) {
    // Drain first, so every session gets a real teardown while its container is
    // still alive. Re-read between passes: `env.sessions` is mutated by
    // `_cleanupSessionMaps` as each destroy lands, and a session can attach
    // mid-cascade.
    if (sessionManager && typeof sessionManager.destroySession === 'function') {
      for (let pass = 0; pass < MAX_CASCADE_PASSES; pass++) {
        const live = [...(environmentManager.get?.(environmentId)?.sessions || [])]
        const pending = live.filter((id) => !destroyedSessions.includes(id))
        if (pending.length === 0) break
        for (const sessionId of pending) {
          // Push BEFORE the destroy, deliberately (#7571 review S2). This list
          // is two things at once: the caller's report, and — via the `pending`
          // filter above — the loop's own record of what it has already
          // attempted. Pushing after a successful destroy would make a session
          // whose `destroySession` throws deterministically re-enter `pending`
          // on every pass, so ONE broken session could consume all
          // MAX_CASCADE_PASSES and starve the sessions behind it of a clean
          // teardown — the exact outcome the cascade exists to prevent.
          //
          // The cost is that `destroyedSessions` can name a session whose
          // teardown threw, so it is "attempted", not "confirmed". That
          // misreport is confined to the handlers' `log.warn` summary; nothing
          // branches on the list, and the environment goes away regardless.
          // Attempted-once-each is the right trade against
          // starve-the-rest-for-one-bad-session.
          destroyedSessions.push(sessionId)
          try {
            sessionManager.destroySession(sessionId)
          } catch (err) {
            // A session that fails to tear down must not block the destroy the
            // operator explicitly forced — the container teardown below ends it
            // regardless. Log loudly; never rethrow.
            log.error(`force-destroy: failed to destroy session ${sessionId} in ${environmentId}: ${err?.stack || err}`)
          }
        }
      }
    } else if ((environmentManager.get?.(environmentId)?.sessions || []).length > 0) {
      log.warn(`force-destroy: ${environmentId} has attached sessions but no SessionManager is wired — they cannot be torn down cleanly`)
    }
  }

  // Always route through the manager, and always pass `force` through: after a
  // successful drain the refusal would not fire anyway, but a session that
  // attached after the last pass must not turn an explicit force into a
  // failure.
  await environmentManager.destroy(environmentId, { force })
  return { destroyedSessions }
}
