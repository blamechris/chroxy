# chroxy skill profile

## Project Context
- **Tech:** Node.js (server, ES modules, no TS) + React Native/Expo (app, TypeScript)
- **Repo:** blamechris/chroxy
- **Main branch:** main
- **CI:** Copilot review + CodeQL ruleset

## Merge Gate
- **Enabled:** Yes — branch protection requires conversation resolution (noted in check-pr line 15)
- See `generic/merge-gate.md` for the CLAUDE.md snippet
- **TODO:** Add merge-gate snippet to chroxy CLAUDE.md

## check-pr Customizations
- Copilot polling IS needed — reviews take ~4 min to start after PR creation. Use Step 0 from generic template.
- Issue labels: `enhancement`, `from-review` (no complexity/testing labels yet)
- Server style: no semicolons, single quotes — common false positive from Copilot
- Evidence pattern: "per CLAUDE.md: no semicolons, single quotes"
- Reply headers: **FIX** / **FALSE POSITIVE** / **FOLLOW-UP ISSUE** (now synced to generic as of 2026-02-16)
- Reply Format Examples section with detailed examples (now synced to generic as of 2026-02-16)
- Branch protection requires conversation resolution — inline replies are mandatory for merge

### Lessons Learned
- **2026-02-08:** Agent posted summary review but skipped all 7 inline replies on PR #116. Root cause: skill said "reply inline" but agent batched mentally and only did the summary. Fix: (1) added verification step that counts root comments vs replied threads, (2) reworded critical rules to make inline replies the PRIMARY output, (3) enforced one-at-a-time processing order.
- **2026-02-10:** check-pr ran immediately after PR #423 was created and found 0 comments because Copilot review hadn't started yet (~4 min delay). Root cause: local skill was missing Step 0 (Copilot polling) from generic template, and generic template only waited for IN_PROGRESS→COMPLETED, not NOT_FOUND→appeared. Fix: (1) updated generic template to also wait for review to appear when PR is <5 min old, (2) synced Step 0 into chroxy local skill.
- **2026-02-16:** check-pr agent on PR #540 posted 4 FOLLOW-UP ISSUE replies saying "Created a follow-up issue." without the issue URL. Despite the template clearly showing `Created ${ISSUE_URL} to track this.`, the agent wrote free-form text instead. Same issue in agent-review: Deferred Items table had `#XX` placeholder but "Include created issue URLs" instruction was too soft. Fix: (1) added explicit comment in check-pr bash block: "NEVER write 'Created a follow-up issue' without the URL", (2) replaced soft "Include created issue URLs" in agent-review with CRITICAL block mandating linked URLs, (3) updated Deferred Items table template to show `[#XX](issue_url)` format. Both generic and local templates updated.

## agent-review Customizations

### Persona
**Chroxy Inspector** — expert in Node.js, React Native/Expo, WebSocket protocol, Claude Code CLI, Cloudflare tunnels, mobile connectivity.

Mindset: "Will this code work reliably over a cellular connection through a tunnel to a remote dev machine?"

### Code Quality — Server
- ES modules (import/export), no TypeScript
- No semicolons, single quotes
- EventEmitter pattern for component communication
- Proper cleanup on destroy/close

### Code Quality — App
- TypeScript strict, functional components with hooks
- Zustand store patterns (immutable updates via `set()`)
- No `any` types, platform-aware code
- No `AbortSignal.timeout()` (not in React Native)

### Architecture
- CLI mode and PTY/terminal mode remain independent paths
- WS protocol messages documented in ws-server.js header
- Auth flow: auth → auth_ok → server_mode → status → claude_ready

### Mobile
- Touch targets min 44pt
- Keyboard handling for Android suggestion bar
- Safe area insets, Expo Go compatibility

## full-review Customizations
- Composes agent-review (Chroxy Inspector persona) + check-pr sequentially
- Agent-review takes ~2-3 min, which covers most of the Copilot review delay (~4 min)
- Combined summary table is the primary output — matches the format used in batch PR reviews
- Same attribution policy applies: no AI mentions anywhere

## create-pr Customizations
- Test plan should include: server tests pass, app type-checks clean, manual smoke test
- Batch-fix PRs are common (from-review batches) — use batch template when closing 3+ issues
- Issue labels to scan: `from-review`, `enhancement`
- Branch naming: `feat/`, `fix/`, `refactor/`, `test/` prefixes with issue numbers in name

