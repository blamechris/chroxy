# Session-side container-vanish resilience (#7569 / #7599)

**Status:** accepted (2026-09-02) · **Scope:** server · **all five slices shipped**
(#7599, #7601, #7600, #7602 server-side; #7603 clients)

## Context

`containers_action` `stop` / `restart` (and a plain `docker stop` / `restart` / `kill`
run OUTSIDE chroxy) kill the process a containerized session is running inside. The
daemon and the `SessionManager` entry survive, but the session is left pointing at a
container it can no longer talk to. #7562 refused **destroy** on live sessions and
#7571 fixed the **daemon-restart restore** path (persist the binding, then re-resolve
via `getContainerInfo()` or throw `ENVIRONMENT_UNAVAILABLE`). Neither runs while the
daemon is alive, so the **live** path had no detection, no coded surface, and no
recovery — the docker-sdk path emitted a generic per-turn error and the docker-cli
path burned its respawn budget to reach an opaque `cli_respawn_exhausted`.

## Decision

**Owner decision (2026-09-02): session-side resilience.** Leave `containers_action`
stop/restart as-is (they do NOT gate on `env.sessions`); instead a containerized
session **detects** its container vanishing and **self-handles**: surfaces it visibly
and, where possible, reconnects. This also covers an external `docker stop` that never
flows through chroxy — which a handler-side gate never could.

