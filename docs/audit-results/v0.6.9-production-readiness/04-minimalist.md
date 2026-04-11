# Minimalist's Audit: Chroxy v0.6.9 Production Readiness

**Agent**: Minimalist — ruthless cutter, YAGNI gospel, believes the best code is no code
**Overall Rating**: 2.4 / 5
**Date**: 2026-04-11

---

## TL;DR

Chroxy is carrying two entire server codepaths when it only uses one. The app is a single 2,344-line message handler and a 1,401-line Zustand god-store feeding a 1,557-line session screen. Dead scaffolding (`message-transform.js`, `ws-schemas.js` re-export, `/assets/xterm/*` route) sits next to legitimate `// legacy` breadcrumbs from the v0.2.0 PTY removal that never got finished. Per-package LoC is dominated by a handful of files that would benefit from deletion, not decomposition.

Server source alone is ~17k LoC, of which a confident **15–20%** could be deleted today with near-zero risk — and that does not count the eas-cng-config P2 migration that would remove `packages/app/ios/` and `android/` entirely.

The project is *shippable* but currently fatter than it is functional. On-call debuggability at 3am suffers from the 2,344-line message-handler switch and the legacy-cli dual dispatch still live in `ws-server.js`.

---

## Section ratings (1 = overwhelming cruft, 5 = already minimal)

| Section | Rating | Notes |
|---|---|---|
| **Server — providers** | **3/5** | 7 session files (base + claude-sdk + claude-cli + codex + gemini + docker-cli + docker-sdk) totaling 2,942 LoC. Codex/Gemini are real product surfaces via dashboard. `claude-cli` (807 LoC) is retained for the "legacy" flag but `CHROXY_LEGACY_CLI` is never the default anywhere; all three docker/sdk variants duplicate wiring that could share a mixin. |
| **Server — handlers + ws-*.js** | **2/5** | `ws-server.js` is 1,222 LoC with a parallel "legacy single CLI" path (34 direct `cliSession` references across `ws-server.js`, `ws-forwarding.js`, `ws-history.js`, `ws-message-handlers.js`) that **no production caller uses** — only tests pass `cliSession:` to `new WsServer`. `handler-registry` split left `ws-file-ops/reader.js` at 584 LoC (bigger than most single handlers) and `ws-schemas.js` as a pure 105-line re-export shim of `@chroxy/protocol`. |
| **Server — supervisor + config** | **2/5** | Supervisor is 625 LoC — forks `server-cli-child.js` (142 LoC) for restart on crash. Needed only for the named-tunnel mode users want stability from. The `--no-supervisor` escape hatch plus the ENV `CHROXY_SUPERVISED=1` flag is the kind of "configurable since forever" weight the brief asks about. Config has `transforms: 'array'`, `noEncrypt`, `legacyCli`, `maxToolInput`, `logFormat` fields — several with one real production value. |
| **App — store + screens + components** | **2/5** | `store/connection.ts` (1,401 LoC) + `store/message-handler.ts` (2,344 LoC) + `store/types.ts` (433 LoC, ~90-member `ConnectionState` interface annotated in-file as a "god object" with a comment admitting phase-1 decomposition is "documentation-only"). `screens/SessionScreen.tsx` is 1,557 LoC. `screens/ConnectScreen.tsx` is 874 LoC. `components/MarkdownRenderer.tsx` is 703, `SettingsBar.tsx` 686, `PermissionDetail.tsx` 648. |
| **Protocol + store-core** | **4/5** | Protocol is appropriately lean (783 LoC across both schema files). The one drag: protocol exports 50+ schemas in a single discriminated union, and most `.passthrough()` wrappers are defensive paranoia against nothing. Store-core is 2,322 LoC of which 654 are crypto tests — acceptable. |
| **Desktop** | **3/5** | `server.rs` 853 LoC + `lib.rs` 1,293 LoC are large but justified (supervisor + Node lifecycle). 16 `#[tauri::command]` entries — all confirmed used by the dashboard. `server-bundle/` directory is 98 MB on disk and contains a **complete duplicate of packages/server/src (16,703 LoC of .js files copied verbatim)** staged by `scripts/bundle-server.sh`. This is a build artifact that shouldn't be tracked; committed size is ~1.8 MB of source. |
| **Scripts + CI + docs** | **3/5** | `scripts/bump-version.sh` is 219 LoC of hand-rolled `node -e` blocks for something `npm version --workspaces` would do in one line. 10 workflow jobs in `ci.yml` (368 LoC). `repo-relay.yml` (29 LoC) is one external trigger — reasonable. `docs/` has ~12 top-level items; `audit-results/` has 6 retained subdirs including 3 prior releases of audits. Audit retention policy file exists — good, but enforce it. |

