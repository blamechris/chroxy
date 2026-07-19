# Spawned-Binary Provenance & Integrity

How Chroxy verifies the external binaries it executes as providers, what that
verification does — and does **not** — protect against, and where the deeper
hardening line sits. Implemented in `packages/server/src/utils/verify-binary.js`,
wired into `utils/preflight.js`, the subprocess spawn path, and `chroxy doctor`
(#6708).

This is distinct from the [credentials-at-rest model](./credentials-at-rest.md)
and the [transport-layer model](./encryption-threat-model.md). Those protect
data. This document is about the **code Chroxy runs**: the daemon execs
`claude`, `codex`, `gemini`, and `cloudflared` as child processes, and until
#6708 it did so with no integrity, provenance, or quarantine check of any kind.

## 1. The gap this closes

Chroxy resolves a provider binary by PATH lookup (`which`/`where`) with a
hardcoded candidate-path fallback (`utils/resolve-binary.js`), then spawns
whatever resolves first. Two concrete failure modes motivated this work:

- **Quarantined-but-present binary.** On macOS a Gatekeeper-quarantined binary
  keeps its execute bit. The old preflight checked only `existsSync` +
  `access(X_OK)`, so it green-lit the binary and the failure surfaced *later* as
  an opaque mid-turn spawn error the operator couldn't diagnose, and
  `chroxy doctor` mislabeled it "Not found — install …".
- **Stale module-load path.** Each provider cached its resolved binary path in a
  module-level `const` frozen at import. A binary quarantined, moved, or removed
  *after* daemon start was still spawned from the stale path — and, because
  preflight re-resolved independently, the existence gate and the actual spawn
  could even resolve *different* paths.

The triggering incident: macOS **XProtect Remediator** removed the OpenAI Codex
native binary out from under a running daemon during a background scan. (That
specific verdict is a probable XProtect false positive; the daemon-executes-
unverified-binaries gap it exposed is real regardless.)

## 2. What Chroxy checks now (P1 — detect & surface)

`verifyBinary(resolvedPath)` classifies a resolved path into one of four states:

| Status | Meaning | Where surfaced |
| --- | --- | --- |
| `ok` | absolute, exists, executable, not Gatekeeper-blocked | proceeds to spawn |
| `not_found` | not absolute (bare-name resolver fallback) or missing on disk | `ProviderBinaryNotFoundError` / doctor `fail` |
| `not_executable` | present but no `X` bit for this process | `ProviderBinaryNotFoundError` / doctor `fail` |
| `quarantined` | macOS: present + executable but carries a **blocking** `com.apple.quarantine` xattr | `ProviderBinaryQuarantinedError` / doctor `fail` |

- **Preflight gate (per session-create).** `runProviderPreflight` re-resolves the
  binary fresh and prefers the provider's live `resolvedBinary` — the exact path
  the spawn will use — so the existence gate and the spawn can no longer diverge.
  A quarantined binary throws `ProviderBinaryQuarantinedError`
  (`code: PROVIDER_BINARY_QUARANTINED`), which `createSession` propagates and the
  WS layer surfaces as a `session_error` with that code (see
  [error-taxonomy.md](../error-taxonomy.md)).
- **Fresh re-resolution (no stale const).** The `resolvedBinary` accessors for
  `codex`, `gemini`, `claude-cli`, and `claude-tui` re-resolve on every access
  instead of returning a frozen import-time `const`, so a binary that changed
  after boot is spawned from its current path.
- **Spawn-time backstop.** If a spawn still fails after preflight passed (the
  binary changed between create and turn), the subprocess catch re-verifies and
  labels the error (quarantine vs vanished) instead of an opaque `ENOENT`.
- **`chroxy doctor`.** The provider-binary and `cloudflared` health checks report
  a quarantined binary distinctly from a missing one, with a copy-pasteable fix:
  `xattr -d com.apple.quarantine <path>` (after verifying provenance) or
  re-download.

### The quarantine flag nuance (no false positives)

The `com.apple.quarantine` xattr value is `flags;timestamp;agent;uuid`. Bit
`0x0040` (`QTN_FLAG_ASSESSMENT_OK`) is set once Gatekeeper has assessed the file
or the user approved it — such a binary launches normally. Chroxy treats a
quarantine xattr as **blocking only when that bit is clear**, so an approved
binary that still carries the xattr is not flagged. Package-manager installs
(Homebrew, `npm -g`) strip the xattr entirely and are never flagged. An
unparseable flags field is treated conservatively as blocking (a labeled,
fixable error beats a silent exec failure).

### Cross-platform behavior

The xattr probe is macOS-only. On Linux and Windows `verifyBinary` performs
exactly the existence + executable check it always did and skips the
mac-specific step cleanly — there is no equivalent Gatekeeper block to detect.

## 3. Threat model — what this does and does NOT protect against

**Protects against (P1):**
- A Gatekeeper-quarantined provider binary being spawned, then failing opaquely.
- A since-moved/removed binary being spawned from a stale cached path.
- An operator being unable to tell "quarantined/blocked" from "not installed".

**Does NOT protect against (out of P1 scope):**
- **Supply-chain compromise / PATH planting.** The daemon still executes whatever
  binary resolves first on `PATH`. A malicious binary planted earlier in `PATH`,
  or a compromised upstream provider release, is spawned automatically. Quarantine
  detection is orthogonal to provenance — a planted binary carries no quarantine
  xattr.
- **Signature / notarization enforcement.** Chroxy deliberately does **not** gate
  on `codesign --verify` / `spctl --assess`. The bundled provider binaries are
  ad-hoc/linker-signed and `spctl` rejects them, so a hard spctl gate would break
  every un-notarized provider. Verifying a signature would only prove the binary
  is *signed*, not that it is the binary the operator intends to run.

## 4. P2 — provenance verification (proposed, not yet implemented)

The residual supply-chain surface grows materially once the orchestration epic
(#6691) auto-spawns worker sessions headless with the operator's credentials —
"the daemon runs whatever is on PATH" stops being a foreground, operator-visible
action. Proposed P2 hardening, to land before write-capable orchestration workers
ship:

- **Opt-in signature gate.** An optional `codesign --verify` / `spctl` assessment
  on macOS for operators who run only notarized provider builds.
- **Cross-platform SHA-256 pin ledger.** Reuse the existing content-trust pattern
  (`path-hash-trust-ledger.js`, already backing `skills-trust.js` and
  `session-preset-trust.js`: a `path → { sha256, firstSeen, approvedAt }` map,
  fail-open, atomic `0600` writes). Pin each provider binary's hash on first
  sight; a changed hash re-gates the binary (warn/block) until an operator
  re-approves — catching an unexpected in-place binary swap regardless of
  signature or quarantine state. Fold `cloudflared` into the same ledger.

## 5. Operator remediation quick reference

When `chroxy doctor` or a session error reports a **quarantined** binary:

1. Confirm the file is what you expect (reinstall from a clean source and compare
   — e.g. `npm i -g @openai/codex@latest`, then `spctl --assess -vv $(which codex)`
   / inspect `codesign`).
2. Only after provenance is confirmed, clear the quarantine:
   `xattr -d com.apple.quarantine <path>` (or allow it in
   System Settings → Privacy & Security).
3. If it was an XProtect false positive, consider reporting it to Apple (Feedback
   Assistant) and the provider's maintainers.

Reading the matched XProtect signature (requires `sudo`) confirms FP vs real:
`sudo log show --last 24h --predicate 'process BEGINSWITH "XProtect"' | grep -i <binary>`.
