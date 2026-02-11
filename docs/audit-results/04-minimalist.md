# Minimalist's Audit: Chroxy System

**Agent**: Minimalist -- Ruthless engineer who believes the best code is no code. Identifies what to cut and proposes minimal alternatives.
**Overall Rating**: 3.0 / 5
**Date**: 2026-02-10

---

## Section Ratings

### 1. Two Server Modes (PTY/tmux vs CLI Headless) -- 2/5 (Cut Candidate)

The project maintains two completely parallel server architectures:

| | PTY/tmux mode | CLI headless mode |
|---|---|---|
| Orchestrator | `server.js` (152 lines) | `server-cli.js` (238 lines) |
| Session impl | `pty-manager.js` (227) + `pty-session.js` (178) | `cli-session.js` (788) + `sdk-session.js` (599) |
| Parser | `output-parser.js` (518) + `noise-patterns.js` (313) | Not needed (structured JSON) |
| Total | **1,388 lines** | **1,625 lines** |

PTY mode is explicitly labeled "legacy" in CLAUDE.md. ws-server.js carries three separate message handlers + three event-forwarding setups. The output parser is 518 lines of stateful regex matching backed by 1,980 lines of tests -- all because PTY path doesn't get structured data.

**Evidence of bitrot:** `pty-manager.js` hardcodes `/opt/homebrew/bin/tmux`, requires `node-pty` which doesn't compile on Node 25.

**Recommendation:** Delete PTY/tmux mode entirely. Saves ~3,200 lines server code + ~2,400 lines tests. Also closes issues #5, #9.

### 2. Supervisor Complexity -- 3/5

447 lines implementing restart backoff (essential), standby health server (essential), and deploy rollback (unused). The rollback system (`rollbackToKnownGood`, `KNOWN_GOOD_FILE`, `DEPLOY_CRASH_WINDOW`) is ~100 lines of untested infrastructure for a deployment system that doesn't exist. No `deploy` CLI command in `cli.js`.

**Recommendation:** Strip deploy rollback (~100 lines of untested dead code). Keep restart backoff and standby server.

### 3. Session Management -- 3/5

632 lines managing multi-session lifecycle, two session types, ring buffer history, state serialization, and tmux auto-discovery. The auto-discovery subsystem (lines 347-401 + session-discovery.js at 131 lines) exists only for PTY mode. Five custom error classes (62 lines) are never caught by type -- all caught as generic `err`.

**Recommendations:**
1. If PTY cut, remove `attachSession`, tmux discovery, `session-discovery.js` (~250 lines saved)
2. Collapse 5 error classes into plain Error throws (50 lines saved)

### 4. Output Parser -- 2/5 (Wrong Problem)

518 + 313 = 831 lines of brittle terminal scraping: 5-state machine, 34 noise filters, 13 state-dependent patterns, 19 spinner detection regexes, dedup with 10s TTL map. All backed by 1,980 lines of tests.

This is impressive engineering solving the wrong problem. The structured JSON path gives you all of this for free. Every Claude Code update can break the regex patterns.

**Recommendation:** Entire subsystem goes away when PTY mode is removed.

### 5. App Components -- 4/5

Seven components are appropriately factored. `connection.ts` at 1,921 lines is the concern -- entire application brain with 30+ message types. The dual state approach (flat + per-session, synced via `updateSession`) is driven by backward compatibility with PTY mode.

**Recommendation:** After PTY mode removal, eliminate legacy flat state path. Saves 200-300 lines of dual-sync branching.

### 6. Code Duplication -- 2/5

- `setModel` and `setPermissionMode` in `cli-session.js` are near-identical 75-line methods -- extract `_killAndRespawn()` (save ~60 lines)
- Three WS message handlers overlap significantly -- collapse after PTY removal
- ANSI strip regex appears in 4 places across server and app
- Trust dialog regex duplicated between `server.js` and `pty-session.js`

### 7. SDK vs CLI Session -- 3/5

Two CLI session implementations: `cli-session.js` (788 lines) spawns `claude -p` as child process, `sdk-session.js` (599 lines) uses SDK in-process. SDK is clearly superior (in-process permissions, no hook script, no process restart on model change).

**Recommendation:** Once SDK path proven stable, delete `cli-session.js`, `permission-hook.js`, hook script. Saves ~1,048 lines.

---

## The Big Picture: What to Cut

| What | Lines Saved | Complexity Removed |
|------|-------------|-------------------|
| PTY mode (all files) | ~5,600 | Three WS handlers, output parser, noise patterns, pty-manager, pty-session, session-discovery |
| Deploy rollback | ~100 | Phantom infrastructure |
| Error class hierarchy | ~50 | 5 classes never caught by type |
| `setModel`/`setPermissionMode` dedup | ~60 | Near-identical methods |
| Legacy flat state (after PTY) | ~200-300 | Dual-sync in connection.ts |
| CLI session (after SDK stable) | ~1,048 | Permission hook pipeline |
| **Total potential** | **~7,158** | **31% of codebase** |

---

## Top 5 Recommendations

1. **Delete PTY/tmux mode** -- 5,600 lines of legacy code maintaining a lossy reverse-engineering of terminal output that structured JSON replaces
2. **Strip deploy rollback from supervisor** -- 100 lines of untested infrastructure for a nonexistent deployment system
3. **Pin SDK and deprecate CLI session** -- the in-process path is strictly superior, schedule deletion after stability milestone
4. **Simplify connection.ts after PTY removal** -- eliminate legacy flat state, collapse dual-sync logic
5. **Extract `_killAndRespawn()` in cli-session.js** -- immediate dedup win

---

## Verdict

At 22,701 lines, Chroxy carries roughly 7,000 lines (~31%) of code that either serves a deprecated mode, duplicates existing functionality, or builds infrastructure for features that don't exist. The CLI headless + SDK path is clearly the future. The project should schedule a cleanup milestone that removes PTY mode, consolidates the SDK path, and simplifies connection.ts. The remaining ~15,500 lines are well-factored and appropriately complex for the problem.
