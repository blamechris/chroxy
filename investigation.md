# Chroxy Codebase Audit & Issue Planning

**Date:** 2026-02-06
**Version Audited:** 0.1.0
**Scope:** Full codebase — server, app, infrastructure, protocol, security

---

## Executive Summary

Chroxy is a functional v0.1.0 prototype with a working server (PTY management, output parsing, WebSocket protocol, cloudflared tunnel, CLI) and a shell mobile app (navigation, connection, session with chat/terminal views). This audit identified **85+ distinct issues** across 7 categories, ranging from critical security gaps to quality-of-life features. The codebase has **zero tests**, **no CI/CD**, and several security concerns that need addressing before any production use.

### Audit Statistics

| Category | Critical | High | Medium | Low | Total |
|----------|----------|------|--------|-----|-------|
| Security | 3 | 8 | 10 | 5 | 26 |
| Server Architecture | 1 | 5 | 8 | 4 | 18 |
| Mobile App | 1 | 4 | 7 | 3 | 15 |
| Protocol & API | 0 | 4 | 5 | 3 | 12 |
| Testing & Quality | 2 | 3 | 2 | 0 | 7 |
| DevOps & Infrastructure | 1 | 2 | 3 | 1 | 7 |
| Features & UX | 0 | 2 | 5 | 3 | 10 |
| **Total** | **8** | **28** | **40** | **19** | **95** |

---

## Table of Contents

