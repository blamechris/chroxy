# Adversary v3: Desktop Architecture Audit

**Agent**: Adversary -- Red-team security engineer thinking like an attacker
**Pass**: v3 (re-verification + new attack surface analysis)
**v2 Rating**: 2.0 / 5
**v3 Rating**: 2.0 / 5 (unchanged -- none of the v2 findings have been remediated)
**Date**: 2026-02-28

---

## v2 Findings Re-Verification

All 5 findings from v2 are **confirmed still present** in source code. No remediation has been applied since v2.

### Finding 1: Token Embedded in HTML via `window.__CHROXY_CONFIG__` -- CONFIRMED CRITICAL

**Files reviewed**:
- `packages/server/src/dashboard.js:136-140`
- `packages/server/src/dashboard/dashboard-app.js:6-8`
- `packages/desktop/src-tauri/src/window.rs:25-27`

**Current state**: The token is still embedded directly into rendered HTML as a JavaScript global:

```javascript
// dashboard.js:136-140
window.__CHROXY_CONFIG__ = {
  port: ${port},
  token: ${apiToken ? JSON.stringify(apiToken).replace(/</g, '\\u003c') : '""'},
  noEncrypt: ${!!noEncrypt},
};
```

The `dashboard-app.js` reads it immediately at line 6-8:

```javascript
var config = window.__CHROXY_CONFIG__;
var port = config.port;
var token = config.token;
```

**Attack vectors**:
1. Any browser extension can read `window.__CHROXY_CONFIG__.token` from the page context
2. Token visible in "View Source" and DevTools Elements panel
3. The `getDashboardHtml()` function at `ws-server.js:504` passes `this.apiToken` (the raw token) directly

**Status**: STILL CRITICAL. No remediation.

### Finding 2: Token in URL Query Strings -- CONFIRMED CRITICAL

**File**: `packages/desktop/src-tauri/src/window.rs:25-27`

```rust
let url = match token {
    Some(t) => format!("http://localhost:{}/dashboard?token={}", port, url_encode(t)),
    None => format!("http://localhost:{}/dashboard", port),
};
```

And `ws-server.js:476`:
```javascript
const queryToken = dashUrl.searchParams.get('token')
```

**Exposure paths**:
- WebView navigation history
- Process list (`/proc/PID/cmdline` on Linux, `ps aux` on macOS) if URL is passed as an argument
- Referer header if the dashboard page makes any external request (unlikely with current CSP, but fragile defense)
- `show_fallback` at `window.rs:85-87` also injects token via `win.eval()` -- a separate code injection surface discussed in new findings below

**Status**: STILL CRITICAL. No remediation.

### Finding 3: Config File World-Readable (setup.rs) -- CONFIRMED HIGH

**File**: `packages/desktop/src-tauri/src/setup.rs:34`

```rust
if let Err(e) = fs::write(&path, json_str) {
```

`std::fs::write()` creates files with default permissions (0o644 on Unix). The config file at `~/.chroxy/config.json` contains `apiToken`. Any local user can read it.

The Node server side uses `writeFileRestricted()` with `mode: 0o600`, but the Tauri first-run setup bypasses this completely. This is especially dangerous because the Tauri setup runs **first** (before the Node server ever starts), establishing the initial world-readable permissions that persist indefinitely.

**Attack chain**: Local user reads `~/.chroxy/config.json` -> extracts `apiToken` -> authenticates via WebSocket -> sets `auto` permission mode (with confirmation bypass if they control the WebSocket client) -> arbitrary code execution via Claude Code tools.

**Status**: STILL HIGH. No remediation. Fix is a 3-line change using `std::os::unix::fs::PermissionsExt`.

### Finding 4: Single Token = Total Compromise -- CONFIRMED HIGH

All sessions, all history, all Claude Code conversations on the machine, and arbitrary code execution are accessible with a single token. The `permission_response` Zod schema (`ws-schemas.js:50-54`) validates decisions to `['allow', 'allowAlways', 'deny']`, and `respondToPermission` in `sdk-session.js:506-525` forwards `allowAlways` to the SDK, which permanently whitelists a tool. An attacker who steals the token can:

1. `list_conversations` -- enumerate every Claude Code conversation on the machine
2. `switch_session` to any session -- no per-session authorization
3. `set_permission_mode` to `auto` with `confirmed: true` -- bypass the confirmation challenge
4. `permission_response` with `allowAlways` -- permanently whitelist dangerous tools
5. `input` -- send arbitrary prompts that Claude will execute with all tools available
6. `browse_files` / `read_file` / `get_diff` -- read project source code
7. `list_directory` -- enumerate the home directory

