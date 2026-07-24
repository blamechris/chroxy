/**
 * Opt-in provenance verification for spawned provider binaries (#6858).
 *
 * P1 (#6708, `verify-binary.js`) detects a binary that is missing, not
 * executable, or macOS-Gatekeeper-quarantined. It does NOT protect against a
 * binary being SWAPPED in place, or against running an un-notarized build when
 * the operator wants only notarized ones. Those are the residual supply-chain
 * surfaces that matter once the orchestration harness (#6691) auto-spawns worker
 * sessions headless with the operator's credentials.
 *
 * This module adds two OPT-IN gates, both OFF by default so P1 behaviour is
 * byte-identical unless an operator opts in:
 *
 *   1. **SHA-256 pin ledger (cross-platform).** The binary's content hash is
 *      pinned on first sight (trust-on-first-use). A later change to the pinned
 *      hash re-gates the binary — `warn` surfaces the change and allows the
 *      spawn; `block` refuses the spawn until an operator re-approves. This
 *      catches an in-place binary swap regardless of signature or quarantine
 *      state. The ledger is `binary-provenance-trust.js` — the same path-keyed,
 *      atomic-0600, fail-open `PathHashTrustLedger` that backs skills/preset
 *      trust.
 *   2. **macOS signature gate (opt-in, hard block).** When enabled, a binary
 *      that fails `spctl --assess` (Gatekeeper / notarization) is refused. This
 *      is for operators who run ONLY notarized provider builds — chroxy's own
 *      bundled providers are ad-hoc/linker-signed and `spctl` rejects them, so
 *      this can only ever be opt-in. It is macOS-only: on other platforms the
 *      gate is a documented no-op (skipped) — the pin ledger still applies
 *      cross-platform. Windows Authenticode is a tracked follow-up.
 *
 * FAIL-SAFE: when a gate is ON, a verification failure blocks (`block` mode) or
 * loudly surfaces (`warn` mode) — it never silently spawns an unverified binary.
 * A binary we cannot even hash is treated as unverifiable: blocked in `block`
 * mode, surfaced-but-allowed in `warn` mode.
 *
 * Every filesystem / subprocess touchpoint is an injectable seam so the whole
 * module is unit-testable with no real binary, ledger file, or `spctl`.
 */

import { createHash } from 'crypto'
import { readFileSync as fsReadFileSync } from 'fs'
import { execFileSync } from 'child_process'

/**
 * Classification of a provenance verification.
 * @enum {string}
 */
export const PROVENANCE_STATUS = Object.freeze({
  /** Verified: pinned hash matches (and signature gate, if on, passed). */
  OK: 'ok',
  /** First sight: hash recorded (trust-on-first-use) and allowed. */
  PINNED: 'pinned',
  /** Pinned hash differs from the current binary — an in-place swap. */
  HASH_MISMATCH: 'hash_mismatch',
  /** macOS signature gate on and the binary failed `spctl` assessment. */
  SIGNATURE_INVALID: 'signature_invalid',
  /** The binary could not be read to hash it. */
  UNREADABLE: 'unreadable',
  /** No gate applied (both off, or nothing to check). */
  SKIPPED: 'skipped',
})

// Absolute path to the system `spctl`. Like `verify-binary.js`'s use of the
// absolute `/usr/bin/xattr`, this is deliberately NOT a bare-name PATH lookup: a
// shadowed `spctl` planted earlier on PATH could lie about the assessment and
// defeat the gate. `/usr/sbin/spctl` is a fixed, SIP-protected macOS binary.
export const MACOS_SPCTL = '/usr/sbin/spctl'

/**
 * Compute the SHA-256 hex digest of a file's raw bytes.
 *
 * @param {string} path
 * @param {object} [opts]
 * @param {(p:string)=>Buffer} [opts.readFileSync=fsReadFileSync]
 * @returns {string} 64-char lower-case hex digest
 */
export function sha256File(path, { readFileSync = fsReadFileSync } = {}) {
  const buf = readFileSync(path)
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Assess a binary's code signature / notarization with `spctl --assess`.
 *
 * macOS-only. On any other platform this is a no-op that returns
 * `{ ok: true, skipped: true }` — there is no equivalent Gatekeeper assessment,
 * and the pin ledger carries the cross-platform integrity story on its own.
 *
 * `spctl --assess --type execute` exits 0 for an accepted (notarized / approved)
 * binary and non-zero otherwise; `execFileSync` throws on a non-zero exit, which
 * we treat as "not accepted" (fail-safe — the gate is opt-in and its whole point
 * is to refuse un-notarized builds).
 *
 * @param {string} path - absolute path to the binary
 * @param {object} [opts]
 * @param {string} [opts.platform=process.platform]
 * @param {Function} [opts.execFile=execFileSync]
 * @returns {{ ok: boolean, skipped: boolean, detail?: string }}
 */
export function assessMacSignature(path, { platform = process.platform, execFile = execFileSync } = {}) {
  if (platform !== 'darwin') {
    return { ok: true, skipped: true, detail: 'signature assessment is macOS-only' }
  }
  try {
    const out = execFile(MACOS_SPCTL, ['--assess', '--type', 'execute', '--verbose', path], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    })
    return { ok: true, skipped: false, detail: (typeof out === 'string' ? out.trim() : '') || 'accepted' }
  } catch (err) {
    // Non-zero exit (rejected / error) OR spctl itself unavailable. Both mean
    // "could not confirm this binary is notarized" → not ok. spctl writes its
    // verdict to stderr ("rejected\nsource=Unnotarized Developer ID").
    const stderr = err && typeof err.stderr === 'string' ? err.stderr.trim() : ''
    const detail = stderr || (err && err.message) || 'spctl assessment failed'
    return { ok: false, skipped: false, detail }
  }
}

