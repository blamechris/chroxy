# Adversary Audit: Chroxy Desktop CLI Agent IDE — Security Analysis

**Auditor Role:** Adversary (Security Engineer)
**Date:** 2026-02-28
**Scope:** Security audit of the IDE implementation plan, existing codebase security posture, and per-phase security requirements

---

## Rating: 3.2 / 5

The existing codebase demonstrates above-average security awareness — E2E encryption, timing-safe token comparison, Zod schema validation, path traversal protections, auth rate limiting, symlink resolution, and CWD sandboxing are all present and mostly well-implemented. However, the IDE vision introduces significant new attack surface (multi-repo filesystem access, multi-session permission domains, repo discovery scanning, cross-device session orchestration) that the current security architecture is not designed to handle. Several concrete vulnerabilities exist today, and the expansion plan lacks the security architecture needed to ship safely.

**What earns the 3.2:** Solid crypto primitives, schema validation everywhere, path traversal defenses that actually resolve symlinks, localhost bypass that correctly uses `req.socket.remoteAddress` instead of spoofable headers. The security floor is high.

**What costs the 1.8:** Token in dashboard HTML, config file permissions, broadcast-to-all-clients session leakage, no per-session auth scoping, Tauri CSP that allows `unsafe-inline`, config written without restricted permissions in setup.rs, no file operation rate limiting, and the IDE expansion creates attack surface with no security architecture planned.

---

## Attack Surface Map for the CLI Agent IDE

```
                          ATTACK SURFACE

    [Mobile Client] ──WSS──> [Cloudflare Tunnel] ──WS──> [Node Server]
         │                                                     │
         │ E2E Encrypted                              [Session Manager]
         │                                             /    |    \
         │                                       [Sess A] [Sess B] [Sess C]
         │                                         │        │        │
    [Desktop WebView] ──WS localhost──> [Node Server]  Claude Code instances
         │                                  │           (each with own CWD,
    [Tauri IPC]                        [File Ops]        permissions, model)
         │                              │      │
    [Native OS]                   [Browse] [Read]
                                   │         │
                              [Repo CWD]  [Repo CWD]
                                   │
                            [~/.claude/projects/]  <-- ConversationScanner
                            [~/Projects/*]         <-- Repo Discovery (Phase 2)

TRUST BOUNDARIES:
  1. Cloudflare tunnel → Node server (auth token)
  2. WebSocket client → authenticated session (single shared token)
  3. Session A → Session B (NO BOUNDARY — shared auth, broadcast leaks)
  4. File ops → filesystem (CWD sandbox, home dir restriction)
  5. Tauri WebView → Node server (CSP, localhost only)
  6. Desktop app → config files (~/.chroxy/)
  7. ConversationScanner → ~/.claude/projects/ (read-only scan)
```

### Key Attack Vectors

| Vector | Current Risk | IDE Risk (Phase 2+) |
|--------|-------------|---------------------|
| Token theft from dashboard HTML | HIGH | HIGH |
| Cross-session data leakage via broadcast | MEDIUM | HIGH |
| Path traversal in file ops | LOW (defended) | MEDIUM (more entry points) |
| Config file permission escalation | MEDIUM | MEDIUM |
| WebView XSS via `unsafe-inline` CSP | LOW | MEDIUM (more dynamic content) |
| Repo discovery following symlinks to sensitive dirs | N/A | MEDIUM |
| Permission approval spoofing across sessions | LOW | HIGH |
| Denial of service via file op flooding | MEDIUM | HIGH |
| Token in URL / browser history | MEDIUM | MEDIUM |
| Conversation scanner reading sensitive JSONL | LOW | LOW |

---

## Existing Vulnerabilities (Code References)

### V1: Token Embedded in Dashboard HTML [HIGH]

**File:** `packages/server/src/ws-server.js` line ~504
```javascript
res.end(getDashboardHtml(this.port, this.apiToken, !this._encryptionEnabled, nonce))
```

**File:** `packages/desktop/src-tauri/src/window.rs` lines 25-27
```rust
pub fn open_dashboard(app: &AppHandle, port: u16, token: Option<&str>) {
    let url = match token {
        Some(t) => format!("http://localhost:{}/dashboard?token={}", port, url_encode(t)),
```