**Status**: STILL HIGH. No per-device tokens, no token rotation, no session-scoped authorization.

### Finding 5: `safeTokenCompare` Has Zero Tests -- CONFIRMED MEDIUM

**File**: `packages/server/src/crypto.js:115-135`

Searched `packages/server/tests/` for any reference to `safeTokenCompare`. **Zero results.** The function has 5 code paths:

1. Both strings, equal length, equal content -> `true`
2. Both strings, equal length, different content -> `false`
3. Both strings, different length -> `false` (length check at line 134)
4. Non-string inputs -> `false` (type guard at line 117-121)
5. Both empty strings -> `false` (explicit at line 133: `maxLen === 0 ? false`)

Path 5 is the most surprising: `safeTokenCompare('', '')` returns `false`. If the server starts with an empty `apiToken` and a client sends an empty token, it would be rejected. This is the correct behavior, but it's completely untested and non-obvious.

**Status**: STILL MEDIUM. No tests added.

---

## New Attack Vectors (v3 Deep Dive)

### NEW-1: CRITICAL -- `win.eval()` Code Injection in Tauri Fallback Window

**File**: `packages/desktop/src-tauri/src/window.rs:79-88`

```rust
let escaped = t
    .replace('\\', "\\\\")
    .replace('\'', "\\'")
    .replace('\n', "\\n")
    .replace('\r', "\\r");
let _ = win.eval(&format!(
    "if (typeof window.__startPolling === 'function') {{ window.__startPolling({}, '{}', '{}'); }}",
    p, escaped, tm
));
```

This injects the API token into JavaScript code executed inside the WebView via `win.eval()`. While the escaping handles single quotes, backslashes, and newlines, it **does not escape**:

