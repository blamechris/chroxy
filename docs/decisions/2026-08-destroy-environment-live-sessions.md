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

**No UI for the escalation yet.** The dashboard's Destroy button is already
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
