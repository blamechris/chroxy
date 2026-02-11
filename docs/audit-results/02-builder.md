# Builder's Audit: Chroxy System

**Agent**: Builder -- Pragmatic full-stack dev who will implement this. Revises effort estimates, identifies file-by-file changes.
**Overall Rating**: 3.8 / 5
**Date**: 2026-02-10

---

## Section Ratings

### 1. Code Organization -- 4/5

**Strengths:**
- Module boundaries clean, dependency graph flows unidirectionally
- No circular dependencies. WsServer receives backends via constructor injection (line 104)
- Clear session type separation: cli-session.js (788), sdk-session.js (599), pty-session.js (178) all implement same EventEmitter interface
- `tunnel-events.js` (23 lines) properly extracted helper eliminates duplication
- Monorepo with npm workspaces correctly configured

**Concerns:**
- `ws-server.js` at 1500 lines approaching extraction threshold
- `connection.ts` at 1921 lines is a monolithic Zustand store; `handleMessage` alone is 753 lines
- `expo-secure-store` incorrectly placed in root `package.json` instead of `packages/app/package.json`

### 2. Component Completeness -- 4/5

Every component listed in CLAUDE.md exists and is functional. No stubs or placeholders. Both server modes fully implemented.

**Missing/Incomplete:**
- xterm.js integration (Issue #5): Terminal view is plain Text with stripAnsi() -- biggest UX gap
- Parser fragmentation (Issue #9): cursor positioning splits, PTY mode only
- Multi-tab navigation (Issue #3): partially done (session picker exists) but scope is broader

### 3. Dependency Health -- 4/5

`npm audit` returns 0 vulnerabilities. Minimal dependency count (7 server, 12 app).

**Notable:**
- `@anthropic-ai/claude-agent-sdk` at ^0.1.0 is riskiest dep -- pre-1.0, breaking changes expected. Consider pinning exact version
- `uuid` could be replaced with `crypto.randomUUID()` (available since Node 16)
- `qrcode-terminal` ^0.12.0 last published 2018 -- unmaintained but low risk
- **Engine field says `>=18` but Node 22 required** -- should be `>=22`

### 4. Build/CI Pipeline -- 3/5

**What's covered:** Server tests, app Jest tests, app TypeScript type check on every PR.

**Gaps:**
- No integration test execution in CI
- No lint step (no ESLint/Prettier config in repo)
- No test coverage reporting or thresholds
- `session-discovery.test.js` calls real tmux commands -- behaves differently on Ubuntu CI vs macOS

### 5. Open Issues -- 4/5

8 open issues is disciplined for v0.1.0. Clean triage with proper labeling.

**Dependency chain:** #429 blocks #430 blocks #424 -- should be worked sequentially.
**Issues #424 and #430 overlap** -- both ask for permission-hook edge case tests, should consolidate.

### 6. Permission Hook System -- 3/5

Clean extraction from session code. Three concerns separated correctly (lock, filesystem ops, lifecycle manager).

**Gap:** Issue #429 (configurable settingsPath) still open. Tests gutted due to P1 incident. Zero test coverage for actual file operations until #429 lands.

---

## Top 5 Findings

1. **`connection.ts` at 1921 lines is a maintainability hazard** -- handleMessage alone is 753 lines, will be bottleneck for any feature touching client state
2. **Unpinned pre-release SDK** -- `@anthropic-ai/claude-agent-sdk` ^0.1.0 allows breaking 0.x updates
3. **Engine field mismatch** -- says `>=18` but Node 22 required for node-pty
4. **No lint or formatting enforcement** -- style is convention-only, will drift with contributors
5. **Issues #424 and #430 should be consolidated** with #429 as prerequisite

---

## Verdict

Clean architecture with sensible module boundaries. The EventEmitter-based session abstraction works well. Dependencies are minimal and healthy. Main risks: connection.ts monolith will slow feature development, SDK version pinning could cause surprise breakages, and CI pipeline needs lint + coverage gates before adding contributors. The codebase is in good shape for a v0.1.0 -- the biggest investment should be splitting connection.ts and hardening CI.