The API token is:
1. Passed to `getDashboardHtml()` where it is embedded in the HTML source (viewable via View Source)
2. Placed in the URL query string (`?token=...`) which is recorded in browser history, Tauri navigation history, and potentially logged by proxies

**Impact:** Any process on the machine that can read the WebView's navigation history, Tauri window state, or the rendered HTML gets the auth token.

**Remediation:** Use a session cookie (HttpOnly, SameSite=Strict) set via a `/dashboard/auth` POST endpoint. Never embed the token in HTML or URL.

### V2: Config File Written Without Restricted Permissions [HIGH]

**File:** `packages/desktop/src-tauri/src/setup.rs` lines 32-34
```rust
if let Err(e) = fs::write(&path, json_str) {
    eprintln!("[setup] Failed to write config: {}", e);
    return false;
}
```

`fs::write` creates the file with the default umask permissions (typically 0o644 — world-readable). The config contains `apiToken`, which is the sole authentication credential.

**File:** `packages/desktop/src-tauri/src/settings.rs` line 84
```rust
fs::write(&path, json).map_err(|e| format!("Failed to write settings: {}", e))
```

Same issue for desktop settings (less sensitive but still poor practice).

**Impact:** Any user or process on a multi-user machine can read the API token from `~/.chroxy/config.json`.

**Remediation:** Use platform-specific restricted file writes: `std::os::unix::fs::OpenOptionsExt` with `.mode(0o600)` on Unix, or ACL-based restriction on Windows. The vision document acknowledges this in Phase 0 — it must be done before any other phase ships.

### V3: `_broadcastToSession` Broadcasts to ALL Authenticated Clients [MEDIUM-HIGH]

**File:** `packages/server/src/ws-server.js` lines 1038-1045
```javascript
_broadcastToSession(sessionId, message, filter = () => true) {
    const tagged = { ...message, sessionId }
    for (const [ws, client] of this.clients) {
      if (client.authenticated && filter(client) && ws.readyState === 1) {
        this._send(ws, tagged)
      }
    }
  }
```

This method sends session-scoped messages (tool results, stream deltas, permission requests) to EVERY authenticated client, not just clients viewing that session. The `sessionId` tag is only for client-side routing — it provides no server-side isolation.

**Impact in IDE context:** When Client A has Session 1 (repo `payment-service`) and Client B has Session 2 (repo `internal-tools`), Client B receives all tool outputs, file contents, and permission requests from Session 1. A malicious mobile client could passively observe all activity across all sessions.

**Remediation:** The default filter should check `client.activeSessionId === sessionId` or a subscription set. Clients that need multi-session updates (IDE with tabs open) should explicitly subscribe via the planned `subscribe_sessions` message. The current behavior must be fixed before Phase 2 ships.

### V4: Tauri CSP Allows `unsafe-inline` for Scripts [MEDIUM]

**File:** `packages/desktop/src-tauri/tauri.conf.json` line 12
```json
"csp": "default-src 'self' http://localhost:*; connect-src ws://localhost:* http://localhost:*; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"
```

`script-src 'unsafe-inline'` defeats the purpose of CSP against XSS. If any server response or WebSocket message contains attacker-controlled HTML that gets rendered without sanitization, inline scripts will execute.

**Note:** The Node server's dashboard endpoint uses a proper nonce-based CSP (line ~483 of ws-server.js). The Tauri-level CSP is the weaker one that applies to the WebView shell. Since the Tauri WebView loads from `http://localhost:*`, the server's response-level CSP takes precedence for the dashboard page — but the Tauri CSP applies to any navigation to other localhost pages or injected content.

**Remediation:** Replace `'unsafe-inline'` with nonce-based CSP in Tauri config. Since Tauri 2.x supports dynamic CSP, pass the nonce from the server or use a hash-based approach.

### V5: No Rate Limiting on File Operations [MEDIUM]

**File:** `packages/server/src/ws-file-ops.js` — all methods (`browseFiles`, `readFileContent`, `getDiff`, `listSlashCommands`, `listAgents`)

