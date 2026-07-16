# Claude Development Notes

Essential development notes for working with Claude on Chroxy.

## Project Overview

**Chroxy** is a remote terminal app for Claude Code. Run a lightweight daemon on your dev machine, connect from your phone via a secure tunnel. Get both a full terminal view and a clean chat-like UI that parses Claude Code's output into readable messages.

**Tech Stack:** Node.js (server), React Native/Expo (mobile app), WebSocket over Cloudflare tunnel

**Architecture:** Monorepo with npm workspaces

```
chroxy/
├── packages/
│   ├── server/       # Node.js daemon + CLI (ES modules, no TypeScript)
│   ├── app/          # React Native mobile app (TypeScript, Expo 54)
│   ├── desktop/      # Tauri tray app (Rust, wraps the dashboard)
│   ├── dashboard/    # Web dashboard (React + Vite, served by the server)
│   ├── protocol/     # Shared protocol types and Zod schemas (@chroxy/protocol)
│   ├── store-core/   # Shared store logic and crypto (@chroxy/store-core)
│   ├── design-tokens/# Design tokens → generated dashboard theme.css/tokens.ts (@chroxy/design-tokens)
│   └── claude-hooks/ # Hook emitters for external Claude Code sessions (@chroxy/claude-hooks)
├── docs/            # Setup guides, architecture
└── scripts/         # Install helpers
```

