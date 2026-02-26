# Futurist's Audit: Chroxy Codebase Re-Baseline

**Agent**: Futurist — Forward-looking architect who evaluates scalability, extensibility, and long-term sustainability risks
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-26

---

## Section Ratings

| Area | Rating | Notes |
|------|--------|-------|
| Server | 3.5/5 | Provider pattern is extensible; single-user assumption limits scale |
| App | 4/5 | TypeScript + Zustand is a solid foundation for growth |
| Desktop | 2.5/5 | Dashboard architecture has no growth path in current form |
| WS Protocol | 3.5/5 | Well-structured but lacks versioning for forward compatibility |
| Extensibility | 3.5/5 | Provider registry is good; plugin points are missing elsewhere |
| Scalability | 3/5 | Single-user, single-machine — adequate for now, walls ahead |
| Dependency Risk | 3/5 | Claude Code SDK is unversioned; Cloudflare tunnel is a SPOF |
| Architecture Longevity | 3.5/5 | Solid for v0.x; needs evolution planning for v1.0 |

---

## Top 5 Findings

### 1. Cloudflare Tunnel Is a Single Point of Failure with No Fallback

**Severity**: High
**Status**: Architectural risk

Chroxy's remote access model depends entirely on Cloudflare tunnels. Quick Tunnel mode uses a random Cloudflare-assigned URL; Named Tunnel mode uses a user-configured domain. In both cases, if Cloudflare's tunnel infrastructure is unavailable, degraded, or changes its API/behavior, Chroxy's remote access stops working entirely.

**Evidence**:
- `tunnel.js` — sole tunnel implementation, Cloudflare-only
- No fallback tunnel provider (e.g., ngrok, Tailscale, WireGuard)
- No local-network-only mode that gracefully degrades when tunnel is unavailable
- Quick Tunnel URLs are ephemeral — Cloudflare can change the URL assignment mechanism at any time
- `cloudflared` binary is a third-party dependency updated on Cloudflare's schedule

**Risk timeline**: Cloudflare has historically been reliable, but:
- Quick Tunnel is an undocumented/informal feature — no SLA
- Cloudflare could deprecate or rate-limit Quick Tunnel at any time
- Named Tunnel requires a Cloudflare account and domain — vendor lock-in

**Recommendation**: Abstract the tunnel layer behind a `TunnelProvider` interface (similar to the existing session provider pattern). Implement at least one alternative: Tailscale (peer-to-peer, no relay dependency) or a generic SSH tunnel provider. Add a LAN-only mode that works without any tunnel for local development.

---

### 2. Protocol Version Lock-In: No WS Protocol Versioning

**Severity**: High
**Status**: Architectural risk

The WebSocket protocol between server and app has no version negotiation. The client connects and immediately starts sending messages in the current format. If the protocol changes (new required fields, renamed types, changed semantics), there is no way for the server to detect which protocol version the client speaks, and no way for the client to detect if the server has been updated.

**Evidence**:
- `ws-server.js` — no version field in the handshake or auth flow
- `ws-schemas.js` — schemas are unversioned; changes break all older clients
- No `protocol_version` field in the auth message or server hello
- App and server are released independently (app via app stores, server via npm)

**Risk timeline**: As Chroxy gains users, app updates will lag behind server updates. Without version negotiation:
- A server update that adds a required field will break older apps
- An app update that sends a new message type will get schema rejections from older servers
- No graceful degradation — features either work or break silently

**Recommendation**: Add a `protocol_version` field to the auth handshake. Server responds with its supported version range. Client and server negotiate the highest mutually supported version. Define a compatibility matrix. This is much easier to add now (pre-v1.0) than after a public release.

---

### 3. Connection Store Singleton Prohibits Multi-Machine Support

**Severity**: Medium
**Status**: Architectural limitation

The app's Zustand connection store (`connection.ts`) is a singleton that manages a single server connection. All state — session, messages, terminal buffer, settings — lives in one flat store tied to one connection. There is no concept of multiple servers, multiple sessions on different machines, or switching between connections.