---

## Top 10 deletions (ordered by impact)

### 1. Legacy single-CLI dispatch in ws-server + friends (~800 LoC, low-medium risk)
**What**: Delete the `cliSession` parameter + `this.cliSession` branches throughout `ws-server.js` (13 refs), `ws-forwarding.js` (8 refs), `ws-history.js` (7 refs), `ws-message-handlers.js` (6 refs including the `createCliSessionAdapter` function), plus the `__legacy__` sessionId magic string. Plus the `EventNormalizer`'s `legacy-cli` mode handling (`event-normalizer.js:264-299`) and its `legacyCli: true` branches.
**Why**: Production `server-cli.js` (the only entry point that constructs WsServer) passes `sessionManager` and never passes `cliSession`. Every runtime path is multi-session. The single-CLI code path is reachable only from tests.
**Verify**: `grep -n 'new WsServer' packages/server/src/*.js` — only `server-cli.js:324`, which does not pass cliSession. Then rewrite ~15 affected test files to use a minimal SessionManager mock instead of `cliSession:`.
**LoC removed**: ~600 source + ~200 tests adapted. 

### 2. `packages/desktop/src-tauri/server-bundle/src/` — check this in as a build artifact, not source (~16,700 LoC removed from git)
**What**: 1.8 MB of source files duplicated from `packages/server/src/`. `bundle-server.sh` already regenerates it on demand.
**Why**: Every PR diff unnecessarily touches this mirror. It bloats repo size, slows clones, and confuses grep/search/code review. It should be regenerated at build time into `.gitignore`d territory.
**Verify**: `git rm -r packages/desktop/src-tauri/server-bundle/src packages/desktop/src-tauri/server-bundle/hooks`, add to `.gitignore`, confirm `bundle-server.sh` still stages it from `packages/server/src/` for Tauri builds.
**LoC removed**: 16,703 JS lines from the repo (counted via `server-bundle/src/*.js`).
**Risk**: None — pure build hygiene.

### 3. `packages/server/src/message-transform.js` (~100 LoC, zero risk)
**What**: `MessageTransformPipeline` + `BUILT_IN_TRANSFORMS` (`contextAnnotation`, `voiceCleanup`). The `config.transforms` field has a schema entry + env var + `CHROXY_TRANSFORMS=…` plumbing through `sdk-session.js`, `cli-session.js`, `session-manager.js`, `server-cli.js`. Default is `[]`.
**Why**: Opt-in pipeline that has only ever had one production value (empty). Classic "configurable since forever" bloat. If nobody's turned it on in 6 months, delete it; the config key can come back via 4 lines in a session when someone actually needs a transform.
**Verify**: `grep -rn "transforms:.*\[" packages/server/src/` — only config default and constructor pass-throughs. No caller sets a non-empty array.
**LoC removed**: ~100 source + ~30 wiring refs + ~40 test lines (`message-transform.test.js` if present).
**Risk**: None.