## create-issue Customizations
- Labels available: `enhancement`, `from-review` (no `complexity:` or `testing:` labels yet)
- If complexity/testing labels are added later, update this note
- Review comment URLs follow GitHub format: `https://github.com/blamechris/chroxy/pull/N/files#r<comment_id>`

## learn Customizations
- **CLAUDE.md sections:** `## Server Conventions`, `## App Conventions`, `## Debugging`
- **Rules naming:** kebab-case (e.g., `react-native.md`, `websocket.md`)
- **Domain quality bar:** React Native platform constraints, WebSocket protocol quirks, tunnel reliability patterns qualify as durable insights
- **Common paths:** `app/**/*.tsx`, `server/**/*.js`

## start-working Customizations

### Ready-to-Work Labels
- No explicit `ready-to-build` label — treat unblocked, unassigned `enhancement` and `from-review` issues as ready
- `from-review` issues are higher priority (deferred PR feedback should be addressed promptly)

### Blocked Labels
- `blocked`, `wontfix`, `needs-design`

### Roadmap File Locations
- Default scan only (`ROADMAP.md`, `TODO.md`, `docs/`) — no custom planning docs

### Source File Patterns for TODOs
- Server: `server/**/*.js`
- App: `app/**/*.tsx`, `app/**/*.ts`

### Priority Signals
- `from-review` → P1 (deferred review feedback)
- `bug` → P0
- No milestones currently in use

### Dependency Check
- `npm outdated` and `npm audit`

### Test Runner
- Server: `npm test`
- App: `npx jest` (TypeScript)

### Audit Focus Areas
- Mobile connectivity reliability (WebSocket, tunnels)
- React Native platform-specific edge cases
- Server event handler cleanup patterns

## smoke-test Customizations

### Application
- **Type:** Web dashboard served by Node.js server
- **Start:** `npx chroxy start` (or server may already be running)
- **Port detection:** Probe 8765, 3131, 8080, 3000 — first responding wins
- **Auth:** API token from `~/.chroxy/config.json` (`apiToken` field), passed as `?token=` query param
- **Dashboard URL:** `http://localhost:{port}/dashboard/?token={token}`

### Connection Readiness
- Dashboard connects via WebSocket automatically on load
- Readiness check: wait for page to NOT contain "Disconnected" or "Connecting..."
- Sidebar, session tabs, and input bar only render after WS connection

### Test Script
- **Path:** `packages/server/tests/smoke-test.mjs`
- **Run:** `cd packages/server && node tests/smoke-test.mjs [--headed]`
- **Screenshots:** `packages/server/tests/screenshots/` (gitignored)
- **Requires:** `playwright` as dev dependency, Chromium installed via `npx playwright install chromium`
- **Rebuild dashboard before testing:** `cd packages/server && npm run dashboard:build`

### Test Categories

| Category | What to Verify |
|----------|---------------|
| Dashboard Core | Page loads (HTTP 200), WS connects, version badge, sidebar, session tabs, full-width layout, input bar |
| Session Creation | Ctrl+N opens modal, session name input, CWD combobox, provider picker (SDK/CLI options) |
| Keyboard Shortcuts | `?` opens help overlay, `Ctrl+K` command palette, `Ctrl+N` new session |
| Health | No critical console errors |

