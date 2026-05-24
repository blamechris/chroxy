# Decision Record: claude-tui-proxy Spike (Phase 1 / Audit Gate)

**Date**: 2026-05-21
**Triggered by**: `docs/audit-results/clarp-proxy-provider-viability/00-master-assessment.md` (Phase 1 gate)

> **Archive note (2026-05-24):** The two spike scripts referenced below
> (`scripts/spike-claude-tui-proxy.mjs` and `scripts/spike-byok-direct.mjs`)
> were throwaway empirical tools and were never committed to `main` — they
> lived on the now-deleted `spike/claude-tui-proxy` branch alongside this
> doc. Their conclusions are now embodied in the live `claude-byok`
> provider (`packages/server/src/byok-session.js`). Inline script paths in
> the body below describe what was measured at the time; they are not
> reproducible from `main` today.

## Question this spike answered

Before any further design work on the `claude-tui-proxy` provider, the audit demanded validating three coupled assumptions that the entire architecture rests on:

1. Does the `claude` binary (interactive TUI entrypoint specifically — that's what `claude-tui-session.js` spawns) honor `ANTHROPIC_BASE_URL`?
2. Does it actually send plaintext HTTP when the base URL is `http://...` (i.e., the SDK doesn't enforce HTTPS)?
3. Is the response SSE stream interceptable end-to-end, with OAuth subscription auth flowing through to upstream `api.anthropic.com`?

Per the audit (Skeptic, Builder, Minimalist all flagged this independently): without all three, the proposal is moot.

## Result: PASS on all three

Tested against `claude` v2.1.147 with OAuth subscription auth (Keychain item `Claude Code-credentials`) on macOS Darwin 25.5.0.

### Q1 — `ANTHROPIC_BASE_URL` honored

Both entrypoints honor it:

| Invocation | Entrypoint (from User-Agent) | Hit our proxy? |
|---|---|---|
| `claude -p "say hello in exactly one word"` | `claude-cli/2.1.147 (external, sdk-cli)` | YES (2 requests observed) |
| `claude` interactive (via node-pty, send "say hello") | `claude-cli/2.1.147 (external, cli)` | YES (4+ requests observed) |

The `cli` entrypoint is what `claude-tui-session.js` spawns today — confirmed our proxy intercepts its traffic.

### Q2 — Plaintext HTTP works

claude sends unencrypted HTTP to `http://127.0.0.1:<port>`. No TLS, no cert pinning, no HTTPS upgrade. The SDK respects the `http://` scheme in the env var.

### Q3 — SSE stream interceptable, OAuth bearer preserved

Sample request observed during the interactive TUI turn:

```
#3 → POST /v1/messages?beta=true  from 127.0.0.1:<ephemeral>
   Host header: "127.0.0.1:<port>"
   Auth present: true (Authorization: Bearer sk-an...[REDACTED 103 chars])
   User-Agent:   claude-cli/2.1.147 (external, cli)
   anthropic-version: 2023-06-01
   anthropic-beta:    claude-code-20250219, oauth-2025-04-20, context-1m-2025-08-07,
                      interleaved-thinking-2025-05-14, redact-thinking-2026-02-12,
                      thinking-token-count-2026-05-13, context-management-2025-06-27,
                      prompt-caching-scope-2026-01-05, advisor-tool-2026-03-01,
                      effort-2025-11-24, structured-outputs-2025-12-15
   Body (1945B JSON, summary):
     model: "claude-opus-4-7", stream: true, max_tokens: 64000,
     system: <array len=3>, tools: <0 tools>, messages: <1 msgs>

← 200 from upstream (TTFH 249ms)
   content-type: text/event-stream; charset=utf-8
   transfer-encoding: chunked
   anthropic-organization-id: <present>
   request-id: req_011CbGiCujQBYBRbW7mMmLT9
   upstream END: chunks=7, bytes=541, TTFB=2136ms, total=2249ms
```

The bearer is an **OAuth subscription token** (`sk-an...`), not an API key — `x-api-key` was not set. SSE response (`text/event-stream`, chunked transfer) flowed through cleanly. The model rendered "Hello" in the TUI as expected. End-to-end traffic interception works with subscription billing.

## Findings that change the design

### F1 — Multiple API calls per turn, not one

The interactive TUI made **4+ API calls** in response to a single "say hello" prompt. Breakdown:

- **Pre-prompt health check** (`max_tokens: 1`, 1 message). Returns 404 from upstream — this is intentional; it's claude testing the API path. The proxy must tolerate 404 here.
- **Main turn** (`stream: true, max_tokens: 64000, system: <array len=3>, tools: <0 tools>`).
- **Follow-up calls** observed in trailing log (truncated in capture).

Implications:
- The proxy can't assume "one request per turn." It needs request-level isolation and per-request SSE assembly, not session-level.
- The Anthropic SSE format is consistent across these calls (we saw `text/event-stream` with chunked transfer for the streaming ones).
- The health-check returning 404 is normal — the proxy must NOT treat 404 as a session-fatal error.

### F2 — User-Agent entrypoint tag is distinct between `-p` and TUI

- `claude -p ...` → `claude-cli/2.1.147 (external, sdk-cli)`
- Interactive `claude` (TUI) → `claude-cli/2.1.147 (external, cli)`

This **confirms #4046's coupling concern**: the session-file `status` field that #4040's readiness probe reads is written by the `cli` entrypoint (TUI). The `sdk-cli` entrypoint (used by `claude -p`) may not write it. If a future refactor switched `claude-tui-session.js` to spawn via `sdk-cli`-style invocation, the probe would silently degrade (exactly what `claude-tui-session.js:317-340` and the #4046 issue call out).

### F3 — `oauth-2025-04-20` beta is in the header

Every authenticated request carries `oauth-2025-04-20` in the `anthropic-beta` list — this is the explicit OAuth flow Anthropic supports for the subscription. If they ever remove this beta, the OAuth path breaks regardless of any proxy. Worth tracking.

### F4 — Bun runtime is in the loop

The first request observed was a `HEAD /` from `User-Agent: Bun/1.3.14`. That's claude's auto-updater or a separate Bun-based component making a localhost ping. No auth header. Returns 404 from upstream. Cosmetic but worth noting — the proxy must accept HEAD requests gracefully, and we'll see traffic from a Bun runtime, not just from the Node-based SDK client.

### F5 — Cert pinning not present (yet)

The SDK accepted our plaintext HTTP endpoint without any objection. Anthropic could add cert pinning or refuse non-HTTPS `ANTHROPIC_BASE_URL` in a future release — this is the single biggest existential risk to the approach (Skeptic R3, Historian L3). No detection mechanism is in place to alert us if/when this happens; **must add a `chroxy doctor` canary** in any production version.

## Decision

The strategic premise of `claude-tui-proxy` is **technically viable as of `claude` v2.1.147**. All three blocker questions answered YES. The audit's Phase 1 gate is passed.

This does **not** automatically green-light the full provider. The audit explicitly called for Phase 2 re-decision after a passing spike, considering:

1. **Whether the streaming-delta UX win is actually perceptible** on Cloudflare-tunneled mobile (Minimalist + contested point #2). Needs measurement before commit.
2. **BYOK alternative** (Historian L2, Minimalist Alternative D adjacent). Anthropic-sanctioned, no countermeasure exposure, replaces *two* providers (`cli-session.js` + `sdk-session.js`) instead of adding one. Strong claim on chroxy's roadmap regardless of the subscription-proxy decision.
3. **Security hardening cost** (Adversary 1-14, Guardian F1-F5). Spike script intentionally has none of these protections — it's throwaway. Production version requires Unix-socket-per-session (or per-session path-token capability), separate child process, Bearer redaction in logger, Host/Origin rejection, kill-switch env var, anti-detection canary.
4. **Anthropic countermeasure timeline** (Historian L1). Every prior subscription wrapper died in <4 months. The spike confirms what's possible today; it does not insure against tomorrow.

## Phase 2 follow-up spikes — both done

### Streaming-gap measurement (proxy path)

Question (Minimalist's challenge): is the streaming delta benefit actually perceptible on mobile, or does markdown re-rendering swallow it?

Extended `scripts/spike-claude-tui-proxy.mjs` to track time-to-first-`content_block_delta` (with `text_delta`) vs time-to-`message_stop` per request. Two prompts run via `claude -p` through the proxy:

| Prompt | TTFB-to-first-text | message_stop | Streaming gap |
|---|---|---|---|
| `"Write a haiku about TCP"` (short) | 2195ms | 2937ms | **742ms** (~25% of turn time) |
| 4-paragraph CPU pipeline explanation (long) | 1595ms | (turn ended before final event was captured; total 27481ms) | **25886ms** (~94% of turn time) |

The gap is "what streaming closes vs today's chroxy `claude-tui-session.js`, which delivers full text in one burst at Stop-hook arrival."

For short responses the gap is sub-second — barely perceptible. For typical long responses (the multi-paragraph or code-heavy outputs that are the bulk of useful chroxy interactions) the gap is **multi-second to multi-tens-of-seconds** of "user staring at a spinner." Streaming would let the user watch text build incrementally from ~1.5s and continuously update. This is a substantial UX win, contradicting the "may not be perceptible on mobile" hedge. **Minimalist's challenge is answered with data: yes, streaming matters for long responses.**

### Additional finding: gzip

The Anthropic API returns SSE responses **gzipped** (`1f 8b 08 00` magic bytes verified from raw byte dump). The naive `chunk.toString('utf8').split('\n\n')` parser misses every event because the bytes are compressed. Skeptic's R3 callout from the audit was correct — the production proxy must include streaming gzip decompression. ~100 LOC of careful streaming code, fixture tests required.

### BYOK SDK comparison

Wrote `scripts/spike-byok-direct.mjs` — uses `@anthropic-ai/sdk` (`Anthropic.messages.stream`) with a user-supplied API key. No `claude` binary, no PTY, no proxy, no OAuth.

| Metric | Proxy path (subscription) | BYOK SDK (API key) |
|---|---|---|
| Approach | Wrap interactive TUI; intercept its SSE | chroxy is the agent; SDK iterator |
| TTFB (haiku) | 2195ms | **1547ms** (29% faster) |
| TTFB (4-paragraph) | 1595ms | **1213ms** (24% faster) |
| Total turn (haiku) | 2937ms | **2278ms** |
| Total turn (long) | 27481ms | **24146ms** (12% faster) |
| Usage stats | Headers only (we'd parse) | Native (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) |
| Text fidelity | `claude -p` stdout: 943 chars for the long prompt | Full SDK response: **5274 chars** (5.6× more text) |
| Code complexity | Proxy server + gzip + SSE parser + multi-session ports + lifecycle + bearer handling | One file, ~150 LOC for parity with `cli-session.js` |
| OAuth bearer in chroxy memory | YES | NO (user-pasted API key only) |
| Anthropic countermeasure exposure | HIGH (`ANTHROPIC_BASE_URL` is the single env var detection would grep for, per Historian L3) | NONE (sanctioned billing path) |
| Subscription billing | Preserved | Replaced with per-token API billing |
| Replaces | Nothing (additive next to `claude-tui-session.js`) | `cli-session.js` AND `sdk-session.js` (both metered after June 15 anyway) |

The BYOK path is strictly cleaner across every dimension except subscription billing. For users who *insist* on subscription billing, `claude-tui` (today's provider) stays as the conservative path. For users moving to metered billing on June 15 anyway, BYOK is the right answer — sanctioned, faster, cleaner architecture.

## Phase 2 conclusion

The proxy is **technically possible** but is the wrong long-term bet:

1. The streaming-delta UX win is real (per the gap measurement) — but BYOK delivers the same win without any of the proxy's risks.
2. The proxy approach inherits gzip + SSE re-chunking + multi-session ports + OAuth bearer handling + countermeasure exposure + cert-pinning fragility — a substantial production burden, all to keep subscription billing.
3. BYOK collapses two existing providers (`cli-session.js`, `sdk-session.js`) into one cleaner SDK-driven provider, gives native usage/cache stats, has zero countermeasure exposure, and is faster end-to-end.

**Recommended decision: build the BYOK provider first.** It addresses the June 15 metering shift directly (the affected providers are exactly the ones BYOK replaces) and has no lifespan exposure. `claude-tui` (today's PTY-based provider) stays in place as the conservative path for subscription-only users. `claude-tui-proxy` (subscription wrapper) becomes a maybe-later if (a) demand from subscription-only users is loud enough, and (b) we can budget the security hardening from Adversary 1, 3, 5, 8, 9, 11 plus the gzip + SSE parser correctly.

## Artifacts

- `scripts/spike-claude-tui-proxy.mjs` — proxy spike with gzip decompression + streaming-gap timing.
  - `--run "..."` for `claude -p` mode
  - `--tui "..."` for interactive TUI via node-pty
  - Idle (no args): print port, then `ANTHROPIC_BASE_URL=http://127.0.0.1:<port> ANTHROPIC_API_KEY= claude -p "..."` in another shell
  - `SPIKE_RAW_DUMP=/tmp/x` env to dump raw SSE bytes (for debugging gzip / parsing)
- `scripts/spike-byok-direct.mjs` — BYOK spike. `ANTHROPIC_API_KEY=... node scripts/spike-byok-direct.mjs "prompt"`