There is no rate limiting or throttling on file operations. An authenticated client can flood the server with `browse_files` and `read_file` requests to:
1. Exhaust server I/O and memory (reading many files concurrently)
2. Scan the entire project directory tree rapidly
3. Cause DoS by triggering many `stat()` and `readFile()` syscalls

**Remediation:** Add per-client rate limiting (e.g., 20 file ops/second with burst of 50). Track in the client state map.

### V6: `list_directory` Has No Session CWD Scoping [LOW-MEDIUM]

**File:** `packages/server/src/ws-message-handlers.js` lines 366-368
```javascript
case 'list_directory':
    ctx.fileOps.listDirectory(ws, msg.path)
    break
```

**File:** `packages/server/src/ws-file-ops.js` lines 32-99 (listDirectory method)

`list_directory` is scoped to the home directory, but not to any session CWD. Unlike `browse_files` (which restricts to session CWD), `list_directory` allows browsing any directory under `~`. This is used for the "add repo" file browser in the IDE.

In the IDE context, this is acceptable for the repo picker but could be tightened. The risk is that an attacker with an auth token can enumerate all directory names under the user's home directory.

**Remediation:** Consider whether `list_directory` should be restricted to a configurable allowed-paths list for the IDE's repo manager.

---

## Multi-Session Permission Isolation Analysis

### Current State: No Isolation

The permission system has a critical design gap for the IDE use case:

1. **Single shared auth token:** All clients authenticate with the same token. There is no per-client, per-session, or per-repo authorization. Once authenticated, a client can interact with any session.

2. **Permission responses are globally routed:** In `ws-message-handlers.js`, permission responses are routed via `permissionSessionMap` (requestId -> sessionId). This is correct for routing, but any authenticated client can respond to any permission request from any session. There is no check that the responding client is authorized for that session.

   ```javascript
   // ws-message-handlers.js, permission_response handler
   const originSessionId = ctx.permissionSessionMap.get(msg.requestId)
   ```

3. **Permission mode changes are per-session but globally accessible:** Any client can send `set_permission_mode` with `mode: 'auto'` for any active session (by switching to it first), enabling `--dangerously-skip-permissions` on a repo they shouldn't control.

### IDE Risk

In the IDE scenario with multiple repos:
- Session A: `payment-service` (sensitive, should require permission approval)
- Session B: `docs-site` (low sensitivity, `auto` mode is fine)

A compromised mobile client or malicious script could:
1. Observe permission requests for Session A (via V3 broadcast leakage)
2. Auto-approve them, enabling Claude to execute arbitrary commands in the payment-service repo
3. Switch Session A to `auto` mode, removing all safety guardrails

### Required Architecture

Before Phase 2 ships:
- **Session subscriptions:** Clients must explicitly subscribe to sessions. `_broadcastToSession` must only send to subscribed clients.
- **Permission response authorization:** Verify the responding client is subscribed to (or is primary for) the session that originated the permission request.
- **Permission mode pinning:** Consider allowing sessions to be created with a locked permission mode that cannot be changed via WebSocket (only via server config).

---

## File Operations Security Analysis

### Path Traversal Defenses: Well Implemented

The file operations in `ws-file-ops.js` demonstrate competent path traversal protection:

1. **`browseFiles`** (line 102-189): Resolves both the requested path and session CWD to their real paths via `realpath()`, then checks `realAbsPath.startsWith(cwdReal + '/')`. This correctly handles:
   - `../` traversal (normalized away by `resolve()`)
   - Symlink-based escapes (resolved by `realpath()`)
   - The `/` suffix prevents prefix confusion (`/home/user/chroxy-evil` vs `/home/user/chroxy`)

2. **`readFileContent`** (line 192-327): Same symlink-resolving sandbox check. Also enforces:
   - 512KB file size limit
   - Binary file detection (null byte check)
   - 100KB content truncation

3. **`getDiff`** (line 330-497): Validates git ref names against `/^[a-zA-Z0-9._\-\/~^@{}:]+$/` to prevent flag injection. Uses `execFile` (not `exec`) for shell injection prevention.

4. **`listDirectory`** (line 32-99): Scoped to home directory with real path resolution.

### Remaining Risks

