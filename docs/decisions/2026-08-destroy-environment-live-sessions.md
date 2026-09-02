# Destroying an environment with live sessions: refuse, and `force` cascades

**Date**: 2026-08-30
**Issue**: #7562 (follow-on from #7552 / PR #7563)
**Status**: decided — implemented on both paths
**Touches**: `packages/server/src/environment-manager.js` (`destroy`),
`packages/server/src/environments/destroy-with-sessions.js` (new),
`packages/server/src/handlers/feature-handlers.js` (`destroy_environment`),
`packages/server/src/handlers/control-room-handlers.js` (`containers_action`),
`packages/protocol/src/schemas/client.ts`,
`packages/protocol/src/schemas/server/environment.ts`
**Pinned by**: `packages/server/tests/environment-destroy-live-sessions.test.js`

## The question

#7552 wired `EnvironmentInfo.sessions` so the dashboard's Destroy button could
finally disable itself while an environment had live sessions. That guard is
**client-side only**. Two server paths destroyed an environment with no check:

- `destroy_environment` (feature-handlers) → straight to `EnvironmentManager.destroy()`
- `containers_action` with `action: 'destroy'` (control-room-handlers) → same,
  and the Control Room has no UI guard at all

`EnvironmentManager.destroy()` never looked at `env.sessions`. So any sender of
either message — a stale dashboard tab whose `environment_list` predates the
session, the Control Room (no UI guard at all), a script, any future client —
could `docker rm -f` the container out from under running sessions.

The mobile app is deliberately **not** in that list: it can put a session into an
environment (`create_session` forwards `environmentId`,
`packages/app/src/store/connection.ts`) but ships no environment-destroy surface
at all, so it is a potential victim of this rather than a way to trigger it.

Measured before the fix (`/tmp` probe against both handlers, one session attached
to each environment): both replied success (`environment_destroyed`,
`containers_action_ack status: "destroyed"`), `docker rm -f <container>` ran, the
environment was deregistered, and **the session was still live in
`SessionManager._sessions`** — pointing at a container that no longer existed.

The issue offered three candidates and explicitly asked for a decision:

1. Refuse on both paths unless `force: true`.
2. Refuse on `destroy_environment`, leave `containers_action destroy` as the
   deliberate override.
3. Destroy the attached sessions first, then the environment.

## Decision: (1) and (3) together — refuse by default on **both** paths, and `force` means cascade

### Why not (2) — an exemption by surface

An override whose availability depends on *which handler you happened to reach*
is the "guard wired to only some of its callers" shape in
[`docs/false-safety-guards.md`](../false-safety-guards.md) — the same shape that
left `containers_action` with no check at all while the dashboard had one. It is
also unauditable: nothing in the message says the operator meant to force
anything, so the log cannot distinguish a deliberate override from a client that
did not know better.

The override survives, as an explicit `force: true` **on the message**. Control
Room keeps its force-it affordance; it just has to say so.

### Why `force` = cascade, not detach

Destroying an environment runs `docker rm -f` on its container, which kills every
process inside it. The attached sessions die either way. The only question is
whether they die **cleanly** — provider teardown, synthetic `stream_end` for
in-flight streams, `session_destroyed` broadcast so clients drop the tab, state
flushed, the `env.sessions` tag removed — or are left sitting in `_sessions`
pointing at nothing, which is exactly what the probe above recorded.

"Detach and keep the session running" is not on the table. A `docker-sdk` session
whose container is gone cannot run; and a session that silently fell back to a
fresh container would be #7561's containment escape, fixed in the same PR. So the
only two coherent options are *refuse* and *destroy them first* — which is what
this decision picks, keyed on `force`.

## Implementation shape

The **refusal** lives in `EnvironmentManager.destroy(envId, { force })`, the one
chokepoint every caller reaches (including any future one), and throws before any
teardown:

```
err.code = 'ENVIRONMENT_HAS_LIVE_SESSIONS'
err.environmentId = <id>
err.sessions = [<session ids>]
```

The **cascade** lives in `environments/destroy-with-sessions.js`, the single
funnel both handlers call — `EnvironmentManager` has no handle on the
`SessionManager`, and giving it one to satisfy this would be a bidirectional
dependency for one call site. It re-reads `env.sessions` between passes (a
session can attach between the read and the destroy; nothing holds the
environment lock across `createSession`), bounded at `MAX_CASCADE_PASSES = 5` so
a client creating sessions in a loop cannot wedge an operator's force-destroy.

Wire shape:

