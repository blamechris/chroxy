# Tunneler's Audit: Windows/Linux Platform Support
**Agent**: Tunneler — Cloudflare tunnel & networking specialist
**Overall Rating**: 2.4 / 5
**Date**: 2026-07-14

## 1. The routability-check blocker (headline)

### Root cause
The supervisor verifies a quick tunnel is routable **before forking the server child** (#5314 no-orphan ordering): `supervisor.js:333 await this._waitForTunnel(httpUrl)` runs at boot, then `startChild()` forks the origin at `supervisor.js:377`. So at verification time the origin (`http://localhost:PORT`) is intentionally down.

`waitForTunnel` accepts a response as "routable" only if `res.ok || ROUTABLE_ORIGIN_DOWN_STATUSES.has(res.status)`, where the allowlist is `{502, 530}` (`tunnel-check.js:17, :45`). Anything else counts as failure; after 20 attempts (~108s) it throws `TUNNEL_NOT_ROUTABLE` → `_failBoot()` → `_tunnel.stop()` + `process.exit(1)` (`supervisor.js:168-176, :362-364`). **The entire server never boots — no local, no LAN, no dashboard.**

### Reproduction (empirical, this machine, cloudflared 2026.6.1)
Started `cloudflared tunnel --url http://localhost:59999` against a dead port and probed the minted URL with Node `fetch` (identical to `waitForTunnel`):
- **40 attempts over 120s → HTTP 404 every time**, `server: cloudflare`, valid `CF-Ray`, empty body. Never 502, never 530.
- Then brought a real origin up on :59999 (local curl → 200). The tunnel **still returned 404** for another ~6 minutes; cloudflared's log showed **zero request lines** — the edge answered 404 *without ever forwarding to the connector*. The hostname→tunnel route never propagated.
- Forcing `--protocol http2`: `000` (DNS) for ~13s, then **404** and stuck — same failure over QUIC and HTTP/2.

### Why 404 (not 502/530)

| Edge state | Meaning | Response |
|---|---|---|
| DNS not propagated | hostname doesn't resolve | fetch throws / curl `000` |
| **Edge reachable, no route to connector yet** | DNS resolved to CF, edge has no hostname→tunnel map | **bare 404** (`server: cloudflare`, empty body) — never reaches cloudflared |
| Edge → connector live, origin down | request traverses, origin refuses | **502** |
| Edge → connector live, no tunnel | hostname known, connector gone | **530 / 1033** |

The `{502, 530}` allowlist only recognizes *connector-traversed* states. A **bare edge 404 proves only DNS settled + edge reachable — NOT that the tunnel data-path works.**

### The correct, safe fix — and why "widen the allowlist" is WRONG
The naive "accept any 4xx/5xx = routable" fix is **unsafe, and my data proves it**: this box's genuinely-dead tunnel returned **404 even with a healthy origin**. Widening would make `waitForTunnel` declare a non-functional tunnel "routable," fork the child, and hand the user a QR leading to a permanent phone-side 404 — worse than today's loud failure.

The right fix has two layers:
1. **Decouple server boot from tunnel routability (primary).** A quick-tunnel routability failure should degrade to local/LAN, not kill the daemon. Fork the child, keep cloudflared, let the existing recovery loop (`base.js:199` / `tunnel_recovered` at `supervisor.js:286`) re-verify in the background; advertise the QR only once verification passes. The no-orphan guarantee is orthogonal (process ordering) and still holds — both are supervised and torn down in `shutdown()` (`supervisor.js:889-916`). The desktop *already* does exactly this "fall back to local-only" pattern when cloudflared is missing (`lib.rs:2233`).
2. **If you must classify a status, verify the STRONG property (secondary).** Keep `{502,530}` for the origin-down window; once the child is up, a working tunnel returns the origin's **200** at `/` (`http-routes.js:278-289`), which `res.ok` already handles. Treat a persistent bare-edge 404 as inconclusive → keep waiting → then degrade, never "pass."

### Windows-specific or universal?
**Universal logic; bites the Windows default first-run hardest** (default `chroxy start` uses a quick tunnel; Windows first-run users have no muscle memory for `--tunnel named`).

## 2. Dimension ratings

| Dimension | Rating | Notes |
|---|---|---|
| (a) Default quick-tunnel first-run | **1.5 / 5** | Reproducibly aborts the entire server on a 404; no local fallback. |
| (b) cloudflared install UX on Windows | **2.5 / 5** | Docs have winget, but every *runtime* hint hardcodes `brew`. |
| (c) Child-process / orphan cleanup | **2.0 / 5** | Desktop `child.kill()` orphans the cloudflared grandchild; public URL survives quit. |
| (d) Named tunnel on Windows | **3.5 / 5** | Flow sound — `execFileSync('cloudflared', …)` resolves `.exe`, cloudflared owns `%USERPROFILE%\.cloudflared`. |
| (e) WSL2 tunnel story | **2.0 / 5** | No cloudflared in distro; WSL2 NAT blocks inbound; zero docs. |

## 3. Top 5 findings

**F1 — `waitForTunnel` boot-gate aborts the whole server on a quick-tunnel 404 (headline).** `tunnel-check.js:17,45` + `supervisor.js:333,362-364`. Fix: decouple boot from routability + background re-verify; do **not** add 404 to the success set (proven false-positive).

**F2 — Every runtime "install cloudflared" hint hardcodes Homebrew.** `tunnel/cloudflare.js:46, 63, 150, 179, 244, 270` + desktop `lib.rs:292, 1912, 2230` all emit `brew install cloudflared`. Windows: **`winget install Cloudflare.cloudflared`**. `platform.js` already exports `isWindows/isMac/isLinux` — pick per-platform (mirror `doctor.js:318-320`). `cli/tunnel-cmd.js:20` inherits the wrong hint via `binary.hint`.

**F3 — Windows desktop quit orphans cloudflared; the public URL outlives the app.** `server.rs:1069-1073` (`child.kill()` = TerminateProcess) kills only the direct node child; cloudflared is a grandchild (`cloudflare.js:74`). No signal → supervisor's `shutdown()`→`_tunnel.stop()` (`supervisor.js:911-916`) never runs. `kill_orphan_cloudflared` runs only on **start** (`server.rs:910`). Security: a public, fingerprintable `/health` endpoint stays exposed after "quit." Fix: call `kill_orphan_cloudflared` from `stop()`/`CloseRequested`/`ExitRequested`/`Drop` (`lib.rs:1489-1517`), or a Job Object.

**F4 — doctor gives no quick-tunnel diagnosis and is inconsistent with the boot-gate.** `checkTunnelRoutability` (`doctor.js:238-273`) returns `null` for non-named tunnels and treats **any** HTTP response (incl. 404) as `pass` (`doctor.js:264`). So a user who hits F1 and runs `npx chroxy doctor` learns nothing. Fix: add a quick-tunnel probe + align doctor's definition with the supervisor's.

**F5 — WSL2 has no working tunnel story and no docs.** Confirmed: Ubuntu WSL2 NAT (`172.19.80.0/20`), `cloudflared` absent. `--tunnel none` + localhost only serves the same box via localhostForwarding — the phone can't reach a NAT'd WSL2 service without `netsh portproxy` + firewall. Pragmatic answer: **install cloudflared *inside* WSL2 and run the tunnel from there** (outbound QUIC/HTTPS traverses NAT cleanly). Needs a docs section.

## 4. Overall rating + verdict — 2.4 / 5
Chroxy's headline promise — phone→dev-box over a Cloudflare tunnel — is undermined on its own default path: on this Windows box, `chroxy start` with the default quick tunnel reproducibly refused to boot at all, because the pre-fork routability gate only accepts `{502,530}` while a warming (and here, genuinely non-routing) edge returns a bare **404**. The surrounding engineering is strong (cloudflared invocation resolves on Windows, named-tunnel setup is Windows-safe, the recovery loop is thoughtfully unbounded, the desktop degrades to local-only when the binary is missing), but three platform gaps stack up: the boot-gate bricks first-run instead of degrading, Windows quit orphans a live public tunnel, and the WSL2 path is undocumented and NAT-blocked. The tempting "just widen the allowlist" fix is **wrong** — my origin-up-still-404 evidence shows it would silently hand users a dead QR. The correct fix is architectural: never let quick-tunnel routability gate the daemon's existence.