1. **TOCTOU in symlink checks:** Between `realpath()` check and `readFile()`, a symlink target could change. This is a theoretical race condition — practical exploitation requires the attacker to have write access to the repo directory (at which point they already have more direct attack vectors).

2. **CWD real path cache** (line 19-29): `_cwdRealCache` caches resolved CWDs indefinitely. If a session's CWD is a symlink that gets retargeted, the cached real path becomes stale. Low risk since session CWDs are typically stable paths.

3. **Untracked file content in diffs** (line 413-483): `getDiff` reads untracked file content up to 50KB. The path traversal check at line 434 is correct, but this is an additional file reading vector.

---

## Repo Discovery Attack Surface (Phase 2)

### ConversationScanner: Acceptable

**File:** `packages/server/src/conversation-scanner.js`

The scanner reads only from `~/.claude/projects/` (a well-known, Claude-controlled directory). It:
- Does not follow symlinks (reads directory entries, not symlink targets)
- Limits concurrency to 15 parallel reads
- Only reads the first 32KB of JSONL files for preview extraction
- Caches results with 5-second TTL

**Risk:** Low. The scanner reads data Claude Code already created. It does not traverse arbitrary filesystem paths.

### Repo Manager (Phase 2 — Not Yet Built): Needs Design

The planned "Add Repo" feature (`add_repo` protocol message) will need:

1. **Path validation:** Must use `realpath()` to resolve symlinks before accepting. Must reject paths outside the home directory (already done by `validateCwdWithinHome` for `create_session`).

2. **Repo enumeration limits:** If the IDE auto-discovers repos (e.g., scanning `~/Projects/`), it should:
   - Skip symlinks or resolve them before including
   - Limit scan depth (no recursive descent)
   - Exclude hidden directories and system paths
   - Have a configurable allowlist/blocklist

3. **Stored repo list security:** The persisted list of repos must be stored in a file with restricted permissions (0o600).

---

## Cross-Device Auth Model Analysis

### Current Model: Shared Secret

All clients (mobile, desktop, additional devices) authenticate with the same API token. This is a bearer token model — possession of the token grants full access to all sessions.

### Weaknesses for IDE Use Case

1. **No device-level authorization:** A stolen/shared token grants access to all repos and all sessions. There is no way to grant a mobile device read-only access or restrict it to certain repos.

2. **Token rotation disconnects all clients:** The `TokenManager` rotation mechanism broadcasts `token_rotated` to all clients, requiring re-authentication. This is correct but disruptive.

3. **No session-level access control:** The vision describes mobile and desktop as "peers" — both see all sessions. For sensitive repos, users may want mobile to have limited access (e.g., monitoring but not sending input).

### Recommendations for Phase 3+

- **Device registration:** On first connection, devices register with a persistent device ID. The server can maintain an approved device list.
- **Capability scoping:** Consider optional per-device capability masks (e.g., `canInput: false`, `allowedSessions: [...]`).
- **Audit logging:** Log all session interactions with client ID and device info for forensic analysis.

---

## CSP and WebView Security Analysis

### Server-Side CSP: Strong

**File:** `packages/server/src/ws-server.js` line ~483
```javascript
'Content-Security-Policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}';
style-src 'self' 'nonce-${nonce}'; connect-src 'self' ws://localhost:${this.port}
wss://localhost:${this.port}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
```

This is a well-configured CSP:
- Nonce-based script/style (no `unsafe-inline`)
- `frame-ancestors 'none'` prevents clickjacking
- `base-uri 'none'` prevents base tag injection
- `form-action 'self'` prevents form-based exfiltration

### Tauri-Level CSP: Weak

**File:** `packages/desktop/src-tauri/tauri.conf.json` line 12

The Tauri CSP allows `unsafe-inline` and `http://localhost:*` (any port). This means:
- If the WebView navigates to any localhost URL (not just the Chroxy server port), the weak CSP applies
- Any XSS in the dashboard can execute inline scripts under the Tauri CSP

### WebView Content Injection Risk

