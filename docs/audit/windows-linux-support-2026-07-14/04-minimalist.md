# Minimalist's Audit: Windows/Linux Platform Support
**Agent**: Minimalist — ruthless YAGNI engineer, proposes the smallest thing that works
**Overall Rating**: 3.5 / 5   (how well the current state already supports a minimal working Windows setup)
**Date**: 2026-07-14

I ran the actual minimal path on this Windows 11 machine. Almost everything works out of the box; exactly **one** narrow bug blocked the headline command, and the local fallback is fully functional. The cross-platform plumbing is genuinely mature — this is not a port that needs writing, it's a port that needs one fix and a scope cut.

## 1. The minimal working path on Windows — what I verified

Environment (verified): Node **24.18** (satisfies `>=22`), npm 11, **cloudflared 2026.6.1** already on PATH, **WSL2 2.5.10**, claude CLI **2.1.195**.

| Step | Command | Result |
|---|---|---|
| Install deps | `npm install` | **48s, exit 0.** node-pty build scripts were *skipped* by npm's allow-scripts policy, yet node-pty **still works** — win32-x64/win32-arm64 **prebuilds are checked in**, so **no Visual Studio / node-gyp toolchain is needed**. |
| CLI | `node packages/server/src/cli.js --help` | Clean. |
| Doctor | `chroxy doctor` | **"All checks passed. Ready to start."** |
| **Local daemon** | `chroxy start --tunnel none --host 127.0.0.1` | **FULLY WORKS.** Bound `127.0.0.1:8765`; `/health` → `200`; spawned a live claude-tui session with QR + pairing token. |
| **Default remote** | `chroxy start` (quick tunnel) | **FAILED** — the one blocker (below). |

**The 80/20 minimal path this afternoon:** `npm install` → `npx chroxy start --tunnel none` → open the token'd dashboard URL in any Windows browser, and/or reach it over LAN from the phone. Zero Tauri, zero MSI, zero signing. It works today.

### The one real blocker
`chroxy start` with the **default** quick tunnel aborts before the server ever binds. The supervisor verifies tunnel routability **before** forking the server child (intentional "no-orphan" ordering, `tunnel-check.js:7-17`, #5314). To detect "edge reached, origin intentionally down," it accepts **only HTTP 502/530** (`ROUTABLE_ORIGIN_DOWN_STATUSES`, `tunnel-check.js:17`). This machine's fresh `trycloudflare.com` tunnel returned **HTTP 404** on all 20 attempts (108s), so boot aborted. *(Note: the Tunneler agent later showed the naive "just add 404" fix is unsafe — 404 persisted even with a healthy origin. See 07-tunneler.md for the correct architectural fix.)*

## 2. Cut list — parity features to drop/defer for Windows v1
1. **The entire Tauri tray app / MSI / installer.** No `bundle.windows` block exists (`tauri.conf.json:33-49`). **The web dashboard is served by the server and reachable in any browser** — ~90% of the tray's value with zero build. Defer.
2. **Swift speech-helper** (`tauri.conf.json:41`) — macOS-only binary; cut from any Windows bundle.
3. **Auto-updater** (`tauri.conf.json:54-59`) — pointless without a Windows bundle to update. Defer with the tray.
4. **Native Windows service.** `getWindowsAlternatives()` (`service.js:173-191`) already punts to Task Scheduler / NSSM. Don't build a native service — **document one `schtasks` line**.
5. **`bash scripts/before-build.sh`** (`tauri.conf.json:9`) — only matters if you build the tray.
6. **mDNS/LAN auto-discovery polish** — QR/manual-URL already works.

## 3. Keep list
1. **`npm install` + `npx chroxy start`** — verified working; supported install.
2. **node-pty prebuilds** — the reason no toolchain is required. Keep shipping win32-x64 **and win32-arm64**.
3. **The tunnel** — Chroxy's whole reason to exist; **just fix the routability check** so default `chroxy start` doesn't abort.
4. **Dashboard-in-browser** — served token-gated from the built dist (`http-routes.js:1064-1071`).
5. **doctor** — accurate on Windows; first-run smoke check.

## 4. Dimension ratings (1–5)

| Dimension | Rating | Why |
|---|---|---|
| (a) Minimal daemon-in-terminal path | **4.5** | `npm install` (no native build) → CLI → doctor → local server → live claude session all worked. node-pty prebuilds are the hero. |
| (b) Tunnel | **2** | cloudflared establishes fine, but the 502/530-only routability allowlist made the **default** `chroxy start` fail on a 404. Blocked the headline command. |
| (c) Dashboard-in-browser | **4.5** | Server serves it cross-platform, token-gated. Caveat: dev checkout must build the dist. |
| (d) WSL2-as-Linux-host | **4.5** | Trivially correct, **zero Chroxy work**: run the Linux server inside WSL2, reach it from Windows via `localhost`. |
| (e) Necessity of the Tauri tray on Windows | **1.5** | Low. Browser dashboard + a start script covers the real need. |

## 5. Top 5 findings
1. **Windows is ~one fix away from the default command working** (tunnel routability check). Highest-leverage.
2. **No native build toolchain is required.** node-pty ships win32 prebuilds. Removes the biggest feared Windows blocker (VS Build Tools).
3. **The local path already delivers 80% of the value.** `chroxy start --tunnel none --host 127.0.0.1` gave a bound server + live claude-tui session. Ship this as the documented "Windows quick start" today.
4. **"Full parity with the macOS tray" is over-scoped for v1.** Cutting the tray/MSI/signing/updater removes most of the effort with little user-facing loss.
5. **Minor polish gaps (non-blocking):** install hints hardcode `brew install cloudflared` on Windows; no OS keychain integration on Windows (0600 file fallback).

## Overall rating + verdict — 3.5 / 5
The stated goal — *"full parity with the macOS Tauri tray app"* — is **over-built for what makes a user productive on Windows today**. The hard cross-platform work is already done and *works*, the local daemon + browser dashboard + live Claude session run cleanly, and WSL2-as-Linux-host is free. The right Windows v1 scope is: **fix the tunnel check, document `npx chroxy start` + browser dashboard (+ one `schtasks` line for autostart), swap the cloudflared install hint to winget, and explicitly defer the Tauri tray, MSI, signing, updater, and speech-helper.** That ships this afternoon; the tray is a v2 nicety, not a v1 requirement.
