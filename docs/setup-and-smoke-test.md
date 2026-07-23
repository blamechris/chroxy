# Setup & Smoke Test — start the Chroxy server and prove it works

A living, **runnable** guide to standing up a Chroxy daemon on your machine and
verifying it end to end. Every command here is copy-pasteable; each smoke-test
step has an **expected output** block and a tick-box so you can confirm a healthy
setup yourself.

> **Node 22 is required.** On macOS with Homebrew, prefix every `chroxy` command
> with the Node 22 path so you don't accidentally run an older Node:
> ```bash
> PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy <command>
> ```
> The examples below assume you've done this (or that `node --version` already
> prints `v22.x`).

---

## 1. Prerequisites

| Dependency | Why | Install (macOS) |
|-----------|-----|-----------------|
| **Node.js ≥ 22** | Runs the daemon | `brew install node@22` |
| **cloudflared** | Secure tunnel (only if you use `--tunnel quick`/`named`) | `brew install cloudflared` |
| **An AI CLI** | The session backend. Default is `claude-tui` (the interactive `claude` TUI). | `claude` (Claude Code), or `gemini` / `codex` for those providers |

`chroxy doctor` (step 4) checks all of these for you.

Linux and Windows are supported too — see [self-hosting-guide.md](self-hosting-guide.md)
for `cloudflared` install on Debian/Ubuntu and the Windows PowerShell quickstart
in the [root README](../README.md).

---

## 2. Install

```bash
git clone https://github.com/blamechris/chroxy.git
cd chroxy
npm install
```

`npm install` bootstraps all workspaces (server, dashboard, protocol, store-core,
…). The web dashboard is built and served by the server; you don't build it
separately for a normal run.

---

## 3. First-time setup — `chroxy init`

Generates an API token and writes `~/.chroxy/config.json`:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy init
```

- The token is stored in your **OS keychain** when available (macOS Keychain,
  Linux libsecret, or Windows DPAPI under `%LOCALAPPDATA%\Chroxy`); otherwise it
  lives in `config.json`. Either way `chroxy start` finds it.
- **Re-running `init`** on an existing setup needs `chroxy init --force` and
  **regenerates the token — which unpairs every already-paired device.** Only do
  that if you intend to re-pair everything. For a running daemon you usually want
  `chroxy pair-code` (step 6), not another `init`.

---

## 4. Verify the environment — `chroxy doctor`

Before starting, confirm every dependency resolves:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy doctor
```

**Expected output** (a healthy macOS setup):

```
Chroxy Doctor

  [ OK ] Node.js            v22.x
  [ OK ] cloudflared        cloudflared version 2026.x
  [ OK ] Config             /Users/you/.chroxy/config.json
  [ OK ] Credential storage OS keychain
  [ OK ] Billing            Default provider 'claude-tui' — Included (subscription)
  [ OK ] claude-tui driving claude 2.1.x
  [ OK ] Port               8765 is available

  Provider: claude-tui
    [ OK ] claude             2.1.x (Claude Code)

All checks passed. Ready to start.
```

- [ ] `doctor` prints **"All checks passed. Ready to start."**

A `WARN` on `cloudflared` is fine if you plan to run `--tunnel none` (LAN-only).
A `Port … in use` error means a daemon is already running — see step 8.

---

## 5. Start the server — `chroxy start`

Pick the tunnel mode that fits how you'll connect:

```bash
# (a) Quick tunnel (default) — random public https URL, no Cloudflare account.
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start

# (b) LAN only — no tunnel; connect from a device on the same Wi-Fi.
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start --tunnel none

# (c) Named tunnel — stable URL (requires `chroxy tunnel setup` first).
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start --tunnel named
```

On start you'll see the bind port (default **8765**), the tunnel URL (or the LAN
address for `--tunnel none`), and a QR code for the mobile app. The server runs
under a **supervisor** that auto-restarts it on crash whenever a tunnel is active.

**Common flags** (`chroxy start --help` for the full list):

| Flag | Purpose |
|------|---------|
| `--tunnel <mode>` | `quick` (default), `named`, `none`, or `cloudflare:named` |
| `--provider <name>` | `claude-tui` (default), `claude-sdk`, `claude-cli`, `gemini`, `codex`, … |
| `--host 127.0.0.1` | Loopback-only bind (auth stays on) |
| `--cwd <path>` | Working directory for the AI session |
| `--port <n>` (via `PORT` env / config) | Change the default 8765 |
| `--no-supervisor` | Run the server directly (no auto-restart) — handy for debugging |
| `--cost-budget <dollars>` | Pause a session at a per-session spend cap |

