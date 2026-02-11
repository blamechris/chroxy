# Tester's Audit: Chroxy System

**Agent**: Tester -- Testability, edge cases, coverage gaps, test strategy analysis.
**Overall Rating**: 3.0 / 5
**Date**: 2026-02-10

---

## Section Ratings

### 1. Test Safety -- 2/5

**Known-and-partially-remediated incident:** `permission-hook.test.js` tests wrote to real `~/.claude/settings.json`, contaminating running Claude Code sessions. Tests correctly removed (lines 80-82), issue #429 tracks the fix.

**ACTIVE same-class bug:** `session-manager.test.js` writes to real `~/.chroxy/session-state.json`:
- Line 9: `const STATE_FILE = join(homedir(), '.chroxy', 'session-state.json')`
- Line 142: `writeFileSync(STATE_FILE, 'not json')` -- writes invalid JSON to real user directory
- Lines 169-175: writes valid state files with session data
- `beforeEach`/`afterEach` cleanup exists but if test crashes, stale file causes phantom session restoration

**Additional concern:** `tunnel.integration.test.js:60` calls `process.kill(pid, 'SIGKILL')` on real cloudflared process. Correctly excluded from CI via naming convention.

### 2. Test Coverage -- 3/5

Good coverage on tested components, major gaps on critical production paths.

**Well-tested (12 server, 3 app test files):**

| Source | Test | Coverage |
|--------|------|----------|
| output-parser.js (518) | output-parser.test.js (1980) | Excellent (3.8x ratio) |
| ws-server.js (1500) | ws-server.test.js (2919) | Good |
| tunnel.js (289) | tunnel.test.js (649) | Good |
| config.js (201) | config.test.js (214) | Good |
| models.js (~75) | models.test.js (75) | Complete |
| connection.ts (1921) | connection.test.ts (788) | Moderate |

**ZERO tests (high-risk):**

| Source | LOC | Risk |
|--------|-----|------|
| supervisor.js | 447 | HIGH -- process lifecycle, auto-restart |
| server-cli.js | 238 | HIGH -- CLI mode orchestrator |
| server-cli-child.js | 127 | HIGH -- signal forwarding, shutdown |
| push.js | 108 | MEDIUM -- push notification delivery |
| cli.js | 641 | MEDIUM -- CLI commands |
| All app screens | ~1,307 | HIGH -- zero render tests |
| All app components | ~1,440 | HIGH -- zero render tests |

The **supervisor** (447 LOC) is particularly concerning -- process forking, auto-restart with exponential backoff, and graceful shutdown with zero test coverage.

### 3. Test Isolation -- 3/5

**Good patterns:**
- `config.test.js`: saves/restores `process.env` in beforeEach/afterEach
- `ws-server.test.js`: port 0 (OS-assigned), cleanup in afterEach
- `tunnel.test.js`: `TestTunnelManager` with mock spawn injection
- `output-parser.test.js`: pure unit tests, no shared state

**Problematic:**
- `session-manager.test.js`: writes to real `~/.chroxy/session-state.json`
- `ws-server.test.js:487`: random ports (`30000 + Math.random() * 10000`) instead of port 0
- `session-discovery.test.js:36-40`: interacts with real tmux on host
- `output-parser.test.js`: `setTimeout`-based timers (not fake timers) -- timing-sensitive, flake risk on slow CI

### 4. CI Pipeline -- 3/5

**Covered:** Server tests, app Jest tests, app TypeScript type check on every PR.

**Missing:**
- No integration tests in CI
- No lint/formatting checks
- No test coverage reporting or thresholds
- `session-discovery.test.js` calls real tmux -- different behavior on Ubuntu CI vs macOS
- No security scanning

### 5. Test Patterns -- 4/5

Tests generally test behavior, not implementation. Good mocking boundaries:
- `tunnel.test.js`: subclass with `_spawnCloudflared` override
- `pty-manager.test.js`: `createMockTmuxExecutor` injection
- `ws-server.test.js`: real WebSocket connections, asserts on received messages
- `output-parser.test.js`: organized by behavior categories with real-world regression cases

**Minor concerns:** Some tests reach into private state (`parser._pendingPrompt`, `parser._suppressingScrollback`).

### 6. App Testing -- 2/5

Only pure utility functions and store logic tested (3 files, 1042 LOC). Zero component rendering tests. Zero interaction tests. Zero screen tests. 6,793 LOC of app source completely untested.

Strategy is "test pure functions, type-check everything else." Catches type errors but not rendering bugs, interaction bugs, or state integration issues.

---

## Top 5 Findings

1. **ACTIVE: session-manager.test.js writes to real `~/.chroxy/session-state.json`** -- same P1 class as settings.json incident
2. **Zero tests for supervisor.js (447 LOC)** -- most operationally critical component in named tunnel mode has no coverage
3. **Zero app component/screen render tests** -- 6,793 LOC of UI completely untested
4. **Timer-based test assertions risk CI flakiness** -- output-parser tests use real setTimeout, not fake timers
5. **session-discovery.test.js depends on host tmux state** -- non-deterministic results

---

## Recommendations

1. **Immediate:** Fix session-manager.test.js to use configurable state file path (same pattern as #429)
2. **High priority:** Add supervisor.test.js with mock child process (similar to tunnel.test.js mock spawn)
3. **Medium priority:** Add `@testing-library/react-native` and write render tests for ConnectScreen, ChatView, InputBar
4. **Medium priority:** Use `node:test` built-in timer mocking for output-parser tests
5. **Low priority:** Add test coverage reporting to CI with minimum threshold

---

## Verdict

Mature test suite for v0.1.0 with excellent coverage in tested areas (output parser, WS server, tunnel). The P1 class bug in session-manager.test.js needs immediate attention. The supervisor and app UI are the largest untested risk surfaces. CI pipeline needs lint, coverage gates, and fake timers to prevent flakiness. The foundation is solid -- the gaps are known and trackable.
