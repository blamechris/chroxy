# Design Review: Gaps, Install Flow, and Test Automation

Honest assessment of where Chroxy stands at v0.1.0, what's missing, and a concrete strategy for both simplifying the install experience and leveraging AI agents for automated QA.

---

## Part 1: Design Gaps and Weaknesses

### What Works Well

The core loop is solid: server starts, tunnel connects, QR scans, chat streams. The CLI headless architecture (stream-json over Agent SDK) was the right call — it avoids the fragility of terminal parsing and keeps the dependency tree small. The reconnection state machine in the app is genuinely robust (exponential backoff, message queueing, stale socket prevention, health-check-before-WebSocket). The WebSocket protocol is well-structured with 30+ message types that cover the full Claude Code surface area.

### Structural Weaknesses

**1. Two mode paths, one maintained**

PTY/tmux mode exists but has fallen behind. Model switching, permission handling, plan mode, agent monitoring — all CLI-only. The output parser has to guess at structure from raw ANSI, which is inherently fragile. Every new feature widens the gap.

*Decision needed:* Either invest in PTY parity or officially deprecate it. Maintaining two codepaths that diverge silently is worse than having one good path and one that's clearly labeled experimental.

**2. `ws-server.js` is a monolith (1,869 lines)**

This file handles auth, message routing, session management, multi-client awareness, permission proxying, plan mode events, agent lifecycle, history replay, and directory listing. It's the single point of failure for the entire protocol layer. A bug in permission handling can break session switching because they share state and control flow.

Not urgent to refactor now, but this will become the main velocity bottleneck as features are added. Worth splitting into protocol handler + session router + feature handlers when the time comes.

**3. Incomplete rate limiting**

