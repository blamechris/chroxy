# Troubleshooting Guide

Common issues and solutions for Chroxy server, app, and tunnel connectivity.

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
1. Check server logs for `[ws] Permission request` lines
2. Verify the permission hook is registered: check `~/.claude/settings.json` for `PreToolUse` hook
3. Ensure `CHROXY_PORT` and `CHROXY_TOKEN` are set in the Claude Code session environment

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

**Symptom:** Session disappears after being idle.

**Cause:** Session timeout is configured and the session was idle too long.

**Fixes:**
- Increase timeout: `npx chroxy start --session-timeout 4h`
- Disable timeout: don't set `--session-timeout` or `CHROXY_SESSION_TIMEOUT`
- The app sends keep-alive pings, but only while it's in the foreground

## 10. Expo dev build issues (app development)

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
