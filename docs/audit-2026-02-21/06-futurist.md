# Futurist's Audit: Chroxy Long-Term Viability

**Agent**: Futurist -- Architect focused on extensibility and strategic positioning
**Overall Rating**: 3.4 / 5
**Date**: 2026-02-21

---

## Architecture Sustainability

### The Two Monoliths

The codebase has a symmetrical problem: `ws-server.js` (2,691 lines) on the server and `connection.ts` (2,764 lines) on the app. These are mirror-image god objects -- the server monolith handles all WS protocol logic, and the app monolith handles all connection/session state.

**This is the single biggest architectural risk.** Every new feature touches both files. Every bug requires understanding the full context of both. Refactoring either one is a high-risk operation because the blast radius is the entire application.

**Sustainability timeline:** At current feature velocity (~3-5 features/week), these files will cross 4,000 lines within 2 months and become effectively unmaintainable by a single developer.

### What Should Be Done

Server decomposition:
- `ws-auth.js` -- authentication, rate limiting, encryption handshake
- `ws-router.js` -- message routing switch statements
- `ws-files.js` -- file browsing, diff generation
- `ws-session-bridge.js` -- session management, history replay
- `ws-server.js` -- HTTP server, WebSocket upgrade, orchestration (kept thin)

App decomposition:
- `store/connection-core.ts` -- phase state machine, connect/disconnect
- `store/connection-messages.ts` -- message handling, history
- `store/connection-encryption.ts` -- crypto operations
- `store/connection-sessions.ts` -- multi-session management

---

## Claude Code Coupling Assessment

**Surprisingly good.** The coupling to Claude Code is narrow:

1. **SDK Session** (`sdk-session.js`): Wraps `@anthropic-ai/claude-code` SDK. This is a ~600 line file with a clean interface: `sendMessage()`, `respond()`, permission handling, model switching.

2. **CLI Session** (`cli-session.js`): Wraps `claude -p` CLI process. Parses stream-json output. ~700 lines.

3. **Provider Abstraction** (`providers.js`): Both sessions register as providers with declared capabilities. The ws-server dispatches to whichever provider is active.

The coupling surface is: one SDK import, one CLI process spawn, and the stream-json event format. If Anthropic changes the SDK API, only `sdk-session.js` needs updating. If they change the CLI output format, only `cli-session.js` needs updating.

**Rating: GOOD.** The abstraction layers here are warranted.

---

## Two-Roadmap Problem

The project has two competing planning documents:
1. **Competitive analysis roadmap** -- 20 action items in 4 phases, maps to actual GitHub issues
2. **In-app-dev roadmap** (`memory/roadmap.md`) -- internal tracking, partially stale

This creates decision paralysis. Which roadmap do you follow? Which items are duplicated? Which take priority?

**Recommendation:** The competitive analysis roadmap should be canonical. It was created with external competitive context (what comparable tools offer) and maps to concrete issues. The in-app-dev roadmap should be archived -- its unique items folded into the competitive roadmap.

---

## Anthropic Risk Assessment

### Scenario A: Anthropic Ships Chat-Only Mobile App
**Risk: LOW.** A chat-only app (like ChatGPT mobile) would not compete with Chroxy's terminal access, file browsing, permission management, and multi-session features. Chroxy's power-user niche is safe.

### Scenario B: Anthropic Ships Terminal-Capable Mobile App
**Risk: HIGH.** If Anthropic builds a mobile app that wraps Claude Code with terminal access and permission handling, Chroxy loses its raison d'etre. Anthropic has more resources, a native SDK, and direct access to Claude Code internals.