/**
 * @typedef {Object} ProvenanceVerdict
 * @property {boolean} ok       True when the spawn is allowed (not blocked, no fatal issue).
 * @property {string}  status   One of {@link PROVENANCE_STATUS}.
 * @property {boolean} blocked  True when the spawn MUST be refused.
 * @property {string}  path     The path that was checked.
 * @property {string|null} hash The computed hash (null when not hashed).
 * @property {string} [pinnedHash]  The previously-pinned hash on a mismatch.
 * @property {string} [message]     Human-facing description of a non-OK verdict.
 * @property {string} [remediation] How to resolve a non-OK verdict.
 */

/**
 * Verify a resolved binary's provenance against the opt-in gates.
 *
 * Runs AFTER the P1 `verifyBinary()` existence/quarantine check — the caller
 * only invokes this on an otherwise-healthy, absolute, resolved path.
 *
 * Order: the signature gate runs FIRST (so a signature-rejected binary is never
 * pinned), then the pin ledger.
 *
 * @param {object} opts
 * @param {string} opts.resolvedPath          - absolute path the spawn will exec
 * @param {'off'|'warn'|'block'} [opts.mode='off'] - pin-ledger mode
 * @param {boolean} [opts.signatureGate=false] - macOS spctl gate (hard block when on)
 * @param {{ getRecord:Function, approve:Function }|null} [opts.ledger=null] - pin ledger
 * @param {string} [opts.platform=process.platform]
 * @param {Function} [opts.sha256File=sha256File]         - injectable hasher
 * @param {Function} [opts.assessSignature=assessMacSignature] - injectable signature assessor
 * @returns {ProvenanceVerdict}
 */
export function verifyProvenance({
  resolvedPath,
  mode = 'off',
  signatureGate = false,
  ledger = null,
  platform = process.platform,
  sha256File: hashFn = sha256File,
  assessSignature = assessMacSignature,
} = {}) {
  const path = typeof resolvedPath === 'string' ? resolvedPath : ''
  const pinning = mode === 'warn' || mode === 'block'

  // Nothing to do — behaviour identical to the pre-#6858 spawn path.
  if ((!pinning && !signatureGate) || !path) {
    return { ok: true, status: PROVENANCE_STATUS.SKIPPED, blocked: false, path, hash: null }
  }

  // 1. macOS signature gate — a hard block when enabled. Checked first so a
  //    signature-rejected binary is never pinned into the trust ledger.
  if (signatureGate) {
    const sig = assessSignature(path, { platform })
    if (!sig.skipped && !sig.ok) {
      return {
        ok: false,
        status: PROVENANCE_STATUS.SIGNATURE_INVALID,
        blocked: true,
        path,
        hash: null,
        message: `code signature / notarization check failed (${sig.detail || 'spctl rejected the binary'})`,
        remediation: 'install a notarized build of this provider, or disable the signature gate (binaryProvenance.signatureGate=false / CHROXY_BINARY_SIGNATURE_GATE=0)',
      }
    }
  }

  // 2. SHA-256 pin ledger.
  if (pinning) {
    let hash
    try {
      hash = hashFn(path)
    } catch (err) {
      // Cannot read the binary to hash it → unverifiable. Fail-safe: block in
      // `block` mode, surface-but-allow in `warn` mode.
      const blocked = mode === 'block'
      return {
        ok: !blocked,
        status: PROVENANCE_STATUS.UNREADABLE,
        blocked,
        path,
        hash: null,
        message: `could not read binary to verify its hash (${(err && err.code) || (err && err.message) || 'read failed'})`,
        remediation: 'ensure the binary is readable, or disable provenance pinning (binaryProvenance.mode=off)',
      }
    }

    if (!ledger) {
      // Pinning requested but no ledger wired — treat as skipped rather than
      // guessing. (Production always wires a ledger when mode is on.)
      return { ok: true, status: PROVENANCE_STATUS.SKIPPED, blocked: false, path, hash }
    }

    const record = ledger.getRecord(path)
    if (!record) {
      // First sight — trust-on-first-use: pin the hash and allow.
      ledger.approve(path, hash)
      return { ok: true, status: PROVENANCE_STATUS.PINNED, blocked: false, path, hash }
    }
    if (record.sha256 === hash) {
      return { ok: true, status: PROVENANCE_STATUS.OK, blocked: false, path, hash }
    }

    // Mismatch — the binary changed in place since it was pinned. Do NOT re-pin
    // here: the mismatch must stay visible until an operator explicitly approves
    // (matches the skills/preset trust ledgers).
    const blocked = mode === 'block'
    return {
      ok: !blocked,
      status: PROVENANCE_STATUS.HASH_MISMATCH,
      blocked,
      path,
      hash,
      pinnedHash: record.sha256,
      message: `binary hash changed since it was pinned (pinned ${record.sha256.slice(0, 8)}…, now ${hash.slice(0, 8)}…)`,
      remediation: blocked
        ? `if this change is expected, re-approve it by removing this path's entry from the binary trust ledger and re-spawning; otherwise investigate the unexpected binary swap`
        : 'if this change is unexpected, investigate the binary swap',
    }
  }

  // Signature gate on, pinning off, signature OK → nothing left to check.
  return { ok: true, status: PROVENANCE_STATUS.OK, blocked: false, path, hash: null }
}