**Current Status (v0.10.0):**
- Server works: CLI headless mode, multi-provider registry (Claude SDK/CLI/TUI, BYOK, Gemini, Codex — **app-server driver is now the default (#6616): approvals surfaced in Chroxy's permission pipeline + permission-mode switching + image vision + intra-session memory; `CHROXY_CODEX_APPSERVER=0` falls back to legacy `codex exec`** — DeepSeek, Ollama, config-driven Anthropic-compatible + OpenAI-compatible endpoints), WebSocket protocol, Cloudflare tunnel (Quick + Named), supervisor auto-restart, push notifications + Discord status-embed sink, external-session event ingest (`POST /api/events` + ingest secret), session management, model switching, plan mode detection, background agent tracking, container environments (Docker Compose, DevContainer, snapshots), container/worktree isolation, K8s/Rancher backends (config-driven selection; experimental — live-cluster validation pending #6275), embedded user-shell terminal, daemon identity-key rotation (`chroxy identity rotate`), Control Room env/runtime management, queue-while-processing (mid-turn send + auto-flush), permission rule engine, persistent pairing tokens with a configurable sliding TTL (#6598), encrypted credentials at rest (macOS Keychain / Linux libsecret / Windows DPAPI — #6644), opt-in IDE navigation surface (`features.ide` / `CHROXY_ENABLE_IDE=1` — VSCode-style collapsible file-tree navigator, symbol side-panel, go-to-definition, find-references, find-in-project, Cmd+P quick-open, syntax-highlit viewer; epic #6469 P1+P2 complete), extensible provider/handler system
- Desktop works: Tauri tray app, multi-host LAN client (server picker, mDNS discovery, shared-session join), web dashboard with syntax highlighting, xterm.js terminal, Control Room, notifications, session tabs, voice-to-text (macOS), console page, environment management panel, startup-failure surfacing with retry
- App works: QR code scanning, connection flow with health checks and retries, ConnectionPhase state machine for resilient reconnection, markdown rendering, dual-view chat/terminal, xterm.js terminal emulation (WebView), plan approval UI, agent monitoring, settings screen, voice-to-text input, session rules UI, worktree toggle
- Claude-hooks works: `chroxy-hooks install` registers eight stateless emitters in Claude Code settings so plain (non-chroxy) sessions feed the daemon's notification pipeline — see `docs/guides/discord-notifications.md`
- **Dev build required** — `expo-speech-recognition` native module means Expo Go no longer works. Use `npx expo run:ios` or `npx expo run:android`.

## Critical Dev Notes

### Node 22 Required

Node 22 is the minimum supported version. Always use Node 22:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start
```

Or prefix any npm/node commands with the Node 22 path when running the server.

### Cloudflare Tunnel Dependency

The server uses Cloudflare tunnels for secure remote access. Two modes:
- **Quick Tunnel** (default): random URL, no account needed
- **Named Tunnel** (`--tunnel named`): stable URL, requires Cloudflare account + domain

```bash
brew install cloudflared

# Named tunnel setup (interactive):
npx chroxy tunnel setup
```

### Triage Runbooks

- [`docs/troubleshooting/session-token-mismatch.md`](docs/troubleshooting/session-token-mismatch.md) — how to enable the `[session-binding-*]` debug logs and correlate a `SESSION_TOKEN_MISMATCH` failure by `requestId` (runbook from the resolved #2832 investigation).
- [`docs/troubleshooting/lan-discovery.md`](docs/troubleshooting/lan-discovery.md) — why the mobile app's "Scan Local Network" finds nothing on the same Wi-Fi (it's a **unicast /24 sweep**, not mDNS — router client/AP isolation blocks it) and the router-side fixes + manual/QR fallbacks (#6561).

## Session Start Protocol

**When user says "Resume" or "Let's start":**
1. `cat CLAUDE.md` - Read this file
2. `git status && git log --oneline -5` - Check current state
3. Review open PRs, **separated by author** so external contributions don't get lost in your own queue:
   - Yours: `gh pr list --state open --author @me`
   - **External:** `gh pr list --state open --search "-author:@me"` — flag any results for review attention before starting new marathons (an open external PR may already cover an issue you'd otherwise queue)
4. Check for skill drift: `/skill outdated` (then `/skill update [name]` to refresh)

### Skills (pull-based registry)

> **"Skills" is overloaded in Chroxy — this section is the DEV-WORKFLOW `/skill` system**
> (authoring/reviewing commands like `/full-review`, compiled into each coding agent's native
> format for people *building* Chroxy). It is unrelated to **runtime skills**
> (`~/.chroxy/skills/*.md`, injected into a live session's prompt). User-facing docs:
> [docs/dev-workflow-skills.md](docs/dev-workflow-skills.md) (this system) and
> [docs/skills.md](docs/skills.md) (runtime). This section stays the operational source of truth
> for the dev-workflow system; both docs link back here (and `AGENTS.md` is generated from here).

Skills live in the `blamechris/skill-templates` **registry** and install **on demand** via the
`/skill` client — think `npm`/`brew` for `.claude/commands/*.md`. There is no push-deploy and no
`sync.sh`; the old push/`customizations/` workflow is retired.

- **`/skill add <name>`** — resolve from the registry → fetch `generic/<name>.md` → fill its
  `{{CUSTOMIZE: ...}}` markers from this repo's `CLAUDE.md` + `.claude/skill-profile.md` + code →
  write a version-stamped `.claude/commands/<name>.md` → **compile to native targets** → record
  in `.claude/skills.lock`.
- **`/skill list` / `/skill outdated` / `/skill update [name]` / `/skill remove <name>`** — manage installed skills.
- **Install-on-miss is a rule:** if `/X` is requested but unavailable, distinguish two
  cases by the **neutral source** `.claude/commands/X.md`: if it's missing, the skill isn't
  installed — run `/skill add X` (fetch + customize + compile). If the source exists but the
  native artifact (`.claude/skills/X/SKILL.md`) is missing, it's just not compiled — run
  `node scripts/compile-skill-targets.mjs --name X` (no registry fetch needed). Then invoke.

**Model-agnostic compile (multi-target).** `.claude/commands/<name>.md` is the provider-NEUTRAL
source; `scripts/compile-skill-targets.mjs` compiles each skill into every coding agent's NATIVE
custom-command format, so the same skill is first-party under whichever model you drive:
- **claude** → `.claude/skills/<name>/SKILL.md` (the v2.1.x "skills" path; the legacy
  `.claude/commands/` slash-command discovery is broken — GH anthropics/claude-code#31846 — so
  Claude loads from `.claude/skills/`). *Version-controlled.*
- **gemini** → `.gemini/commands/<name>.toml` (TOML; `$ARGUMENTS`→`{{args}}`). *Version-controlled.*
- **codex** *(opt-in)* → `~/.codex/prompts/<name>.md` (invoked `/prompts:<name>`; user-global,
  not version-controlled). Codex CLI still supports `~/.codex/prompts/` (recent versions also ship
  a `~/.codex/skills/` dir); the emitter targets the stable prompts path. Off by default — the
  compiler prints a hint if `~/.codex` exists but `codex` isn't a selected target.
- **pi** *(opt-in)* → `~/.pi/agent/skills/<name>/SKILL.md` (Pi Coding Agent, `earendil-works/pi`;
  invoked `/skill:<name>`; user-global, not version-controlled). Markdown + YAML frontmatter
  (`name` + `description`) like the claude target, but Pi **appends** invocation args as
  `User: <args>` rather than substituting inline — so `$ARGUMENTS`/`$N` in the body pass through
  literally and the compiler `warn`s if a body uses them. Off by default — the compiler prints a
  hint if `~/.pi` exists but `pi` isn't a selected target. (#6573)

The active target list is the `targets:` line in `.claude/skill-profile.md` (this repo:
`claude, gemini` — both in-repo/version-controlled; codex and pi are per-machine opt-in via
`--targets codex` / `--targets pi`, kept out of the committed default so a clone never writes to an
unaware machine's `~/.codex` or `~/.pi`). With no `targets:` line the compiler falls back to
`claude` only and `/skill` prompts you. After editing a skill's generic source by hand, recompile:
`node scripts/compile-skill-targets.mjs --name <name>` (`--dry-run` to preview).

This repo carries `.claude/skill-profile.md` (the customization profile + `targets:`) and
`.claude/skills.lock` (what's installed, at which template hash). Maintainers edit templates in
the registry's `generic/` and run its `scripts/build-index.sh`; consumers pick changes up on the
next `/skill update`. **Registry follow-up:** the multi-target compile step should also land in the
registry's `generic/skill.md` so other repos inherit it (this repo's `/skill` is ahead of the
template until then).

## Git Workflow

### Zero Attribution Policy

**CRITICAL - READ THIS FIRST:**

Claude must NEVER include ANY of the following in commits, PRs, or any files:
- `Co-Authored-By: Claude` or any Claude co-author line
- `Generated with Claude Code` or similar phrases
- `Generated by Claude` or `Created by Claude`
- Any emoji + "Generated with" pattern
- Any mention of Claude, Anthropic, or AI assistance in commit messages
- Any attribution in PR descriptions

**The user is the SOLE AUTHOR of all work. Period.**

Commit messages should be clean and professional:
```
feat(server): add graceful shutdown on SIGTERM

- Clean up child processes on exit
- Close WebSocket connections
```

NOT:
```
feat: Add feature

🤖 Generated with [Claude Code](...)

Co-Authored-By: Claude...
```

### Branch Naming

```
feat/feature-name         # New features
fix/issue-description     # Bug fixes
refactor/component        # Refactoring
docs/topic                # Documentation
test/test-description     # Test additions
```

### Commit Message Format

```
type(scope): Short summary in present tense

[Optional body with details]
```

**Types:** feat, fix, refactor, docs, test, chore, style, perf
**Scopes:** server, app, desktop, tunnel, ws, cli, ci, docs

### PR Workflow

**CRITICAL: NEVER commit directly to main.** Always use feature branches and PRs.

1. Create feature branch from `main`
2. Develop and test
3. Push and create PR
4. Get user confirmation before merging (interactive sessions) or pass the Unattended Merge Gate (autonomous sessions — see below)
5. Squash merge to main

**Unattended Merge Authority:** During autonomous/unattended sessions, a session-created PR may be self-merged ONLY after the full review pipeline (`/full-review`: agent review + thread triage) passes with a clean verdict, ALL CI checks are green on the final commit, and ALL review threads are resolved. NEVER use `gh pr merge --auto` or GitHub auto-merge — verify the gates, then merge synchronously and confirm the PR reports `MERGED`. No `--admin`, no protection overrides. Every self-merged PR MUST appear as its own entry in the end-of-session report (PR, issue, review verdict, checks, merge SHA). If any gate fails, flag the PR with the failed gate named and leave it for the user.

**Outside autonomous sessions, NEVER auto-merge.** Always present a summary and wait for explicit user confirmation.

**Merge Gate — MANDATORY triage when merge is blocked:**

When `gh pr merge` fails with "not mergeable" or "base branch policy prohibits the merge", check in this order:

1. **Check for merge conflicts:** `gh pr view {N} --json mergeable,mergeStateStatus`. If `CONFLICTING`, rebase or merge main into the branch to resolve, then retry.
2. **Check CI:** `gh pr checks {N}`. If any check is `FAILURE` or `PENDING`, fix the failing check or wait for pending checks, then retry.
3. **Assume unresolved review threads** (if no conflicts and CI is green). Respond with:
   > Merge blocked — unresolved review threads. Please resolve them here:
   > https://github.com/blamechris/chroxy/pull/{N}/files
   >
   > Say "done" when resolved.
   Then wait for user confirmation and retry `gh pr merge --squash`.

## Code Style

### Server (packages/server/)

- ES modules (`import`/`export`)
- No TypeScript — plain JavaScript
- No semicolons
- Single quotes for strings
- EventEmitter pattern for component communication

### App (packages/app/)

- TypeScript (strict)
- Functional components with hooks
- Zustand for state management
- React Navigation for routing

## Testing Conventions

### Server tests must not touch real user state (#4633)

Every test that constructs a `SessionManager` **must** pass `stateFilePath` pointing at a temp file. Otherwise the manager defaults to `~/.chroxy/session-state.json` and the test silently clobbers your live state (this happened on 2026-05-30 — see `feedback_test_state_contamination.md`).

Two layers of defence are wired up:

1. **Sandbox guard** (`packages/server/tests/_setup.mjs`, loaded via `node --import`) — monkey-patches `fs.writeFileSync`/`promises.writeFile`/`renameSync`/`mkdirSync`/`createWriteStream`/`openSync(w*)` to throw `CHROXY_TEST_SANDBOX` if any test writes to the real `~/.chroxy/` or `~/.claude/` tree. The error includes the call site, so the next bare `new SessionManager()` fails loudly at the offending test.
2. **CI lint** (`packages/server/scripts/lint-tests-state-file-path.sh`) — fails the build if any `new SessionManager(...)` in `tests/` is missing `stateFilePath`. Run locally with `cd packages/server && ./scripts/lint-tests-state-file-path.sh`.

If you need to write to the real home for a legitimate reason (no current test does), set `process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES = '1'` scoped to the test and restore it after. The sandbox guard MUST stay enabled in `package.json`.

### Provider session constructors must forward every BaseSession opt (#4797 / #5367)

Every class that extends `BaseSession` (or `JsonlSubprocessSession`, the middle layer above the subprocess providers) **must** forward every opt accepted by `BaseSession`'s constructor. Dropping one silently disables it on its way down — the "middle-layer trap" that has bitten three times (#3224, #3231, #4790) and is documented in project memory as `feedback_jsonl_subprocess_middle_layer.md`.

Since #5367, the canonical way to forward is the **picker**, not a hand-maintained parallel destructure: each subclass takes a single `constructor(opts = {})` and calls `super(buildBaseSessionOpts(opts, { ...overrides }))`, where `buildBaseSessionOpts` (in `base-session.js`) copies exactly the keys in the exported `BASE_SESSION_OPT_KEYS` array. Subclass-local opts are read off `opts` directly; per-subclass defaults (e.g. `provider`, `model`) go in the `overrides` bag (which wins). The single source of truth is `BASE_SESSION_OPT_KEYS` + the `BaseSession` ctor destructure — the lint asserts they stay equal.

The CI lint (`packages/server/scripts/lint-session-opt-forwarding.sh`) now: (1) asserts `BASE_SESSION_OPT_KEYS` equals the `BaseSession` ctor destructure (drift → fail), and (2) requires every subclass to forward via `super(buildBaseSessionOpts(...))` (or a rest-spread, or the legacy explicit `super({ ... })` which is still checked per-key) — a hand-rolled `super({ a, b })` that drops keys, or a `super(someOtherFn(opts))`, fails. Run locally with `cd packages/server && ./scripts/lint-session-opt-forwarding.sh`.

**When adding a new BaseSession opt:** add it to the `BaseSession` constructor destructure AND to `BASE_SESSION_OPT_KEYS` (same PR) — every picker subclass then inherits it for free. If an opt deliberately should not propagate to a particular subclass (rare), add `// lint-ignore-opt-forwarding: <key>` immediately above the class declaration and explain why.

## Architecture

Server streams through `ws-server.js` → Cloudflare tunnel → mobile app / desktop dashboard:

- **Server:** `server-cli.js` → `sdk-session.js` (Agent SDK) or `cli-session.js` (legacy `claude -p`). Provider selected via `providers.js` registry.
- **Shared:** `ws-server.js` (WebSocket + auth + E2E encryption), `tunnel/` (Cloudflare), `session-manager.js`, `providers.js`, `config.js`, `push.js`
- **Desktop:** Tauri tray app wrapping the web dashboard served by the server
- **App:** ConnectScreen → SessionScreen (ChatView + TerminalView), Zustand store (`connection.ts`)

For component tables, WS protocol messages, data flow diagrams, and file listings: see `docs/architecture/reference.md`

### Security model

- [`docs/security/bearer-token-authority.md`](docs/security/bearer-token-authority.md) — token classes (primary / pairing-bound / hook secret), what each one grants, and the checklist for adding new endpoints. Read this before touching `ws-auth.js`, `ws-permissions.js`, `pairing.js`, or any new HTTP route that touches session state.
- [`docs/security/encryption-threat-model.md`](docs/security/encryption-threat-model.md) — transport-layer (key exchange + message encryption) threat model.

## Dev Commands

```bash
# Server (use Node 22!)
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run server:dev

# App — start Metro dev server (from packages/app/)
npx expo start

# Test client (validate server without mobile app)
node packages/server/src/test-client.js wss://your-url
```

### App Dev Builds (EAS)

The app requires a **custom dev build** (not Expo Go) because `expo-speech-recognition` and `expo-secure-store` include native code. Dev builds are configured via `eas.json` and built in the cloud with [EAS Build](https://expo.dev/eas).

**One-time setup:**
```bash
npm install -g eas-cli
eas login                    # create account at expo.dev if needed
cd packages/app
eas build:configure          # already done — created eas.json
```

**Building the dev client:**
```bash
# Build for Android (or --platform ios, or --platform all)
eas build --profile development --platform android
```

This uploads to EAS cloud, builds (~10-15 min), and provides a download URL/QR code. Install the APK on your phone. The dev client app ("Chroxy") replaces Expo Go.

**Only rebuild when native dependencies change** (new native modules, SDK upgrades). For normal code changes (components, hooks, styles), hot reload works instantly — same as Expo Go.

**Daily development workflows:**

| Scenario | Command | Notes |
|----------|---------|-------|
| Developing at home | `npx expo start` | LAN mode, phone + Mac on same wifi, hot reload |
| Testing on the go | `eas build --profile preview` | Standalone APK with bundled JS, no Metro needed |
| Local emulator | `npx expo run:android` or `npx expo run:ios` | Requires local SDK, builds locally |

**Known issues:**
- `npx expo start --tunnel` fails on Android (ngrok URL triggers `IDN.toASCII` SSL error). Use LAN mode or preview builds instead.
- First time opening the dev client, enter the Metro URL shown in terminal (e.g., `exp://192.168.x.x:8081`).

## UI Verification with Maestro

Maestro E2E flows let agents verify app UI after code changes. Flows live in `packages/app/.maestro/`.

### Prerequisites

```bash
# Install Maestro (one-time)
curl -Ls "https://get.maestro.mobile.dev" | bash

# Boot a simulator
xcrun simctl boot <device-id>   # e.g. xcrun simctl list devices available

# Build + install the chroxy dev client once (flows target com.blamechris.chroxy;
# Expo Go can no longer load the app — native modules)
cd packages/app && npx expo run:ios

# Start Metro dev server (from packages/app/)
npx expo start

# Session/chat flows need the mock server on port 9876
bash packages/app/.maestro/scripts/start-mock-server.sh
```

### Running Flows

```bash
export PATH="$PATH:$HOME/.maestro/bin"

# Full green gate (recommended) — each flow in its OWN maestro process (#6091).
# Reliable on a single simulator over long runs: avoids the XCUITest instability
# that accumulates when all 22 flows share one process (run-all.yaml). Parses the
# flow inventory from run-all.yaml, starts/reuses the mock server, retries a
# failing flow once (env flakiness vs real defect), prints a pass/fail summary.
bash packages/app/.maestro/scripts/run-all-sequential.sh --device <device-id>

# Single-process run of all flows (fine on stable hosts / for a quick pass, but
# flaky over long single-simulator runs — see #6091).
maestro test --device <device-id> packages/app/.maestro/run-all.yaml

# Run a single flow
maestro test --device <device-id> packages/app/.maestro/connect-screen.yaml
```

### After App Changes — Verification Workflow

When you modify app components (screens, UI elements, styling), verify with Maestro:

1. Ensure a simulator is booted and Metro is running
2. Run the relevant flow(s) — screenshots are saved to `packages/app/`
3. Read the screenshot PNGs with the Read tool to visually verify correctness
4. Delete screenshots when done (they're gitignored)

### Available Flows

| Flow | What it verifies |
|------|------------------|
| `connect-screen.yaml` | ConnectScreen elements: title, QR button, LAN scan, manual entry, port |
| `manual-connect.yaml` | Manual entry form, URL input, Connect → optimistic SessionScreen + reconnect banner on unreachable server, header Disconnect back to ConnectScreen |
| `lan-scan.yaml` | LAN scan trigger, in-progress or results state (scan can finish near-instantly) |
| `chat-todolist.yaml` | TodoList renderer end-to-end (mock-server emits TodoWrite tool_use+tool_result, entry expands, structured TodoList renders with testIDs) |
| `run-all.yaml` | Runs all 22 flows sequentially — see its commented list for the full per-flow inventory (session, plan approval, AskUserQuestion, terminal, reconnect, disconnected-permission no-op, …) |

### Fixture Seeding for Structured Renderers

Tests for chat message renderers (TodoList, future MCP tools, `tool_input_delta`, etc.) seed fixtures via **mock-server trigger phrases** rather than an in-app debug menu. The pattern:

1. The Maestro flow types a trigger phrase (e.g. `show-todos`) into the chat input.
2. `mock-server.mjs` detects the phrase in its `case 'input'` handler and emits the corresponding `tool_start` + `tool_result` pair on the WebSocket.
3. The app processes these through `store-core/handlers/{handleToolStart,handleToolResult}` — the production wire path — and lights up the renderer.
4. The flow taps the bubble to expand and asserts on `testID` props (`todo-list-header`, `todo-list-item-<id>`, etc.).

Adding a new renderer to the suite:

- Add a `text.includes('<phrase>')` branch alongside the `show-todos` block in `mock-server.mjs` that emits the right `tool_start`/`tool_result` for the renderer.
- Add `testID` props to the renderer's key elements if not already present.
- Add `<renderer>.yaml` using `setup/ensure-session-screen.yaml`, the input + send sequence, an `extendedWaitUntil` for the bubble header, tap-to-expand, and `assertVisible: id:` checks.
- Add the new flow to `run-all.yaml`.

This keeps the app dependency-free (no debug menu, no URL scheme handler) and tests the same path production tool messages take.

### Gotchas

- **For a full multi-flow gate, prefer `scripts/run-all-sequential.sh`** (each flow in its own maestro process) over `run-all.yaml` on a single simulator — the single-process `run-all.yaml` accumulates XCUITest instability and crashes non-deterministically mid-flow (`kAXErrorInvalidUIElement` / abrupt termination) over long runs (#6091). Never pass multiple `.yaml` files to one `maestro test` — that runs them in parallel and breaks on one simulator.
- **Dev-client menu + onboarding** can appear on launch — flows dismiss them with `optional: true` taps (the dev menu's "Continue" sheet / a top-of-screen tap, then onboarding "Skip"); expect these as WARNED/SKIPPED steps in green runs
- **Flow `name:` must not contain "/"** — Maestro derives report filenames from it; a slash crashes standalone runs with FileNotFoundException
- **`wait` is not a valid command** — use `waitForAnimationToEnd` or `extendedWaitUntil`
- **Emoji/icon text matching** is unreliable — prefer `testID` anchors; an `accessibilityLabel` overrides the visible text in Maestro's matcher, and accessible containers flatten children so exact text matches need `.*wildcards.*`
- **Screenshots save to CWD** — always clean up after verification
- **Device compatibility** — tested on iPhone 16 Pro (iOS 18.6), portrait only; iPad and Android are untested (tap coordinates may differ)

## Repo Memory MCP

This repo has the `repo-memory` MCP server configured, with ~1,500 files pre-indexed (AST summaries) and a `post-merge` hook that keeps the cache warm. Use it to avoid re-reading files and save tokens — it is heavily underused (the cache is warm but agents rarely call it).

### Exploration protocol — try repo-memory before Read/grep

- **Before you `Read` a file, call `get_file_summary`** — it returns exports, imports, purpose, and line count for a fraction of a full Read (a summary runs ~150–400 tokens; a full Read of a large file is several thousand). Use `batch_file_summaries` for several related files at once (preferred over N× `get_file_summary`).
- **Before you grep for a concept** (auth, validation, tunnel, pairing…), call `search_by_purpose`.
- Use `get_related_files` to find what else to look at, and `get_dependency_graph` to trace imports/dependents (useful for review-impact checks).
- `get_project_map` for structure/entry points at the start of a task; `get_changed_files` to see what moved since the last session.

### When to Read the full file anyway

Read the full file (not just the summary) when you need exact implementation details, control flow, or to write code that matches the file's style — or when a summary returns `suggestFullRead: true` (low-quality summary, read instead).

### Subagents

Spawned subagents get a fresh context and **do not inherit this guidance** — when a skill or prompt launches an exploration/review subagent, repeat the exploration protocol in that subagent's prompt (the exploration-heavy skills already do). `get_token_report` summarizes savings; the `repo-memory report` CLI reads the same data at zero token cost.

## Reference

For detailed component tables, WebSocket protocol messages, file listings, and state management details: see [`docs/architecture/reference.md`](docs/architecture/reference.md)

---

*Last Updated: 2026-07-02*
*Version: 0.9.47*