**Mitigation strategy:**
- Double down on power-user features that Anthropic is unlikely to prioritize: multi-session orchestration, diff viewer, cost budgets, conversation search, checkpoint/rewind.
- Build features that require local machine access (dev server preview tunneling, MCP awareness) -- harder for a cloud-first Anthropic app to replicate.
- Move fast on client persistence (#685) -- the app must feel "installed" and valuable on its own, not just a thin pipe to a server.

### Scenario C: Claude Code SDK API Changes
**Risk: MEDIUM.** The SDK is pre-1.0 and may change. The `sdk-session.js` abstraction means changes are localized, but a major API redesign could require significant rework.

**Mitigation:** Pin SDK version, monitor changelogs, keep `sdk-session.js` thin.

---

## Technical Debt Forecast

### 1. Static Model List
`models.js` hardcodes available models. When Anthropic adds new models (which they do quarterly), this list becomes stale. Users cannot select the latest model without a server update.

**Debt trajectory:** Gets worse over time. Fix with dynamic model query (#686).

### 2. Three-Mode Code Triplication
The `_handleMessage` function in `ws-server.js` has three switch statements for three server modes (CLI multi-session, CLI single-session, PTY). Each has overlapping but slightly different message handling. Adding a new WS message type requires updating up to three places.

**Debt trajectory:** Linear increase per feature. Fix by deleting PTY mode and unifying the CLI paths.

### 3. Encryption Singletons
`ws-server.js:378` stores encryption state on the client object: `{ sharedKey, sendNonce, recvNonce }`. This is per-connection, which is correct. But the nonce management is scattered across the file -- increment here (line 430), increment there (line 2653). A dedicated `EncryptedChannel` class would centralize this.

**Debt trajectory:** Low -- it works. But nonce bugs are catastrophic (silent decryption failures).

### 4. No Server TypeScript
The server is plain JavaScript with JSDoc comments. This is a deliberate choice (CLAUDE.md says "No TypeScript -- plain JavaScript"). But as the codebase grows past 10K LOC, type errors become harder to catch. The app side benefits significantly from TypeScript's type checking.

**Debt trajectory:** Increases with complexity. Consider TypeScript migration for server if LOC exceeds 15K.

### 5. Permission Handling Duplication
Both `sdk-session.js` and `cli-session.js` implement permission mode switching independently. The logic is similar but not identical. The EventNormalizer helps on the output side but does not address the input/configuration side.

**Debt trajectory:** Moderate. Fix by committing to SDK path and removing CLI session.

---

## 90-Day Survival Analysis

What matters most for Chroxy to be viable in 90 days?

### Critical (Without These, Project Stalls)

1. **Client-side persistence (#685).** Losing chat history on disconnect makes the app feel disposable. This is the #1 user experience gap. Must ship within 30 days.

2. **Dynamic model list (#686).** Anthropic will release new models. If users cannot select them without a server update, the app feels abandoned. Ship within 30 days.

### Important (Without These, Growth Stalls)

3. **Image results (#684).** Computer use and screenshot results are increasingly common in Claude Code workflows. Not displaying them makes Chroxy feel incomplete.

4. **ws-server.js decomposition.** At current growth rate, this file blocks development within 60 days.

5. **acceptEdits permission mode.** The most common Claude Code workflow requires a mode that does not exist in Chroxy.

### Nice to Have (90-Day Horizon)

6. Web client fallback (#610)
7. Conversation search (#615)
8. Onboarding tutorial (#628)

---

## Top 5 Recommendations

1. **Merge roadmaps immediately.** One roadmap, one source of truth. Archive `memory/roadmap.md`, update competitive roadmap with current status.

2. **Break the monoliths.** Split `ws-server.js` and `connection.ts` before they cross 3,000 lines. This is prerequisite infrastructure for everything else.

3. **Ship dynamic models within 2 weeks.** Issue #686. Static lists are a time bomb -- the next Anthropic model release breaks the app's model picker.

4. **Commit to SDK path.** Remove CLI session (`cli-session.js`) and PTY mode. The SDK is the strategic investment. Maintaining three code paths multiplies every future feature's cost by 3.

5. **Client persistence within 30 days.** Issue #685. This is the difference between "demo" and "daily driver." AsyncStorage for conversation history, reconnect to previous session. Without this, users will not form the habit of using Chroxy.
