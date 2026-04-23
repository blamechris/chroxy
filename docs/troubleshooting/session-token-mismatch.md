# SESSION_TOKEN_MISMATCH Triage Runbook

Step-by-step guide for diagnosing `SESSION_TOKEN_MISMATCH` errors in production
using the `[session-binding-*]` diagnostic logs introduced for issue
[#2832](https://github.com/blamechris/chroxy/issues/2832).

## Symptom

Clients (app or dashboard) see one of:

- `session_error` or `error` with `code: 'SESSION_TOKEN_MISMATCH'` on
  the WebSocket path (shape depends on call site — most handlers send
  `session_error`; `permission_response` uses the generic `error`
  envelope via `handler-utils.js:sendError`).
- HTTP `403 { "error": "not authorized for this permission request", "code": "SESSION_TOKEN_MISMATCH" }`
  from the legacy `POST /permission-response` HTTP path
  (`packages/server/src/http-routes.js`).

On Android specifically (issue #2832), the most common trigger is:
backgrounding the app while a permission prompt is visible, then tapping
**Approve** after returning. The tap fails with "Not authorized to respond
to this permission request" because the reconnected client's
`boundSessionId` no longer matches the `permissionSessionMap` entry
recorded when the prompt was first issued.

## What the error means

A client is attempting a session-scoped action on a session it is not
bound to. Bound clients (those paired via QR while a session was active)
have a `boundSessionId` stamped on the socket at auth time; every
session-scoped handler compares it against the target session and emits
`SESSION_TOKEN_MISMATCH` on a mismatch.

Call sites (for reference, in `packages/server/src/`):

| Handler | Scenario |
| --- | --- |
| `handlers/session-handlers.js` | `create_session` / `switch_session` / `rename_session` blocks a bound client from escaping its session. |
| `handlers/conversation-handlers.js` | `resume_conversation` / `context_request` on the wrong session. |
| `handlers/feature-handlers.js` | `feature_request` / `web_task_*` on the wrong session. |
| `handlers/settings-handlers.js` | `permission_response` whose `requestId` maps to a different session than the client's binding. **This is the #2832 path.** |
| `ws-permissions.js` | HTTP `POST /permission-response` with mismatched binding. |
| `handler-utils.js` | Generic `resolveSession` / `enforceBoundSession` helpers used by feature wrappers. |

## Step 1 — Enable debug logs

The three `[session-binding-*]` diagnostic logs used for triage are:

| Prefix | Level | Fires when |
| --- | --- | --- |
| `[session-binding-create]` | `debug` | A permission request is registered in `permissionSessionMap`. Emitted from both the SDK path (`ws-forwarding.js`) and the legacy HTTP path (`ws-permissions.js`). Records the origin `sessionId`. |
| `[session-binding-resend]` | `debug` | A pending permission is replayed to a (re)connecting client. Records the target client's `id`, `activeSessionId`, and `boundSessionId`. Both SDK and legacy variants exist. |
| `[session-binding-reject]` | `warn` | `permission_response` is refused because `mappedSessionId !== client.boundSessionId`. This is the warn line you will see at default log level. |

`create` and `resend` are gated at `debug` level (see #2854) to keep prod
logs clean during auto-accept sessions with heavy permission traffic.
`reject` stays at `warn` so it is always visible.

To enable the full correlation trail, restart the server with
`LOG_LEVEL=debug`:

**CLI (default `npx chroxy start`):**
```bash
LOG_LEVEL=debug PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start
```

**Supervisor mode (`--tunnel named`):**
```bash
LOG_LEVEL=debug npx chroxy start --tunnel named
```
The supervisor passes its environment through to each child respawn, so
setting it once on the supervisor process is sufficient.

**Desktop (Tauri tray app):**
Quit the tray app, relaunch from a shell with `LOG_LEVEL=debug` exported:
```bash
LOG_LEVEL=debug /Applications/Chroxy.app/Contents/MacOS/chroxy
```
(macOS GUI launch has a minimal env — launching from a shell with the
env var set is the reliable way to pass it through to the spawned Node
server.)

**Programmatically (tests or embedded use):**
```js
process.env.LOG_LEVEL = 'debug'
// Set before requiring/importing the server so `initFileLogging` and
// the per-module loggers in `packages/server/src/logger.js` pick it up.
```

Revert by removing `LOG_LEVEL` (defaults to `info`) and restarting.

## Step 2 — Reproduce

Reproduce the failure as closely as you can to the reported path. For
#2832 the canonical flow is:

1. Pair the Android app while a session is active.
2. Start a tool call that triggers a permission prompt.
3. Background the app (home button / task switch).
4. Foreground the app — the prompt is still visible.
5. Tap **Approve**. The server emits `SESSION_TOKEN_MISMATCH`.

## Step 3 — Correlate by `requestId`

Grep the server log for the single permission request that was rejected.
The `requestId` is the stable correlation key across all three log lines.

```bash
# Find the reject (warn-level, always visible).
# Log file is ~/.chroxy/logs/chroxy.log (rotated as chroxy.1.log,
# chroxy.2.log, chroxy.3.log — see packages/server/src/logger.js).
grep '\[session-binding-reject\]' ~/.chroxy/logs/chroxy.log | tail -20

# Pick the failing requestId out of the JSON payload, then replay:
REQ=req_abc123   # from the rejected entry
grep -E "\[session-binding-(create|resend|reject)\].*$REQ" ~/.chroxy/logs/chroxy.log
```

Expected timeline for a #2832-shaped failure:

```
DEBUG [session-binding-create] permission req_abc123 created (sessionId=sess-42)
DEBUG [session-binding-resend] permission req_abc123 resent to client client-ios (sessionId=sess-42, activeSession=sess-42, boundSession=sess-42)
WARN  [session-binding-reject] permission_response rejected {"requestId":"req_abc123","decision":"allow","clientId":"client-ios-2","activeSessionId":"sess-42","boundSessionId":"sess-42","mappedSessionId":"sess-99","requestCreatedAt":1713830400000,"clientConnectedAt":1713830461000,"requestAgeMs":61000,"likelyPostReconnect":true}
```

The `[session-binding-reject]` payload includes every correlation field
needed for triage in a single structured line:

| Field | Meaning |
| --- | --- |
| `requestId` | Correlation key — same across create / resend / reject. |
| `decision` | `allow` / `allowAlways` / `deny` as submitted by the client (see `PermissionResponseSchema` in `packages/protocol/src/schemas/client.ts`). |
| `clientId` | Which WebSocket client submitted the response. Different from the `[session-binding-create]` client means a reconnect happened. |
| `activeSessionId` | The session the client is *currently* subscribed to. |
| `boundSessionId` | The session the client's token is *bound* to (set at auth for pairing-issued tokens). |
| `mappedSessionId` | The origin session recorded in `permissionSessionMap` for this `requestId`. Mismatch with `boundSessionId` is the trigger. |
| `requestCreatedAt` | `Date.now()` when the permission prompt was issued. |
| `clientConnectedAt` | `Date.now()` of the submitting client's auth handshake. |
| `requestAgeMs` | `now - requestCreatedAt`. |
| `likelyPostReconnect` | `true` if the request is older than 30s **or** the client connected after the prompt was issued. Heuristic for "this is probably the #2832 background-reconnect path." |

## Step 4 — Classify the failure mode

Using the fields above, most SESSION_TOKEN_MISMATCH cases fall into one
of these buckets:

1. **`likelyPostReconnect: true`, all three session ids equal each other
   except `mappedSessionId` differs** — the #2832 pattern. The
   `permissionSessionMap` entry predates the client's current auth; on
   reconnect the mapping was not updated (or was overwritten to a new
   session id by the resend path). This is the active root-cause
   investigation on [#2832](https://github.com/blamechris/chroxy/issues/2832).

2. **`boundSessionId !== activeSessionId`** — the client is bound to
   session A but sent a response on behalf of session B. This is the
   attack the binding check was added to prevent (agent-review of PR
   #2806, blocker 5). Legitimate clients should never reach this state.

3. **`boundSessionId` set, `mappedSessionId: null`** — the request was
   never registered in `permissionSessionMap`, or its entry was consumed
   by a previous response. Check for duplicate `permission_response`
   submissions or a server restart between create and response.

4. **No `[session-binding-create]` for this `requestId`** — the prompt
   was issued before `LOG_LEVEL=debug` was enabled. Re-reproduce after
   restart.

## Step 5 — Attach to the issue

For the active #2832 investigation, attach the full correlation
triplet (create + resend + reject lines for the same `requestId`) to
the issue. The `likelyPostReconnect`, `requestAgeMs`, and the delta
between `[session-binding-create]`'s `sessionId=` and the reject's
`mappedSessionId` are the fields that narrow down which of the three
hypotheses on #2832 applies.

## Related

- Issue [#2832](https://github.com/blamechris/chroxy/issues/2832) — active
  root-cause investigation for the Android background-reconnect failure.
- PRs [#2851](https://github.com/blamechris/chroxy/pull/2851),
  [#2854](https://github.com/blamechris/chroxy/pull/2854), and
  [#2882](https://github.com/blamechris/chroxy/pull/2882) — introduced
  and hardened the diagnostic logs.
- PR [#2911](https://github.com/blamechris/chroxy/pull/2911) — enriched
  `SESSION_TOKEN_MISMATCH` error payloads with `boundSessionName` so the
  app and dashboard can surface an actionable "Device paired to one
  session" alert with a Disconnect button. Only applies to the two
  new-session-creation paths in `session-handlers.js` /
  `conversation-handlers.js`; the permission-response and feature-handler
  paths still return the generic message.
- `docs/error-taxonomy.md` — the three WebSocket error response shapes
  (`error`, `server_error`, `session_error`). `SESSION_TOKEN_MISMATCH`
  may arrive as either `session_error` or `error` on the WebSocket path
  (the `permission_response` handler uses the generic `error` envelope
  via `handler-utils.js:sendError`), or as a 403 JSON response on the
  legacy HTTP path.
