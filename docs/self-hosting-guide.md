# Self-Hosting Guide

Run Chroxy on your own server or dev machine for persistent remote access to Claude Code.

## Requirements

| Dependency | Version | Install |
|---|---|---|
| Node.js | **22.x** | `brew install node@22` or [nvm](https://github.com/nvm-sh/nvm) |
| cloudflared | latest | `brew install cloudflared` |
| git | any | `brew install git` (macOS) / `apt install git` (Linux) |
| Claude Code | latest | `npm install -g @anthropic-ai/claude-code` |

## Quick Start (Quick Tunnel)

No Cloudflare account needed. URL changes every restart.

```bash
# Clone and install
git clone https://github.com/blamechris/chroxy.git
cd chroxy && npm install

# Initialize config (generates API token + default settings)
npx chroxy init

# Start the server (Node 22!)
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start
```

The server prints a QR code. Scan it with the Chroxy app to connect.

## Docker

The root `Dockerfile` builds a self-contained image of the chroxy daemon. It
supports exactly two things (an owner decision, #8151):

- the **headless `claude-sdk` provider** (needs `ANTHROPIC_API_KEY`);
- the **web dashboard**, served at `/dashboard`.

It does **not** support the embedded user-shell terminal or the `claude-tui`
provider. Both need [`node-pty`](https://github.com/microsoft/node-pty), and
this image has no linux prebuild for it — the build deliberately skips native
compilation (`npm ci --ignore-scripts`, no `build-essential`/`python3`) to
keep the image small and avoid a compiler toolchain in a container that runs
as an unprivileged user. `claude-tui` additionally assumes an interactive
login shell, which a container doesn't have.

- The **user-shell terminal** is already off by default on every chroxy
  install (`userShell.enabled` must be explicitly set) — selecting it in this
  image fails the same way it would anywhere else it's disabled: a
  `USER_SHELL_DISABLED` error naming the config key to flip. It is NOT
  recommended to enable it in this image, since node-pty can't load here.
- Selecting **`claude-tui`** (or an operator-enabled user-shell terminal) in
  this image fails at session start with an actionable error rather than a
  crash or a raw native-module stack trace — the real message (server logs /
  the client's error toast) reads:
  > node-pty is unavailable here [PTY_UNAVAILABLE] — use the claude-sdk
  > provider instead. The embedded terminal and the claude-tui provider both
  > require a native PTY binding that failed to load. This is expected
  > inside the official chroxy Docker image, which ships without a native
  > build toolchain (node-pty has no linux prebuild). Outside Docker, run
  > `npm rebuild node-pty` and restart the chroxy daemon — on Linux the
  > rebuild needs python3, make and a C++ compiler.
  > Cause: \<the underlying load error\>

  (the exact wording may drift; the `[PTY_UNAVAILABLE]` marker and the
  leading "use the claude-sdk provider instead" sentence are the stable
  part — see `packages/server/src/utils/node-pty-support.js`.)

```bash
docker build -t chroxy .

docker run -d --name chroxy \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e CHROXY_TUNNEL=none \
  -e CHROXY_CWD=/workspace \
  -p 8765:8765 \
  -v chroxy-data:/home/chroxy/.chroxy \
  -v "$(pwd)":/workspace \
  chroxy start
```

`-e CHROXY_CWD=/workspace` matters: without it, new sessions default to
`$HOME` (`/home/chroxy` in this image), NOT the bind-mounted project
directory — `/workspace` sits outside `$HOME`, and the daemon's own cwd
resolution (`config.cwd || (cwd is under $HOME ? cwd : homedir())`) only
picks it up when told to. Note this only fixes the **Default** session's
starting directory; creating an *additional* session rooted under
`/workspace` from the dashboard/app is a separate gate
(`validateCwdAllowed`'s "home fallback" layer, `handler-utils.js`), which
still requires the cwd to be under `$HOME` unless `config.workspaceRoots`
explicitly allowlists `/workspace` — not yet wired into this image's default
config, and not solved by this PR.

Then open `http://localhost:8765/dashboard?token=<the token from the logs>`
(the entrypoint auto-generates and logs an `API_TOKEN` prefix on first start;
the full token is written to `~/.chroxy/config.json` inside the `chroxy-data`
volume, or pass your own with `-e API_TOKEN=...`).

The image sets `CHROXY_PROVIDER=claude-sdk` by default — without it, the
daemon's own default provider (`claude-tui`, unsupported here — see above)
would apply, and sessions would fail the moment they started. This is an
**image-level `ENV`, not a config-file value** — if you also mount a
`config.json` with its own `"provider"` field, the baked-in `ENV` still wins
(config precedence is CLI flag > env var > config file > default, and the
image's `ENV` is read at the env-var tier). Override it with `-e
CHROXY_PROVIDER=...` or `--provider` if you ever need to (see
[docs/providers.md](providers.md) for the full provider list); every provider
other than `claude-sdk` is untested/unsupported in this image.

## Production Setup (Named Tunnel)

For a stable URL that survives restarts, use a Named Tunnel with supervisor mode.

### 1. Set Up a Named Tunnel

Requires a free Cloudflare account and a domain on Cloudflare DNS.

```bash
npx chroxy tunnel setup
```

This walks you through authentication, tunnel creation, and DNS routing. See [Named Tunnel Guide](named-tunnel-guide.md) for detailed steps.

### 2. Start with Supervisor

Supervisor mode auto-restarts the server if Claude crashes, while keeping the tunnel alive:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start --tunnel named
```

The supervisor is enabled by default in named tunnel mode. To disable it:

```bash
npx chroxy start --tunnel named --no-supervisor
```

### 3. Verify

- Server banner shows your stable hostname
- QR code encodes the same URL every time
- Kill the server process → supervisor logs the restart (`Child ran for <n>s | total restarts: <n> | next backoff: <n>ms`) → server restarts within seconds
- App shows "Server Restarting" banner during recovery, then auto-reconnects

## Process Management

### systemd (Linux)

```ini
[Unit]
Description=Chroxy Server
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/chroxy
# Update this path to your Node 22 installation (nvm, fnm, etc.)
Environment=PATH=/home/youruser/.nvm/versions/node/v22/bin:/usr/local/bin:/usr/bin
ExecStart=node ./node_modules/.bin/chroxy start --tunnel named
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp chroxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chroxy
```

### launchd (macOS)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.chroxy.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/opt/node@22/bin/node</string>
        <string>/path/to/chroxy/node_modules/.bin/chroxy</string>
        <string>start</string>
        <string>--tunnel</string>
        <string>named</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/chroxy</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/chroxy.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/chroxy.err</string>
</dict>
</plist>
```

```bash
cp com.chroxy.server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.chroxy.server.plist
```

## Firewall

Chroxy only needs **outbound port 443** (HTTPS). The Cloudflare tunnel initiates the connection from your server to Cloudflare's edge — no inbound ports required.

| Direction | Port | Protocol | Purpose |
|---|---|---|---|
| Outbound | 443 | HTTPS | Cloudflare tunnel (cloudflared → Cloudflare edge) |
| Loopback | 8765 | HTTP/WS | Server ↔ cloudflared (localhost only) |

No firewall rules or port forwarding needed. The tunnel handles NAT traversal automatically.

## Troubleshooting

### Wrong Node.js version

Chroxy requires Node 22.x. Verify: `node -v` should show `v22.x`.

```bash
# macOS
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start

# nvm
nvm use 22
```

### "cloudflared not found"

```bash
# macOS
brew install cloudflared

# Linux (Debian/Ubuntu) — official signed repository
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared
```

### Server starts but no QR code appears

The tunnel URL must be routable before the QR is shown. This takes a few seconds for DNS propagation. If it times out:

1. Check cloudflared logs for errors
2. Verify tunnel exists: `cloudflared tunnel list`
3. Try `--tunnel quick` to rule out named tunnel config issues

### App can't connect

1. Verify the server is running and the tunnel URL is accessible: `curl https://your-tunnel-url/health`
2. Should return JSON containing `"status":"ok"` (also includes `mode` and `version`). Use the `/health` path explicitly — a plain `curl` of `/` returns the same JSON, but a browser-style `Accept: text/html` request to `/` redirects to `/dashboard`.
3. If the health check fails, the tunnel may not be routable yet — wait a few seconds and retry

### Supervisor keeps restarting

Check the server logs for crash reasons. The supervisor backs off from 2s to 10s over 10 attempts, then exits. Common causes:

- Claude Code not installed or not authenticated (`claude --version`)
- Permission issues accessing the working directory
- Missing `~/.chroxy/config.json` (run `chroxy init`)