The dashboard renders content from Claude Code sessions — tool outputs, file contents, error messages. If any of this content is rendered as HTML without sanitization, XSS is possible. The current vanilla JS dashboard likely uses `textContent` in many places, but the React migration (Phase 1) must ensure:
- All dynamic content uses React's default escaping (JSX `{}` expressions)
- `dangerouslySetInnerHTML` is never used with unsanitized session data
- Markdown rendering (if added) uses a sanitizing renderer
- Terminal output in xterm.js is safe (xterm handles escape sequences, not HTML)

---

## Tauri IPC and Command Security Analysis

### Capabilities: Minimal and Correct

**File:** `packages/desktop/src-tauri/capabilities/default.json`
```json
{
  "permissions": [
    "core:default",
    "shell:allow-open",
    "autostart:default",
    "notification:default"
  ]
}
```

This is a tight permission set:
- `shell:allow-open` — only allows opening URLs in the default browser (not arbitrary shell commands)
- No filesystem access from the WebView
- No custom Tauri commands exposed to the frontend

### No Custom IPC Commands

The Rust code (`lib.rs`, `server.rs`, etc.) does not define any `#[tauri::command]` functions. All application logic flows through the WebSocket. This is secure — it means the WebView cannot invoke privileged Rust-side operations.

### Process Management

**File:** `packages/desktop/src-tauri/src/server.rs`

The server child process is managed safely:
- `Command::new(&node_path).arg(&cli_js)` — no shell interpolation
- `execFile` (not `exec`) for subprocess execution
- SIGTERM with 5-second grace period before SIGKILL
- Drop implementation ensures cleanup

**Risk:** The `CHROXY_SERVER_PATH` environment variable (line 332) allows overriding the server path. If an attacker can set environment variables for the Tauri process, they could redirect it to a malicious server. This requires local access, so the risk is low.

---

## Per-Phase Security Requirements

### Phase 0: Foundation — Security Gates

These MUST be completed before any other phase:

| Gate | Status | Priority |
|------|--------|----------|
| Fix config.json permissions to 0o600 | Acknowledged | CRITICAL |
| Fix settings.json permissions to 0o600 | Acknowledged | CRITICAL |
| Remove token from dashboard HTML source | Acknowledged | CRITICAL |
| Remove token from URL query parameter | Not explicitly acknowledged | HIGH |
| Add `safeTokenCompare` unit tests | Acknowledged | HIGH |
| Fix `_broadcastToSession` to filter by subscription | Acknowledged (session filtering) | CRITICAL |
| Add `tauri-plugin-single-instance` | Acknowledged | MEDIUM |
| Fix Tauri CSP to remove `unsafe-inline` | Not acknowledged | HIGH |
| Fix `setup.rs` `fs::write` to use restricted permissions | Not acknowledged | CRITICAL |

### Phase 1: React Migration — Security Gates

| Gate | Requirement |
|------|-------------|
| XSS audit | All React components must use default escaping. No `dangerouslySetInnerHTML` with session data. |
| CSP compatibility | React build output must work with nonce-based CSP (no inline scripts in built HTML). |
| WebSocket hook security | The `useWebSocket` Zustand store must not expose raw WebSocket to components (prevent prototype pollution or message injection). |
| Dependency audit | Run `npm audit` on new React dependencies. Pin versions. |

### Phase 2: Sidebar + Session Tabs — Security Gates

| Gate | Requirement |
|------|-------------|
| Session subscription model | `subscribe_sessions` must be implemented. `_broadcastToSession` must check subscriptions. |
| Permission response authorization | Permission responses must be validated against the subscriber set for the originating session. |
| Repo path validation | `add_repo` must validate paths with `realpath()` and restrict to home directory. |
| Repo list persistence security | Stored repo list file must have 0o600 permissions. |
| Multi-tab isolation test | Verify that switching tabs does not leak data between sessions in the terminal buffer or React state. |

### Phase 3: Polish + Power Features — Security Gates

| Gate | Requirement |
|------|-------------|
| Notification content sanitization | Native notifications must not contain unsanitized session content (XSS via notification body on some platforms). |
| Keyboard shortcut scope | Shortcuts must not be active when the WebView is not focused (prevent ghost input to sessions). |
| Split pane isolation | Two visible sessions must not share any mutable state. |

### Phase 4: Expandability — Security Gates

