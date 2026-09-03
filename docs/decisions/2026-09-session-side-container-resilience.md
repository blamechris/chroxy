# Session-side container-vanish resilience (#7569 / #7599)

**Status:** accepted (2026-09-02) · **Scope:** server · foundation for #7600–#7603

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
   - **per-session** `DockerSdkSession` / `DockerSession` containers use `--rm` → removed
     on stop → terminal; still fail-visible, just not reconnectable.
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

## Consequences / follow-ups

- **#7600** docker-byok: no long-lived process — probe on tool-dispatch failure + evict
  the dead container from the shared pool.
- **#7601** proactive: a `docker inspect` liveness poll (catches an idle session's
  externally-stopped container before the next turn) + an `environment_stopped` /
  `environment_restarted` fast-path.
- **#7602** live reconnect: re-resolve a returned env container via `getContainerInfo`
  and rebind `_containerId` to the SAME id.
- **#7603** clients: a per-session "container stopped — needs attention" surface with a
  reconnect affordance.

Prior art: [`2026-08-destroy-environment-live-sessions.md`](./2026-08-destroy-environment-live-sessions.md).