**Evidence**:
- `connection.ts` — single `create()` call, one store instance for the entire app
- `WebSocket` reference stored as a single variable, not a map
- `messages`, `terminalBuffer`, `conversationHistory` are all singular arrays
- No `serverId` or `connectionId` to namespace state

**Risk timeline**: Users who run Chroxy on multiple dev machines (work laptop, home desktop, cloud VM) will need to disconnect and reconnect to switch between them. This is acceptable for v0.x but will become a friction point as usage grows.

**Recommendation**: Refactor the store to support multiple named connections. Each connection gets its own state slice (messages, terminal, session). The UI can show a server switcher. Start with the data model change (namespace by connection ID) even if the UI only shows one connection at a time — this prevents a painful migration later.

---

### 4. dashboard.js Is a Time Bomb for Feature Growth

**Severity**: High
**Status**: Architectural risk

The dashboard's 2768-line template string architecture does not scale. Every new dashboard feature (conversation history view, agent monitoring panel, cost tracking widget) must be added to this single string. There is no component model, no state management, no build step, and no way to share code between the dashboard and the desktop app (which wraps it in Tauri).

**Evidence**:
- `dashboard.js` — monolithic template, 2768 lines and growing
- Desktop app (`packages/desktop/`) wraps the same dashboard in a Tauri webview
- No shared component library between dashboard and desktop
- Each feature addition increases the maintenance burden non-linearly (more code in one file = harder to find anything)

**Growth projection**: At the current rate of feature additions (~2-3 dashboard features per release cycle), the file will exceed 4000 lines by v0.3.0 and become effectively unmaintainable.

**Recommendation**: Extract the dashboard into a proper frontend application. Options:
1. **Minimal**: Separate HTML/CSS/JS files served statically (low effort, big improvement)
2. **Moderate**: Vite + vanilla JS/TS with component files (enables linting, hot reload)
3. **Full**: Shared React component library used by both the mobile app and the dashboard (maximum reuse, highest effort)

Option 2 is the sweet spot for Chroxy's current scale. It enables growth without over-engineering.

---

### 5. Claude Code SDK Is an Unversioned Runtime Dependency

**Severity**: High
**Status**: Dependency risk

Chroxy's `SdkSession` depends on the Claude Code SDK (`@anthropic-ai/claude-code`), which is installed globally on the user's machine as part of Claude Code. The SDK's API is not formally versioned — it evolves with Claude Code releases, which happen frequently and without a public changelog for the SDK surface.

**Evidence**:
- `sdk-session.js` — imports from `@anthropic-ai/claude-code` (resolved from the global install)
- No `peerDependencies` declaration pinning a compatible SDK version range
- No version check at startup to verify SDK compatibility
- SDK methods used: `query()`, `supportedModels()`, `abortQuery()` — any of these could change signature

**Risk timeline**: Claude Code updates approximately every 1-2 weeks. Each update could:
- Change the SDK's exported function signatures
- Add required parameters to existing methods
- Change the event stream format that SdkSession parses
- Remove or rename methods

Without version pinning or runtime checks, Chroxy will break silently when the SDK changes. Users will see cryptic errors and blame Chroxy.

**Recommendation**: Add a startup version check that reads the Claude Code version and compares it against a known-compatible range. Display a clear warning if the version is outside the tested range. Document the tested SDK versions in CLAUDE.md. Consider bundling a specific SDK version rather than relying on the global install, if the SDK's license permits it.

---

## Verdict

Chroxy is well-architected for its current scope — a single-user, single-machine remote terminal for Claude Code. The provider pattern, schema-driven protocol, and TypeScript app provide genuine extensibility. The risks are all about what happens next. The Cloudflare tunnel dependency has no fallback, the protocol has no versioning, the connection model assumes one machine, the dashboard cannot grow, and the SDK dependency has no version contract. None of these are problems today — Chroxy works. But each one becomes a wall the moment usage scales beyond the current assumptions. The cheapest time to add protocol versioning, a tunnel abstraction layer, and a proper dashboard build is now, before v1.0 sets the compatibility contract. The most important single change is protocol versioning: it unlocks independent evolution of client and server, which is the prerequisite for all other scalability improvements.