### 4. `packages/server/src/ws-schemas.js` — pure re-export shim (105 LoC, zero risk)
**What**: `ws-schemas.js` is a 105-line `export { ... } from '@chroxy/protocol'` file. Its own comment says "This file exists for backward compatibility so existing server imports don't need to change."
**Why**: There is no backward compatibility to maintain — nothing outside `packages/server/` imports from it. Internal imports can be rewritten to `from '@chroxy/protocol'` with a mechanical sed.
**Verify**: `grep -rn "from.*ws-schemas" packages/server/src/` then rewrite, delete the file.
**LoC removed**: 105.
**Risk**: Zero.

### 5. `/assets/xterm/*` HTTP route + server-side xterm deps (~40 LoC + 2 deps)
**What**: `http-routes.js:211-248` serves xterm.js/addon-fit/css from node_modules. Plus remove `@xterm/xterm` and `@xterm/addon-fit` from `packages/server/package.json` dependencies.
**Why**: The route is never fetched by any client. Dashboard bundles xterm via Vite. App bundles it into `xterm-bundle.generated.ts` at build time via `packages/app/scripts/bundle-xterm.js`. The server dep exists only to serve these three file paths.
**Verify**: `grep -rn "/assets/xterm" packages` — only self-references in `http-routes.js` and its server-bundle mirror (see deletion #2). The one real bundle script (`packages/app/scripts/bundle-xterm.js`) reads from node_modules directly, not via HTTP.
**LoC removed**: ~40 source + 2 package.json deps + install weight reduced.
**Risk**: Zero, pending a `grep` pass for `fetch('/assets/xterm...')` — none found.

### 6. `scripts/bump-version.sh` → `npm version --workspaces` (~180 LoC deleted)
**What**: Replace 219 LoC of bash + `node -e` blocks with `npm version --workspaces` (or at most a 30-line wrapper). The script writes to 10+ files (`package.json`, `app.json`, `Cargo.toml`, `tauri.conf.json`, etc.) via ad-hoc sed/node invocations.
**Why**: This grew organically and still misses edge cases. `Cargo.toml` + `tauri.conf.json` need one regex each; the rest is solved by npm workspaces. Trimming this means every release becomes 30 seconds faster *and* 189 fewer lines to maintain.
**Verify**: Apply change on a scratch branch, run `./scripts/bump-version.sh 0.6.10`, compare diffs to what `npm version` produces.
**LoC removed**: ~180.
**Risk**: Low — release automation, well-tested by usage.

### 7. Codex + Gemini providers (~480 LoC, medium risk — needs product call)
**What**: `codex-session.js` (227) + `gemini-session.js` (251) + registry + dashboard `provider-labels.ts` entries + `CreateSessionModal` flavor text.
**Why**: Chroxy is sold as a "remote terminal app for Claude Code." These are speculative multi-provider scaffolding. Neither has mobile app client-side support — they exist only in the dashboard. If the product positioning stays Claude-focused, these are dead weight.
**Verify**: Ask the owner — if the answer is "yeah, those are aspirational," delete. If it's "people really do use them," keep and don't rate-rebase the PR.
**LoC removed**: ~600 counting dashboard plumbing.
**Risk**: Medium — product decision, not engineering.

### 8. `dev-preview.js` + tunnel pattern-matching (~205 LoC, low risk)
**What**: `DevPreviewManager` scans tool-result output for `localhost:NNNN` patterns and spawns a secondary Cloudflare quick tunnel for each one. Wired through `ws-forwarding.js`, `ws-server.js`, protocol schemas (`CloseDevPreviewSchema`), and the `DevPreviewBanner.tsx` app component.
**Why**: Extremely specific and fragile feature — brittle regex pattern-matching on every tool_result, spawning side-effect tunnels that can multiply without bound across sessions. High complexity/value ratio. Replaceable with "user runs `chroxy tunnel` in a second tab."
**Verify**: Search release notes/issues for dev-preview usage. If nobody's filed a bug or requested it in 90 days, it's dead.
**LoC removed**: ~300 across packages.
**Risk**: Low if unused. High if beloved by the owner — ask first.

### 9. `ios-live-activity/` + all its plumbing (~400 LoC, medium risk — check usage)
**What**: `packages/app/src/ios-live-activity/` (index + live-activity-bridge + live-activity-manager + types + useLiveActivity hook), plus the `liveActivityTokens` path in `push.js`, plus `registerLiveActivityToken`/`unregisterLiveActivityToken` WS handlers.
**Why**: iOS-only, requires native module rebuilds, adds a second push-token registry and persistence schema to maintain. CLAUDE.md says "live_activity" is a mobile capability — but if the team doesn't personally use it or have user reports, it's speculative.
**Verify**: Does the owner use Live Activities? Are there users reporting bugs?
**LoC removed**: ~400.
**Risk**: Medium.

### 10. Jest mock for `@expo/vector-icons` + other optional RN mocks in `jest.setup.js` (~50 LoC)
**What**: Review `packages/app/jest.setup.js` (80 LoC, 7 `jest.mock` calls). At least one mock (`@expo/vector-icons`) exists to patch around tests that probably don't render icons anymore after the migration to text-based UI.
**Why**: Mock bloat is load-bearing friction — every one of these lets a test file lie about its dependencies. Trim aggressively.
**Verify**: Delete one mock at a time, run tests, reinstate only the ones that actually fail.
**LoC removed**: ~30-50.
**Risk**: Low, fast to verify.

---

## Top 5 consolidations

### 1. `cli-session.js` + `docker-session.js` + `docker-sdk-session.js` into `sdk-session.js` with a runtime "execution context" parameter
**Before**: 807 + 319 + 385 + 608 = 2,119 LoC across 4 files, each inheriting from `base-session.js` and duplicating setup/teardown.
**After**: 1 class, ~1,000 LoC, with `executionContext: 'host' | 'docker'` and `transport: 'sdk' | 'legacy-cli'` as strategy fields. Container-specific launching becomes a ~150-line helper, not a subclass hierarchy.
**Saved**: ~1,000 LoC.

### 2. `ws-file-ops/browser.js` (477 LoC) + `ws-file-ops/reader.js` (584 LoC) into a single `ws-file-ops/fs.js`
**Before**: 1,061 LoC across two files that share MIME detection, path safety checks, and encoding logic.
**After**: 1 file, ~600 LoC. Read and browse are two methods, not two modules.
**Saved**: ~400 LoC + one fewer handler wiring hop.

### 3. All 8 `packages/server/src/handlers/*.js` files back into `ws-message-handlers.js`
**Before**: 8 files (109–256 LoC each), 1,324 total, plus `handler-utils.js` (242) + `handler-registry` (memory: "handler-registry.js"). ~1,600 LoC and three layers of indirection.
**After**: One ~1,000 LoC file. The split was premature — each handler has exactly one caller (the dispatcher) and no cross-handler reuse that isn't already in `handler-utils.js`. The extra files created surface area without hiding complexity.
**Saved**: ~600 LoC and a full directory removed from on-call mental load.
**Caveat**: This one's controversial — the owner may prefer "easier to grep". Document the trade-off.

### 4. `packages/app/src/store/message-handler.ts` — split into 3 files by message origin (stream vs control vs session-lifecycle)
**Before**: Single 2,344-line file with 95 `case '...':` branches inside one mega-switch.
**After**: Not a rewrite — a pure split by message category. Keeps the store shape. Each file ~800 LoC max.
**Saved**: Not LoC — cognitive load. Primary goal: make the on-call 3am experience tractable.
**Net**: Neutral on LoC, strong net win on debuggability.

### 5. `packages/server/src/cli/*-cmd.js` (11 files, 1,219 LoC) into ~3 files by concern
**Before**: `cli/` has one file per `commander` subcommand: `config-cmd.js` (34), `doctor-cmd.js` (31), `init-cmd.js` (60), `update-cmd.js` (45), `server-cmd.js` (67), `tunnel-cmd.js` (101), `session-cmd.js` (143), `deploy-cmd.js` (167), `status-cmd.js` (188), `service-cmd.js` (223), plus `shared.js` (160).
**After**: `cli/core-cmds.js` (config/doctor/init/update/server/shared) + `cli/runtime-cmds.js` (session/status/service/tunnel) + `cli/deploy-cmd.js`. 3 files, same LoC but 70% fewer file opens per on-call session.
**Saved**: ~0 LoC, huge cognitive load reduction.

---

## The single biggest "ship smaller" move

**Delete the legacy single-CLI codepath from `ws-server.js` and friends** (deletion #1).

It's 600+ LoC of production code nobody runs, 34 grep hits of `cliSession` conditionals spread across 4 core server files, an entire `__legacy__` sessionId sentinel, a `legacy-cli` mode in `EventNormalizer`, and a `createCliSessionAdapter()` shim function. It forces every reader of `ws-server.js` to mentally reason about a multiplexed-versus-single mode that is never multi in reality. Deleting it gives the biggest 3am-debuggability win per hour spent, and the only blocker is rewriting ~15 test files (all of which would get cleaner in the process).

**Runner-up**: Stop committing `packages/desktop/src-tauri/server-bundle/src/` (deletion #2). 16,703 lines of duplicate source vanish from every PR diff overnight.

---

## Production readiness from a complexity angle

**The raw numbers**: Server source ~17k LoC, app source ~30k LoC (TS/TSX), dashboard source ~uncounted but similar order, store-core + protocol + desktop each ~2-4k. Total product surface is on the order of **60-70k LoC of first-party code**, plus the `server-bundle/src` duplication (16.7k). That's big for a one-person/small-team on-call rotation.

**The load-bearing fat**: The top three files the on-call engineer is most likely to read at 3am are `ws-server.js` (1,222), `store/message-handler.ts` (2,344), and `screens/SessionScreen.tsx` (1,557). Combined, that's 5,123 lines the on-call needs to reason about just to locate a bug. Each of these is *itself* documented as a known god object (the store even has an in-file comment admitting it's ~90 members and phase-1 decomposition is "documentation-only"). When the author acknowledges the debt in code comments and defers fixing it to "future phases," that's a signal the ship-date pressure is pushing against structural health. On-call at 3am means you need to find the bug, not read a 90-member interface to find out where to start looking.

**The real verdict**: Chroxy is *shippable* but carrying 15-20% extractable fat (server) and significant cognitive-load fat (app). It will ship v0.6.9 fine — the question is whether the team can support it in production. If the user base is hobbyist (self-hosted, power users), the current complexity is acceptable but risky. If it grows to a meaningful user base, the god objects will start producing outage postmortems.

---

## Overall rating: **2.4 / 5**

Chroxy has good fundamentals — clean module boundaries, typed protocol, sensible monorepo structure — but it's carrying two architectural decisions that shouldn't survive to production:

1. A dual-mode dispatch (single-CLI vs multi-session) where one mode is dead
2. God objects in the app store/screen layer that the team has explicitly deferred decomposing

Neither will block a v0.6.9 release. Both will make v0.7.0 hurt. The right move before calling this "production ready" is a single deletion-focused PR that ships deletions #1-5 (and maybe #6) together — that nets ~17,700 LoC gone in an afternoon, with minimal regression risk, and leaves the codebase meaningfully easier to debug at 3am.

**Verdict**: *Carrying too much weight for a small team to confidently support in production.* Not catastrophically — the core logic is good and the tests are substantial — but the god objects and dead dispatch branches are exactly the kind of thing that turns a Sunday-morning bug report into a Sunday-afternoon investigation. Cut aggressively before the user base grows.