### Known Quirks
- `?` shortcut fails if textarea has focus (key goes to input, not shortcut handler) — click body first
- Provider picker had missing CSS on first deploy — always rebuild dashboard before testing
- Server must be running (can't start headless in test because tunnel setup is interactive)

## autonomous-dev-flow Customizations

### Branch Prefix
- Uses `feat/` (not `auto/`) — matches existing branch naming conventions (`feat/`, `fix/`, `refactor/`, `test/`)

### Decomposition Trigger
- No `complexity:high` label currently in use — treat issues with large scope descriptions (multiple systems, 3+ files) as decomposition candidates

### Test Runners
- Server: `cd packages/server && npm test` (Node built-in test runner)
- App: `cd packages/app && npx jest` (TypeScript)
- Dashboard: `cd packages/server && npm run dashboard:test`

### Lint/Typecheck
- App: `cd packages/app && npx tsc --noEmit`
- Dashboard: `cd packages/server && npm run dashboard:typecheck`

### Commit Scopes
- `server`, `app`, `desktop`, `tunnel`, `ws`, `cli`, `ci`, `docs`, `dashboard`

### PR Test Plan
- `- [ ] Server tests pass`
- `- [ ] App type-checks clean`
- `- [ ] Dashboard tests pass`
- `- [ ] Manual smoke test`

### Smoke Test Integration (Phase 4.5)

#### File Pattern Trigger
```
dashboard-next|\.tsx$|\.css$|\.html$|components\.css|theme
```
Any PR touching dashboard source files, React components, CSS, or theme files triggers the smoke test.

#### UI Rebuild Command
```bash
cd packages/server
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run dashboard:build
```
Dashboard serves compiled Vite bundles — source changes are NOT visible without rebuild.

#### Smoke Test Invocation
Run `/smoke-test` skill — it handles server auto-start/stop, auth token, and screenshot verification.

#### Known Quirks
- `?` shortcut test fails when textarea has focus (captures keystroke) — test selector issue, not app bug
- Server must be running for WS connection — smoke test auto-starts one if none found
- Always rebuild dashboard before testing (provider picker CSS was invisible without rebuild)

## decompose-issue Customizations
- Default sub-issue labels: `enhancement`, plus `from-review` if the parent has it. No `complexity:*` labels in chroxy yet — if added later, update this note.
- Parent-link convention: body line "Part of #N" only — no `parent:#N` label scheme.
- Parent-marker label: none currently. If a `decomposed` label is added later, the skill will pick it up via the existence check.
- Same heuristic as `autonomous-dev-flow` decomposition trigger above — treat issues spanning multiple systems or 3+ files as candidates. Use commit scopes (`server`, `app`, `desktop`, `tunnel`, `ws`, `cli`, `dashboard`) to find natural seams when proposing sub-issues.

## parallel-dev Customizations

Shares all customization points with `autonomous-dev-flow` above (branch prefix, test runners, lint/typecheck, decomposition trigger, commit scopes, PR test plan, smoke test integration).

### Parallel-Specific Settings
- **Default concurrency:** 3
- **Dependency setup in worktree:** `npm install` (monorepo — each worktree needs its own node_modules)

## merge Customizations

### Review Gate
- /full-review is MANDATORY before every merge — hard gate, no exceptions for "obvious" fixes
- Review skip exception: pure .md skill/doc files with zero code changes
- Lesson (2026-03-14): Skipped review on PRs #2248, #2251 during fast iteration — user caught it and mandated the gate

### Merge Strategy
- Always `--squash --delete-branch`

### Auto-Version
- Workflow: `.github/workflows/auto-version.yml`
- Bumps patch version on every merge to main (skips commits starting with `chore: bump version`)
- Version source of truth: `packages/server/package.json`
- Version synced across 6 files by `scripts/bump-version.sh`: server, app, desktop, root package.json + tauri.conf.json + Cargo.toml

### Post-Merge: Tauri Desktop Rebuild
- **Build order:** dashboard → bundle-server.sh → cargo build → cargo tauri bundle → ad-hoc codesign → install to /Applications
- **TAURI_ENV_PLATFORM=darwin required** — without it, Vite uses `/dashboard/` base path → white screen in Tauri webview
- **touch src-tauri/src/lib.rs** before cargo build — forces binary relink to pick up new resources
- **rm -rf target/release/bundle** before cargo tauri bundle — clears aggressively cached bundles
- **Ad-hoc signing:** `codesign --force --deep --sign -` (no Apple signing identity on dev machine)
- **Node 22 required** for all npm commands: `PATH="/opt/homebrew/opt/node@22/bin:$PATH"`
- **Full PATH required** for npm to find `sh`: include `/usr/bin:/bin:/usr/sbin:/sbin`
- **Verify after install:** `grep 'src=' .../dist/index.html` must show `/assets/` not `/dashboard/assets/`

### Skip Logic
- **Skip rebuild** when merged PRs only touch: `docs/`, `.github/`, `packages/app/`, `scripts/`, `*.md`
- **Always rebuild** when touching: `packages/server/`, `packages/desktop/`, `packages/protocol/`, `dashboard-next/`

### Flags
- Skip flag: `--no-build`
- Post-merge only flag: `--build-only`

### Lessons Learned
- **2026-03-14:** Dashboard built without `TAURI_ENV_PLATFORM` → white screen. Root cause: Vite config checks `process.env.TAURI_ENV_PLATFORM` to set base path (`/` for Tauri, `/dashboard/` for web). The `beforeBuildCommand` in `tauri.conf.json` sets it, but manual builds from CLI don't. Fix: always set `TAURI_ENV_PLATFORM=darwin` explicitly.
- **2026-03-14:** Installed .app had stale dashboard even after rebuild. Root cause: `cargo tauri bundle` skips re-bundling when binary hasn't changed. Fix: `touch src-tauri/src/lib.rs` forces relink, `rm -rf target/release/bundle` clears cached bundles.
- **2026-03-14:** `npm run dashboard:build` failed with `ENOENT spawn sh`. Root cause: sandbox PATH didn't include `/usr/bin:/bin`. Fix: use full PATH in all npm commands.

## manual-testing-mode Customizations

### Version Source-of-Truth
- **File:** `packages/server/package.json` (`.version` field)
- All other version files mirror it: `package.json` (root), `packages/{app,desktop,protocol,dashboard,store-core}/package.json`, `packages/desktop/src-tauri/Cargo.toml`, `packages/desktop/src-tauri/tauri.conf.json` — 9 files total.
- Bump verification command:
  ```bash
  grep '"version":' package.json packages/*/package.json packages/desktop/src-tauri/tauri.conf.json && grep '^version' packages/desktop/src-tauri/Cargo.toml
  ```

### Surface Labels
Use one severity (`bug` / `enhancement` / `ux`) plus surface(s):
- `desktop` — Tauri tray app + bundled web dashboard
- `app` — React Native mobile app
- `server` — Node.js daemon, CLI, WS protocol
- `tunnel` — Cloudflare named/quick tunnels
- `dashboard` — web dashboard React/Vite UI (when distinct from desktop bundling)

### Rebuild Reminder for Visual Bugs
When the user reports a UI bug on the desktop app, remind them after the issue is filed that the Tauri bundle is **aggressively cached**. To verify a fix locally:
1. `cd packages/dashboard && TAURI_ENV_PLATFORM=darwin npm run build`
2. `cd packages/desktop && bash scripts/bundle-server.sh`
3. `touch src-tauri/src/lib.rs && cd src-tauri && cargo build --release`
4. `rm -rf target/release/bundle && cargo tauri bundle`
5. `pkill Chroxy 2>/dev/null; rm -rf /Applications/Chroxy.app && cp -R target/release/bundle/macos/Chroxy.app /Applications/`

This is in `merge` customization too — same trap applies during dogfooding.

### Smoke Test Reference
- Repo's smoke skill: `/smoke-test`
- After a fix-mode commit on the manual-testing branch, prompt the user: *"Want me to run /smoke-test before we move on?"* — only for desktop/dashboard surface fixes.

### Wrap-up PR Conventions
- PR title: `chore(release): manual-testing v{N} — {N} fixes from dogfooding`
- Squash merge with auto-version disabled (we already bumped); commit message should start with `chore: bump version` so the auto-version workflow on main skips re-bumping.
- Issue cross-links: every fix PR section gets `Closes #N` for inline-fixed issues; pure-filed issues stay open for triage.

## swarm-audit Customizations

### Domain-Specific Extended Agents

| Agent | Nickname | Lens | When to Include |
|-------|----------|------|-----------------|
| Expo Expert | "Expo Expert" | Expo SDK lifecycle, React Native constraints, OTA updates, dev client vs Expo Go | Target involves mobile app architecture, updates, or Expo-specific features |
| Tunneler | "Tunneler" | Cloudflare tunnels, DNS, TLS, WebSocket proxying, network reliability | Target involves tunnel configuration, connectivity, or networking |

### Grading Criteria
- Operator should weight mobile UX: touch targets, offline behavior, reconnect experience
- Guardian should weight WebSocket edge cases: stale sockets, tunnel drops, concurrent writes
- Expert agents should verify claims against actual Cloudflare/Expo documentation
