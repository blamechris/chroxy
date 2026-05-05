# chroxy-pod-agent WebSocket Protocol

The `chroxy-pod-agent` sidecar exposes an HTTP/WS server inside each K8s pod.
`K8sBackend` (issue #3320) is the sole client; no other services should connect.

---

## Transport

- HTTP server on `$PORT` (default `7681`), bound to `0.0.0.0`
- WebSocket upgrade at any path (the agent does not route by path)
- Frames are UTF-8 JSON objects, one per WS message

---

## Auth

All WS upgrades must carry:

```
Authorization: Bearer <CHROXY_AGENT_TOKEN>
```

`CHROXY_AGENT_TOKEN` is injected into the pod via a K8s Secret and read once at
startup.  The comparison is constant-time (`crypto.timingSafeEqual`) to
prevent timing attacks.

If the env variable is unset the agent starts but rejects **all** upgrades with
`401 Unauthorized` and logs a startup warning — fail-secure by default.

The `/healthz` endpoint does **not** require auth (K8s readiness/liveness
probes cannot carry headers).

---

## Handshake Sequences

### New Session

```
K8sBackend                       chroxy-pod-agent
     │                                  │
     │── GET /healthz ──────────────────▶ 200 { ok: true, version }
     │                                  │
     │── WS Upgrade (Authorization: Bearer <token>) ──▶
     │                                  │   reject → 401 (socket end, no WS frame)
     │                                  │   accept → WS connection open
     │                                  │
     │── { type: 'spawn', ... } ────────▶
     │◀─ { type: 'session_started', sessionId }
     │◀─ { type: 'event', payload: <object|string>, seq: N }
     │◀─ { type: 'stderr', data: '...', seq: N }
     │◀─ { type: 'exit', code: 0, seq: N }
     │                                  │   (WS close follows within 50 ms)
```

### Resume After Reconnect

```
K8sBackend                       chroxy-pod-agent
     │                                  │
     │── WS Upgrade (Authorization: Bearer <token>) ──▶
     │                                  │   accept → WS connection open
     │                                  │
     │── { type: 'resume', sessionId, lastSeq } ──▶
     │◀─ { type: 'event', ..., seq: N+1 }   (buffered frames replayed)
     │◀─ ...
     │◀─ { type: 'exit', code: 0, seq: M }
     │                                  │   (WS close follows within 50 ms)
```

### Session Lost After Agent Restart

```
K8sBackend                       chroxy-pod-agent
     │                                  │
     │── WS Upgrade ───────────────────▶
     │                                  │
     │── { type: 'resume', sessionId } ─▶
     │◀─ { type: 'session_lost', sessionId }
     │                                  │   (connection stays open for a new spawn)
```

---

## Frame Reference

### Client → Agent

#### `spawn`

Start a child process inside the pod.

```json
{
  "type": "spawn",
  "cmd":  "claude",
  "args": ["--input-format", "stream-json", "--output-format", "stream-json", "-p"],
  "env":  { "CLAUDE_HEADLESS": "1" },
  "cwd":  "/workspace"
}
```

| Field  | Type              | Required | Description                                        |
|--------|-------------------|----------|----------------------------------------------------|
| `cmd`  | string            | yes      | Binary to execute                                  |
| `args` | string[]          | no       | Argument list (default `[]`)                       |
| `env`  | object (strings)  | no       | Extra env vars merged on top of the agent's env    |
| `cwd`  | string            | no       | Working directory for the child process             |

#### `resume`

Reconnect to an existing in-flight session after a network blip.

```json
{ "type": "resume", "sessionId": "<uuid>", "lastSeq": 42 }
```

| Field       | Type    | Required | Description                                           |
|-------------|---------|----------|-------------------------------------------------------|
| `sessionId` | string  | yes      | The session UUID received in the prior `session_started` frame |
| `lastSeq`   | number  | no       | Highest `seq` the client has processed (default `0`). Frames with `seq > lastSeq` are replayed. |

#### `ping`

Client-side heartbeat.  Agent replies with `{ type: 'pong' }`.

```json
{ "type": "ping" }
```

---

### Agent → Client

#### `session_started`

Sent immediately after `spawn` is accepted, before any output frames.
The client must store `sessionId` to send a `resume` frame if it needs to
reconnect.

```json
{ "type": "session_started", "sessionId": "550e8400-e29b-41d4-a716-446655440000" }
```

#### `event`

One NDJSON line from the child process's stdout, parsed into `payload`.  If
the line is not valid JSON the raw string is forwarded as `payload`.

```json
{ "type": "event", "payload": { ...claude-sdk-event... }, "seq": 1 }
```

#### `stderr`

A chunk of raw text from the child process's stderr stream.

```json
{ "type": "stderr", "data": "some error text\n", "seq": 2 }
```

#### `exit`

Child process exited.  The WS connection is closed by the agent within 50 ms
of sending this frame.

```json
{ "type": "exit", "code": 0, "seq": 3 }
```

#### `session_lost`

Sent in response to a `resume` frame when the agent has no record of the
given `sessionId` (e.g. the agent process restarted and lost all session
state).  The connection stays open; the client may open a new session with
`spawn` or simply close.

```json
{ "type": "session_lost", "sessionId": "550e8400-e29b-41d4-a716-446655440000" }
```

#### `pong`

Response to a client `ping`.

```json
{ "type": "pong" }
```

#### `error`

Protocol or runtime error.

```json
{ "type": "error", "message": "spawn: cmd is required" }
```

---

## One Active Client

The agent enforces a single active WS client at a time.  A second connection
attempt is accepted at the TCP/WS level (so the handshake completes and auth
is validated) but is then immediately rejected with:

```json
{ "type": "error", "message": "another client is already connected" }
```

followed by `ws.close(1008)`.  The first connection is unaffected.

---

## One Spawn Per Connection

Each connection may run **one** child process at a time.  A second `spawn`
frame on a connection that already has a running child is rejected with:

```json
{ "type": "error", "message": "spawn: child already running" }
```

The first child continues unaffected.  K8sBackend (#3320) is the sole consumer
and is expected to open one connection per session; multi-spawn semantics are
not part of this protocol.

---

## Session Lifecycle and Resume Semantics

When a `spawn` is accepted the agent assigns a UUID `sessionId` and begins
buffering output frames (up to `CHROXY_AGENT_BUFFER_SIZE`, default 1000).
Each frame carries a monotonically increasing `seq` number scoped to the
session.

When the WS connection closes — for any reason other than a natural child
exit — the **child process continues running** inside the pod.  This allows
a reconnecting client to resume the session and receive replayed output.

When the client reconnects it sends `{ type: 'resume', sessionId, lastSeq }`.
The agent replays any buffered frames with `seq > lastSeq` and then resumes
live forwarding.

If the agent has no record of the `sessionId` (e.g. the agent process
restarted), it sends `{ type: 'session_lost', sessionId }`.  The child process
is gone in this case; the session is unrecoverable.

### PID 1 Reaping Limitation

This resume mechanism survives **network blips** (transient WS disconnects)
only.  It does **not** survive agent process restarts.  If the pod is evicted,
OOM-killed, or the `chroxy-pod-agent` process itself crashes, the in-pod child
is reaped by PID 1 (the container init process) and all session state is lost.
The reconnecting K8sBackend will receive `session_lost` and surface `exit(-2)`
to the caller.

True cross-restart session persistence (disk-backed buffer, NATS, etc.) is
deferred to a later phase.

---

## Orphan Prevention

When the child exits naturally the agent sends an `exit` frame and closes the
WS within 50 ms.  If the agent itself is shut down (`SIGTERM`/`SIGINT`), all
running children are sent `SIGTERM` with a 5 s `SIGKILL` escalation.

In contrast to the pre-#3321 behaviour, a WS disconnect alone **no longer
kills the child** — it keeps running to support resume.

---

## Stream Ordering Guarantees

Frames produced by the agent have the following ordering properties:

- **Same-stream order is preserved.**  All `event` frames arrive in the order
  the child wrote NDJSON lines to stdout.  All `stderr` frames arrive in the
  order the child wrote bytes to stderr.
- **Cross-stream order is NOT preserved.**  stdout is line-buffered (via
  `readline`), so an `event` frame is only emitted on a newline.  stderr is
  forwarded as raw `data` chunks the moment they arrive.  This means a stderr
  byte written *before* a stdout newline can appear *after* the resulting
  `event` frame on the wire — and vice-versa, a partial stdout line that
  finally completes can flush *after* later stderr writes.
- **`seq` is cross-stream.**  The `seq` counter increments for every emitted
  frame regardless of stream (event/stderr/exit), so it provides a total
  ordering of all output frames within a session.

Consumers that need to interleave the two streams (e.g. for log display) must
buffer them locally and reconcile by `seq` or timestamp — the wire order of
`event` and `stderr` frames is not authoritative.

The terminal `exit` frame is always the last frame on the connection, after
which the WS close handshake follows within 50 ms.

---

## Ping / Pong Keepalive

The agent sends a WebSocket `ping` frame (not a `{ type: 'ping' }` JSON frame)
to the active client every 30 seconds.  If no `pong` is received before the
next tick the connection is terminated with `ws.terminate()`.

Clients may also send `{ type: 'ping' }` JSON frames at any time; the agent
replies with `{ type: 'pong' }`.

---

## Error Cases

| Condition                           | Agent behaviour                                    |
|-------------------------------------|----------------------------------------------------|
| No `Authorization` header           | `401` socket end, no WS frame                      |
| Wrong token                         | `401` socket end, no WS frame                      |
| `CHROXY_AGENT_TOKEN` not set        | `401` socket end for all upgrades + startup warn   |
| Second WS connection                | Auth validated, then `error` frame + close `1008`  |
| `spawn` without `cmd`               | `error` frame, connection stays open               |
| `spawn` while child already running | `error` frame, first child unaffected              |
| Unknown message type                | `error` frame, connection stays open               |
| Child process spawn failure         | `error` frame, connection stays open               |
| Invalid JSON frame from client      | `error` frame, connection stays open               |
| `resume` with unknown sessionId     | `session_lost` frame, connection stays open        |
| `resume` while session has active client | `error` frame + close `1008`                  |

---

## Future Work

**Disk-backed session buffer**

The current in-memory ring buffer is lost when the agent process exits.  A
disk-backed buffer (e.g. append-only log file per session) would allow
recovery from agent restarts, not just network blips.

**Multi-client session**

The single-client policy is intentional for Phase 1.  Future work could allow
multiple observers to attach to a session (e.g. a monitoring dashboard and the
active K8sBackend).

**Cross-Pod session migration**

A session that survives pod rescheduling would require distributed session
state (e.g. Redis or a shared volume).  Not planned in the near term.
