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
- Kill the Claude process → supervisor logs "scheduling respawn" → server restarts within seconds
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

1. Verify the server is running and the tunnel URL is accessible: `curl https://your-tunnel-url`
2. Should return `{"status":"ok"}`
3. If the health check fails, the tunnel may not be routable yet — wait a few seconds and retry

### Supervisor keeps restarting

Check the server logs for crash reasons. The supervisor backs off from 2s to 10s over 10 attempts, then exits. Common causes:

- Claude Code not installed or not authenticated (`claude --version`)
- Permission issues accessing the working directory
- Missing `~/.chroxy/config.json` (run `npx chroxy init`)
