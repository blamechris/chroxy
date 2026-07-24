# Spawned-Binary Provenance & Integrity

How Chroxy verifies the external binaries it executes as providers, what that
verification does — and does **not** — protect against, and where the deeper
hardening line sits. P1 (detect & surface, #6708) is implemented in
`packages/server/src/utils/verify-binary.js`, wired into `utils/preflight.js`, the
subprocess spawn path, and `chroxy doctor`. P2 (opt-in provenance: a SHA-256 pin
ledger + a macOS signature gate, #6858) is in `utils/verify-provenance.js` +
`binary-provenance-trust.js`, wired into the same preflight and the `cloudflared`
spawn — see §4.

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

**Does NOT protect against in P1 (addressed by the opt-in P2 gate, §4):**
- **Supply-chain compromise / PATH planting.** With P1 alone the daemon still
  executes whatever binary resolves first on `PATH`. A malicious binary planted
  earlier in `PATH`, or an in-place swap of a resolved binary, is spawned
  automatically. Quarantine detection is orthogonal to provenance — a planted
  binary carries no quarantine xattr. The **opt-in SHA-256 pin ledger** (§4) closes
  the in-place-swap case: a changed hash on a previously-seen path re-gates the
  binary. (A brand-new path planted earlier on `PATH` is pinned on first sight
  under trust-on-first-use, so the ledger catches *changes*, not a first-run
  plant — pair it with a controlled `PATH` for defence in depth.)
- **Signature / notarization enforcement.** P1 deliberately does **not** gate on
  `codesign --verify` / `spctl --assess`, because chroxy's bundled provider
  binaries are ad-hoc/linker-signed and `spctl` rejects them, so a hard spctl gate
  would break every un-notarized provider. §4 adds this as an **opt-in** gate for
  operators who run only notarized provider builds.

## 4. P2 — opt-in provenance verification (implemented, #6858)

The residual supply-chain surface grows materially once the orchestration epic
(#6691) auto-spawns worker sessions headless with the operator's credentials —
"the daemon runs whatever is on PATH" stops being a foreground, operator-visible
action. P2 adds two **opt-in, OFF-by-default** gates, so P1 behaviour is
byte-identical unless an operator explicitly turns one on. Implemented in
`utils/verify-provenance.js` + `binary-provenance-trust.js`, wired into
`utils/preflight.js` (provider spawn) and `tunnel/cloudflare.js` (cloudflared
spawn).

### Cross-platform SHA-256 pin ledger

`binary-provenance-trust.js` (`BinaryProvenanceLedger`) is a thin subclass of the
same `PathHashTrustLedger` that backs `skills-trust.js` / `session-preset-trust.js`
— a `path → { sha256, firstSeen, approvedAt }` map, fail-open on a corrupt/missing
file, atomic `0600` writes. Default file: `~/.chroxy/binary-trust.json` (next to
the other trust ledgers), under a `binaries` wrapper key.

- **First sight → pin + allow** (trust-on-first-use).
- **Matching hash → allow.**
- **Changed hash → re-gate.** `warn` mode logs the change and still spawns;
  `block` mode **refuses the spawn** until the operator re-approves. This catches
  an in-place binary swap regardless of code signature or quarantine state, and
  works on every platform (it is pure content hashing).

This is folded across **every spawned binary** — the provider binaries (`claude`,
`codex`, `gemini`) via preflight, and `cloudflared` via the tunnel gate — sharing
one ledger instance so pins are unified.

### macOS signature gate

When enabled, a binary that fails `spctl --assess --type execute` (Gatekeeper /
notarization) is **hard-blocked** before spawn. This is for operators who run only
notarized provider builds; chroxy's own bundled providers are ad-hoc/linker-signed
and `spctl` rejects them, which is exactly why it can only ever be opt-in. `spctl`
is invoked by its absolute SIP-protected path (`/usr/sbin/spctl`), never a PATH
lookup, so a shadowed `spctl` can't subvert the gate (same hardening as the P1
`/usr/bin/xattr` probe). The gate is **macOS-only**: `assessMacSignature()` checks
`process.platform` and returns `{ ok: true, skipped: true }` immediately on any
other platform, performing no check at all — there is no Linux or Windows
equivalent wired up yet, regardless of the `signatureGate` config value. On those
platforms `binaryProvenance` is **hash-pin-only**: the SHA-256 ledger is the entire
provenance story, with no code-signature / notarization backstop. Windows
Authenticode signature gating is tracked in #6932.

### Fail-safe semantics

When a gate is ON, a verification failure blocks (`block` mode / signature gate) or
loudly surfaces (`warn` mode) — it **never silently spawns an unverified binary**.
A binary that can't even be hashed is treated as unverifiable: blocked in `block`
mode, surfaced-but-allowed in `warn` mode. A `block`-mode failure throws
`ProviderBinaryProvenanceError` (`code: PROVIDER_BINARY_PROVENANCE`) from preflight,
or `TunnelBinaryProvenanceError` (`code: TUNNEL_BINARY_PROVENANCE`) from the tunnel.

### Known limitations (accepted, not defects)

Two properties of this design are inherent to how it's built, not gaps left to
close. They're named here so they're legible to a reviewer rather than discovered
by one.

- **check→exec is not atomic (TOCTOU).** `verifyProvenance()` hashes the bytes at
  a resolved *path* (`sha256File`); the spawn that follows execs that same path a
  moment later. Those are two separate filesystem operations with an
  application-visible gap between them — Node has no `fexecve` (no way to hash an
  already-open file descriptor and then exec that exact descriptor), so there is
  no way to make "the bytes I hashed" and "the bytes that run" the same syscall.
  An attacker who can write to the resolved binary path in that window can swap in
  a different binary than the one verified. #6937 closed the *wider* version of
  this gap for `cloudflared` — `_verifyCloudflaredProvenance()` now pins the exact
  absolute path it verified (`this._resolvedCloudflaredPath` in
  `tunnel/cloudflare.js`) and `_spawnCloudflared()` execs that pinned path instead
  of re-resolving the bare `cloudflared` name off `PATH`, matching the provider
  preflight path's existing `resolvedBinary` invariant (verify-path ==
  spawn-path). That removes the *independent-double-resolution* race (verify one
  path, spawn a different one) but does not — cannot — remove the fundamental
  check-then-exec race on a single path. This is the same limitation class as the
  protected-path floor's check-time-realpath TOCTOU (#6922). The gate still raises
  the bar materially: instead of a one-time silent plant, an attacker now has to
  win a race against a live spawn. It is not, and cannot be with these OS
  primitives, an atomic guarantee — accepted and documented rather than treated as
  an open defect.
- **The trust ledger is TOFU, and the ledger file itself is the trust root.** A
  path's *first* sight pins its hash automatically (`ledger.approve(path, hash)`
  inside `verifyProvenance`) with no operator gate on that initial pin —
  trust-on-first-use, not trust-on-verification. An operator who wants a stronger
  baseline than "whatever was there the first time this ran" can pre-seed
  `~/.chroxy/binary-trust.json` out of band *before* first spawn — either
  hand-editing the `binaries` map with hashes computed on a known-good host/build,
  or calling `BinaryProvenanceLedger.approve(path, hash)` programmatically — so the
  first real spawn is checked against a hash the operator chose, not one the gate
  observed at an arbitrary first run. Because the ledger IS the trust root, its
  `0600` permission (`path-hash-trust-ledger.js`'s atomic write) is
  **integrity-relevant, not just confidentiality-relevant**: this file is
  user-writable by design (best-effort persistence, fail-open on a read-only
  `$HOME`), so anyone with write access to it can pin an attacker-chosen hash and
  have the gate wave a malicious binary through as "verified." The ledger is only
  as trustworthy as the account that owns `~/.chroxy` — protecting that account is
  part of this gate's threat model, not an orthogonal concern.

### Configuration

Both gates are OFF by default. Config block (mirrored by env overrides):

```jsonc
{
  "binaryProvenance": {
    "mode": "off",           // "off" (default) | "warn" | "block" — pin ledger
    "signatureGate": false   // macOS spctl gate; hard-blocks un-notarized builds
  }
}
```

- `CHROXY_BINARY_PROVENANCE` = `off` | `warn` | `block` (overrides `mode`)
- `CHROXY_BINARY_SIGNATURE_GATE` = `1` | `0` (overrides `signatureGate`)

Resolved by `resolveBinaryProvenanceMode()` / `isBinarySignatureGateEnabled()` in
`config.js` — both fail-closed (anything but an explicit opt-in value ⇒ off).

**Re-approving a legitimately changed binary** (e.g. after `npm i -g @openai/codex@latest`):
remove that path's entry from `~/.chroxy/binary-trust.json` (or delete the file —
it fails open to empty and re-pins every binary on next spawn). A programmatic
`revoke(path)` / `approve(path, hash)` API exists on the ledger for a future CLI /
dashboard surface.

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
