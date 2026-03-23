# v0.6.7 Comprehensive Audit — Master Assessment

**Date:** 2026-03-22
**Version:** 0.6.0 (pre-v0.6.7)
**Scope:** Full codebase — server, desktop, app, protocol, store-core

## Auditor Panel

| Agent | Rating | Findings | Top Finding |
|-------|--------|----------|-------------|
| Skeptic | 3.0/5 | 11 | Desktop tray kills unrelated processes on same port |
| Builder | 3.5/5 | 11 | Stale connection info after unclean shutdown |
| Guardian | 2.8/5 | 11 | Token rotation broadcasts plaintext to unencrypted clients |
| Minimalist | 3.2/5 | 10 | 4,525 lines of duplicated message handler code |
| Operator | 3.0/5 | 11 | Session close with no confirmation dialog |
| Adversary | 3.0/5 | 10 | Auth token leaked via URL Referer header |
| Tester | 2.8/5 | 11 | Dashboard message handler (2254 lines) has zero tests |
| Futurist | 3.0/5 | 10 | 98-member god interface ConnectionState |

**Aggregate Score: 3.0/5**

## Consensus Findings

Findings where 2+ agents independently flagged the same issue:

### 1. Nonce Counter Overflow (Guardian, Skeptic, Tester)
The encryption nonce counter is a plain JavaScript number with no overflow protection. Past `Number.MAX_SAFE_INTEGER` (2^53 - 1), nonce values repeat, enabling nonce reuse attacks against the XChaCha20-Poly1305 stream.

### 2. Token Broadcast in Plaintext (Guardian, Skeptic, Adversary)
The `token_rotated` server message sends the raw API token to all connected clients, including those on unencrypted WebSocket connections. An eavesdropper on a non-E2E-encrypted link captures the new token.

### 3. Message Handler Duplication (Minimalist, Futurist)
The app (`useMessageHandler.ts`, ~2,271 lines) and dashboard (`message-handler.ts`, ~2,254 lines) implement nearly identical message parsing, delta accumulation, and state management logic. Combined 4,525 lines of duplicated code that must be kept in sync manually.

### 4. Dashboard Message Handler Untested (Tester, Guardian)
`packages/desktop/src/dashboard/message-handler.ts` at 2,254 lines has zero dedicated test coverage. This is the core data pipeline for the desktop dashboard.

### 5. Hook Secret Timing Attack (Guardian, Adversary)
`Set.has()` used for hook secret validation is not constant-time. An attacker can measure response timing to brute-force the secret byte-by-byte.

## Severity Distribution

| Severity | Count |
|----------|-------|
| High | 7 |
| Medium | 18 |
| Low | 3 |
| Large (refactor) | 2 |

## Themes

- **Security hardening needed:** Encryption nonce handling, token transmission, auth token exposure, input sanitization
- **Test coverage gaps:** Core message handling pipeline, crypto module, checkpoint/conversation handlers
- **Code duplication:** App and dashboard share significant logic that should live in `store-core`
- **UX gaps:** Missing confirmation dialogs, dead-end states, no-op buttons
- **Dead code:** Legacy PTY/tmux config, unused protocol constants
