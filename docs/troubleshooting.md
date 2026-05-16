# Troubleshooting Guide

Common issues and solutions for Chroxy server, app, and tunnel connectivity. For provider-specific setup (installation, model lists, env vars) see [docs/providers.md](providers.md); the Gemini and Codex sections below cover only runtime errors.

> **Triaging a stuck session?** Jump straight to [the `/diagnostics` endpoint](#0-diagnostics-endpoint-triaging-stuck-sessions) — it dumps live per-session state (busy flags, paused timers, pending permissions) plus a tail of the on-disk log in one request.

## 0. `/diagnostics` endpoint (triaging stuck sessions)

When a session hangs — most often surfaced to the user as **"Response timed out after 5 minutes"** — `GET /diagnostics` is the first thing to call. It returns a runtime snapshot of the server: per-session `isBusy` / `permissionMode` / `resultTimeoutPaused` / pending-permission queue, plus a tail of `~/.chroxy/logs/chroxy.log`. Available since v0.6.0 (PR [#3734](https://github.com/blamechris/chroxy/pull/3734), issue [#3732](https://github.com/blamechris/chroxy/issues/3732)).

### How to call it

The endpoint is bearer-auth gated using the same API token as every other authenticated route. The token lives in `~/.chroxy/config.json` (`apiToken` field) and is also exported into the Claude Code session environment as `CHROXY_TOKEN`.

```bash
TOKEN=$(jq -r .apiToken ~/.chroxy/config.json)

# JSON (default) — full structured snapshot
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:8765/diagnostics | jq

# text/plain — human-readable, copy-pasteable for bug reports
curl -s -H "Authorization: Bearer $TOKEN" \
     -H "Accept: text/plain" \
     http://localhost:8765/diagnostics
```

If you set a non-default port, substitute it. The endpoint is also reachable through the Cloudflare tunnel URL (same auth header), but for local triage `localhost` skips the tunnel layer and is faster.

A `403 {"error":"unauthorized"}` response means your token is wrong or stale — re-read `~/.chroxy/config.json` and retry.

#### Tuning the log window with `?logTailBytes=N` (#3739)

By default the snapshot includes the last ~8KB of `chroxy.log`. For a long-running stall where the relevant event is further back, pass `?logTailBytes=N` to widen the window; for a tight repro where you want a fast response, shrink it.

```bash
# Widen to 32KB for a long stall
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8765/diagnostics?logTailBytes=32768" | jq '.logs.lines | length'

# Shrink to 1KB for a tight repro loop
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8765/diagnostics?logTailBytes=1024"
```

Rules:

- Must be a positive integer. `NaN`, `0`, negatives, and missing values fall back to the 8KB default.
- Hard-capped at **65536 bytes** (8× the default). Larger requests are silently clamped, not rejected — an operator who asks for 1MB still gets a useful 64KB response.
- Fractional values (e.g. `1024.9`) are truncated to integers.

### What the JSON snapshot looks like

```jsonc
{
  "server": {
    "version": "0.6.0",
    "mode": "cli",
    "uptime": 1842,         // seconds
    "pid": 12345,
    "nodeVersion": "v22.11.0",
    "memory": { "rss": 187904000, "heapUsed": 96534528, "heapTotal": 134217728 }
  },
  "clients": { "connected": 2, "authenticated": 2 },
  "counters": { /* metrics.snapshot() */ },
  "rateLimiters": [        // <-- per-limiter eviction stats (#3996, #4005)
    { "name": "ws", "evictionCount": 0, "lastEvictionAt": null, "mapSize": 3, "maxEntries": 10000, "evictionsInWindow": 0, "evictionWindowMs": 60000, "evictionWindowSaturated": false },
    { "name": "permission", "evictionCount": 0, "lastEvictionAt": null, "mapSize": 0, "maxEntries": 10000, "evictionsInWindow": 0, "evictionWindowMs": 60000, "evictionWindowSaturated": false },
    { "name": "diagnostics", "evictionCount": 0, "lastEvictionAt": null, "mapSize": 1, "maxEntries": 10000, "evictionsInWindow": 0, "evictionWindowMs": 60000, "evictionWindowSaturated": false },
    { "name": "http-permission", "evictionCount": 0, "lastEvictionAt": null, "mapSize": 0, "maxEntries": 10000, "evictionsInWindow": 0, "evictionWindowMs": 60000, "evictionWindowSaturated": false }
  ],
  "sessions": [
    {
      "id": "sess-42",
      "name": "main",
      "provider": "claude",
      "cwd": "/Users/you/projects/foo",
      "isBusy": true,                    // <-- a turn is in flight
      "permissionMode": "default",
      "currentMessageId": "msg_018A...",
      "resultTimeoutPaused": true,       // <-- the 5-min RESULT_TIMEOUT is paused
      "permissionPauseCount": 1,         // <-- and one permission caused the pause
      "pendingPermissions": [
        {
          "requestId": "req_abc123",
          "tool": "Bash",
          "description": "rm -rf node_modules && npm install",
          "createdAt": 1715000000000,
          "ageMs": 184000              // <-- 3m 4s waiting for user approval
        }
      ],
      "lastActivityAt": 1714999800000
    }
  ],
  "logs": {
    "source": "file",
    "path": "/Users/you/.chroxy/logs/chroxy.log",
    "lines": [ /* last ~8KB of log lines */ ]
  }
}
```

### Interpreting the fields when triaging a hang

| Field | What it tells you |
| --- | --- |
| `sessions[].isBusy` | A turn is in flight. If `true` for many minutes with no `pendingPermissions`, the upstream provider (Anthropic / OpenAI / Gemini) is wedged — check network and `logs.lines` for retry/backoff messages. |
| `sessions[].resultTimeoutPaused` | The 5-minute `RESULT_TIMEOUT` watchdog (introduced for #2831) is paused. It pauses while the session waits on a permission prompt, then resumes when permissions clear. |
| `sessions[].permissionPauseCount` | How many outstanding pauses there are. **Should equal `pendingPermissions.length`.** If `permissionPauseCount > 0` but `pendingPermissions` is empty, the timer has leaked — capture this snapshot and file a bug. |
| `sessions[].pendingPermissions[].ageMs` | How long the prompt has been waiting. A multi-minute age usually means the prompt never reached the app (see [§4](#4-permission-requests-not-reaching-the-app)) or the user backgrounded the app and the prompt is sitting unseen. |
| `sessions[].pendingPermissions[].tool` / `.description` | What the session is asking permission for. Tool *inputs* are intentionally redacted from `/diagnostics` — the full input lives in `logs.lines` (and the on-disk log). |
| `sessions[].lastActivityAt` | Wall-clock of the last persisted activity. Compared against `Date.now()` it tells you how stale the session is even when `isBusy` is true. |
| `logs.lines` | Last ~8KB of `chroxy.log`. Look for `[ws]`, `[session-binding-*]`, or provider-error stack traces near the failure window. |
| `logs.source: "disabled"` | File logging is off. Restart with `CHROXY_LOG_LEVEL=debug` (or set `logLevel`/`logDir` in config) to enable, then re-trigger the failure. |
| `rateLimiters[].evictionCount` | Cumulative entries evicted from each limiter's per-IP map since process start (#3996). **Non-zero is the signal that the limiter is shedding entries** — usually source-IP rotation against an HTTP endpoint (`http-permission`, `diagnostics`, `permission`) or a DDoS pattern against `ws`. Pair with `rateLimiters[].mapSize == maxEntries` to confirm steady-state pressure. The throttled `[WARN] [rate-limit]` lines in `logs.lines` reference the same limiter `name`. |
| `rateLimiters[].evictionsInWindow` | Evictions in the most recent `evictionWindowMs` (default 60s) (#4005). **This is the live-alert signal** — `evictionCount` only tells you "has this ever happened since boot?", whereas `evictionsInWindow` tells you "is it happening *right now*?". A non-zero value paired with mapSize at the cap is the textbook live-attack signature; alert on this rather than the cumulative counter. |
| `rateLimiters[].evictionWindowMs` | The actual window length used for `evictionsInWindow`, surfaced for transparency so dashboards can render "X evictions in the last Y minutes" without hard-coding the constant. |
| `rateLimiters[].evictionWindowSaturated` | `true` when the eviction-rate buffer hit its hard cap (1024 entries) and `evictionsInWindow` has degraded to a floor rather than the exact count. Cumulative `evictionCount` still captures full magnitude. Clears automatically once the buffer drains. |

### Common patterns

- **Session frozen, `isBusy: true`, `resultTimeoutPaused: false`, no pending permissions** → the upstream provider call is in flight and unresponsive. Check `logs.lines` for the last outbound request and any retry messages; restart the session if needed.
- **Session frozen, `pendingPermissions[].ageMs` is large** → the prompt was issued but the app never responded. Verify the app is connected (check `clients.connected`), then re-foreground it. See [§4](#4-permission-requests-not-reaching-the-app).
- **`resultTimeoutPaused: true`, `permissionPauseCount > 0`, `pendingPermissions` empty** → timer leak. Restart resolves it; please attach the `/diagnostics` JSON to a bug report.
- **`SESSION_TOKEN_MISMATCH` errors after reconnect** → see the dedicated [`SESSION_TOKEN_MISMATCH` runbook](troubleshooting/session-token-mismatch.md), which uses `/diagnostics` alongside the `[session-binding-*]` debug logs.

### When to capture a snapshot

Always grab a `text/plain` snapshot **at the moment of failure** before restarting the server — restart resets every flag. Paste it into the bug report:

```bash
TOKEN=$(jq -r .apiToken ~/.chroxy/config.json)
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: text/plain" \
     http://localhost:8765/diagnostics > /tmp/chroxy-diag-$(date +%s).txt
```

## 1. "No API token configured" on server start

**Symptom:** Server exits immediately with `No API token configured`.

**Fix:**
```bash
npx chroxy init     # Interactive setup — generates token and config
npx chroxy start    # Now starts successfully
```

Or set the token manually in `~/.chroxy/config.json`:
```json
{ "apiToken": "your-token-here" }
```

## 2. App can't connect (timeout or "connection failed")

**Diagnostic steps:**
1. Verify the server is running: check terminal for the QR code / URL output
2. If using LAN: ensure phone and server are on the same Wi-Fi network
3. Try opening the server URL in a browser — you should see `{"status":"ok"}`
4. Check firewall: ensure the server port (default 8765) is not blocked

**Common causes:**
- **Wrong URL**: re-scan the QR code or re-enter the URL
- **VPN active**: VPNs can block local network traffic — disconnect and retry
- **Tunnel not ready**: Quick tunnels take a few seconds to become routable — wait and retry

## 3. Tunnel URL not working

**Symptom:** QR code generated but app shows "connection failed".

**Diagnostic steps:**
```bash
# Test the tunnel URL directly
curl -s https://your-tunnel-url.trycloudflare.com
# Should return: {"status":"ok"}
```

**Fixes:**
- **Quick tunnel**: restart the server to get a new URL (Quick tunnel URLs are ephemeral)
- **Named tunnel**: verify `cloudflared` is authenticated: `cloudflared tunnel list`
- **DNS propagation**: new tunnel URLs can take 5-10 seconds to resolve — retry after a moment
- Install cloudflared if missing: `brew install cloudflared`

## 4. Permission requests not reaching the app

**Symptom:** Claude Code hangs waiting for permission, but no prompt appears in the app.

**Diagnostic steps:**
1. Hit [`/diagnostics`](#0-diagnostics-endpoint-triaging-stuck-sessions) — if `pendingPermissions` is non-empty with a multi-second `ageMs`, the server registered the prompt but no client picked it up
2. Check server logs for `[ws] Permission request` lines
3. Verify the permission hook is registered: check `~/.claude/settings.json` for `PreToolUse` hook
4. Ensure `CHROXY_PORT` and `CHROXY_TOKEN` are set in the Claude Code session environment

**Fixes:**
- Restart the server — the hook is re-registered on startup
- If the hook was manually removed, restart will re-add it
- Check that the server port matches `CHROXY_PORT` in the hook configuration

## 5. "Node.js version too old" or crypto errors

**Symptom:** Server crashes with `crypto.randomBytes is not a function` or similar.

**Fix:** Chroxy requires Node 22+.
```bash
node --version                    # Check current version
brew install node@22              # Install Node 22
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start
```

## 6. App shows "server restarting" loop

**Symptom:** App connects briefly then shows "server restarting" repeatedly.

**Causes:**
- Claude Code process crashing and being respawned by the supervisor
- Max restarts reached — check server logs for `max respawn` errors

**Fixes:**
- Check server terminal for error messages
- Ensure Claude Code CLI is installed and working: `claude --version`
- Increase max restarts if needed: `npx chroxy start --max-restarts 20`

## 7. QR code won't scan

**Diagnostic steps:**
1. Ensure good lighting and hold phone steady
2. Try zooming in on the QR code in the terminal
3. Use manual connection instead: copy the URL and token from server output

**Fixes:**
- Increase terminal font size for a larger QR code
- Use `npx chroxy info` to re-display connection details without restarting

## 8. E2E encryption errors ("decrypt failed")

**Symptom:** Messages arrive garbled or app shows decryption errors.

**Causes:**
- Client and server key mismatch after reconnection
- Using `--no-encrypt` on one side but not the other

**Fix:** Disconnect and reconnect from the app. The key exchange happens fresh on each connection.

## 9. Session timeout / "session destroyed"

**Symptom:** Session disappears after being idle, or you see "Response timed out after 5 minutes" mid-turn.

**Cause:** Either the session-idle timeout fired, or the per-turn `RESULT_TIMEOUT` watchdog (5 min by default) fired.

**Fixes:**
- For the idle timeout: increase it with `npx chroxy start --session-timeout 4h`, or disable it by not setting `--session-timeout` / `CHROXY_SESSION_TIMEOUT`. The app sends keep-alive pings, but only while it's in the foreground.
- For the per-turn `RESULT_TIMEOUT`: capture a [`/diagnostics`](#0-diagnostics-endpoint-triaging-stuck-sessions) snapshot **before restarting** so you can see whether the session was wedged on a pending permission, an upstream provider call, or a leaked timer. Restarting wipes every flag.

## 10. Gemini provider errors (`--provider gemini`)

See [docs/providers.md](providers.md) for Gemini CLI installation and supported models.

**Symptom:** `GEMINI_API_KEY environment variable is not set`
- The `gemini` provider refuses to start without an API key. Export it before launching Chroxy:
  ```bash
  export GEMINI_API_KEY=your-key-here
  npx chroxy start --provider gemini
  ```

**Symptom:** `gemini: command not found` / `ENOENT`
- The Gemini CLI binary is not installed or not on PATH. Chroxy probes `/opt/homebrew/bin/gemini`, `/usr/local/bin/gemini`, and `/usr/bin/gemini`.
- Install via npm: `npm install -g @google/gemini-cli` (or the distribution for your platform), then verify `gemini --version`.

**Symptom:** Model errors or empty responses
- Gemini's default model is `gemini-2.5-pro`. Switch with `--model gemini-2.5-flash` (or any model your API key has access to).
- The Gemini provider does **not** support attachments, plan mode, permission handling, or conversation resume. Sending a message with attachments emits an `error` event rather than being silently ignored. See the [Providers section](feature-matrix.md#providers) in the feature matrix.

## 11. Codex provider errors (`--provider codex`)

See [docs/providers.md](providers.md) for Codex CLI installation and supported models.

**Symptom:** `OPENAI_API_KEY environment variable is not set`
- The `codex` provider refuses to start without an API key. Export it before launching Chroxy:
  ```bash
  export OPENAI_API_KEY=your-key-here
  npx chroxy start --provider codex
  ```

**Symptom:** `codex: command not found` / `ENOENT`
- The Codex CLI binary is not installed or not on PATH. Chroxy probes `/opt/homebrew/bin/codex`, `/usr/local/bin/codex`, and `/usr/bin/codex`.
- Install the OpenAI Codex CLI per the upstream instructions, then verify `codex --version`.

**Symptom:** Model not supported / invocation fails
- Codex's default model is `gpt-5.4`. Switch with `--model <name>` using a model your API key has access to.
- The Codex provider does **not** support attachments, plan mode, permission handling, or conversation resume. Sending a message with attachments emits an `error` event rather than being silently ignored. See the [Providers section](feature-matrix.md#providers) in the feature matrix.

## 12. Expo dev build issues (app development)

**Symptom:** `expo-speech-recognition` or other native modules cause build failures.

**Fixes:**
```bash
cd packages/app

# Clean and rebuild
npx expo prebuild --clean
npx expo run:ios    # or run:android

# If pods fail (iOS)
cd ios && pod install && cd ..
npx expo run:ios
```

**Note:** Expo Go no longer works — a custom dev build is required. See CLAUDE.md for details.
