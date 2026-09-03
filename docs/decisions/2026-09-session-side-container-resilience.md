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
   `CONTAINER_VANISHED` session error (per close / per failed turn) via the existing
   `session_error` plumbing (`ServerSessionErrorSchema` already carries an optional
   `code` + `recoverable` and is `.passthrough()` — no wire change).
2. **Never fall back to the host, never launch a fresh/default container.** The
   `DockerSdkSession` constructor reads an absent `containerId` as
   `_containerOwned = true`, so `start()` would launch a brand-new default
   `node:22-slim` (the #7561 trap). Therefore **`_containerId` is never nulled** on
   the live path, and the vanish never triggers `start()` / `_startContainer`. On the
   next turn a still-gone container simply re-detects and re-surfaces.
3. **Recoverable ≠ terminal.** `CONTAINER_VANISHED` is emitted `recoverable: true` — it
   is a container-lost state distinct from a code crash (`cli_respawn_exhausted`). The
   session is **kept**, not dropped, so reconnect (#7602) has something to re-attach.
   Whether a given container actually returns is a reconnect concern:
   - **env-backed** containers are named (`chroxy-env-<id>`) and **not `--rm`**, so they
     survive a stop and keep their id → reconnectable (#7602).
   - **per-session** `DockerSdkSession` / `DockerSession` containers use `--rm` → removed
     on stop → terminal; still fail-visible, just not reconnectable.
4. **A user Stop is not a vanish.** Detection runs only for a genuine unexpected exit,
   after the intentional-stop branch has already claimed the close (`_consumeIntentionalStop`
   on the CLI path; `wasIntentionalStop` on the SDK path).

## Mechanism (#7599)

- **`classifyDockerError`** (`docker-session.js`) gains a `container_gone` bucket
  matching `No such container` / `is not running`, distinct from a dead daemon or a
  missing image.
- **docker-cli** (`DockerSession` → `CliSession`): the exec child's stderr is buffered
  (`_recentContainerStderr`); `_handleContainerGoneOnClose(code)` — a hook called by
  `CliSession._handleChildClose` just before the generic crash→respawn tail — classifies
  it and, on a vanish, emits `CONTAINER_VANISHED` and returns `true` to **suppress the
  respawn** (respawning a `docker exec` into a stopped/removed container only flaps).
- **docker-sdk** (`DockerSdkSession` → `SdkSession`): the SDK's query rejection does not
  carry the docker stderr, so `_classifyContainerFailure(err)` — a hook called in the
  query catch before the generic surface — **probes** the container
  (`docker exec <id> true`) and emits `CONTAINER_VANISHED` only on a confirmed
  container-gone; an API/model error with a healthy container falls through to the
  generic surface.

Both base classes ship a no-op hook, so host-CLI and in-process SDK sessions are
unaffected.

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