`_authFailures` map is initialized with per-IP tracking but enforcement is never wired up. A malicious client can brute-force tokens at line speed. The Cloudflare tunnel provides some network isolation, but quick tunnels have publicly discoverable URLs (they're just random words at `trycloudflare.com`).

**4. Input validation gaps**

Session names, CWD paths, and tunnel names flow through to shell commands without sanitization. In CLI headless mode the risk is lower (no raw shell execution), but PTY mode constructs tmux commands with user-provided strings. This is a real command injection surface if PTY mode stays.

**5. Config token stored in plaintext**

`~/.chroxy/config.json` has the API token as a plain UUID string. File permissions are `0o600` which is good, but there's no rotation mechanism, no encryption at rest, and no way to invalidate a compromised token short of running `chroxy init` again.

**6. Silent failure modes**

- `cloudflared` not installed: discovered only after server partially starts
- Permission hook errors: some paths don't propagate to the app
- Tunnel DNS verification: can hang for 20+ seconds with no user feedback
- Node version wrong: `node-pty` compilation fails with a wall of C++ errors

**7. Feature completeness**

Several features have the protocol wired but incomplete UI or logic:
- File browser (`list_directory`/`directory_listing`): protocol exists, UI unclear
- Slash commands: message type defined, no implementation
- Permission modes UI: `set_permission_mode` works but mode switching in app needs the confirmation flow
- Agent monitoring: spawned/completed events fire, but agent descriptions truncated and no drill-down

### What's Missing Entirely

| Gap | Impact | Difficulty |
|---|---|---|
| No auth token rotation | Security risk grows over time | Low |
| No server-side logging/audit trail | Can't debug issues after the fact | Low |
| No crash telemetry to client | App shows "reconnecting" but doesn't know why | Medium |
| No offline message drafting | Phone without signal = useless | Medium |
| No multiple device sync | Second phone sees stale state | Medium (protocol supports it, UX doesn't) |
| No update/upgrade path | Users must `git pull` and hope | Medium |
| No Windows/Linux server support | macOS-only (Homebrew deps, PTY paths) | High |

---

## Part 2: One-App Install Flow

### Current Reality (6 steps, 3 hidden prerequisites)

```
1. brew install node@22 cloudflared    # Hidden: user discovers this only on failure
2. git clone ...chroxy                  # No npm publish, no installer
3. cd chroxy && npm install             # node-pty may fail to compile
4. PATH="..." npx chroxy init          # Interactive prompts, PATH dance
5. PATH="..." npx chroxy start         # Tunnel takes 5-20s, no progress feedback
6. Scan QR from phone                  # Requires Expo Go already installed
```

Friction points: Node 22 PATH hack, missing prereq checks, no global install, slow tunnel startup with no progress indicator, QR code shown only once (scroll up to find it).

### Target: Two Commands + One Scan

```
1. brew install chroxy                  # or: npx chroxy@latest install
2. chroxy start                         # Just works, progress bar, QR code
3. Scan QR from phone                   # App Store app, not Expo Go
```

### How to Get There

**Phase 1: Preflight checks (small effort, high impact)**

Add a `preflight()` function to `cli.js start` that runs before anything else:

```
[chroxy] Checking prerequisites...
  Node 22+ ........ OK (v22.15.0)
  cloudflared ...... OK (2024.12.0)
  claude CLI ....... OK (/usr/local/bin/claude)
  Config file ...... OK (~/.chroxy/config.json)
  [tmux ............ SKIP (not needed for CLI mode)]

[chroxy] Starting server...
```

If something fails, print the exact install command (`brew install cloudflared`) and exit before wasting time.

**Phase 2: Auto-init on first start**

If `~/.chroxy/config.json` doesn't exist when `chroxy start` runs, generate it with defaults automatically. Print the token and continue. No separate `init` step needed. The current interactive prompts ask about port and tmux session name — neither matters for 99% of users.

```
[chroxy] No config found. Creating ~/.chroxy/config.json with defaults...
[chroxy] Your API token: a1b2c3d4-...
[chroxy] Starting server...
```

**Phase 3: `npx chroxy@latest start` (requires npm publish)**

Publish `@chroxy/server` to npm. Users skip the git clone entirely:

```bash
npx chroxy@latest start
```

First run: downloads, auto-inits, starts, shows QR.
Subsequent runs: cached, just starts.

The `engines` field already enforces Node 22. The `bin` entry already maps `chroxy` to `cli.js`. The main blocker is that `node-pty` is a compile-time native dependency — it'll fail on systems without build tools. Since PTY mode is secondary, make `node-pty` an optional dependency and fail gracefully if it's missing when `--terminal` is passed.

**Phase 4: Launch on login (launchd on macOS)**

Add a `chroxy service install` command that creates a launchd plist:

```xml
<!-- ~/Library/LaunchAgents/dev.chroxy.server.plist -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.chroxy.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/node@22/bin/node</string>
    <string>/path/to/chroxy/src/cli.js</string>
    <string>start</string>
    <string>--tunnel</string>
    <string>named</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/chroxy.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/chroxy.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

This only makes sense with named tunnels (stable URL), because quick tunnels change on every restart and the QR code would be different each time. The app would need to re-scan. With a named tunnel + `KeepAlive`, chroxy is always running and the app always reconnects to the same URL.

Commands:
```bash
chroxy service install    # Creates plist, loads it
chroxy service uninstall  # Unloads and removes plist
chroxy service status     # Shows launchd status + last log lines
chroxy service logs       # Tails /tmp/chroxy.log
```

**Phase 5: Homebrew formula (polish)**

A Homebrew formula that handles Node 22 dependency, installs cloudflared as a dependency, and provides the `chroxy` command directly. This is the "one command install" endgame:

```bash
brew install chroxy
chroxy start
```

### Recommended Priority

1. Preflight checks — do this now, eliminates the most common failure mode
2. Auto-init on first start — do this now, removes an entire step
3. npm publish — do this soon, removes git clone
4. launchd service — do this for named tunnel users, enables "always on"
5. Homebrew formula — polish, do when the project is stable

---

## Part 3: Automated Testing with AI Agents

### The Problem

The smoke test checklist has 100+ manual test cases across 15 scopes. Only 2 scopes have ever been tested. 30+ PRs have merged since the last test run. You're currently both developer and sole QA tester — which means bugs only surface when you're actively using the app.

### The Strategy: Three Layers

```
Layer 1: Protocol Test Harness    ← Agent-executable, no phone needed
Layer 2: Scenario Simulator       ← Agent-executable, validates full flows
Layer 3: Visual Smoke Tests       ← Human-assisted, agent-guided
```

### Layer 1: Protocol Test Harness

**What it is:** An automated version of `test-client.js` that connects to a real server, runs through WebSocket protocol scenarios, and asserts on responses. Think of it as an integration test that exercises the actual server (not mocks).

**File:** `packages/server/tests/harness.js`

```js
// Concept:
const harness = new TestHarness('ws://localhost:8765', token)

await harness.connect()
await harness.expectMessage('auth_ok')
await harness.expectMessage('server_mode', { mode: 'cli' })
await harness.expectMessage('available_models')

// Send a message and validate the streaming response lifecycle
await harness.send('input', { data: 'Say exactly: "pong"' })
await harness.expectMessage('stream_start')
await harness.expectMessageMatching('stream_delta', delta => delta.text.includes('pong'))
await harness.expectMessage('stream_end')
await harness.expectMessage('result')

// Permission flow
await harness.send('input', { data: 'Create /tmp/harness-test.txt with "hello"' })
await harness.expectMessage('permission_request', { timeout: 30000 })
await harness.send('permission_response', { id: lastPermission.id, action: 'allow' })
await harness.expectMessage('result')
```

**What an AI agent can do with this:**
- Write new test scenarios by reading the WebSocket protocol spec in CLAUDE.md
- Run the harness against a local server (`--no-auth --tunnel none`)
- Analyze failures and correlate with code changes
- Expand coverage systematically (one smoke-test scope at a time)

**Coverage this enables:**
- Connection/auth flow (all variants)
- Chat send/receive/streaming lifecycle
- Permission request/response/timeout
- Model switching
- Session CRUD and switching
- Multi-client behavior (spawn two harness instances)
- Interrupt handling
- Plan mode events
- Agent spawning/completion events
- History replay on reconnect

That covers ~70% of the smoke test checklist without touching a phone.

### Layer 2: Scenario Simulator

**What it is:** Pre-scripted multi-step scenarios that exercise complex flows. Each scenario is a function that uses the harness and makes assertions about the full sequence.

```js
// scenarios/reconnection.js
export async function testReconnection(serverUrl, token) {
  const client = new TestHarness(serverUrl, token)
  await client.connect()
  await client.sendMessage('Remember the code word: blue-elephant-42')
  await client.expectResponse()

  // Disconnect and reconnect
  client.disconnect()
  await sleep(2000)
  await client.connect()

  // Verify history replay
  await client.expectMessage('history_replay_start')
  await client.expectMessage('history_replay_end')

  // Verify conversation memory survived
  await client.sendMessage('What was the code word?')
  const response = await client.expectResponseContaining('blue-elephant-42')
  return { passed: true, response }
}
```

**Scenarios to build:**
| Scenario | Tests | Priority |
|---|---|---|
| `auth-flow` | Valid token, wrong token, no token, timeout | High |
| `chat-roundtrip` | Send, stream, complete, verify content | High |
| `permission-cycle` | Request → allow/deny/timeout | High |
| `model-switch` | Switch model mid-conversation | Medium |
| `session-lifecycle` | Create, switch, rename, destroy | Medium |
| `reconnection` | Disconnect, reconnect, history replay | Medium |
| `multi-client` | Two clients, primary tracking, broadcast | Medium |
| `interrupt` | Send long prompt, interrupt mid-stream | Medium |
| `plan-mode` | Trigger plan, approve/reject | Medium |
| `agent-monitoring` | Trigger Task tool, track spawn/complete | Low |
| `stress` | Rapid-fire messages, large payloads, many sessions | Low |

**How an agent runs this:**

```bash
# Start server in no-auth mode for testing
npx chroxy start --no-auth --tunnel none &
SERVER_PID=$!

# Run scenario suite
node tests/scenarios/run-all.js --url ws://localhost:8765

# Collect results
# Agent reads output, identifies failures, can inspect server logs
```

An AI agent like Claude can:
1. Start the server in test mode
2. Run scenario suites
3. Read failure output and server logs
4. Correlate failures with recent code changes
5. Report which smoke-test scopes pass/fail
6. Suggest fixes for failures

### Layer 3: Visual Smoke Tests (Human-Assisted, Agent-Guided)

Some things can't be tested without a phone: QR scanning, keyboard behavior, scroll performance, animation smoothness, touch gestures. But an agent can still help.

**Agent-guided protocol:**

1. Agent runs Layer 1 + 2, generates a report of what passed
2. Agent produces a focused checklist of what needs human verification (only the visual/interaction items)
3. Human runs through the reduced checklist (15-20 items instead of 100+)
4. Human reports results back to agent
5. Agent updates `qa-log.md` with full coverage

**What the reduced human checklist looks like:**

```
## Visual Verification (Agent Pre-Verified: Protocol OK)

Connection:
- [ ] QR code scans correctly from phone camera
- [ ] ConnectScreen layout correct (no overlaps)

Chat:
- [ ] Streaming text is visible letter-by-letter (not batched)
- [ ] Auto-scroll follows new content
- [ ] Tool bubbles expand/collapse on tap

Keyboard:
- [ ] iOS: keyboard animates smoothly, safe area respected
- [ ] Android: input moves above keyboard + autocomplete bar

Terminal:
- [ ] xterm.js renders green text on black background
- [ ] Special key bar visible and functional
```

This cuts human testing time by ~70% because the agent has already verified all the protocol-level behavior.

### Implementation Plan

**Step 1: Build the test harness**

Create `packages/server/tests/harness.js` with:
- WebSocket client wrapper (connect, send, expect)
- Message matching (type, content, timeout)
- Assertion helpers (expectMessage, expectResponse, expectResponseContaining)
- Cleanup (disconnect, kill server)

**Step 2: Write the first 3 scenarios**

- `auth-flow`: covers Connection scope
- `chat-roundtrip`: covers Chat scope
- `permission-cycle`: covers Permissions scope

These three cover the most critical paths and validate the harness works.

**Step 3: Add to CI**

```yaml
# .github/workflows/ci.yml
integration-tests:
  runs-on: ubuntu-24.04
  steps:
    - uses: actions/setup-node@v4
      with: { node-version: '22' }
    - run: npm ci
    - run: |
        # Start server in background (no-auth, no tunnel)
        npx chroxy start --no-auth --tunnel none &
        sleep 3
        # Run integration scenarios
        node packages/server/tests/scenarios/run-all.js
```

**Step 4: Agent-as-QA workflow**

Once the harness and scenarios exist, the workflow for any PR becomes:

1. Agent reads the PR diff
2. Agent consults the file-to-scope mapping in `smoke-test.md`
3. Agent runs relevant scenario suites
4. Agent reports: "Protocol tests pass for Connection, Chat, Permissions. Human verification needed for: QR scanning, keyboard behavior."
5. You do the visual checks (5 minutes instead of 30)
6. Agent updates `qa-log.md`

This is the "beta tester" experience you're describing — by the time you pick up the phone, the protocol-level stuff is already verified. You're testing feel, not function.

### What This Doesn't Solve

- **App rendering bugs**: CSS/layout issues can only be caught visually or with screenshot comparison (Detox/Maestro territory, much heavier investment)
- **Network edge cases on real phones**: Airplane mode, cellular handoff, background/foreground — need real hardware
- **Performance**: Streaming latency, scroll jank, memory leaks — need profiling on device
- **Expo Go vs production build**: Behavior can differ, especially around push notifications and deep links

These are real gaps, but they're the right gaps to have. Protocol correctness + human visual spot-checks covers 90% of the bug surface. The remaining 10% is what you discover as a beta tester rather than an alpha tester.

---

## Summary of Recommendations

### Do Now
1. **Preflight checks** in `chroxy start` — catches missing prereqs before they waste time
2. **Auto-init** on first start — removes the separate `init` step
3. **Build the test harness** — unlocks agent-driven QA for every PR

### Do Soon
4. **Publish to npm** — enables `npx chroxy@latest start`, removes git clone
5. **Write the core 3 scenarios** (auth, chat, permissions) — covers the critical path
6. **Wire rate limiting** — `_authFailures` is already tracked, just needs enforcement
7. **Make `node-pty` optional** — prevents install failures for CLI-only users

### Do When Ready
8. **`chroxy service install`** (launchd) — "always on" for named tunnel users
9. **Expand to all 11 scenario suites** — full protocol coverage
10. **Decide on PTY mode** — maintain or deprecate, but stop the silent divergence
11. **Homebrew formula** — the one-command install endgame
