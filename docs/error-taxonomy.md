# WebSocket Error Response Taxonomy

The Chroxy server emits **three** distinct error message types over the
WebSocket protocol. Each type has a different shape and a different meaning.
Clients (mobile app, web dashboard, desktop) must handle all three; server
handlers must choose the type that best matches the failure class.

> **Compatibility:** These three types are load-bearing. Do **not** rename,
> remove, or collapse them. Existing clients branch on `type` and would break.

## 1. `error` — transport / protocol / validation errors

```json
{
  "type": "error",
  "code": "INVALID_MESSAGE",
  "message": "expected object, received string",
  "requestId": null,
  "correlationId": "abc123",
  "details": "..."
}
```

**When to emit.** The incoming WebSocket message was malformed, failed Zod
schema validation, came from an unauthenticated client, or was otherwise
rejected before reaching a handler. These errors are **client-caused** and
not usually retryable without a code fix on the client.

**Where it comes from.**
- `ws-auth.js` — invalid auth payload, unknown message types during handshake
- `ws-server._handleMessage` — `ClientMessageSchema.safeParse` failure path
- `handler-utils.sendError(ws, requestId, code, message)` — utility for handler
  validation errors where a stable `code` is needed

**Client behavior.** Surface the `message` (or map `code` to a localized
string), clear loading state, do not retry automatically.

## 2. `server_error` — server-side handler failure

```json
{
  "type": "server_error",
  "message": "Failed to list repos: ENOENT",
  "recoverable": true,
  "correlationId": "abc123",
  "category": "repo",
  "sessionId": "session-42"
}
```

**When to emit.** A handler threw an unhandled exception, a background
operation failed, or a required server-side resource is unavailable. These
errors are **server-side** and not the client's fault.

- `recoverable: true`  — the client may retry the same request.
- `recoverable: false` — fatal connection state; the client should reconnect.

**Where it comes from.**
- `ws-server._handleMessage` — outer catch around all handler dispatch
- `ws-server.onMessage` — outer catch around decryption + routing
- `ws-history.js` — encryption key-exchange timeout (`recoverable: false`)
- `ws-auth.js` — client failed to initiate required key exchange (`recoverable: false`)
- `ws-broadcaster.js` — broadcast delivery failures
- `handlers/repo-handlers.js` — repository enumeration failures

**Client behavior.** Surface the `message`, clear loading state. If
`recoverable: true`, optionally offer a "retry" action. If
`recoverable: false`, prompt the user to reconnect.

## 3. `session_error` — session-scoped operation error

```json
{
  "type": "session_error",
  "message": "Session not found: session-42",
  "sessionId": "session-42",
  "code": "SESSION_TOKEN_MISMATCH"
}
```

**When to emit.** A session operation failed in an expected, user-facing
way — the session doesn't exist, the client isn't authorized for it, the
requested feature isn't supported by the session's provider, or the caller
passed invalid arguments for a session-scoped operation.

**Where it comes from.**
- `handlers/session-handlers.js` — session create/destroy/rename/switch
- `handlers/conversation-handlers.js` — resume, context lookup, auth
- `handlers/checkpoint-handlers.js` — create/restore checkpoint
- `handlers/input-handlers.js` — input while paused, invalid attachments
- `handlers/settings-handlers.js` — thinking level, permission rules
- `handlers/feature-handlers.js` — extension messages
- `handlers/repo-handlers.js` — cwd validation, add-repo argument errors

**Client behavior.** Surface the `message` in the session's chat area or as
a banner, clear per-session loading state. The optional `code` (e.g.
`SESSION_TOKEN_MISMATCH`) may drive specific recovery flows.

### `SESSION_TOKEN_MISMATCH` — canonical four-field contract

When the rejection code is `SESSION_TOKEN_MISMATCH`, the inner payload
always contains exactly four fields regardless of which envelope carries it
(`session_error`, `web_task_error`, the generic `error` type, or the HTTP
403 body):

```json
{
  "code": "SESSION_TOKEN_MISMATCH",
  "message": "Not authorized to access this session",
  "boundSessionId": "session-42",
  "boundSessionName": "My Project"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `code` | `string` | Always `"SESSION_TOKEN_MISMATCH"`. |
| `message` | `string` | Human-readable description, suitable for display. |
| `boundSessionId` | `string\|null` | The session ID the client token is bound to. `null` when the client has no binding (e.g. the HTTP fallback path) or when the binding is stale and unresolvable. |
| `boundSessionName` | `string\|null` | Display name of the bound session, looked up at emit time. `null` when `boundSessionId` is null or the session can no longer be resolved. |

**Envelope parity.** The same four fields appear on every emit path:

| Envelope | Source | Trigger |
| --- | --- | --- |
| `type: "session_error"` | `handlers/session-handlers.js`, `handlers/conversation-handlers.js`, `handlers/feature-handlers.js` | Bound client attempts to access a different session via the named-session flow. |
| `type: "error"` (via `sendError`) | `handlers/settings-handlers.js` — `permission_response` | Bound client submits a response for a permission request that originated on a different session. |
| `type: "web_task_error"` | `handlers/feature-handlers.js` — `web_task_*` dispatch | Bound client issues a web-task command against a session it is not bound to. |
| HTTP `403` JSON body | `packages/server/src/http-routes.js` — `POST /permission-response` | Legacy HTTP response path; session mismatch detected on the bound-session check. |

**Server-side source of truth.** Every emit site calls
`buildSessionTokenMismatchPayload()` in
`packages/server/src/handler-utils.js`, which centralises the shape so
clients can branch on `code === 'SESSION_TOKEN_MISMATCH'` without reading
each handler to discover which fields are present.

**Client recovery.** Use `boundSessionId` / `boundSessionName` to surface
an actionable message — e.g. "Device paired to _My Project_. Disconnect and
reconnect to switch sessions." Do not retry the rejected operation
automatically; the binding is enforced at the token level and will not
change without a new auth handshake.

See also [`docs/troubleshooting/session-token-mismatch.md`](troubleshooting/session-token-mismatch.md)
for the full diagnostic runbook including `[session-binding-*]` log
correlation.

## Choosing the right type (handler author checklist)

When you need to send an error from a handler, ask:

1. **Did the WebSocket message fail to parse or validate?**
   → `error` (usually handled by the schema layer, not your handler).

2. **Did my handler throw an unexpected exception?**
   → Don't send anything — the outer catch in `_handleMessage` will emit
   `server_error` with the `correlationId` already in scope.

3. **Is this an expected, user-facing failure of a session operation?**
   → `session_error` via `ctx.send(ws, { type: 'session_error', message, ... })`.

4. **Is this a server-side resource failure that is not tied to a specific
   session?** (e.g., filesystem enumeration, external API)
   → `server_error` with explicit `recoverable`.

When in doubt, prefer `session_error` for anything handler-scoped and
`server_error` for infrastructure failures. Do not invent new top-level
error types.