1. [Security](#1-security)
2. [Server Architecture](#2-server-architecture)
3. [Mobile App](#3-mobile-app)
4. [Protocol & API](#4-protocol--api)
5. [Testing & Quality](#5-testing--quality)
6. [DevOps & Infrastructure](#6-devops--infrastructure)
7. [Features & UX](#7-features--ux)
8. [Priority Matrix](#priority-matrix)

---

## 1. Security

### SEC-01: Remove or gate auto-trust dialog acceptance
**Priority:** Critical
**Labels:** `security`, `server`

The server automatically accepts Claude's "Do you trust this folder?" dialogs via regex matching in `packages/server/src/server.js:39-57`. This bypasses Claude Code's built-in security check and could auto-approve any future permission request that matches the pattern.

```javascript
if (/trust\s*this\s*folder/i.test(clean) || /Yes.*trust/i.test(clean)) {
  if (!trustAccepted) {
    trustAccepted = true
    setTimeout(() => ptyManager.write("\r"), 300)
  }
}
```

**Scope:**
- Remove auto-trust entirely, or gate it behind an explicit `--auto-trust` CLI flag
- Consider forwarding trust dialogs to the mobile app for user confirmation
- Document the security implications if the flag is used

---

### SEC-02: Use timing-safe token comparison
**Priority:** High
**Labels:** `security`, `server`

Token comparison in `packages/server/src/ws-server.js:149` uses `===` which is vulnerable to timing attacks:

```javascript
if (msg.type === "auth" && msg.token === this.apiToken) {
```

**Scope:**
- Replace with `crypto.timingSafeEqual()` using Buffer conversion
- Add token format validation before comparison

---

### SEC-03: Store API token securely (not plaintext)
**Priority:** Critical
**Labels:** `security`, `server`

The API token is stored in plaintext at `~/.chroxy/config.json` with default file permissions. Any process running as the user can read it. It also survives in backups and could be committed if user tracks dotfiles.

**Scope:**
- Set restrictive file permissions (0600) on config.json
- Investigate OS keychain integration (Keychain on macOS, Secret Service on Linux)
- Add `--token-from-stdin` flag for CI/CD use cases
- Never log the full token (current code logs first 8 chars in `server.js:94`)

---

### SEC-04: Fix command injection risk in tmux session name
**Priority:** High
**Labels:** `security`, `server`, `bug`

Session name is interpolated directly into shell commands in `packages/server/src/pty-manager.js:33,108`:

```javascript
execSync(`/opt/homebrew/bin/tmux kill-session -t ${this.sessionName} 2>/dev/null`)
execSync(`tmux has-session -t ${this.sessionName} 2>/dev/null`)
```

**Scope:**
- Validate session name against strict allowlist pattern: `^[a-zA-Z0-9_-]+$`
- Use array-form `execFileSync` instead of string `execSync` to avoid shell interpretation
- Apply same fix to all shell command constructions

---

### SEC-05: Add rate limiting to WebSocket server
**Priority:** High
**Labels:** `security`, `server`

No protection against message flooding. An authenticated client can send unlimited messages at any rate, consuming memory and CPU.

**Scope:**
- Implement token bucket rate limiter (e.g., 60 input messages/minute per client)
- Add connection throttling (max N concurrent connections per token)
- Add max message size limit (e.g., 1MB per WebSocket frame)
- Return structured error on rate limit with `retry_after` field

---

### SEC-06: Add WebSocket message size limits
**Priority:** High
**Labels:** `security`, `server`

WebSocket messages have no size restrictions in `packages/server/src/ws-server.js:108-116`. A client could send a multi-GB JSON payload causing memory exhaustion.

**Scope:**
- Set `maxPayload` option on WebSocketServer (e.g., 1MB)
- Reject oversized messages with structured error
- Log dropped oversized messages at warn level

---

### SEC-07: Implement token rotation mechanism
**Priority:** High
**Labels:** `security`, `server`, `enhancement`

The API token is a static UUID that never expires. No way to rotate without `chroxy init --force` and re-scanning QR on all devices.

**Scope:**
- Add `chroxy token rotate` command that generates new token
- Support grace period where both old and new tokens are valid (e.g., 5 minutes)
- Notify connected clients of impending token change
- Consider JWT with expiration for session tokens (separate from config API token)

---

### SEC-08: Reduce token exposure in logs and QR codes
**Priority:** Medium
**Labels:** `security`, `server`

Token is embedded in connection URL displayed via QR code (`server.js:87`) and partially logged to console. QR codes can be photographed, captured by screen recordings, or visible in terminal scrollback.

**Scope:**
- Add `--show-qr` flag to optionally display QR (don't show by default)
- Clear terminal screen after QR is scanned
- Never log token, even partial
- Consider time-limited QR codes

---

### SEC-09: Validate resize command bounds
**Priority:** Medium
**Labels:** `security`, `server`

Resize messages processed without bounds checking in `packages/server/src/ws-server.js:246`:

```javascript
case "resize":
  this.ptyManager.resize(msg.cols, msg.rows)
  break
```

**Scope:**
- Validate cols (20-500) and rows (10-200) before calling resize
- Reject non-positive, non-integer, or unreasonably large values
- Return error for invalid dimensions

---

### SEC-10: Remove server mode from unauthenticated health endpoint
**Priority:** Medium
**Labels:** `security`, `server`

Health endpoint at `packages/server/src/ws-server.js:70-75` leaks server mode without authentication:

```javascript
res.end(JSON.stringify({ status: "ok", mode: this.serverMode }))
```

**Scope:**
- Remove `mode` from unauthenticated response
- Or require auth header for detailed health info
- Return only `{ status: "ok" }` publicly

---

### SEC-11: Add authentication audit logging
**Priority:** Medium
**Labels:** `security`, `server`, `observability`

No logging of failed authentication attempts or successful connections with metadata.

**Scope:**
- Log all auth attempts with: timestamp, outcome, client info
- Track failed attempt count for potential brute force detection
- Add structured log format for security events
- Include in future alerting system

---

### SEC-12: Add biometric authentication to mobile app
**Priority:** Medium
**Labels:** `security`, `app`, `enhancement`

Anyone with physical access to an unlocked phone can access the terminal session. No additional authentication layer within the app.

**Scope:**
- Add optional Face ID / Touch ID / fingerprint lock on app launch
- Auto-lock after configurable inactivity period
- Require biometric auth for sensitive actions (export, disconnect)
- Fallback PIN code

---

### SEC-13: Prevent deep link hijacking
**Priority:** Medium
**Labels:** `security`, `app`

App registers `chroxy://` URL scheme. On Android, any app can register the same scheme and intercept connection URLs containing tokens.

**Scope:**
- Implement Universal Links (iOS) and App Links (Android) with domain verification
- Add intent filter validation
- Consider HTTPS-based connection flow instead of custom scheme

---

### SEC-14: Secure mobile credential storage
**Priority:** Medium
**Labels:** `security`, `app`

`expo-secure-store` errors silently caught with no logging in `packages/app/src/store/connection.ts:100-127`. Credentials may backup to iCloud/Google Drive.

**Scope:**
- Log storage failures at warn level
- Show user feedback when credentials can't be saved
- Use `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` on iOS to prevent backup
- Document Expo Go limitations vs production build behavior

---

### SEC-15: Add session management and client tracking
**Priority:** Medium
**Labels:** `security`, `server`, `enhancement`

No server-side session management. Once authenticated, WebSocket remains valid indefinitely. No ability to list active clients or revoke sessions.

**Scope:**
- Implement session IDs separate from API token
- Add session expiry (configurable, e.g., 24 hours)
- Add `chroxy sessions list` and `chroxy sessions revoke <id>` CLI commands
- Limit concurrent sessions (e.g., max 5)
- Track client metadata (device name, connected time)

---

### SEC-16: Add per-client token support
**Priority:** Low
**Labels:** `security`, `server`, `enhancement`

All devices share one token. Can't revoke access for a single device.

**Scope:**
- Support multiple API keys with labels: `chroxy token create --label "iPhone"`
- Independent revocation per token
- Add token scopes (read-only, read-write, admin)
- Show which token is in use on connection

---

### SEC-17: Validate working directory in CLI mode
**Priority:** Medium
**Labels:** `security`, `server`

`cwd` parameter passed to `spawn()` without validation in `packages/server/src/cli-session.js:94`. Could access sensitive directories.

**Scope:**
- Validate cwd exists and is within allowed paths
- Resolve symlinks before validation
- Default to `process.cwd()` not `process.env.HOME`
- Document security implications of cwd setting

---

### SEC-18: Add output sanitization for sensitive data
**Priority:** Medium
**Labels:** `security`, `server`, `app`

All terminal output including secrets, API keys, and passwords flows through WebSocket unfiltered. Terminal buffer stores 50k characters in mobile app memory.

**Scope:**
- Implement optional secret detection patterns
- Warn users when sensitive-looking content detected
- Consider redaction option for known secret patterns
- Add warning before exporting messages containing potential secrets

---

### SEC-19: Protect against ReDoS in output parser
**Priority:** Low
**Labels:** `security`, `server`, `performance`

Output parser uses 30+ complex regex patterns in `packages/server/src/output-parser.js:66-114`. Crafted input could trigger catastrophic backtracking.

**Scope:**
- Audit all regex patterns for exponential backtracking potential
- Add timeout to regex operations
- Consider using `re2` library for guaranteed linear time
- Add benchmarks for worst-case regex inputs

---

### SEC-20: Add npm audit to development workflow
**Priority:** Low
**Labels:** `security`, `devops`

No automated dependency vulnerability scanning. Using `node-pty` native module which has direct system access.

**Scope:**
- Add `npm audit` check to CI pipeline
- Configure Dependabot for automated PRs
- Pin `node-pty` version and review release notes for each update
- Add Snyk or similar scanner

---

### SEC-21: Add clipboard exposure warnings
**Priority:** Low
**Labels:** `security`, `app`

Copy function in `packages/app/src/screens/SessionScreen.tsx:101-115` places messages in system clipboard which syncs across devices via iCloud/Google.

**Scope:**
- Warn when copying content that appears to contain secrets
- Consider auto-clear clipboard timer
- Use pasteboard privacy APIs where available

---

### SEC-22: Prevent zombie process accumulation
**Priority:** Low
**Labels:** `security`, `server`, `reliability`

If server crashes, tmux and Claude CLI processes may persist as orphans. No automatic cleanup.

**Scope:**
- Use process groups for child processes
- Implement PID file tracking
- Clean up orphans on server restart
- Add `chroxy cleanup` command

---

### SEC-23: Add resource limits on spawned processes
**Priority:** Medium
**Labels:** `security`, `server`

Claude CLI and tmux processes have no CPU, memory, or file descriptor limits. Could consume all system resources.

**Scope:**
- Set process resource limits via ulimit or cgroup
- Monitor child process resource usage
- Kill runaway processes after configurable threshold
- Add resource usage to health endpoint

---

### SEC-24: Restrict tunnel URL lifetime
**Priority:** Medium
**Labels:** `security`, `server`

Cloudflare `*.trycloudflare.com` URLs persist as long as the process runs. If URL leaks, attacker has permanent access point.

**Scope:**
- Document that tunnel URLs should be treated as sensitive
- Consider periodic tunnel rotation (reconnect every N hours)
- Investigate authenticated Cloudflare tunnels with account-level control
- Add tunnel URL to audit log

---

### SEC-25: Protect QR code display from shoulder surfing
**Priority:** Low
**Labels:** `security`, `server`

QR code displayed in terminal can be photographed by bystanders or security cameras.

**Scope:**
- Display QR for limited time, then clear screen
- Require explicit `--show-qr` flag
- Add countdown timer before QR disappears
- Support NFC or Bluetooth pairing as alternative

---

### SEC-26: Add error message sanitization
**Priority:** Low
**Labels:** `security`, `server`

Error stack traces could expose internal file system paths, providing reconnaissance data to attackers.

**Scope:**
- Sanitize error messages sent to WebSocket clients
- Strip file paths and stack traces from client-facing errors
- Log full errors server-side only
- Use structured error codes instead of raw messages

---

## 2. Server Architecture

### SRV-01: Fix hard-coded macOS tmux path
**Priority:** Critical
**Labels:** `bug`, `server`, `cross-platform`

tmux binary path is hard-coded to `/opt/homebrew/bin/tmux` in `packages/server/src/pty-manager.js:33,41-42` but uses bare `tmux` on line 108. Fails on Linux and on macOS with non-Homebrew installations.

**Scope:**
- Use `which tmux` or `command -v tmux` to locate binary dynamically
- Make tmux path configurable via config or env var
- Use consistent path throughout the file
- Add pre-flight check that tmux exists with helpful error message
- Test on Linux (Ubuntu, Debian) and macOS (Homebrew, MacPorts)

---

### SRV-02: Extract hard-coded timing values into configuration
**Priority:** High
**Labels:** `server`, `enhancement`, `configuration`

30+ hard-coded timing values scattered across all server files:

| File | Value | Purpose |
|------|-------|---------|
| `server.js:55` | 300ms | Trust dialog acceptance delay |
| `server.js:62` | 2000ms | PTY reattach timer |
| `pty-manager.js:73` | 500ms | Shell launch delay before Claude |
| `ws-server.js:99` | 10000ms | Auth timeout |
| `ws-server.js:272` | 50ms | Delta batch window |
| `output-parser.js:196` | 500ms | Prompt flush timeout |
| `output-parser.js:310` | 1500ms | Message flush timeout |
| `output-parser.js:322` | 5000ms | Grace period before emitting |
| `output-parser.js:341` | 10000ms | Deduplication window |
| `cli-session.js:235` | 300000ms | Result timeout (5 min) |
| `cli-session.js:470` | 5000ms | Interrupt timeout |
| `cli-session.js:512` | 3000ms | Force-kill delay |
| `tunnel.js:66` | 30000ms | Tunnel establishment timeout |

**Scope:**
- Create a `defaults.js` config module with all timing values
- Allow overrides via config file and environment variables
- Document each value's purpose and valid range
- Group related timings logically

---

### SRV-03: Add pre-flight dependency validation
**Priority:** High
**Labels:** `server`, `enhancement`, `dx`

Server assumes `cloudflared`, `tmux`, and `claude` exist. Fails at runtime with cryptic errors instead of at startup.

**Scope:**
- Add `chroxy doctor` command to validate all dependencies
- Check at startup: binary exists, version is compatible, can execute
- Print clear, actionable error messages with install instructions
- Add dependency status to health endpoint
- Document tested version matrix

---

### SRV-04: Fix hard-coded working directory
**Priority:** High
**Labels:** `bug`, `server`

PTY working directory always set to `process.env.HOME` in `packages/server/src/pty-manager.js:48`, ignoring the actual cwd.

**Scope:**
- Default to `process.cwd()` instead of HOME
- Make configurable via `--cwd` CLI flag
- Support per-session working directories

---

### SRV-05: Eliminate duplicate startup code
**Priority:** High
**Labels:** `server`, `refactor`

`server.js` and `server-cli.js` have near-identical startup/shutdown sequences. Configuration loading is duplicated between `index.js` and `server.js`.

**Scope:**
- Extract common startup/shutdown logic into shared module
- Single source of truth for configuration
- Unified error handling during startup
- Proper async cleanup with `Promise.all` for shutdown

---

### SRV-06: Add structured logging
**Priority:** High
**Labels:** `server`, `enhancement`, `observability`

Current logging is `console.log`/`console.error` with string interpolation. No timestamps, no log levels, no structured format, no log rotation.

**Scope:**
- Add `pino` as structured logger
- JSON format with: timestamp, level, component, message, context
- Support log levels via `LOG_LEVEL` env var (error, warn, info, debug, trace)
- Redact sensitive fields (tokens, session content)
- Add correlation IDs for request tracing across components
- File-based logging with rotation for production

---

### SRV-07: Fix output parser memory leak in deduplication
**Priority:** Medium
**Labels:** `bug`, `server`, `performance`

Deduplication map in `packages/server/src/output-parser.js:342-348` pruning only triggers at 200+ entries and only removes entries older than 30s. Under steady load, map can grow unbounded.

**Scope:**
- Replace with LRU cache with fixed max size
- Reduce pruning threshold or use time-based eviction
- Add metrics for deduplication map size
- Consider using WeakRef for entries

---

### SRV-08: Make model allowlist dynamic
**Priority:** Medium
**Labels:** `server`, `enhancement`

`ALLOWED_MODELS` hard-coded in `packages/server/src/ws-server.js:10-19`. Needs code update for every new Claude model.

**Scope:**
- Fetch available models from Claude CLI (`claude --models` or similar)
- Allow config-based model list as fallback
- Cache model list with TTL refresh
- Accept any model string matching a pattern (e.g., `claude-*`)

---

### SRV-09: Add graceful shutdown with proper drain
**Priority:** Medium
**Labels:** `server`, `reliability`

Shutdown in `server.js:98-104` and `server-cli.js:77-83` doesn't wait for async operations. WebSocket clients may not receive close messages.

**Scope:**
- Send `{ type: "server_shutdown", gracePeriodSeconds: 5 }` to all clients
- Wait for in-flight messages to complete
- `Promise.all` for all cleanup operations
- Add configurable grace period
- Force exit after timeout

---

### SRV-10: Add WebSocket heartbeat/keep-alive
**Priority:** Medium
**Labels:** `server`, `reliability`

No periodic ping/pong to detect stale connections. Dead clients linger consuming resources.

**Scope:**
- Add configurable heartbeat interval (default 30s)
- Close connection after 2 missed pongs (60s)
- Track latency from ping-pong round trips
- Log stale connection cleanup

---

### SRV-11: Extract output parser patterns to data file
**Priority:** Medium
**Labels:** `server`, `maintainability`

30+ regex patterns hard-coded in `packages/server/src/output-parser.js:66-114` are fragile, hard to maintain, and have performance implications.

**Scope:**
- Extract patterns to JSON/YAML data file
- Add documentation for each pattern's purpose
- Unit test each pattern individually
- Consider pattern hot-reloading without server restart
- Profile regex performance and optimize hot paths

---

### SRV-12: Add max message/buffer size enforcement
**Priority:** Medium
**Labels:** `server`, `reliability`

No protection against very large PTY outputs or parser buffers consuming all memory.

**Scope:**
- Add max buffer size to output parser (e.g., 1MB)
- Truncate with warning when exceeded
- Add max message size for parsed output
- Configure limits via server config

---

### SRV-13: Replace execSync with async alternatives
**Priority:** Medium
**Labels:** `server`, `performance`

Synchronous `execSync` calls in `pty-manager.js:33,108` block the event loop.

**Scope:**
- Replace `execSync` with `execFile` (async) or `spawnSync` with array args
- Use promises for tmux session checks
- Avoid blocking the main event loop during startup

---

### SRV-14: Add tunnel provider abstraction
**Priority:** Medium
**Labels:** `server`, `enhancement`, `architecture`

Tunnel implementation hard-coded to cloudflared in `packages/server/src/tunnel.js`. URL pattern matching is fragile regex.

**Scope:**
- Define `TunnelProvider` interface with `start(port)` and `stop()` methods
- Implement providers: cloudflared, ngrok, localtunnel, localhost (no tunnel)
- Select via `--tunnel` CLI flag or config
- Support custom domains for paid tunnel services
- Add tunnel health monitoring and automatic failover

---

### SRV-15: Improve CLI session respawn logic
**Priority:** Medium
**Labels:** `server`, `reliability`

Respawn logic in `packages/server/src/cli-session.js:181-201` has hard-coded max attempts (5) and delay schedule. No detection of persistent failures.

**Scope:**
- Make max attempts and delays configurable
- Implement circuit breaker pattern (stop retrying on persistent failure)
- Detect common failure modes (API key revoked, binary missing)
- Notify clients of respawn state
- Add exponential backoff that persists across attempts

---

### SRV-16: Add localhost development mode
**Priority:** Low
**Labels:** `server`, `dx`

Must run cloudflared even for local testing. Slow startup, requires internet.

**Scope:**
- Add `chroxy start --local` mode that skips tunnel
- Direct WebSocket on `ws://localhost:8765`
- Auto-detect if cloudflared is missing and suggest local mode
- QR code points to local IP for same-network testing

---

### SRV-17: Support cross-platform Node.js version management
**Priority:** Low
**Labels:** `server`, `dx`

Package.json says `>=18` but CLAUDE.md requires Node 22. No enforcement.

**Scope:**
- Update engines field to `">=18 <25"` or specifically `"22.x"`
- Add `.nvmrc` or `.node-version` file with `22`
- Add startup check that validates Node version
- Document in README and error messages

---

### SRV-18: Add environment profiles
**Priority:** Low
**Labels:** `server`, `configuration`

Single config file, no dev/staging/prod separation.

**Scope:**
- Support `~/.chroxy/config.{development,production}.json`
- Select via `--env` flag or `CHROXY_ENV` env var
- Config inheritance: base + environment overrides
- Environment-specific defaults (dev: verbose logs, prod: errors only)

---

## 3. Mobile App

### APP-01: Split SessionScreen into focused components
**Priority:** High
**Labels:** `app`, `refactor`, `architecture`

`packages/app/src/screens/SessionScreen.tsx` is 895 lines with 10+ state variables, 4 nested components, and handles chat rendering, terminal rendering, input, and keyboard management.

**Scope:**
- Extract `ChatView` to `components/ChatView.tsx`
- Extract `TerminalView` to `components/TerminalView.tsx`
- Extract `InputBar` to `components/InputBar.tsx`
- Extract `MessageBubble` and `ToolBubble` to `components/MessageBubble.tsx`
- Extract `ModelSelector` to `components/ModelSelector.tsx`
- Each component gets its own props interface and can be unit tested independently

---

### APP-02: Add error boundary for crash recovery
**Priority:** High
**Labels:** `app`, `bug`, `reliability`

No error boundary in the app. Any render error crashes the entire app with no recovery.

**Scope:**
- Add `ErrorBoundary` component wrapping each screen
- Show recovery UI with "Retry" and "Reconnect" buttons
- Log error details to console/future error tracking
- Preserve connection state across recoveries

---

### APP-03: Add message list virtualization
**Priority:** High
**Labels:** `app`, `performance`

Messages rendered via `ScrollView` + `.map()` in `SessionScreen.tsx:375-385`. No virtualization. With 100+ messages, scrolling becomes janky and memory grows linearly.

**Scope:**
- Replace `ScrollView` + `.map()` with `FlatList`
- Implement `renderItem` with proper `keyExtractor`
- Memoize message components with `React.memo`
- Add estimated item size for smooth scrolling
- Add maximum message history limit (e.g., 500 messages)

---

### APP-04: Fix reconnection logic — add exponential backoff
**Priority:** High
**Labels:** `app`, `bug`, `reliability`

Auto-reconnect in `packages/app/src/store/connection.ts:407-414` uses fixed 1.5s delay. If server is down, app hammers server with reconnect attempts.

**Scope:**
- Implement exponential backoff: 1s, 2s, 4s, 8s, 16s, max 60s
- Add max reconnect attempts (e.g., 10)
- Show attempt count in UI ("Reconnecting... attempt 3/10")
- Add "Give up" button
- Reset backoff on successful connection

---

### APP-05: Add accessibility labels throughout
**Priority:** High
**Labels:** `app`, `accessibility`

No `accessibilityLabel` on buttons, no `accessibilityRole` on message bubbles, no `accessibilityHint` for long-press behavior. Buttons use emojis with no accessible labels.

**Scope:**
- Add `accessibilityLabel` to all interactive elements
- Add `accessibilityRole` to semantic components (button, text, header)
- Add `accessibilityHint` for non-obvious interactions (long-press)
- Support Dynamic Type (system font size)
- Support Reduce Motion preference
- Test with VoiceOver (iOS) and TalkBack (Android)

---

### APP-06: Refactor global mutable state in connection store
**Priority:** Medium
**Labels:** `app`, `refactor`, `bug`

Module-level mutable variables in `packages/app/src/store/connection.ts:130-157`:

```typescript
let connectionAttemptId = 0
let disconnectedAttemptId = -1
let messageIdCounter = 0
const pendingDeltas = new Map<string, string>()
let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null
```

**Scope:**
- Move counters into Zustand store state
- Move `pendingDeltas` into store or use refs
- Use UUID-based IDs instead of monotonic counters
- Ensure proper cleanup on disconnect/reconnect
- Add proper TypeScript types for all state

---

### APP-07: Add proper URL and input validation
**Priority:** Medium
**Labels:** `app`, `bug`

Weak validation in `ConnectScreen.tsx:58-71` — only checks if URL starts with protocol. QR parser in lines 16-32 accepts `wss://` without token and drops port info.

**Scope:**
- Validate URL format (hostname, optional port)
- Validate token format (UUID pattern)
- Preserve port from QR code parsing
- Show specific error messages (not just "Missing Info")
- Add connection test before saving

---

### APP-08: Add message type validation
**Priority:** Medium
**Labels:** `app`, `bug`, `reliability`

No validation that incoming `msgType` is valid in `packages/app/src/store/connection.ts:294-306`. Invalid types could corrupt UI state.

**Scope:**
- Validate `msgType` against known `ChatMessage['type']` values
- Log and drop unknown message types
- Add type guard functions
- Prevent rendering errors from unexpected data

---

### APP-09: Add theme system with dark/light mode
**Priority:** Medium
**Labels:** `app`, `enhancement`, `accessibility`

Hardcoded dark theme colors duplicated across multiple files. `app.json` locks to `"userInterfaceStyle": "dark"`. No light theme option.

**Scope:**
- Create theme constants file with named colors
- Support dark and light themes
- Respect system preference (auto mode)
- Add theme toggle in settings
- Use React context for theme propagation

---

### APP-10: Fix stream delta race conditions
**Priority:** Medium
**Labels:** `app`, `bug`

Multiple race conditions in delta handling:
- `pendingDeltas` map persists across reconnects (`connection.ts:141-157`)
- `streamingMessageId` set to null on reconnect but deltas may still flush
- New stream can start before old deltas finish flushing

**Scope:**
- Clear `pendingDeltas` on disconnect
- Add stream session tracking (stream starts carry session ID)
- Validate delta belongs to current stream before applying
- Add tests for edge cases

---

### APP-11: Support landscape orientation
**Priority:** Medium
**Labels:** `app`, `enhancement`

`app.json:6` hardcodes portrait orientation. Terminal viewing benefits significantly from landscape mode on phones.

**Scope:**
- Allow landscape orientation
- Adaptive layout for both orientations
- Terminal view optimized for landscape
- Chat view optimized for portrait
- Auto-rotate based on content or user preference

---

### APP-12: Memoize handler functions and expensive operations
**Priority:** Medium
**Labels:** `app`, `performance`

Handler functions in `SessionScreen.tsx:101-127` filter messages on every render. Each message creates new handler functions in the map.

**Scope:**
- Memoize `handleCopy`, `handleExport` with `useCallback`
- Use `useMemo` for derived data (filtered messages, selected count)
- Prevent unnecessary re-renders with `React.memo` on child components
- Profile render performance and address hotspots

---

### APP-13: Add configurable special key toolbar
**Priority:** Low
**Labels:** `app`, `enhancement`

Only 6 hardcoded special keys in `SessionScreen.tsx:291`. Users may need Ctrl+Z, Ctrl+D, F1-F12, etc.

**Scope:**
- Expand default key set
- Allow drag-to-reorder keys
- Add/remove keys from key library
- Save custom toolbar layouts
- Consider multi-row toolbar for power users

---

### APP-14: Add iPad split-view support
**Priority:** Low
**Labels:** `app`, `enhancement`

No iPad optimization. SessionScreen uses same layout regardless of screen size.

**Scope:**
- Side-by-side chat + terminal on iPad/tablets
- Adjustable split ratio
- External keyboard shortcuts (Cmd+1/2 for view switching)
- Trackpad/mouse support

---

### APP-15: Add connection quality indicator
**Priority:** Low
**Labels:** `app`, `enhancement`, `ux`

Only "Reconnecting..." banner shown. No real-time connection quality info.

**Scope:**
- Show latency indicator (green/yellow/red)
- Measure WebSocket round-trip time
- Warn when connection is degrading
- Show "offline" state clearly

---

## 4. Protocol & API

### PROTO-01: Add protocol version negotiation
**Priority:** High
**Labels:** `protocol`, `server`, `app`

No version field in protocol messages. Can't evolve protocol without breaking old clients.

**Scope:**
- Add `protocol_version` field to auth request
- Server responds with negotiated version and capabilities
- Semantic versioning (MAJOR.MINOR.PATCH)
- Support N-1 version for 6 months after new version
- Document migration path for each version

---

### PROTO-02: Add heartbeat protocol
**Priority:** High
**Labels:** `protocol`, `server`, `app`, `reliability`

No mechanism to detect half-open connections (tunnel dies silently, app backgrounded).

**Scope:**
- Server sends `ping` every 30s with timestamp
- Client responds with `pong` within 10s
- Server closes connection after 2 missed pongs
- Client uses ping latency for connection quality indicator
- Make interval configurable

---

### PROTO-03: Add structured error codes
**Priority:** High
**Labels:** `protocol`, `server`, `app`

Errors are untyped strings. Client can't distinguish retryable vs fatal errors.

**Scope:**
- Define error code enum: `AUTH_FAILED`, `AUTH_TIMEOUT`, `RATE_LIMIT_EXCEEDED`, `INVALID_MESSAGE`, `PTY_PROCESS_DIED`, `CLI_PROCESS_DIED`, `INPUT_REJECTED`, `TUNNEL_DISCONNECTED`, `INTERNAL_ERROR`
- Add severity levels: `fatal`, `error`, `warning`
- Include `retry_after` for retryable errors
- Include `recovery_hint` for user-facing guidance
- Document all error codes

---

### PROTO-04: Add message sequence numbers
**Priority:** High
**Labels:** `protocol`, `server`, `app`, `reliability`

No ordering guarantees. Stream deltas can arrive out-of-order over lossy connections.

**Scope:**
- Add monotonic `seq` field to all server→client messages
- Client detects gaps and requests resend
- Server maintains buffer of last N messages for replay
- Add `resend_request` message type
- Handle duplicate messages via deduplication

---

### PROTO-05: Add JSON Schema validation for all messages
**Priority:** Medium
**Labels:** `protocol`, `server`, `reliability`

Malformed messages cause undefined behavior. No runtime validation.

**Scope:**
- Create JSON Schema for every message type
- Validate all incoming messages against schema
- Return structured validation errors
- Publish schemas in docs for client implementers
- Add `ajv` dependency for validation

---

### PROTO-06: Add message acknowledgment for critical messages
**Priority:** Medium
**Labels:** `protocol`, `server`, `app`

Fire-and-forget means critical messages (model changes, errors) can be silently lost.

**Scope:**
- Add `ack_id` to critical message types (model_changed, error, auth_ok)
- Client sends `ack` message in response
- Server retries if no ACK after 5s (up to 3 times)
- Track unacked messages per client

---

### PROTO-07: Add backpressure protocol
**Priority:** Medium
**Labels:** `protocol`, `server`, `app`, `performance`

Server can flood slow clients with stream_delta messages during rapid output.

**Scope:**
- Client sends `flow_control: pause` when buffer full
- Server buffers deltas during pause (max 10KB, then drop oldest)
- Client sends `flow_control: resume` when ready
- Add `ws.bufferedAmount` monitoring on server side

---

### PROTO-08: Add file transfer protocol
**Priority:** Medium
**Labels:** `protocol`, `server`, `app`, `feature`

No way to transfer files (images from Claude tools, screenshots from phone, code files).

**Scope:**
- Define file transfer messages: `file_available`, `file_data`, `file_complete`
- Add `/files/:id` HTTP endpoint for large files
- Support chunked transfer for files >100KB
- Use binary WebSocket frames for efficiency
- Restrict MIME types and max size (10MB)
- Auto-cleanup temp files after session

---

### PROTO-09: Add REST API for non-realtime operations
**Priority:** Medium
**Labels:** `protocol`, `server`, `enhancement`

WebSocket is overkill for simple queries (list sessions, get config, check health).

**Scope:**
- `GET /health` — expanded health with dependency status
- `GET /sessions` — list active sessions
- `GET /config` — server configuration (non-sensitive)
- `GET /metrics` — Prometheus-style metrics
- All protected by Bearer token auth
- OpenAPI documentation

---

### PROTO-10: Add per-message compression
**Priority:** Low
**Labels:** `protocol`, `server`, `performance`

Large messages consume bandwidth over mobile connections.

**Scope:**
- Enable WebSocket per-message deflate extension
- Configure compression threshold (only compress >1KB)
- Make compression level configurable
- Measure and log bandwidth savings

---

### PROTO-11: Add session checkpoint and restore
**Priority:** Low
**Labels:** `protocol`, `server`, `app`, `enhancement`

If app force-quits, entire chat history is lost. Can't resume where left off.

**Scope:**
- Server periodically saves session state (messages, terminal buffer, model)
- Client sends `restore_session` on reconnect with `since_timestamp`
- Server replays missed messages
- Configurable retention (e.g., 24 hours)
- Storage in `~/.chroxy/sessions/`

---

### PROTO-12: Add capability negotiation
**Priority:** Low
**Labels:** `protocol`, `server`, `app`

Client doesn't know what features server supports. Can't gracefully handle mismatches.

**Scope:**
- Server advertises capabilities after auth: streaming, model-switch, file-transfer, etc.
- Client adapts UI based on capabilities
- Feature detection over version checking
- Document capability discovery flow

---

## 5. Testing & Quality

### TEST-01: Set up test framework for server package
**Priority:** Critical
**Labels:** `testing`, `server`, `infrastructure`

Zero tests in entire codebase. No test framework configured.

**Scope:**
- Add Vitest as test framework (ESM native, fast)
- Add `c8` for coverage
- Configure `test`, `test:watch`, `test:coverage` scripts
- Create test directory structure
- Add mock helpers for node-pty, child_process, WebSocket
- Target: 60% coverage in 3 months, 80% in 6 months

---

### TEST-02: Write unit tests for OutputParser (P0)
**Priority:** Critical
**Labels:** `testing`, `server`

OutputParser is 393 LOC with complex state machine and regex-heavy parsing. Highest-risk module.

**Scope:**
- Test all state transitions (IDLE → THINKING → RESPONSE → TOOL_USE)
- Test ANSI stripping edge cases (split sequences, cursor positioning)
- Test noise filtering (all 30+ patterns)
- Test prompt detection (numbered options, permission dialogs)
- Test message deduplication logic
- Test grace period behavior
- Golden file testing (sample PTY outputs vs expected parsed output)
- Coverage target: 90%

---

### TEST-03: Write unit tests for WebSocket server
**Priority:** High
**Labels:** `testing`, `server`

Authentication, connection management, and message routing are security-critical and untested.

**Scope:**
- Test auth flow (valid/invalid tokens, timeout)
- Test message routing for all types
- Test client state management
- Test broadcast filtering (chat vs terminal mode)
- Test malformed message handling
- Mock WebSocket, PtyManager, OutputParser
- Coverage target: 85%

---

### TEST-04: Write unit tests for PtyManager
**Priority:** High
**Labels:** `testing`, `server`

Process lifecycle bugs can cause zombie processes and memory leaks.

**Scope:**
- Test session creation vs resume logic
- Test PTY lifecycle (spawn, data, resize, exit, cleanup)
- Test tmux session detection
- Test environment variable setup
- Mock node-pty and execSync
- Coverage target: 80%

---

### TEST-05: Set up test framework for app package
**Priority:** High
**Labels:** `testing`, `app`, `infrastructure`

No testing in mobile app. No Jest or React Native Testing Library configured.

**Scope:**
- Add Jest with React Native preset
- Add @testing-library/react-native
- Configure test scripts
- Create mock helpers for WebSocket, SecureStore, navigation
- Write tests for connection store (highest risk)
- Write component tests for ConnectScreen and SessionScreen

---

### TEST-06: Add integration tests for server
**Priority:** Medium
**Labels:** `testing`, `server`

No testing of component interactions (WebSocket → PTY → Parser flow).

**Scope:**
- Test full server startup (mock tunnel only)
- Test client→server→PTY→parser→broadcast flow
- Test reconnection scenarios
- Test mode switching
- Test multi-client behavior

---

### TEST-07: Add ESLint and Prettier with pre-commit hooks
**Priority:** Medium
**Labels:** `quality`, `dx`, `infrastructure`

No linting or formatting enforcement. Code style rules exist in CLAUDE.md but nothing enforces them.

**Scope:**
- Configure ESLint for server (no semicolons, single quotes)
- Configure ESLint for app (TypeScript strict, React hooks rules)
- Add Prettier configuration
- Add Husky + lint-staged for pre-commit enforcement
- Add lint step to CI pipeline
- Fix existing lint violations

---

## 6. DevOps & Infrastructure

### OPS-01: Set up GitHub Actions CI pipeline
**Priority:** Critical
**Labels:** `devops`, `ci`, `infrastructure`

No CI/CD. No automated testing, linting, or build verification on PRs.

**Scope:**
- Lint & format check (server JS, app TS)
- TypeScript type checking (app)
- Unit test runner with coverage reporting
- Integration tests
- npm audit (security)
- Build verification for both packages
- Required status checks for PR merge

---

### OPS-02: Add branch protection rules
**Priority:** High
**Labels:** `devops`, `infrastructure`

CLAUDE.md says "NEVER commit directly to main" but nothing enforces this.

**Scope:**
- Require pull request reviews (1 approval)
- Require status checks to pass
- Require branches to be up to date
- Enable linear history (squash merge)
- Disallow force push to main

---

### OPS-03: Create docs/ directory with architecture documentation
**Priority:** High
**Labels:** `docs`, `infrastructure`

`docs/` referenced in README and project structure but doesn't exist.

**Scope:**
- Architecture overview with diagrams
- WebSocket protocol specification
- Tunnel setup comparison (cloudflared vs ngrok)
- Output parser tuning guide
- Troubleshooting guide
- Security model document
- Consider VitePress for docs site

---

### OPS-04: Add release automation
**Priority:** Medium
**Labels:** `devops`, `infrastructure`

No automated releases, changelogs, or version bumping.

**Scope:**
- Add CHANGELOG.md (Keep a Changelog format)
- Set up conventional commits
- Automate npm publishing for server package
- GitHub Release creation with release notes
- Semantic versioning automation

---

### OPS-05: Add Docker support for server
**Priority:** Medium
**Labels:** `devops`, `server`, `deployment`

No containerization option. Manual process only.

**Scope:**
- Create Dockerfile for server (Node 22, tmux, cloudflared)
- Add docker-compose.yml
- Add health check
- Run as non-root user
- Document container usage

---

### OPS-06: Add EAS build configuration for mobile app
**Priority:** Medium
**Labels:** `devops`, `app`, `deployment`

No Expo Application Services config for automated mobile builds.

**Scope:**
- Create `eas.json` with development, preview, and production profiles
- Set up TestFlight distribution for iOS
- Set up Play Store internal testing for Android
- Add GitHub Actions workflow for mobile builds

---

### OPS-07: Add PR template and expand issue templates
**Priority:** Low
**Labels:** `devops`, `dx`

No PR template. Bug/feature issue templates are minimal.

**Scope:**
- Create `.github/pull_request_template.md` with checklist
- Enhance issue templates with more structured fields
- Add "technical debt" and "security" issue templates
- Add SECURITY.md for vulnerability reporting

---

## 7. Features & UX

### FEAT-01: Add markdown rendering in chat view
**Priority:** High
**Labels:** `app`, `feature`, `ux`

Claude responses displayed as plain text. No formatting for bold, italic, code blocks, headers, lists, or tables.

**Scope:**
- Add `react-native-markdown-display` or similar
- Render inline formatting (bold, italic, code)
- Render code blocks with syntax highlighting
- Support headers, lists, tables, blockquotes
- Handle horizontal rules
- Copy button on code blocks

---

### FEAT-02: Add syntax-highlighted code blocks
**Priority:** High
**Labels:** `app`, `feature`, `ux`

Code in messages shown as monospace text with no highlighting.

**Scope:**
- Auto-detect language from markdown code fences
- Syntax highlighting for 20+ languages
- Copy button per code block
- Line numbers (toggleable)
- Word wrap toggle

---

### FEAT-03: Add Settings screen
**Priority:** Medium
**Labels:** `app`, `feature`

No Settings screen. Can't change input settings, themes, or other preferences within the app.

**Scope:**
- Input behavior (enter to send in chat/terminal)
- Theme selection (dark/light/auto)
- Terminal font and size
- Notification preferences
- Connection timeout settings
- About/version info
- Clear local data option

---

### FEAT-04: Add message search and filtering
**Priority:** Medium
**Labels:** `app`, `feature`

Can't search message history or filter by type.

**Scope:**
- Search bar with text search across all messages
- Filter by message type (response, tool use, user input)
- Highlight search matches
- Navigate between results (prev/next)
- Search within code blocks

---

### FEAT-05: Add multi-server connection profiles
**Priority:** Medium
**Labels:** `app`, `feature`

Can only connect to one server. No way to manage multiple Chroxy instances.

**Scope:**
- Named profiles (e.g., "Work Mac", "Home Desktop")
- Quick-switch between saved connections
- Profile-specific settings
- Connection history per profile
- Edit/delete profiles

---

### FEAT-06: Add push notifications
**Priority:** Medium
**Labels:** `app`, `server`, `feature`

App must be in foreground to see responses. No way to be notified when Claude finishes.

**Scope:**
- Push notification when app is backgrounded and response arrives
- Notification for long-running task completion
- Notification for errors/disconnections
- Deep link from notification to specific message
- Configurable notification preferences
- Requires server-side push token registration

---

### FEAT-07: Add conversation export in multiple formats
**Priority:** Medium
**Labels:** `app`, `feature`

Only exports to JSON. No human-readable formats.

**Scope:**
- Export as Markdown (formatted, with headers)
- Export as PDF
- Export as plain text
- Share via system share sheet
- Include/exclude tool use in exports

---

### FEAT-08: Add command history and quick commands
**Priority:** Low
**Labels:** `app`, `feature`, `ux`

No command history in terminal mode. Can't re-use previous inputs.

**Scope:**
- Scrollable command history (arrow up/down)
- Save frequently used commands as quick commands
- Quick command library with categories
- Fuzzy search in command history

---

### FEAT-09: Add terminal color scheme selection
**Priority:** Low
**Labels:** `app`, `feature`, `ux`

Hardcoded terminal colors. No theme options for terminal view.

**Scope:**
- Solarized Dark/Light
- Dracula, Monokai, Nord
- Custom color picker
- Font selection (JetBrains Mono, Fira Code, etc.)
- Font size adjustment (pinch-to-zoom)

---

### FEAT-10: Add onboarding flow for first-time users
**Priority:** Low
**Labels:** `app`, `feature`, `ux`

No guidance for new users on how to connect or use the app.

**Scope:**
- 3-4 screen swipeable tutorial
- Show server setup steps
- Demonstrate QR scanning
- Explain chat vs terminal modes
- Skip button + "Don't show again"

---

## Priority Matrix

### Critical (Do First)
| Issue | Category | Effort |
|-------|----------|--------|
| SEC-01 | Security — Auto-trust removal | Small |
| SEC-03 | Security — Token storage | Medium |
| SRV-01 | Server — Cross-platform tmux | Small |
| TEST-01 | Testing — Framework setup | Medium |
| TEST-02 | Testing — OutputParser tests | Large |
| OPS-01 | DevOps — CI pipeline | Medium |

### High (Do Next)
| Issue | Category | Effort |
|-------|----------|--------|
| SEC-02 | Security — Timing-safe compare | Small |
| SEC-04 | Security — Command injection | Small |
| SEC-05 | Security — Rate limiting | Medium |
| SEC-06 | Security — Message size limits | Small |
| SEC-07 | Security — Token rotation | Medium |
| SRV-02 | Server — Config timing values | Medium |
| SRV-03 | Server — Dependency validation | Medium |
| SRV-04 | Server — Working directory fix | Small |
| SRV-05 | Server — Deduplicate startup code | Medium |
| SRV-06 | Server — Structured logging | Medium |
| APP-01 | App — Split SessionScreen | Large |
| APP-02 | App — Error boundary | Small |
| APP-03 | App — Message virtualization | Medium |
| APP-04 | App — Reconnection backoff | Small |
| APP-05 | App — Accessibility labels | Medium |
| PROTO-01 | Protocol — Version negotiation | Medium |
| PROTO-02 | Protocol — Heartbeat | Medium |
| PROTO-03 | Protocol — Structured errors | Medium |
| PROTO-04 | Protocol — Sequence numbers | Medium |
| TEST-03 | Testing — WS server tests | Large |
| TEST-04 | Testing — PtyManager tests | Medium |
| TEST-05 | Testing — App test framework | Medium |
| OPS-02 | DevOps — Branch protection | Small |
| OPS-03 | DevOps — Documentation | Large |
| FEAT-01 | Feature — Markdown rendering | Medium |
| FEAT-02 | Feature — Code highlighting | Medium |

### Medium (Planned)
| Issue | Category | Effort |
|-------|----------|--------|
| SEC-08 through SEC-18 | Security hardening | Various |
| SRV-07 through SRV-14 | Server improvements | Various |
| APP-06 through APP-12 | App improvements | Various |
| PROTO-05 through PROTO-09 | Protocol enhancements | Various |
| TEST-06, TEST-07 | Testing expansion | Various |
| OPS-04 through OPS-06 | DevOps automation | Various |
| FEAT-03 through FEAT-07 | App features | Various |

### Low (Backlog)
| Issue | Category | Effort |
|-------|----------|--------|
| SEC-19 through SEC-26 | Security polish | Various |
| SRV-15 through SRV-18 | Server polish | Various |
| APP-13 through APP-15 | App polish | Various |
| PROTO-10 through PROTO-12 | Protocol advanced | Various |
| OPS-07 | DevOps polish | Small |
| FEAT-08 through FEAT-10 | Nice-to-have features | Various |

---

## Suggested Sprint Plan

### Sprint 1: Foundation
- SEC-01, SEC-02, SEC-04 (quick security fixes)
- SRV-01 (cross-platform tmux)
- TEST-01 (test framework)
- TEST-07 (linting setup)
- OPS-01 (CI pipeline)

### Sprint 2: Testing & Security
- TEST-02 (OutputParser tests)
- TEST-03 (WS server tests)
- SEC-03, SEC-05, SEC-06 (token + rate limiting)
- APP-02 (error boundary)
- OPS-02 (branch protection)

### Sprint 3: Reliability
- SRV-02, SRV-06 (config + logging)
- APP-04 (reconnection)
- PROTO-02 (heartbeat)
- PROTO-03 (structured errors)
- SRV-09 (graceful shutdown)

### Sprint 4: UX Polish
- APP-01 (split SessionScreen)
- APP-03 (virtualization)
- FEAT-01, FEAT-02 (markdown + code highlighting)
- APP-05 (accessibility)

### Sprint 5: Protocol & Features
- PROTO-01 (versioning)
- PROTO-04 (sequence numbers)
- FEAT-03 (settings screen)
- FEAT-05 (multi-server profiles)
- SEC-07 (token rotation)

---

*Generated from full codebase audit on 2026-02-06*
