# Named Tunnel Setup Guide

Named Tunnels give you a **stable URL** that never changes. Scan the QR code once, connect forever — even if the server restarts.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free)
- A domain on Cloudflare DNS (register one via [Cloudflare Registrar](https://www.cloudflare.com/products/registrar/), ~$10/year for `.dev` or `.xyz`)
- `cloudflared` installed: `brew install cloudflared`

## Quick Setup (Interactive)

```bash
npx chroxy tunnel setup
```

This walks you through:
1. Logging in to Cloudflare
2. Creating a tunnel
3. Setting up a DNS route
4. Saving the configuration

## Manual Setup

If you prefer to set things up manually:

### 1. Authenticate

```bash
cloudflared tunnel login
```

This opens a browser to authorize cloudflared with your Cloudflare account.

### 2. Create a Tunnel

```bash
cloudflared tunnel create chroxy
```

### 3. Route DNS

Point your hostname to the tunnel:

```bash
cloudflared tunnel route dns chroxy chroxy.example.com
```

Replace `chroxy.example.com` with your actual subdomain.

### 4. Configure Chroxy

Edit `~/.chroxy/config.json`:

```json
{
  "apiToken": "your-existing-token",
  "port": 8765,
  "tunnel": "named",
  "tunnelName": "chroxy",
  "tunnelHostname": "chroxy.example.com"
}
```

Or use CLI flags:

```bash
npx chroxy start --tunnel named --tunnel-name chroxy --tunnel-hostname chroxy.example.com
```

Or environment variables:

```bash
CHROXY_TUNNEL=named CHROXY_TUNNEL_NAME=chroxy CHROXY_TUNNEL_HOSTNAME=chroxy.example.com npx chroxy start
```

### 5. Start the Server

```bash
npx chroxy start
```

The QR code and connection URL will always be the same.

## How It Works

- **Quick Tunnel** (default): `cloudflared` creates a temporary tunnel with a random `*.trycloudflare.com` URL. Changes every restart.
- **Named Tunnel**: `cloudflared` connects to a pre-configured tunnel with a DNS CNAME record. The URL is your domain, always the same.

Both modes auto-recover if `cloudflared` crashes. Named tunnels are better because:
- No QR re-scan after server restart
- Enables supervisor mode (Phase 2) for automatic server restart
- Works with saved connections in the app

## Tunnel Modes

| Mode | CLI Flag | URL | Account Needed |
|------|----------|-----|----------------|
| `quick` | `--tunnel quick` (default) | Random `*.trycloudflare.com` | No |
| `named` | `--tunnel named` | Your domain | Yes (free) |
| `none` | `--tunnel none` | `localhost` only | No |

## Troubleshooting

### "cloudflared not found"

```bash
brew install cloudflared
```

### "Tunnel timed out"

Check that your tunnel exists and DNS is configured:

```bash
cloudflared tunnel list
cloudflared tunnel route dns chroxy chroxy.example.com
```

### "Certificate not found"

Run `cloudflared tunnel login` to re-authenticate.

### Checking tunnel status

```bash
cloudflared tunnel info chroxy
```
