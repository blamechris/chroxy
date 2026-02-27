# Skeptic's Audit: Full Codebase Health Post-v0.2.0

**Agent**: Skeptic -- Cynical systems engineer who cross-references every claim against actual code
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-26

## Section Ratings

| Area | Rating | Key Issue |
|------|--------|-----------|
| Server Core | 4/5 | `modeLabel` TDZ risk in tunnel_recovered; dead tmux code in server-cli.js |
| Dashboard | 3/5 | CSP connect-src breaks dashboard over tunnel; 1793-line ES5 JS untested |
| App | 4/5 | `token_rotated` handler is a no-op (console.log + break) |
| Desktop | 3/5 | Tauri CSP uses `unsafe-inline`, contradicting server's nonce-based CSP |
| Tests | 3/5 | 19 failing tests on main; dashboard JS has zero behavioral tests |
| CI/CD | 4/5 | No app tests in release pipeline; integration tests never run in CI |
| Documentation | 3/5 | Stale tmux JSDoc in server-cli.js:23 |

## Top 5 Findings

1. **CSP `connect-src` makes dashboard unusable over tunnel** (ws-server.js:481) — restricts WS to localhost only; dashboard accessed via tunnel can't connect back
2. **Mobile app ignores `token_rotated`** (message-handler.ts:1817-1822) — silent auth failure, users stranded
3. **Dead tmux code and stale comments** (server-cli.js:23-25, 127-133) — handler for `new_sessions_discovered` never fires
4. **19 failing tests on main** — checkpoint-manager, session-context, get_diff tests fail with ENOENT
5. **`modeLabel` TDZ risk** (server-cli.js:288 vs 303) — tunnel_recovered callback references const before declaration

## Verdict

Well-structured codebase with solid fundamentals, but incomplete follow-through on recent features: token rotation is half-implemented (server+dashboard but not app), CSP restricts dashboard to localhost-only (undocumented), and dead tmux code lingers. Close the gaps before adding new features.
