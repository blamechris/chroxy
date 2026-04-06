# Futurist's Audit: Chroxy v0.6.8 Full Codebase

**Agent**: Futurist — Extensibility, technical debt forecast, plugin architecture.
**Overall Rating**: 4.1 / 5
**Date**: 2026-04-05

---

## Section Ratings

### Protocol Schema Evolution — 3/5

`@chroxy/protocol` defines Zod schemas for all WS messages. This is good — it enforces structure. The problem is schema drift: the server's `ws-message-handlers.js` and the app's `store/message-handler.ts` can handle message types that aren't in the schema (they have fallback branches). Over time, undocumented message types accumulate. As of v0.6.8, there are message types handled in the app that have no corresponding Zod schema in `@chroxy/protocol`.

**Forecast**: In 6 months, the schema will be 30% incomplete. New contributors will not know which message types are authoritative. The schema becomes misleading documentation.

**Fix**: Add a CI check that compares registered handler types against schema keys. Any handler type not in the schema is a build failure.

### Provider System Extensibility — 4/5

`providers.js` is a clean registry. Adding a new provider (e.g., an OpenAI-compatible endpoint) requires implementing a session class and registering it. The interface is implicit (duck-typed), but the existing providers serve as examples. The only concern is that the provider interface has grown organically — `setModel`, `setPermissionMode`, `respondToPermission`, `respondToQuestion` are all implicitly required. A formal interface definition (even in JSDoc) would help.

### Docker / Container Isolation — 3/5

`docker-session.js` and `docker-sdk-session.js` implement container isolation. The container lifecycle (create → attach → destroy) is sound. The gap: if the Docker daemon is not running when a session starts, the error is caught but swallowed in some paths — the client receives a generic failure instead of "Docker is not running." Silent Docker failures will confuse users who expect container isolation.

**Forecast**: As Docker support grows (DevContainers, snapshots), the error handling gap will cause increasingly confusing failures. Users will think Chroxy is broken when Docker is simply not running.

### Desktop/Mobile Feature Parity — 3/5

The desktop dashboard and mobile app have diverged in feature support. The desktop has the Console page, Environment panel, and agent monitoring. The mobile app has biometric lock, voice-to-text, and push notifications. These are not problems today, but the capability matrix will become hard to maintain. The server cannot easily detect which client type is connected (desktop vs mobile) — it sends all message types to all clients.

**Forecast**: In 12 months, a feature built for desktop will accidentally break on mobile because the server broadcast a message type the mobile client doesn't handle.

**Fix**: Add a `clientCapabilities` field to the auth message. Server uses it to gate capability-specific messages.

### Tech Debt Trajectory — 4/5

`ws-server.js` (1027 lines) and `session-manager.js` (1016 lines) are god classes. Both have issues open (#2147, #2148) tracking decomposition. The existing audit results (v0.6.7-comprehensive) correctly identified these. The decomposition has not happened. At current growth rate (~50 lines/month per file), these files will hit 1200 lines in 4 months.

The test suite is in good shape for unit tests but has gaps in integration tests (see Tester's report).

---

## Top 5 Findings

1. **Protocol schema drift** (`@chroxy/protocol`, `ws-message-handlers.js`): Undocumented message types handled in code but absent from schemas. Add CI enforcement. This becomes worse every sprint.

2. **No client capability negotiation** (WS auth flow): Desktop and mobile clients receive identical message streams. Client-specific features will break without capability gating. Add `clientCapabilities: string[]` to auth message.

3. **Docker error visibility** (`docker-session.js`, `docker-sdk-session.js`): Docker failures produce generic errors. Add specific error codes: `docker_not_running`, `docker_image_not_found`, `docker_permission_denied`.

4. **`ws-server.js` / `session-manager.js` decomposition stalled** (#2147, #2148): God classes grow unchecked. Both issues are XL scope — they need to be broken into smaller PRs to make progress.

5. **Implicit provider interface** (`providers.js`): The provider contract is undocumented and duck-typed. New providers will miss required methods and fail at runtime. Add a JSDoc `@typedef ProviderSession` or a validation function.

---

## Forecast: Next 6 Months

| Risk | Likelihood | Impact | Trigger |
|------|-----------|--------|---------|
| Protocol schema 50% incomplete | HIGH | MEDIUM | Each sprint adds undocumented message types |
| Mobile app breaks on new desktop feature | MEDIUM | MEDIUM | Next desktop-only feature added |
| WsServer hits 1400 lines | HIGH | LOW | Normal feature additions |
| Docker failures confuse users | MEDIUM | MEDIUM | First user with Docker not installed |
| New provider breaks silently | LOW | HIGH | First external contributor adding a provider |

---

## Concrete Recommendations

1. **CI schema coverage check**: Add a test that imports all WS message handler registrations and verifies each key exists in `@chroxy/protocol` schemas. Fail CI if not.
2. **Client capabilities in auth**: Add `capabilities: string[]` to the WS `auth` message. Server filters broadcasts by declared capabilities.
3. **Docker error codes**: In `docker-session.js`, catch specific Docker errors (daemon not running, image not found) and emit structured error events with `code` fields.
4. **Decompose god classes**: Break #2147 and #2148 into 3-5 smaller PRs. Start with the auth subsystem (extract `WsAuthHandler`) and the session lifecycle (extract `SessionLifecycle`).
5. **Document provider interface**: Add `@typedef {Object} ProviderSession` JSDoc with all required methods to `providers.js`. Add a `validateProvider(p)` function that throws if methods are missing.

---

## Overall Verdict

Chroxy v0.6.8 is in good shape for its current user base. The architecture can scale. The main risks are accumulated technical debt (god classes stalled, schema drift accelerating) and a coming capability matrix problem as desktop and mobile features diverge. The crypto and security issues (other agents' domain) are the most urgent. On the extensibility and debt trajectory front, the project is managing well with clear awareness of its largest files — it just needs to translate that awareness into action.

**Overall Rating: 4.1 / 5**
