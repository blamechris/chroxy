# Tunneler Audit: Tunnel & Connectivity Architecture

**Agent**: Tunneler -- networking and Cloudflare tunnel expert
**Overall Rating**: 3.2 / 5
**Date**: 2026-02-09

---

## Executive Summary

The architecture demonstrates strong understanding of the problems (URL instability, session loss, reconnection UX) and proposes generally sound solutions. The `connectionPhase` state machine and supervisor design are well-done. However, the Named Tunnel technical details contain factual errors that would cause implementation failures, Cloudflare Free tier constraints are unaddressed, and local network fallback is underspecified.

---

## Section Ratings

| Section | Rating | Summary |
|---------|:------:|---------|
| Named Tunnel description | 2/5 | `.cfargotunnel.com` is NOT a public URL. Named Tunnel = Custom Domain. |
| Quick vs Named comparison | 2/5 | False distinction. Two rows should be merged. |
| Supervisor owns cloudflared | 4/5 | Architecturally sound. Minor lifecycle gaps. |
| Reconnection state machine | 5/5 | `connectionPhase` enum is correct and complete. |
| Custom close codes | 4/5 | Good. Race condition on SIGTERM (close frame may not send). |
| Device pairing | 4/5 | Correctly identifies hostile `clearSavedConnection` UX. |
| Message queue | 4/5 | Per-type TTL well-thought-out. |
| Local network fallback | 2/5 | IP instability, ATS violations, no failover listener. |
| DNS propagation | 4/5 | Well-handled for Quick. Named needs initial propagation wait. |
| Cloudflare Free tier | 0/5 | Not discussed at all. |

---

## Critical Finding: Named Tunnels Require a Domain

The doc presents Named Tunnels as providing a "Persistent URL like `abc123.cfargotunnel.com`" with 2-minute setup. **This is wrong.**

`.cfargotunnel.com` is an internal CNAME target, not a browsable endpoint. Named Tunnels require:
1. `cloudflared tunnel login` -- selects a CF zone (i.e., a **domain you own on Cloudflare**)
2. `cloudflared tunnel create chroxy`
3. `cloudflared tunnel route dns chroxy subdomain.yourdomain.com` -- DNS CNAME
4. A config.yml with ingress rules
5. `cloudflared tunnel run chroxy`

The "2 minutes" claim is only true if the user already has a domain on Cloudflare. Otherwise, adding a domain takes 15-60 minutes.

The comparison table separating "Named Tunnel" (2 min, no domain) from "Custom Domain" (10+ min) is a false distinction. They are the same thing.

---

## Corrected Comparison Table

| Factor | Quick Tunnel (current) | Named Tunnel + Custom Domain |
|--------|:---:|:---:|
| URL stability | New every restart | Persistent |
| Setup time | 0 | 15-60 min (first time); 0 (subsequent) |
| Account needed | No | Free CF account + domain on CF |
| Reconnect works | Never | Always |
| Idle timeout | 100s (mitigated by ping) | 100s (same) |
| Reliability | No SLA, dev use only | Production-grade |

---

## Cloudflare Free Tier Constraints (Missing from doc)

| Concern | Free Tier Limit | Impact |
|---------|----------------|--------|
| Quick Tunnel SLA | None. Can be terminated any time. | HIGH |
| WS idle timeout | 100 seconds | Medium (30s ping mitigates) |
| WS message size | 16MB per frame | Low |
| Named Tunnel limits | Unlimited concurrent | Low |
| Bandwidth | No published limit | Low |

---

## 502 Behavior During Restart

For HTTP: Accurate, cloudflared returns 502 when origin is down.
For WebSocket: Different -- existing connections get abnormal closure (code 1006), not 502. New upgrade attempts get 502.

**Critical nuance**: Custom close code 4000 requires server to send clean close frame before SIGTERM. Race condition: if SIGTERM kills process before frames flush, clients see 1006 instead of 4000. The `prepare_shutdown` IPC helps but timing must be explicit.

---

## Alternative Tunnel Solutions (Not Discussed)

| Solution | Stable URL | Free | Best For |
|----------|:---------:|:----:|---------|
| Tailscale | Yes | Yes (personal) | Security-conscious users. E2E encrypted. |
| ngrok | Yes (paid) | $8/mo | Stable URLs without owning a domain. |
| bore | No | Yes | Not suitable. |
| WireGuard | Yes | Yes | Too complex for target audience. |

The architecture should have a **pluggable tunnel provider interface** rather than hardcoding Cloudflare assumptions. TunnelManager is already somewhat abstracted.

---

## Local Network Fallback Issues

1. **IP instability**: DHCP leases change. QR-encoded IP goes stale.
2. **WS vs WSS**: Local `ws://192.168.x.x` is unencrypted. iOS ATS blocks by default.
3. **No failover listener**: Phone switching WiFi→cellular has ~3.5s interruption, not "seamless."
4. **Token in plaintext**: Over local unencrypted WS. Acceptable at home, not at coffee shop.

---

## Corrected Named Tunnel Setup Command

```bash
npx chroxy tunnel setup
# Step 1: cloudflared tunnel login       (opens browser, selects CF zone)
# Step 2: cloudflared tunnel create chroxy
# Step 3: User enters subdomain (e.g., "chroxy.mysite.com")
# Step 4: cloudflared tunnel route dns chroxy chroxy.mysite.com
# Step 5: Polls DNS until reachable
# Step 6: Saves to ~/.chroxy/config.json
```
