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

## Handshake Sequence

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
     │                                  │── { type: 'event', payload: <object|string> }
     │                                  │── { type: 'stderr', data: '...' }
     │                                  │── { type: 'exit', code: 0 }
     │                                  │   (WS close follows within 50 ms)
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

#### `ping`

Client-side heartbeat.  Agent replies with `{ type: 'pong' }`.

```json
{ "type": "ping" }
```

---

### Agent → Client

#### `event`

One NDJSON line from the child process's stdout, parsed into `payload`.  If
the line is not valid JSON the raw string is forwarded as `payload`.

```json
{ "type": "event", "payload": { ...claude-sdk-event... } }
```

#### `stderr`

A chunk of raw text from the child process's stderr stream.

```json
{ "type": "stderr", "data": "some error text\n" }
```

#### `exit`

Child process exited.  The WS connection is closed by the agent within 50 ms
of sending this frame.

```json
{ "type": "exit", "code": 0 }
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
| Unknown message type                | `error` frame, connection stays open               |
| Child process spawn failure         | `error` frame, connection stays open               |
| Invalid JSON frame from client      | `error` frame, connection stays open               |

---

## Future Work

**#3321 — Session resume / reconnect**

A `resume` frame type and `sessionId` / `seq` fields will be added to support
reconnecting to an in-flight claude process after a network disruption.  The
hook point is marked in `agent.js` with a `#3321` comment.

Planned additions:
- Client → agent: `{ type: 'resume', sessionId: string, seq: number }` — resume
  an existing process, replaying any buffered output since `seq`
- `event` frames will gain an optional `seq` field (monotonic counter per session)
- `spawn` may gain an optional `sessionId` field to pre-assign an ID for later
  resume