**Opt-in IDE surface (epic #6469):** the file/symbol navigator, go-to-definition,
find-references, find-in-project, and syntax-highlit viewer are gated behind a
feature flag — off by default. Enable with `CHROXY_ENABLE_IDE=1`:

```bash
CHROXY_ENABLE_IDE=1 PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start --tunnel none
```

**Opt-in semantic session titles (#6764):** by default a new session's sidebar
label is the first user message truncated at a word boundary. With this flag on,
that label is upgraded — once per session, asynchronously (never blocking the
turn) — to a short model-generated title via a cheap one-shot Haiku call. If the
call fails, times out, or no model access is available, the truncation label is
kept. Off by default; enable with `features.semanticTitles: true` in
`~/.chroxy/config.json` or `CHROXY_SEMANTIC_TITLES=1`:

```bash
CHROXY_SEMANTIC_TITLES=1 PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start --tunnel none
```

The title model defaults to a cheap Haiku alias; override it with
`CHROXY_SEMANTIC_TITLES_MODEL=<id>` or the existing `summarize.model` config key.
The one-shot is hard-bounded by a timeout (default 15s) so a stalled provider
aborts the call and falls back to the truncation label rather than leaking a
never-settling request; override it with `CHROXY_SEMANTIC_TITLES_TIMEOUT_MS=<ms>`
or the `summarize.titleTimeoutMs` config key.

**Metering note:** this one-shot runs through the Agent SDK / headless path
(the same call the `summarize.model` summarizer uses). On a Claude
subscription, headless/SDK calls are billed against the separate metered pool,
not the plan's main quota — so an opted-in user on a subscription spends one
(small) metered-pool call per new session's first turn. The cost is
negligible, but it is non-zero and separate from your interactive usage.

---

## 6. Connect

Get your token (needed for the dashboard URL):

```bash
# From the OS keychain (default on macOS):
security find-generic-password -s chroxy -a api-token -w

# …or from config.json if it lives there instead:
jq -r '.apiToken' ~/.chroxy/config.json
```

- **Web dashboard:** open `http://localhost:8765/dashboard?token=<TOKEN>` (the
  token is set as a cookie on first load). Over a tunnel, use the tunnel URL
  instead of `localhost:8765`.
- **Mobile app:** scan the QR code the server printed, or run
  `npx chroxy pair-code` to reprint the typeable pairing code + URL for a
  camera-less device — no restart needed.
- **Desktop tray app:** launches its own dashboard; add this daemon as a LAN
  server from the picker.

---

## 7. Smoke test — prove it end to end

Run each check and tick the box. All green = a working setup.

### 7a. Is the daemon up and healthy?

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy status
```

**Expected output:**

```
Chroxy v0.9.47

Status:   Running (pid 12345)
Port:     8765
Tunnel:   https://<something>.trycloudflare.com   (quick)
Uptime:   1m 12s
Sessions: 0 active
```

- [ ] `status` reports **Running** with a pid, port, and (if applicable) a tunnel URL.

### 7b. Does the health endpoint answer?

```bash
curl -s http://localhost:8765/health
```

**Expected output** (exact shape):

```json
{"status":"ok","mode":"cli","version":"0.9.47"}
```

- [ ] `/health` returns JSON with `"status":"ok"` and the current `version`.

> Use the `/health` path explicitly: a plain `curl` of `/` returns the same JSON,
> but a browser-style `Accept: text/html` request to `/` redirects to `/dashboard`.

### 7c. Does the dashboard render? (Playwright smoke test)

Chroxy ships a Playwright-based dashboard smoke test that opens the dashboard in
a headless browser, screenshots each step, and verifies key UI elements. It
**auto-detects a running server** (probing ports `8765, 3131, 8080, 3000`) and
starts a throwaway one if none is found.

```bash
cd packages/server
PATH="/opt/homebrew/opt/node@22/bin:$PATH" node tests/smoke-test.mjs
#   add --headed to watch the browser drive the dashboard
```

**Expected output** (tail):

```
  ✓ dashboard loaded
  ✓ connection UI present
  ✓ session controls present
  …
All checks passed.
```

- [ ] `smoke-test.mjs` exits **0** (`echo $?` → `0`). Exit `1` = one or more checks failed.

Screenshots are saved to `packages/server/tests/screenshots/` (gitignored) — read
them if a check fails to see exactly what rendered. The script stops any server it
started with `SIGTERM` (8s grace) so the session-state flush isn't lost.

### 7d. Can a client actually connect and start a session?

Open the dashboard URL from step 6, then:

- [ ] The dashboard connects (status dot goes green) after you paste the URL with `?token=`.
- [ ] Creating a new session shows the provider (default `claude-tui`) and a live terminal + chat view.
- [ ] Sending a message produces a response (the AI CLI is wired up correctly).

If 7a–7c pass but 7d doesn't, it's almost always the **AI CLI**, not chroxy — run
`chroxy doctor` again and confirm the `Provider:` block is `OK`.

---

## 8. When something's wrong

| Symptom | Check |
|---------|-------|
| `Port 8765 is available` fails / "address in use" | A daemon is already running. `chroxy status` to confirm. Stop it: **Ctrl+C** if you started it in the foreground; `chroxy service stop` if you installed it as a system daemon; otherwise kill the pid that `chroxy status` printed. |
| `No API token configured. Run 'npx chroxy init' first.` | You skipped step 3, or the keychain entry was removed. Re-run `chroxy init`. |
| Dashboard 403s | The `?token=` is missing/wrong — re-fetch it (step 6). |
| Tunnel URL unreachable | `curl https://<tunnel>/health`; wait a few seconds for the route to propagate, or check `cloudflared` in `doctor`. |
| App can't connect | See [self-hosting-guide.md](self-hosting-guide.md#app-cant-connect). |

Full failure catalogue: [docs/troubleshooting.md](troubleshooting.md). Named-tunnel
setup: [docs/named-tunnel-guide.md](named-tunnel-guide.md). Provider setup + env
vars: [docs/providers.md](providers.md). All config keys / env vars:
[packages/server/CONFIG.md](../packages/server/CONFIG.md).

---

*Runnable against Chroxy v0.9.47. If a command's output drifts from what's shown
here, trust the code — and please open an issue so this guide can be corrected.*