- client → `{ type: 'destroy_environment', environmentId, force?: boolean }`
- client → `{ type: 'containers_action', action: 'destroy', environmentId, force?: boolean }`
- server → `{ type: 'environment_error', environmentId, error, code: 'ENVIRONMENT_HAS_LIVE_SESSIONS', sessions: [...] }`
- server → `{ type: 'session_error', code: 'CONTAINER_ACTION_FAILED', reason: 'live-sessions', ... }`

`force` is a **strict** boolean on both paths — only an explicit `true`
escalates, so a truthy string from a hand-rolled client cannot destroy live
sessions.

## What this deliberately does NOT do

**No UI for the escalation yet.** *(Superseded by #7568 — see the follow-on
below; the escalation UI now ships. This paragraph records the #7562 scope.)*
The dashboard's Destroy button is already
disabled while `env.sessions` is non-empty, so its happy path never reaches the
refusal; what changes today is that a *stale* tab, the Control Room, a script and
any other sender get a real refusal instead of a destroyed container. Adding the
"N sessions are running — destroy them too?" confirm row (and the Control Room
equivalent) is a UI change with its own review surface and is filed separately
rather than folded in. Until then `force` is reachable from any client that sends
the field.

**`stop` and `restart` are not gated — and that is a scoped decision, not a
claim that they are safe.** #7562 is about `destroy`, and only `destroy` is
irreversible: the container and the environment record are gone. `stop` and
`restart` also kill the processes a session runs via `docker exec`, so a live
session survives neither in any useful sense — but the container and the
environment still exist afterwards, so the failure is recoverable in a way a
destroy is not, and gating them is a separate policy question with its own UI
consequences (the Control Room's stop/restart controls exist precisely to bounce
a wedged container). Filed as a follow-up rather than folded in here.

## Follow-on (#7575) — the TOCTOU window on the guard is now closed

**Date**: 2026-09-01
**Issue**: #7575 (follow-on from #7562)
**Touches**: `packages/server/src/environment-manager.js` (`destroy`)
**Pinned by**: `packages/server/tests/environment-manager.test.js`
(`EnvironmentManager.destroy() — create/destroy TOCTOU (#7575)`)

The #7562 refusal above is a check-then-act, and its "act" is not synchronous:
`destroy` checks `env.sessions` (empty → proceed), then `await`s the backend
teardown (`docker rm -f` / `docker compose down`) before deleting the
environment record. That `await` is a yield point. A `create_session` scheduled
during it ran the handler's `getContainerInfo(environmentId)` — a **lockless,
synchronous** status read that only throws when `status !== 'running'` — while
the environment was still registered and still `running` (only its *container*
was mid-removal). The read passed, `SessionManager.createSession` tagged the env
via `addSession`, and `destroy` then deleted the record: a session stranded on a
container that no longer exists, with the guard having waved the destroy through
on a zero-session snapshot. This is the classic TOCTOU on the check the decision
above installed — `docs/false-safety-guards.md`'s "a precondition read outside
the lock the mutation holds."

**The fix — an internal, non-persisted `_destroying` marker set before the first
`await`.** Inside `destroy`'s existing lock, immediately after the #7562 refusal
and **before** any teardown `await`, add the env id to a manager-level
`this._destroying` Set, and clear it in a `finally` so it clears on both the
success and the failure paths. `getContainerInfo` refuses whenever the id is in
that Set (in addition to its existing `status !== 'running'` throw) with the same
NOT_RUNNING-style message — **no new wire shape**, the same refusal the handler
already surfaces.

**Why a Set and not an `env.status = 'destroying'` value** (the shape reached for
first, and rejected in review): `EnvironmentStatusSchema` in
`packages/protocol/src/schemas/server/environment.ts` is a **closed**
`z.enum(['running', 'stopped', 'error'])`. A fourth value would (a) fail Zod
validation on any environment snapshot broadcast to a client during the teardown
window, and (b) — because status is persisted — leave a crashed daemon restarting
into a stuck `destroying` env. The `_destroying` Set is never serialized (nothing
in `_persist()`'s shape references it) and is reconstructed empty on every start,
so it cannot leak onto the wire and a crash mid-teardown clears it for free.
`env.status` is never touched by this fix.

**Why marking synchronously is sufficient — and why `addSession` is deliberately
NOT also gated.** The create path reads the container info
(`getContainerInfo`, `handlers/session-handlers.js`) and tags the environment
(`addSession`, called from the synchronous `SessionManager.createSession`) in
**one synchronous run** — there is no `await` between the read and the tag — so
that read→tag pair is atomic with respect to `destroy`'s yields. Every
interleaving then resolves safely: a create that completed **before** the mark
tagged the env, so the #7562 sessions-check refuses the destroy; a create that
begins **at or after** the mark sees the id in `_destroying` at `getContainerInfo`
and is refused. There is no interleaving where `getContainerInfo` observes a
usable env **and** `addSession` lands during teardown.

**Residual window, stated honestly.** That closure rests on the create path's
read→tag atomicity. If a future change inserts an `await` between
`getContainerInfo` and `addSession`, a create whose read already passed could
still `addSession` while `destroy` is parked at teardown, reopening the strand.
That invariant is called out in a `LOAD-BEARING INVARIANT` comment at the mark
site, with the remedy named: re-check `_destroying` inside `addSession` (which
runs synchronously and would observe the mark). It is not added pre-emptively
because, with `addSession` reached only after `createSession` has already
inserted the entry into `_sessions`, making it *throw* would strand a half-built
entry, and making it *silently skip* would recreate the very strand this fixes —
so the correct closure is a guard in the create path, not in `addSession`, and it
is only warranted once such an `await` actually exists.

## Follow-on (#7568) — the client now SURFACES the refusal and offers the escalation

**Date**: 2026-09-02
**Issue**: #7568 (the "No UI for the escalation yet" item above, now closed)
**Touches**: `packages/protocol/src/schemas/server/environment.ts`
(`ServerEnvironmentErrorSchema` — `code` + `sessions`, landed with #7571),
`packages/store-core/src/handlers/environment.ts` (`handleEnvironmentError`),
`packages/dashboard/src/store/message-handler.ts` (`environment_error` +
`CONTAINER_ACTION_FAILED`), `packages/dashboard/src/store/connection.ts`
(`destroyEnvironment` / `sendContainersAction` gain `force`),
`packages/dashboard/src/components/EnvironmentPanel.tsx`,
`packages/dashboard/src/components/ContainersStatusSection.tsx`
**Pinned by**: `EnvironmentPanel.destroyGuard.test.tsx`,
`ContainersStatusSection.test.tsx`, `dispatch-containers-action.test.ts`,
`message-handler.test.ts` (`environment_error dispatch`),
`store-core/.../handlers.test.ts` (`handleEnvironmentError`).

The server half above refuses correctly, but until #7568 the **client** dropped
the refusal on the floor: `handleEnvironmentError` returned only `{ error }`, and
the dashboard's `case 'environment_error'` was a bare `console.error` — the
operator saw nothing and could not escalate. #7568 closes that:

- **`handleEnvironmentError` now parses `code` and `sessions`** off the wire
  (not just `error`), so both the notification and the panel can name the ids.
- **The dashboard surfaces it.** `environment_error` now raises a real toast via
  `addServerError`; the `ENVIRONMENT_HAS_LIVE_SESSIONS` case NAMES the sessions
  and uses the non-destructive **warning** register (the guard did its job —
  nothing broke). Every other environment failure stays a red error.
- **The EnvironmentPanel Destroy affordance** drops the flat
  `disabled={env.sessions.length > 0}` dead-end. Destroy always opens a confirm;
  the live-session branch names the sessions and offers **Force destroy**, which
  re-sends `destroy_environment` with `force: true`. The empty-environment path
  sends **no** `force` field.
- **The Control Room Containers row** reads the `reason: 'live-sessions'`
  discriminator off the `CONTAINER_ACTION_FAILED` reply (recorded as
  `liveSessions` on the inline result) and offers a **Force destroy** button that
  routes through its own confirm and re-sends `containers_action destroy` with
  `force: true`. An operational `destroy-failed` stays a plain error with no
  escalation.

**`force: true` is sent on exactly one path on each surface — the explicit
force-confirm.** The plain destroy on both surfaces omits the field, so the
initial attempt still hits the server refusal and the cascade is always an
operator's explicit second choice, never an accident. This is the client mirror
of the server's strict-boolean `force`.

**Two sources of truth, deliberately.** The EnvironmentPanel pre-empts using the
per-card `env.sessions` it already renders (same server-authoritative list the
refusal carries), so the operator gets the escalation on the first click rather
than after a round-trip; the async refusal toast still fires and covers the race
where a session attached after the last `environment_list` broadcast. The
Containers row reacts to the recorded refusal (`liveSessions`) because its inline
per-row result cell is already the surface a failed action renders into. Both
are correct; each matches the surface it lives on.
