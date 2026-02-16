# Tunnel Expert's Audit: Chroxy Security Architecture

**Agent**: Tunnel Expert -- Deep expert in Cloudflare tunnels and WebSocket security
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-12

## Verdict

Solid foundation with production-readiness gaps. Architecture leverages Cloudflare well but lacks defense-in-depth. Named Tunnels would be exposed without additional security policies.

## Section Ratings

### 1. Tunnel Configuration: 4/5
**Strengths**: Minimal flags, correct TLS delegation, no custom termination
**Weaknesses**: No validation of hostname format, missing Cloudflare Access policies

### 2. URL Leakage: 2/5 🔴
**Critical Issues**:
- Quick Tunnel URLs logged to stdout (tunnel.js:152-154) - leaked in logs, terminal history
- Auth tokens in QR codes (supervisor.js:169)
- No URL rotation for compromised tunnels

### 3. TLS/Encryption: 5/5 ✅
**Perfect**: Correctly delegates to Cloudflare. No server-side TLS needed (localhost is unencrypted but local-only).

### 4. DDoS Protection: 3/5
**Strengths**: Cloudflare L3/L4 mitigation, auth token required, auth rate limiting
**Weaknesses**:
- No app-layer rate limiting on authenticated endpoints
- `/permission` unbounded
- Health check `/` unauthenticated (availability scanning)

### 5. Tunnel Recovery: 4/5
**Strengths**: Auto-recovery with backoff, Named Tunnels preserve URL, Supervisor keeps tunnel alive
**Weaknesses**:
- Quick Tunnel URL changes on recovery (breaks QR codes)
- No circuit breaker after max attempts
- Recovery events not forwarded to app

### 6. Health Monitoring: 3/5
**Strengths**: `/health` endpoint, supervisor heartbeat, standby during restart
**Weaknesses**:
- Doesn't check tunnel connectivity (only local server)
- No metrics on latency, packet loss
- Split-brain scenario possible (server healthy, tunnel dead)

## Top 5 Findings

### 1. Missing Cloudflare Access Policies (HIGH)
**Issue**: Named Tunnels have no Access integration. Anyone with URL can attempt auth.

**Fix**: Configure Cloudflare Access to require email verification:
```bash
# Dashboard: Access > Applications > Add application
# Policy: Allow, Emails ending in @your-domain.com
```

### 2. Auth Token in QR URL (HIGH)
**Issue**: QR embeds full token (`chroxy://host?token=abc123`). Leaked QR = full access.

**Fix**: Use ephemeral token exchange or TOTP-based pairing codes (expires in 5min).

**supervisor.js:169:**
```javascript
const connectionUrl = `chroxy://${wsUrl}?token=${this._apiToken}` // ⚠️
```

### 3. Quick Tunnel URL Logged Globally (MEDIUM)
**Issue**: URLs logged to stdout, exposed in process logs, docker logs.

**tunnel.js:152-154:**
```javascript
console.log(`  HTTP:      ${this.url}`)  // ⚠️ Full URL leaked
```

**Fix**: Redact in logs (show only first 16 chars), full URL only in supervisor.

### 4. No WebSocket Rate Limiting (MEDIUM)
**Issue**: Authenticated clients can send unlimited messages/sec.

**Fix**: Token-bucket rate limiter (100 msg/min per client, 2 tokens/sec refill).

### 5. Tunnel Health Not Exposed to App (LOW)
**Issue**: `tunnel_recovered` events not sent to WebSocket clients.

**Fix**: Wire events in supervisor.js, forward to ws-server, broadcast as `tunnel_status`.

## Cloudflare Best Practices

### 1. Enable WAF (Web Application Firewall)
**Free Tier:**
- Rate Limiting: 10 req/sec per IP to `/permission`
- IP Access Rules: Block known bot IPs
- Browser Integrity Check

**Pro Tier ($20/mo):**
- Custom WAF rules
- Geographic restrictions
- Advanced DDoS protection

### 2. Use Argo Tunnel (Smart Routing)
- Routes via Cloudflare's private backbone
- 30% faster (especially international)
- $0.10/GB after 1GB free

```bash
cloudflared tunnel run --protocol quic chroxy
```

### 3. Add Cloudflare Access (Zero Trust)
Require device auth before reaching tunnel:
1. Dashboard → Zero Trust → Access → Applications
2. Add `chroxy.example.com`
3. Policy: Allow if email in domain
4. Session: 24 hours

### 4. Enable Tunnel Logs
```yaml
# ~/.cloudflared/config.yml
tunnel: chroxy
loglevel: info
logfile: /var/log/cloudflared.log  # Ship to SIEM
```

### 5. Avoid Quick Tunnels in Production
Quick Tunnels are dev-only:
- ❌ Random URLs leak in logs
- ❌ URL changes on restart
- ❌ No Access integration
- ❌ No analytics/logging

**Production Checklist:**
- [ ] Use Named Tunnel
- [ ] Configure Access policies
- [ ] Enable WAF rules
- [ ] Set up logging
- [ ] Use Argo (optional, $)

## Comparison: Quick vs Named

| Aspect | Quick | Named |
|--------|-------|-------|
| URL Stability | ❌ Changes | ✅ Permanent |
| Setup | ✅ Zero config | ⚠️ Domain needed |
| Access Policies | ❌ Not supported | ✅ Supported |
| WAF Rules | ⚠️ Generic only | ✅ Custom |
| Logging | ❌ No | ✅ Full |
| Argo | ❌ Not available | ✅ Supported |
| **Production Ready** | ❌ Dev only | ✅ With policies |

## Architecture Issues

### 1. No Defense-in-Depth
**Current**: Single layer (auth token)
**Recommended**: Multi-layer:
1. Cloudflare Access (pre-auth)
2. Auth token (current)
3. Per-client rate limiting (missing)
4. Audit log

### 2. Tunnel as Single Point of Failure
**Issue**: If cloudflared dies beyond max retries, unreachable.
**Fix**: Add fallback to Tailscale/ngrok, expose health to external monitoring.

### 3. No Metrics/Observability
**Fix**: Expose `/metrics` endpoint with tunnel latency, byte counts, error rates. Integrate with Grafana/Datadog.

## Production Readiness Gaps

| Gap | Severity | Quick Fix | Long-term Fix |
|-----|----------|-----------|---------------|
| No Access policies | High | Add Access app | Zero Trust |
| Token in QR | High | Redact logs | Ephemeral exchange |
| No rate limiting | Medium | Token-bucket | Cloudflare Workers |
| URL leakage | Medium | Redact logs | Deprecate Quick |
| No tunnel health | Low | Forward events | `/tunnel-status` endpoint |

## Overall Rating: 3.5/5

**Production Ready?**
- Quick Tunnels: ❌ No
- Named Tunnels with mitigations: ✅ Yes

**Critical Path to Production:**
1. Disable Quick Tunnels for prod
2. Add Cloudflare Access for Named Tunnels
3. Implement per-client rate limiting
4. Redact tunnel URLs in logs
5. Add `/tunnel-status` endpoint

**With fixes, rating → 4.5/5**
