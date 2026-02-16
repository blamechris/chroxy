# Consolidated Investigation Findings

**Date:** 2026-02-15
**Sources:** Security audit swarm (04-*), hosting investigation (05-*), final codebase audit (03-*), cross-branch synthesis

This document consolidates and cross-validates findings from multiple investigation branches. Point-in-time artifacts are preserved as-is; this doc captures what was confirmed, corrected, and actionable.

---

## Confirmed Bugs (Issues Filed)

### 1. "Always Allow" Treated as Deny in SDK Mode — #481

**Location:** `sdk-session.js:430`

`respondToPermission` checks `decision === 'allow'` (strict equality). When the app sends `'allowAlways'`, it falls through to the `else` branch → resolves as `{ behavior: 'deny' }`. Users tap "Always Allow" and Claude silently gets denied.

- CLI mode unaffected (passes decision string through to HTTP hook as-is)
- SDK mode is the only affected path
- Fix: add `else if (decision === 'allowAlways')` with `{ behavior: 'allowAlways' }` — the Agent SDK supports this natively

### 2. Permission Routing via `activeSessionId` Race Condition — #482

**Location:** `ws-server.js:709` (permission_response), `ws-server.js:882` (user_question_response)

Permission and question responses route via `client.activeSessionId` instead of tracking which session originated the request. If the user switches sessions while a permission prompt is pending, the response goes to the wrong session and gets silently dropped. The originating session times out (5 min) → auto-deny.

- Same bug affects `user_question_response`
- Fix: maintain `_permissionSessionMap` (requestId → sessionId) populated on permission_request emit

---

## Severity Corrections

The security audit swarm docs contain several overstated or internally inconsistent findings. Corrections:

| Original Claim | Correction |
|---|---|
| **Path traversal CVSS 9.1/9.8** | Overstated. `_listDirectory` returns non-hidden subdirectory names only. Cannot read file contents. `.ssh` etc. filtered by `!d.name.startsWith('.')`. Actual severity: **MEDIUM** (directory structure disclosure). Acceptable for single-user tool; revisit if multi-user is added. |
| **"Weak" 122-bit token entropy** | Not a real concern. 122 bits is computationally unbrute-forceable. Implementation uses `crypto.timingSafeEqual`, exponential rate limiting, 10s auth timeout, `chmod 600` config, `expo-secure-store` on mobile. Appropriate for threat model. |
| **Aggregate security score 5.9/10** | Internally inconsistent. Three different calculations yield 4.38, 4.33, 5.0 — "5.9" claimed as average without showing math. |
| **Claude CLI memory leak "can grow to 12GB+"** | Actually understated. GitHub issues document 20GB, 93GB, even 129GB. Multiple root causes (orphan processes, indexing regression in 2.1.8+, idle session leaks). Still unresolved upstream as of Feb 2026. |

---

## Competitive Landscape Updates

The hosting investigation (05-*) competitive analysis is largely accurate. Updates as of Feb 2026:

| Competitor | Doc Claim | Current Status |
|---|---|---|
| **Happy Coder** | ~8-10k stars | **~12.1k stars**. Now supports Gemini. HN reliability complaints confirmed. |
| **CCC (Naarang)** | iOS + Android, Bun | Active and thriving. Parallel agents, checkpoints. Most feature-complete direct competitor. |
| **Vibe Companion** | Reverse-engineered WS | **1.9k stars, 76 releases**. Fastest release cadence. Uses `--sdk-url` WebSocket path. |
| **CloudCLI (Siteboon)** | Open-source web UI | **v1.16.4**. GPLv3 (not MIT). Supports Claude + Cursor + Codex. |
| **CCC (kidandcat)** | Go + Telegram | Active. Uses `--dangerously-skip-permissions` — security gap vs Chroxy. |
| **CodeRemote** | $49/month | Pre-launch / waitlist only. Possibly vaporware. |
| **Superconductor** | Multi-agent platform | Active, VC-backed. iOS + Android. Managed service, not self-hosted. |

**Anthropic official mobile Claude Code:**
- iOS app + web sessions at claude.ai/code — research preview since Oct 2025
- Session teleportation (`/teleport`) shipped Jan 2026
- Still iOS-only, no terminal view, GitHub repos only
- Team/Enterprise pricing now supported

**Chroxy's remaining differentiation:** terminal view (xterm.js in native app), Android support, self-hosted/any local project, privacy (code stays on machine), free.

---

## Hosting Pricing Corrections

| Service | Doc Claims | Actual (Feb 2026) |
|---|---|---|
| **Hetzner CX22** | ~$6/mo, US locations | CX22 discontinued → CX23 ~$3.80/mo, **EU-only**. US equivalent (CPX21) ~$8-10/mo. |
| **Contabo VPS 10** | ~$5/mo | **$4.95/mo** ($3.96 annual). Best value for US hosting. |
| **Fly.io** | ~$10/mo | **$11.11/mo** ($6.67 with reservations). |
| **GCP e2-micro** | Free forever | Still free. 1GB RAM borderline-unusable given Claude CLI memory behavior. |

**Recommendation:** For US self-hosting, Contabo VPS 10 ($5/mo, 8GB RAM, 3 US locations) is the clear winner.

---

## Priority for Alpha Launch

Based on consolidated findings:

1. Fix "Always Allow" → deny (#481) — 1-line fix
2. Fix permission session routing (#482) — moderate complexity
3. Operator UX items (permission timeout warning, crash recovery feedback)
4. Ship to TestFlight / Play Store internal testing