| Gate | Requirement |
|------|-------------|
| File browser scoping | Each file browser panel must be locked to its session's CWD. No cross-session file browsing. |
| Diff viewer sanitization | Diff content must be treated as untrusted text. Syntax highlighting must not execute embedded code. |
| Checkpoint restore authorization | Checkpoint operations must verify the client has access to the session. |
| Multi-machine auth | Connecting to remote Chroxy servers must use per-server credentials, not the local token. |
| Plugin sandbox | If a plugin system is added, plugins must run in an isolated context with explicit permissions. |
| Code review UI | Inline comments in the review UI must be sanitized to prevent stored XSS. |

---

## Security Architecture Recommendations

### 1. Implement Client-Session Subscriptions (Before Phase 2)

Replace the broadcast-all pattern with explicit subscriptions:

```javascript
// Client state
{
  subscribedSessions: new Set(), // sessions this client receives events for
  activeSessionId: string,       // currently focused session (for input routing)
}

// _broadcastToSession becomes:
_broadcastToSession(sessionId, message, filter = () => true) {
  const tagged = { ...message, sessionId }
  for (const [ws, client] of this.clients) {
    if (client.authenticated &&
        client.subscribedSessions.has(sessionId) &&
        filter(client) &&
        ws.readyState === 1) {
      this._send(ws, tagged)
    }
  }
}
```

### 2. Session-Scoped Permission Authorization

When a `permission_response` arrives, verify:
```javascript
case 'permission_response': {
  const originSessionId = ctx.permissionSessionMap.get(msg.requestId)
  if (originSessionId && !client.subscribedSessions.has(originSessionId)) {
    ctx.send(ws, { type: 'permission_expired', requestId: msg.requestId,
      message: 'Not authorized for this session' })
    break
  }
  // ... proceed with existing handling
}
```

### 3. Token-Free Dashboard Authentication

Replace token-in-URL with a session cookie flow:

```
1. Tauri opens http://localhost:{port}/dashboard/login
2. Login page POST /dashboard/auth with token in body
3. Server sets HttpOnly, SameSite=Strict cookie
4. Server redirects to /dashboard
5. Dashboard WebSocket auth uses the cookie or a short-lived JWT
```

### 4. File Operation Rate Limiting

Add to client state:
```javascript
{
  fileOpBucket: { tokens: 20, lastRefill: Date.now() },
}
```

Check before every file operation:
```javascript
function checkFileOpRateLimit(client) {
  const now = Date.now()
  const elapsed = now - client.fileOpBucket.lastRefill
  client.fileOpBucket.tokens = Math.min(20, client.fileOpBucket.tokens + elapsed / 1000)
  client.fileOpBucket.lastRefill = now
  if (client.fileOpBucket.tokens < 1) return false
  client.fileOpBucket.tokens--
  return true
}
```

### 5. Restricted File Writes in Rust

Replace all `fs::write` calls with:
```rust
#[cfg(unix)]
fn write_restricted(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    use std::io::Write;
    let mut writer = std::io::BufWriter::new(file);
    writer.write_all(content.as_bytes())?;
    Ok(())
}
```

### 6. Tauri CSP Hardening

Update `tauri.conf.json`:
```json
"csp": "default-src 'self'; connect-src ws://localhost:* http://localhost:*; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'"
```

Remove `unsafe-inline` entirely. If inline styles are needed for dynamic sizing (xterm.js), use style hashes or move to external stylesheets.

---

## Summary

The Chroxy codebase has a strong security foundation. The E2E encryption, schema validation, path traversal defenses, and auth rate limiting are all implemented with care. The main gaps are operational (file permissions, token exposure) and architectural (no session-level isolation for the multi-session IDE model).

**The single most important security task before Phase 2:** Fix `_broadcastToSession` to use a subscription model. Without this, the multi-repo IDE leaks all session activity to all connected clients. Every other IDE feature builds on the assumption that sessions are isolated.

**Second most important:** Remove the token from HTML/URL. This is the easiest credential theft vector and it exists in production today.

The Phase 0 list in `desktop-vision.md` correctly identifies most of these issues. Execute Phase 0 completely before building Phase 1. Do not skip it.