- **Backticks** (\`) -- if the JS engine context or future code changes use template literals, this could break
- **`$`** combined with `{` -- template literal injection if context changes
- **Unicode escapes** -- `\u0027` is a single quote that bypasses the `\\'` replacement

More critically: `tunnel_mode` (`tm`) is passed directly from settings without validation. While currently constrained to "quick"/"named"/"none" by the menu handler, if any code path allows arbitrary tunnel mode strings, this becomes a direct JavaScript injection in the Tauri WebView.

The real issue is architectural: using `win.eval()` to pass data into a WebView is an anti-pattern that Tauri explicitly discourages. The correct approach is `app.emit()` events with JSON payloads, which eliminates injection risk entirely.

**Severity**: HIGH (currently mitigated by input constraints, but fragile and one code change away from exploitable).

### NEW-2: HIGH -- `.passthrough()` on Input Schemas Allows Session ID Injection

**File**: `packages/server/src/ws-schemas.js`

12 client-to-server schemas use `.passthrough()`, including `InputSchema` (line 33), `BrowseFilesSchema` (line 101), `ReadFileSchema` (line 106), and `GetDiffSchema` (line 137).

`.passthrough()` means Zod passes through **any additional properties** without validation. Look at how `handleSessionMessage` uses the validated message:

```javascript
// ws-message-handlers.js:100
const targetSessionId = msg.sessionId || client.activeSessionId
```

And:
```javascript
// ws-message-handlers.js:371
const browseSessionId = msg.sessionId || client.activeSessionId
```

The `InputSchema` does NOT define a `sessionId` field, but `.passthrough()` lets it through. A client can send:

```json
{ "type": "input", "data": "delete everything", "sessionId": "other-session-id" }
```

This would target a session the client hasn't explicitly switched to. While the client is already authenticated (same token = same access), this violates the expected invariant that `input` targets the active session. It could cause confusion in multi-client scenarios and bypasses any future per-session authorization.

The same applies to `browse_files`, `read_file`, and `get_diff` -- extra `sessionId` fields pass through validation and override the active session target.

**Note**: `PermissionResponseSchema` (line 50-54) does NOT use `.passthrough()`. This is correct and inconsistent with the other schemas.

**Severity**: HIGH (enables cross-session targeting; blocks future per-session authorization).

### NEW-3: MEDIUM -- CSP in Tauri Allows Arbitrary Localhost Connections

**File**: `packages/desktop/src-tauri/tauri.conf.json:11`

```json
"csp": "default-src 'self' http://localhost:*; connect-src ws://localhost:* http://localhost:*; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"
```

Issues:
1. **`'unsafe-inline'` for scripts**: Allows inline script execution. Combined with XSS, an attacker can execute arbitrary JavaScript in the Tauri WebView. The server-side CSP at `ws-server.js:483` correctly uses nonce-based script-src, but the Tauri-level CSP is weaker and is the one that actually constrains the WebView.
2. **`ws://localhost:*` wildcard**: Allows WebSocket connections to any port on localhost. A malicious or compromised service running on any local port could be contacted from the dashboard.
3. **`http://localhost:*` wildcard**: Same for HTTP. The dashboard could be tricked into making requests to any local service.
4. **No `frame-ancestors`**: The server CSP includes `frame-ancestors 'none'` but the Tauri CSP does not.
5. **No `base-uri` or `form-action`**: Missing restrictions that the server-side CSP includes.

The Tauri CSP is strictly weaker than the server-side CSP. Since the WebView enforces the **intersection** of both CSPs (Tauri CSP is applied by the WebView runtime, server CSP by the HTTP response), the server-side CSP partially compensates. But when the dashboard is loaded as a local file (fallback page), only the Tauri CSP applies.

**Severity**: MEDIUM (degraded defense-in-depth; `unsafe-inline` is the primary concern).

### NEW-4: MEDIUM -- Dashboard Markdown Renderer XSS Surface

**File**: `packages/server/src/dashboard/dashboard-app.js:361-428`

The hand-rolled markdown renderer at lines 361-428 processes Claude's response text and renders it via `innerHTML`. The flow is:

1. Extract fenced code blocks and inline code (pre-escape)
2. `escapeHtml()` the remaining text
3. Apply regex-based markdown transformations (headers, bold, italic, links, lists)
4. Restore code blocks from placeholders
5. Set via `div.innerHTML = renderMarkdown(content)` at lines 617, 1450, 1639

The `escapeHtml` function (line 808-811) covers `&`, `<`, `>`, `"` but **not single quotes**. Single quote escaping is not strictly necessary for the current usage patterns (no single-quoted HTML attributes), but it's a latent vulnerability if the rendering code changes.

The link sanitization at lines 397-403 blocks `javascript:`, `data:`, and `vbscript:` URL schemes, which is correct. However:

1. **The regex uses `\s*` which allows leading whitespace**: `\t\tjavascript:alert(1)` would be blocked, but this is fragile.
2. **URL is only escaped for double quotes** (`url.replace(/"/g, "&quot;")`), but single quotes in URLs are not escaped. Since the `href` uses double quotes, this is currently safe.
3. **Headers (`<h1>`, `<h2>`, `<h3>`) take content directly from regex capture groups** after HTML-escaping. This is safe because the escape happens before the header transformation.

The most dangerous line is `1639`:
```javascript
planContentEl.innerHTML = renderMarkdown(msg.plan);
```

The plan content comes directly from Claude's output via the SDK. If an attacker can manipulate Claude's output (prompt injection), they could inject markdown that, after rendering, produces executable HTML. However, since `escapeHtml` runs before the markdown transformations, this would require finding a bypass in the transformation chain itself.

**Specific bypass attempt**: Can the markdown transformations produce unescaped HTML from escaped input?

- Headers: `&lt;script&gt;` becomes `<h1>&lt;script&gt;</h1>` -- safe
- Bold: `**content**` becomes `<strong>content</strong>` -- safe, content was already escaped
- Links: `[text](url)` -- URL is passed through `escapeHtml` first (since it's in the non-code-block text), then the link regex matches on the escaped text. The `[` and `]` survive escaping. So `[click](http://evil.com)` works, but `[click](javascript:alert(1))` is blocked.

**Conclusion**: The current renderer appears safe against XSS from Claude's output, but the hand-rolled nature means each new markdown feature is a new XSS risk. The code block placeholder mechanism (using `\x00CB` + index) is clever but fragile -- if Claude's output contains `\x00CB0\x00`, it would be replaced with a code block.

**Severity**: MEDIUM (no confirmed bypass, but fragile hand-rolled sanitization with expansion risk).

### NEW-5: LOW -- Forged `permission_response` Can Auto-Approve for Any Session

**File**: `packages/server/src/ws-message-handlers.js:224-249`

```javascript
case 'permission_response': {
  const { requestId, decision } = msg
  if (!requestId || !decision) break
  const originSessionId = ctx.permissionSessionMap.get(requestId) || client.activeSessionId
  // ...
  entry.session.respondToPermission(requestId, decision)
```

The `PermissionResponseSchema` properly validates `decision` to `['allow', 'allowAlways', 'deny']` (no `.passthrough()`), and the `requestId` must match a pending permission. So a client cannot forge a permission response for a request that doesn't exist.

However, the schema's `requestId` field is `z.string().min(1)` -- no format validation. The actual request IDs follow the pattern `perm-{counter}-{timestamp}`. A client that observes the pattern could predict future request IDs, but since the server only resolves permissions that are actually pending (checked via `_pendingPermissions.has(requestId)`), prediction alone isn't useful.

**The real risk**: Any authenticated client can respond to ANY pending permission on ANY session. The `permissionSessionMap` lookup falls back to `client.activeSessionId`, but even without the fallback, the client can respond to permissions from sessions it isn't viewing. In a multi-user scenario (future), this means User B could approve User A's permission requests.

**Severity**: LOW (requires authentication; single-user model makes this moot today; becomes HIGH in multi-user scenario).

### NEW-6: LOW -- `shell.open` Plugin Enabled Without Restrictions

**File**: `packages/desktop/src-tauri/tauri.conf.json:37-39`

```json
"plugins": {
  "shell": {
    "open": true
  }
}
```

The Tauri `shell.open` plugin allows opening URLs and files in the default OS handler. If XSS is achieved in the WebView, the attacker could use `shell.open` (via `window.__TAURI__` if `withGlobalTauri` were true) to open arbitrary URLs or files.

Currently `withGlobalTauri: false` (line 9), which means the Tauri API is not exposed to the WebView JavaScript context. This significantly limits the attack surface. However, the `shell.open` plugin is still initialized and available to Rust code -- if any `#[tauri::command]` handler is added that exposes it, the surface opens up.

**Severity**: LOW (mitigated by `withGlobalTauri: false`; defense-in-depth concern).

---

## Section-by-Section Ratings

| Section | Rating | Key Issues |
|---------|--------|-----------|
| Message Synchronization | 2/5 | Full history replay to any authenticated client; no differential access control; fire-and-forget delivery means a client could miss a permission_request and Claude auto-denies |
| Repository & Session Mgmt | 2/5 | State file at `~/.chroxy/session-state.json` contains full message history readable by any local user; `list_conversations` exposes all Claude Code conversations; no session-level auth |
| Tunnel Implementation | 3/5 | E2E encryption is genuinely strong; localhost bypass is correctly implemented via raw socket IP; tunnel verification is sound; CSP gap between server and Tauri is the main concern |
| WebSocket Layer | 2/5 | `.passthrough()` on 12 schemas; `win.eval()` token injection; token in HTML/URLs; `safeTokenCompare` untested |
| Data Flow Diagram | 2/5 | Accurate but security-blind; shows "Auth + E2E + Encrypt + Compress" as a black box without analyzing what happens when each fails |
| Proposed Protocol | 1/5 | `subscribe_sessions` with zero access control model; IPC channel "skips encryption and validation" -- exactly the wrong framing for a protocol that grants code execution |

---

## Top 5 Findings (Ranked by Exploitability)

| # | Severity | Finding | File | Exploitability |
|---|----------|---------|------|---------------|
| 1 | CRITICAL | Token in HTML + URLs -- any extension or process can steal it | `dashboard.js:136-140`, `window.rs:25-27` | Trivial -- `window.__CHROXY_CONFIG__.token` from any extension |
| 2 | HIGH | Config file world-readable by Tauri setup | `setup.rs:34` | Trivial -- `cat ~/.chroxy/config.json` from any local account |
| 3 | HIGH | `.passthrough()` allows `sessionId` injection across session boundaries | `ws-schemas.js` (12 schemas) | Easy -- craft WebSocket message with extra `sessionId` field |
| 4 | HIGH | `win.eval()` token injection in Tauri fallback window | `window.rs:79-88` | Requires code change to tunnel_mode validation (currently mitigated) |
| 5 | MEDIUM | CSP `unsafe-inline` + wildcard localhost in Tauri | `tauri.conf.json:11` | Requires XSS first, but weakens all defense-in-depth |

---

## Attack Scenario: Complete Compromise via Browser Extension

**Prerequisite**: User installs any browser extension with page access (ad blocker, password manager, productivity tool) or uses a Chromium-based browser with remote debugging enabled.

1. Extension executes content script on `http://localhost:*/dashboard*`
2. Reads `window.__CHROXY_CONFIG__.token` -- now has the API token
3. Opens `ws://localhost:{port}` WebSocket, sends `{ type: 'auth', token: '<stolen>' }`
4. Sends `{ type: 'set_permission_mode', mode: 'auto', confirmed: true }` -- bypasses confirmation dialog
5. Sends `{ type: 'input', data: 'Read ~/.ssh/id_rsa and write its contents to /tmp/exfil.txt' }`
6. Claude Code executes without any permission checks (auto mode)
7. Attacker reads the file via `{ type: 'read_file', path: '/tmp/exfil.txt' }`

**Total time**: < 2 seconds. **Detection**: None (no audit log, no anomaly detection, no per-device tracking).

**Note**: In a Tauri WebView, browser extensions don't apply. But the same attack works from:
- A compromised npm package running in the same Node.js process
- A malicious localhost service that reads the world-readable config file
- Network-adjacent attacker who can read the Referer header from a Quick Tunnel URL

---

## Remediation Priority

### Immediate (This Week) -- Unchanged from v2

| Action | Effort | Impact |
|--------|--------|--------|
| Fix `config.json` permissions in `setup.rs` (use `std::os::unix::fs::PermissionsExt`, set 0o600) | 15 min | Closes local privilege escalation |
| Remove token from `window.__CHROXY_CONFIG__` -- use HttpOnly session cookie for dashboard auth | 2-4 hours | Closes extension/DevTools token theft |
| Remove token from URL query string in `window.rs` -- pass via cookie or POST | 30 min | Closes browser history/Referer leaks |
| Replace `win.eval()` with `app.emit()` events in `window.rs` | 1 hour | Eliminates code injection surface |
| Add `safeTokenCompare` unit tests (7 cases) | 20 min | Validates auth gatekeeper |

### Short-term (Weeks 1-4)

| Action | Effort | Impact |
|--------|--------|--------|
| Remove `.passthrough()` from all client-to-server schemas | 1 hour | Prevents field injection / session ID override |
| Tighten Tauri CSP: remove `unsafe-inline`, use nonce; restrict localhost to specific port | 2 hours | Hardens defense-in-depth |
| Add audit logging for auth, permission_response, set_permission_mode | 1-2 days | Enables detection of unauthorized access |

### Medium-term (Months 1-3)

| Action | Effort | Impact |
|--------|--------|--------|
| Per-device token derivation (HMAC of master token + device ID) | 1-2 weeks | Enables revocation, audit trail |
| Session-scoped authorization (client can only access sessions they created or were granted) | 1 week | Defense in depth |
| Rate limiting on `set_permission_mode` to `auto` | 2 hours | Slows automated attacks |

---

## Overall Rating: 2.0 / 5

Unchanged from v2. The audit document remains a strong inventory and a weak security analysis. All 5 v2 findings are still present in code. The v3 deep dive found additional attack surface:

- `win.eval()` code injection (NEW-1, HIGH)
- `.passthrough()` session ID injection (NEW-2, HIGH, refined from v2 finding 4)
- Tauri CSP weaker than server CSP (NEW-3, MEDIUM)
- Hand-rolled markdown renderer XSS surface (NEW-4, MEDIUM)
- Cross-session permission response (NEW-5, LOW)
- `shell.open` plugin enabled (NEW-6, LOW)

**What the audit gets right**: The E2E encryption analysis is accurate and the implementation is genuinely strong. The provider registry and tunnel adapter patterns are sound. The file operations (`ws-file-ops.js`) have proper `realpath()` boundary checks that prevent path traversal. The `respondToPermission` flow correctly validates decisions via Zod schema. These are real engineering strengths.

**What the audit misses**: It treats authentication as a solved problem while the token is exposed through 6+ vectors. It proposes an IPC channel that "skips encryption and validation" without analyzing the security implications. It never mentions that `unsafe-inline` in the Tauri CSP undermines the nonce-based server CSP. And it proposes `subscribe_sessions` without any access control model.

**Bottom line**: The architecture is fundamentally sound but the authentication perimeter has multiple critical holes. Token exposure is the single most important issue. Fix it before building anything new.