This document records the **foundation** (#7599): detection + a single coded
`CONTAINER_VANISHED` session error on both exec-based paths. Reconnect (#7602),
proactive/idle detection (#7601), docker-byok (#7600) and the client render (#7603)
build on it.

## The invariant taxonomy

1. **Fail visibly, never silently.** A vanished container surfaces exactly one coded
   `CONTAINER_VANISHED` error (per close / per failed turn). It is emitted as an `error`
   event; the generic normalizer (`event-normalizer.js`) forwards its `code` to clients
   unchanged — the same wire path `cli_respawn_exhausted` / `stream_stall` /
   `resume_unknown` use — so **the `code` is the surfaced signal and no wire change is
   needed.** (The normalizer caps adjacent fields, so a `recoverable` flag would be
   silently dropped; it is deliberately not emitted here — see invariant 3.)
2. **Never fall back to the host, never launch a fresh/default container.** The
   `DockerSdkSession` constructor reads an absent `containerId` as
   `_containerOwned = true`, so `start()` would launch a brand-new default
   `node:22-slim` (the #7561 trap). Therefore **`_containerId` is never nulled** on
   the live path, and the vanish never triggers `start()` / `_startContainer`. On the
   next turn a still-gone container simply re-detects and re-surfaces.
3. **Recoverable ≠ terminal — as a server-side behavior, not a wire flag.**
   `CONTAINER_VANISHED` is a container-lost state distinct from a code crash
   (`cli_respawn_exhausted`). The session is **kept**, not dropped (no
   `respawn_exhausted`, no `destroy`), so reconnect (#7602) has something to re-attach —
   that "keep the session" behavior is the recoverability, decided and acted on
   server-side, **not** carried as a wire flag. Whether a given container actually
   returns is a reconnect concern:
   - **env-backed** containers are named (`chroxy-env-<id>`) and **not `--rm`**, so they
     survive a stop and keep their id → reconnectable (#7602).
   - **per-session / self-owned** containers — `DockerSession` always, `DockerSdkSession`
     and `DockerByokSession` when they launched their own — use `--rm`, so Docker removes
     them the moment they stop → terminal; still fail-visible, just not reconnectable.

   **This split is enforced by construction, not by convention**, which is what makes it
   safe to rely on downstream: a create carrying an `environmentId` is FORCED to
   `provider: 'docker-sdk'` (the env opts are spread last, overriding whatever provider
   was requested). So "env-bound" and "is a `DockerSdkSession` holding a named, `--rm`-free
   container" are the same set. `DockerSdkSession` is consequently the only provider that
   implements `reattachContainer`, and the other two are terminal **by construction** —
   no allow-list, no provider check, nothing to keep in sync. This is the single
   authoritative statement of the split; the Mechanism sections below apply it rather than
   restate it.
4. **A user Stop is not a vanish.** Detection runs only for a genuine unexpected exit,
   after the intentional-stop branch has already claimed the close (`_consumeIntentionalStop`
   on the CLI path; `wasIntentionalStop` on the SDK path).

## Mechanism (#7599)

Both exec-based paths **actively probe** the container rather than trusting the closed
exec's stderr. The shared `probeContainerGone(containerId)` helper runs
`docker exec <id> true` and classifies the PROBE's own stderr (pure docker-client
output) via `classifyDockerError`, resolving `true` only on a confirmed `container_gone`.
This was a **review correction**: an earlier draft classified the docker-cli path's
buffered exec stderr, which mixes docker-client errors with the app's own output — so a
benign app line containing "is not running" produced a false vanish (and suppressed
respawn → stuck session), and an in-flight kill with no docker-client line was missed on
the first close. Probing removes both failure modes and makes the two paths symmetric.

- **`classifyDockerError`** (`docker-session.js`) gains a `container_gone` bucket
  matching `No such container` / `is not running`, distinct from a dead daemon or a
  missing image. The probe reuses it on its own (uncontaminated) stderr.
- **docker-cli** (`DockerSession` → `CliSession`): `_handleContainerGoneOnClose(code)` —
  called by `CliSession._handleChildClose` before the generic crash→respawn tail —
  returns a Promise, so the base **defers** the generic respawn until the probe resolves.
  On a confirmed vanish it emits `CONTAINER_VANISHED` and resolves `true` to **suppress
  the respawn** (respawning a `docker exec` into a stopped/removed container only flaps);
  otherwise the generic respawn runs. A healthy-container crash still respawns as before.
- **docker-sdk** (`DockerSdkSession` → `SdkSession`): the SDK's query rejection does not
  carry the docker stderr, so `_classifyContainerFailure(err)` — a hook called in the
  query catch before the generic surface — probes and emits `CONTAINER_VANISHED` only on
  a confirmed container-gone.
- **Teardown race:** both paths re-check `_destroying` **after** the (up-to-10s) probe
  await before emitting — a `destroy()` landing in the probe window has already removed
  listeners, and emitting `error` onto a dead `EventEmitter` throws in Node.

Both base classes ship a no-op hook (`false` / `null`), so host-CLI and in-process SDK
sessions are unaffected — the host CLI path stays fully synchronous.

## Mechanism (#7601) — proactive poll + the environment fast-path

The #7599 paths are all **reactive**: each needs a live turn or a live exec child to
notice anything. A `docker stop` run OUTSIDE chroxy against an **idle** session fires
no chroxy event and closes no exec, so nothing detects it until the user's next turn.
`ContainerLivenessMonitor` (`container-liveness-monitor.js`) is that missing detector,
and it is the ONLY one for that case.

- **Docker-agnostic by construction.** The module's only import is the logger; it never
  shells out. Everything Docker-shaped arrives through two injected seams:
  - `enumerate() => Array<{sessionId, containerId, session}>` — **synchronous**, not a
    promise. Returns the live containerized poll targets.
  - `inspect(containerId) => Promise<'running' | 'gone' | 'unknown'>`.
- **Interval.** `DEFAULT_LIVENESS_INTERVAL_MS = 30_000`, overridable per instance via the
  ctor's `intervalMs`, which `SessionManager` re-exposes as `containerLivenessIntervalMs`
  and spreads in only when non-null. No config key maps to it and `server-cli` never
  passes it, so **production always runs at 30s**; the opt exists for tests.
- **Wiring.** `SessionManager` builds the monitor ONLY when a `containerInspect` seam was
  injected — otherwise the field is null and nothing ever polls, so an embedding that
  wired no inspect degrades to #7599's reactive-only behaviour. `server-cli` supplies it
  unconditionally (a dedicated stateless Docker backend wrapped by
  `inspectContainerLiveness`) and starts the poll at boot.
- **No overlapping ticks.** A plain `_ticking` re-entrancy flag, set at the top of `_tick`
  and cleared in a `finally`. The `setInterval` callback deliberately does not await the
  tick, so this flag is the only overlap protection. The timer is `unref`'d, so the poll
  never holds the daemon's event loop open.
- **One inspect per distinct container.** Targets are grouped into a `Map` keyed by
  `containerId`; each distinct container is inspected exactly once per tick, all of them
  concurrently, and the verdict fans out to every session bound to that container. The
  whole target object is carried (not just the session) because the recovery edge needs
  `sessionId`. Malformed targets — missing `containerId` or `session` — are dropped
  before batching.
- **Verdicts.** `'gone'` → `notifyContainerVanished()` and move on. `'running'` → the
  clear/recovery branch. `'unknown'` → return, touching no latch: this is the fail-closed
  no-op, and an inspect that THROWS is coerced to `'unknown'` for exactly that reason (a
  dead Docker daemon must not read as a fleet of vanished containers).

**The fan-out is CLOSED over those three values (#7620).** `inspect` is an injection
seam, so the monitor does not rely on `inspectContainerLiveness` — the only production
inspect — to be the only implementation: `'running'` is tested explicitly, and any
unrecognised verdict (a typo'd string, a future seam, a `null`) degrades to the same
no-op as `'unknown'`, with a warn naming the verdict because an unrecognised one means
the seam itself is broken. It originally did not: `unknown → return`, `gone → notify`,
**everything else** → the clear/recovery branch, so a mis-implemented seam cleared
latches and could fire `onRecovered` — the opposite direction from the fail-closed
guarantee the recovery edge advertises for a missing boolean. Both halves of the
fail-closed direction now hold: a broken *inspect* seam and a `clearContainerVanished`
that returns nothing each yield "no reconnect attempted", never a spurious one.

**The fast-path dual.** `ws-server` subscribes to `environment_stopped` and
`environment_restarted` and surfaces the same vanish immediately rather than up to 30s
later. The two mechanisms do not coordinate: double-emission is deduped by the shared
per-session latch. Coverage is stop/restart ONLY — `environment_destroyed` (reachable with
`force: true` past #7562's live-session guard) and `environment_restored` (a snapshot
restore, which swaps the environment's container id) get no fast path and fall to the poll.
The restore case is the interesting one: the session's `_containerId` now names a removed
container, so the poll verdicts `'gone'`, and any later recovery edge lands on
`container_replaced` — fail-visible, never a silent rebind onto the rebuilt container.

**Latch scope, precisely.** `surfaceContainerVanished`'s `_containerVanishedNotified`
latch dedups the poll, the environment fast-path, the docker-cli exec-close and byok —
every emitter that routes through the shared helper. The **docker-sdk turn-reject path is
an explicit exception**: `_classifyContainerFailure` arms the latch DIRECTLY and returns
its payload for `SdkSession` to emit, deliberately re-surfacing once per turn for as long
as the container stays gone. That direct arming is not incidental — it is what makes a
vanish detected mid-turn eligible for the poll's later gone→running transition, so a
turn-detected vanish earns the same re-attach as a poll-detected one.

## Mechanism (#7600) — docker-byok

docker-byok has **no long-lived in-container process**. Its agent loop runs on the host
and the container only ever sees discrete `docker exec` calls, so there is no child whose
exit could report a vanish. Both #7599 mechanisms are therefore unavailable to it, and the
#7601 poll is the only **idle-time** detection it gets.

- **Detection is probe-on-dispatch.** When a container-routed tool throws, the session
  probes the container and, on a confirmed vanish, surfaces `CONTAINER_VANISHED` through
  the shared helper. The gate is `CONTAINER_ROUTED_TOOLS`, a single `Map` that serves as
  both the dispatch table and the probe gate — so a tool added to one cannot be forgotten
  in the other.
- **The gate keys on the TOOL NAME, not on the error's origin.** Container-routed tools
  return `{isError: true}` for logical failures, so the catch is mostly reserved for
  exec-layer throws — but not exclusively: a host-side path validation throw (a missing
  `file_path`, or a path escaping the workspace) still costs one `docker inspect`. The
  verdict comes back `'running'`, the probe returns false, and the plain error text is
  used — harmless, but not free.
- **The throttle is structural, not a timer.** Once `_containerReady` flips false, the
  up-front refusal returns BEFORE the try block, so no later dispatch can probe. That
  bounds the inspect fan-out to roughly one per vanish (concurrent in-flight dispatches
  can each probe once before the flip).
- **Wire text.** The failing tool's result is `Tool <name> failed in docker-byok: <detail>`
  with `CONTAINER_VANISHED_MESSAGE` as the detail; the subsequent up-front refusals read
  `docker-byok: <why> (tool <name>)`. The const is embedded, not the whole string — worth
  knowing before grepping for it.
- **Pool eviction reuses an existing wire.** `markActiveContainerSoiled()` predates this
  slice and already had three callers (`snapshot()`, the snapshot-restore branch of
  `start()`, and the postCreateCommand marker-write failure). #7600 adds a fourth producer
  rather than a new mechanism.

Two scope facts that decide how much of this half ever runs, and which a reader will
otherwise assume the other way:

1. **Pooling is opt-in and off by default.** `_pool` is non-null only when
   `CHROXY_DOCKER_BYOK_POOL` is set AND the session self-owns its container (it is null
   when a `containerId` was supplied, and when a compose file is set). In the default
   configuration `markActiveContainerSoiled()` returns at its first line and the whole
   eviction path is inert.
2. **Soiling matters for the #5043 reason, not for liveness.** A container coupled to a
   previous session's writable layer must never be reused. It is NOT that a successor
   would attach to a dead id — `acquire()` runs a one-shot `_verifyContainer` on a pool
   hit and relaunches fresh on failure, so a stale pooled id costs a wasted round trip and
   nothing worse. The verify is the independent backstop; the soil mark is the intent.

**The two halves of #7600 apply to disjoint session shapes.** Soiling only bites a
self-owned, pool-enabled session. The readiness restore only ever fires for a container
that can be observed running again under the same id — and a self-owned container is
launched `--rm`, so Docker removes it the moment it stops. Net: soiling is for self-owned
pooled sessions, readiness restore is for attached / env-backed / compose sessions, and no
single session exercises both.

**byok's readiness restore is poll-only.** A byok session never carries an
`environmentId` (see #7602 below), so `reattachEnvironmentSessions` never reaches one and
the `environment_restarted` fast path does nothing for it. It also always answers
`provider_unsupported`, so a byok session that genuinely recovered contributes 0 to that
function's count and logs `provider_unsupported` — **the observable success is the restored
`_containerReady`, never the counter or the log line.**

## Mechanism (#7602) — live re-attach

#7599 surfaces the vanish; #7601 notices it while idle. #7602 is what happens when the
container comes BACK: an env-bound session re-affirms its binding so the next turn resumes
inside it, without ever repointing at a different container.

**The trigger is an EDGE, not a level.** `clearContainerVanished()` now RETURNS whether it
actually flipped the latch — symmetric with `notifyContainerVanished`'s "true if it
emitted" — and the monitor's optional `onRecovered` fires only on that gone→running
transition. A level would re-resolve the environment binding of every healthy idle
containerized session every 30s, forever. A provider whose `clearContainerVanished`
returns nothing yields NO edge, so the failure direction is "no reconnect attempted",
never "reconnect attempted spuriously".

**Two triggers, and their ordering is load-bearing.** The poll's recovery edge, and
`environment_restarted` calling `reattachEnvironmentSessions(envId)` **after** the vanish
fan-out — the vanish arms the latch whose clearing IS the edge, so reversing them produces
no reconnect. A plain `environment_stopped` gets the fan-out and no re-attach.

**Recorded because both halves of that handler read DIFFERENT rosters:** the vanish
fan-out iterates `env.sessions` (EnvironmentManager's roster); the re-attach iterates
`SessionManager._sessions` filtered on `entry.environmentId`. An edge is produced only for
a session present in BOTH. A session in `_sessions` but missing from `env.sessions` is
armed by nothing and waits for the poll; a session in `env.sessions` whose entry carries a
different or null `environmentId` is armed and never cleared by the fast path. #7552's
`addSession` tagging is what keeps the two in sync, so the fast path's correctness depends
on it. (The source comment justifies reading `_sessions` for agreement with the POLL, and
is silent about the fan-out it is ordered behind.)

**Which sessions this can reach** follows from invariant 3 above: env-bound implies
`DockerSdkSession`, by construction. That is why the feature-detect on `reattachContainer`
is a complete story rather than a coverage gap — there is no provider allow-list anywhere
in this path, and there is nothing that could drift out of sync with one.

**The outcome set** is eight distinct non-`ok` reasons, returned from nine sites, in gate
order:

| Reason | Emits | Meaning |
|---|---|---|
| `session_gone` (×2 sites) | — | entry or session missing / tearing down |
| `provider_unsupported` | — | no `reattachContainer` on the provider (feature-detect) |
| `not_environment_bound` | — | no `entry.environmentId`: terminal by classification |
| `environments_disabled` | `ENVIRONMENT_UNAVAILABLE` | container environments not enabled |
| `environment_unavailable` | `ENVIRONMENT_UNAVAILABLE` | `getContainerInfo` threw (no such env, or not running) |
| `no_container` | `ENVIRONMENT_UNAVAILABLE` | the environment reports no container |
| `container_replaced` | `ENVIRONMENT_UNAVAILABLE` | the environment now runs a DIFFERENT container |
| `provider_refused` | `ENVIRONMENT_UNAVAILABLE` | the provider declined the binding |

**Three** reasons emit nothing (the two terminal classifications plus the teardown no-op);
**five** go through the `refuse()` closure — one warn and exactly one
`ENVIRONMENT_UNAVAILABLE`. Because the refusal is reachable only from the recovery edge,
and the latch transitions once, a permanently-refusing environment produces one error, not
one every 30s.

**Gate order has an observable consequence:** the feature-detect runs BEFORE the
`environmentId` resolution, so a non-docker-sdk session that IS env-bound reports
`provider_unsupported`, never `not_environment_bound`. Any mapping from outcome back to
cause needs that order or it will name the wrong reason.

**`_containerId` is never nulled and never repointed** (the #7561 trap: an absent id reads
as `_containerOwned` and would launch a fresh default container). This holds on two
separate grounds, and only the first is obvious: every refusal above the provider call
returns before touching the provider at all; and `provider_refused` — which by definition
DOES call it — is safe because all three of `reattachContainer`'s own gates precede its
only two writes, and it contains no assignment to `_containerId` whatsoever.

**A rejected `containerUser` does not fail the re-attach.** `reattachContainer` warns,
KEEPS the previously-validated user, and still returns true — so the re-attach is logged
as succeeded and reports `ok`. What is rejected is the FIELD, not the binding. (The
constructor, given the same input, throws.)

**Why a differing container id is a refusal rather than a rebind.** A stop/start keeps the
container's writable layer, so the in-container `claude` install and the SDK transcript
survive and the resumed turn is genuinely the same conversation. A REBUILT container has
none of that, so re-pointing at it would resume the conversation as a silently blank one.
Refusing is what prevents that.

**That argument is live-path-specific, and the boot path does not share it.**
`_resolveRestoredContainerBinding` never compares the persisted container id against the
environment's current one — it accepts whatever the environment reports. So a rebuilt
environment container is ACCEPTED on a daemon-restart restore and REFUSED live. See
follow-ups.

**#7602 is silent to clients on success.** A successful re-attach emits nothing on the
session and broadcasts nothing — only a log line, and the fast path's return count is
discarded by its caller. The only client-visible artefacts of this slice are #7599's
`CONTAINER_VANISHED` and the refusal's `ENVIRONMENT_UNAVAILABLE`. Everything a user
actually SEES about recovery is #7603.

## What shipped

All five slices are merged. The four server-side ones each have a Mechanism section
above; the client surface is #7603.

| Slice | What it added |
|---|---|
| **#7599** | detection + one coded `CONTAINER_VANISHED` on both exec-based paths |
| **#7601** | the proactive 30s liveness poll (the only detector for an external `docker stop` on an idle session) + the `environment_stopped` / `environment_restarted` fast-path |
| **#7600** | docker-byok: probe-on-dispatch, readiness flip, and pool soiling |
| **#7602** | the recovery edge and live re-attach of an env-bound session, with an eight-outcome refusal set |
| **#7603** | the per-session client surface: a persistent, reconnect-oriented banner on the dashboard and the mobile app, released by a completed turn or an explicit dismiss — never by `claude_ready` |

## Open follow-ups

**#7619**, **#7620** and **#7621** were surfaced by verifying this document's mechanism
against the source rather than against the PR descriptions, which is worth noting: each
one is a place where a code comment or a PR body described a stronger guarantee than the
code implements. Of those, **#7620** is now fixed — see the verdict fan-out above.

- **#7619** — the BOOT restore path accepts a rebuilt environment container that the live
  path refuses (`container_replaced`). The two paths disagree on the same situation, and
  the boot outcome is the silently-blank-session the live refusal exists to prevent. Needs
  a decision, not just a patch.
- **#7621** — the `environment_restarted` arm and clear halves read DIFFERENT rosters, so
  the fast path's correctness depends on #7552's tagging keeping them in sync.
- **#7618** — the cross-client container-lost contract is enforced by two hand-matched
  test files rather than by the shared switch-fixture anti-drift harness, which cannot
  currently assert non-`messages` session-state fields.

Prior art: [`2026-08-destroy-environment-live-sessions.md`](./2026-08-destroy-environment-live-sessions.md).
