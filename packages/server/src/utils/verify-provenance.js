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
 *
 * ## Stat-identity caches (#8030)
 *
 * #8030 re-runs this gate before EVERY spawn of a per-turn provider (the Agent
 * SDK execs a new process per chat turn), not just once at session-create. Both
 * checks are synchronous and would otherwise add real latency to every turn —
 * measured on this machine's 215 MB `claude`: ~100ms to SHA-256 hash, ~430ms
 * for `spctl --assess`. `sha256FileCached` and `assessMacSignatureCached` wrap
 * the two checks in module-level caches that hold one entry per path, valid
 * only while the path's `statIdentity` (path + dev + ino + size + mtimeMs +
 * ctimeMs — see stat-identity.js) is unchanged, so a spawn against an
 * UNCHANGED binary is served from cache instead of re-hashing/re-assessing,
 * and a replaced binary overwrites its old entry instead of adding one:
 *
 *   - The hash cache takes the identity BEFORE and AFTER the read and caches
 *     only when both are non-null and equal — a file that changed mid-read
 *     (a `claude update` racing this exact spawn) must never pin a hash that
 *     doesn't match what's on disk NOW. A hashing error is never cached
 *     either, for the same "don't pin a transient failure" reason
 *     `probeBinaryVersion` already established.
 *   - The signature cache stores a verdict only when it is `ok === true &&
 *     !skipped` — a rejected or skipped assessment is re-run every call so a
 *     binary that starts failing `spctl` (or a gate that just got turned on
 *     for a previously-skipped platform check) is never masked by a stale
 *     pass.
 *
 * These caches are the DEFAULT `sha256File` / `assessSignature` seams passed
 * to `verifyProvenance` below, so every existing test that injects its OWN
 * seam is unaffected — the cache only activates on the real filesystem path.
 */

import { createHash } from 'crypto'
import { readFileSync as fsReadFileSync, statSync as fsStatSync } from 'fs'
import { execFileSync } from 'child_process'
import { statIdentity } from './stat-identity.js'
import {
  classifyResolvedBinary as defaultClassifyResolvedBinary,
  resolveHoistedOptionalDependencyRoots,
  buildPackageTreeManifest as defaultBuildPackageTreeManifest,
} from './binary-package-manifest.js'

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

// path -> { identity, hash }. Module-level so it survives across
// preflight/spawn-gate calls within one daemon process (#8030). Keyed by PATH,
// not by identity, so a path holds at most one entry: each `claude update`
// mints a new identity that replaces the old one instead of leaving a dead
// key behind for the daemon's lifetime.
const hashCache = new Map()
// path -> { identity, verdict, at } for a PASSING, non-skipped signature
// verdict — see assessMacSignatureCached's docblock for why a rejection/skip
// is never stored, and why a stored pass expires. One entry per path, as above.
const signatureCache = new Map()

// A cached signature PASS expires after this long. Unlike a hash, a Gatekeeper
// verdict can change while the file does not: Apple can revoke a notarization
// ticket or a Developer ID, and the stat identity cannot see that. Before
// #8030 the gate re-ran `spctl` at every session create; this bounds how stale
// a pass may get while keeping the per-turn cost at one ~430ms assessment per
// window instead of one per turn.
export const SIGNATURE_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * Cached wrapper around {@link sha256File}: one entry per path, served only
 * while the path's {@link statIdentity} matches the one it was hashed under.
 *
 * Reads the identity BEFORE hashing and again AFTER — the hash is cached only
 * when both reads succeeded (non-null) AND agree, which means the file did
 * not change out from under the read. This is deliberately stricter than
 * `probeBinaryVersion`'s single before-only identity: a version probe just
 * re-execs the binary (a changed file gets a fresh, correct probe next time
 * regardless), but a hash cached against the WRONG bytes would pin a false
 * "verified" verdict for every subsequent spawn until something else changed
 * the file again.
 *
 * A thrown hash error (unreadable file) is never cached — propagated as-is,
 * exactly like the uncached `sha256File`, so `verifyProvenance`'s existing
 * UNREADABLE handling is unaffected.
 *
 * Not cached on Windows: there `ctimeMs` is NTFS ChangeTime, which the file's
 * owner can set (SetFileInformationByHandle), so a same-size in-place swap
 * that restores every timestamp would keep its old identity. Every Windows
 * call hashes, as every session create did before #8030.
 *
 * @param {string} path
 * @param {object} [seams]
 * @param {(p:string)=>import('fs').Stats} [seams.statSync=fs.statSync]
 * @param {(p:string)=>Buffer} [seams.readFileSync=fs.readFileSync]
 * @param {string} [seams.platform=process.platform]
 * @returns {string} 64-char lower-case hex digest
 */
export function sha256FileCached(path, { statSync = fsStatSync, readFileSync = fsReadFileSync, platform = process.platform } = {}) {
  if (platform === 'win32') return sha256File(path, { readFileSync })
  const before = statIdentity(path, statSync)
  const cached = hashCache.get(path)
  if (before && cached && cached.identity === before) {
    return cached.hash
  }

  // Let a hash failure propagate uncaught — never cached (see docblock).
  const hash = sha256File(path, { readFileSync })

  const after = statIdentity(path, statSync)
  if (before && after && before === after) {
    hashCache.set(path, { identity: before, hash })
  }
  return hash
}

/**
 * Cached wrapper around {@link assessMacSignature}: one entry per path, served
 * only while the path's {@link statIdentity} matches and the TTL holds.
 *
 * Only caches an `{ ok: true, skipped: false }` verdict — a genuine Gatekeeper
 * PASS. A rejected verdict (`ok: false`) is re-assessed on every call so a
 * binary that starts failing `spctl` is never masked by a stale pass, and a
 * `skipped` verdict (non-macOS, or the gate resolved to a no-op) is likewise
 * never cached since it carries no real assessment to reuse.
 *
 * A cached pass also expires after {@link SIGNATURE_CACHE_TTL_MS}: a
 * revocation (notarization ticket or Developer ID) changes the verdict without
 * changing the file, so the stat identity alone would keep serving a stale
 * pass for the daemon's lifetime.
 *
 * @param {string} path
 * @param {object} [opts] - forwarded to {@link assessMacSignature} (`platform`,
 *   `execFile`), plus the cache's own `statSync` and `now` seams.
 * @param {(p:string)=>import('fs').Stats} [opts.statSync=fs.statSync]
 * @param {() => number} [opts.now=Date.now]
 * @returns {{ ok: boolean, skipped: boolean, detail?: string }}
 */
export function assessMacSignatureCached(path, { statSync = fsStatSync, now = Date.now, ...rest } = {}) {
  const identity = statIdentity(path, statSync)
  const cached = signatureCache.get(path)
  if (identity && cached && cached.identity === identity) {
    if (now() - cached.at < SIGNATURE_CACHE_TTL_MS) return cached.verdict
    signatureCache.delete(path)
  }

  const verdict = assessMacSignature(path, rest)
  if (identity && verdict && verdict.ok === true && !verdict.skipped) {
    signatureCache.set(path, { identity, verdict, at: now() })
  }
  return verdict
}

/**
 * Test-only hook: clear both module-level provenance caches (hash + macOS
 * signature) so suites don't leak identities across test files that reuse the
 * same tmp paths. Mirrors `binary-version.js`'s `_resetProbeCacheForTest`.
 */
export function _resetProvenanceCacheForTest() {
  hashCache.clear()
  signatureCache.clear()
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
 * @param {{ getRecord:Function, approve:Function, reload?:Function }|null} [opts.ledger=null] - pin ledger.
 *   `reload` is optional (#8073) — a `getRecord()` miss is refreshed from
 *   disk first when the ledger has one; a fake without it decides from
 *   whatever `getRecord` already returns, unchanged.
 * @param {string} [opts.platform=process.platform]
 * @param {Function} [opts.sha256File=sha256FileCached]         - injectable hasher
 * @param {Function} [opts.assessSignature=assessMacSignatureCached] - injectable signature assessor
 * @param {Function} [opts.classifyBinary=classifyResolvedBinary] - injectable launcher/native
 *   classifier (#8040). Defaults to the real classifier so every production
 *   caller gets package-tree coverage with no per-caller wiring — see
 *   `binary-package-manifest.js`. A test that wants the pre-#8040 single-file
 *   behaviour injects `() => ({ kind: 'native' })` (never touches real fs).
 * @param {Function} [opts.buildManifest=buildPackageTreeManifest] - injectable
 *   manifest builder (#8040), only called when `classifyBinary` reports a launcher.
 * @param {{ maxFiles?: number, maxBytes?: number }} [opts.manifestLimits] - cap
 *   overrides forwarded to `buildManifest` (tests only — production uses the
 *   module's generous defaults).
 * @returns {ProvenanceVerdict}
 */
export function verifyProvenance({
  resolvedPath,
  mode = 'off',
  signatureGate = false,
  ledger = null,
  platform = process.platform,
  // #8030: default to the stat-identity-CACHED hasher/assessor, not the raw
  // ones — a per-turn re-verification gate calling the uncached versions
  // would add ~0.1-0.5s of blocking work to every turn. Every existing test
  // that injects its own `sha256File`/`assessSignature` seam is unaffected;
  // this only changes what runs when nothing is injected (production).
  sha256File: hashFn = sha256FileCached,
  assessSignature = assessMacSignatureCached,
  // #8040: real launcher/native classifier + manifest builder by DEFAULT, so
  // every one of this function's callers (preflight.js, doctor.js's two
  // call sites, the tunnel adapter's cloudflared gate) gets package-tree
  // coverage automatically through this ONE code path — none of them need
  // to change. Tests that want the pre-#8040 single-file behaviour (every
  // test in verify-provenance.test.js written before this) inject
  // `classifyBinary: () => ({ kind: 'native' })`, exactly like they already
  // inject their own `sha256File`/`assessSignature` seam to avoid touching
  // the real filesystem.
  classifyBinary = defaultClassifyResolvedBinary,
  buildManifest = defaultBuildPackageTreeManifest,
  manifestLimits = {},
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
    // #8040: hash the entry file itself first — cheap even for a launcher
    // (codex's `bin/codex.js` is ~8.7 KB, gemini's `bundle/gemini.js` ~5 KB),
    // and needed either way: it IS the hash for a native resolution, and it
    // is the comparison point for migrating a legacy single-file pin below.
    let entryHash
    try {
      entryHash = hashFn(path, { platform })
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

    // #8040: resolve known launchers (an npm-installed codex's bin/codex.js,
    // gemini's bundle/gemini.js) to a manifest of their WHOLE installed
    // package — the entry, every sibling file (nested node_modules included),
    // and any hoisted optionalDependencies package — instead of hashing only
    // the entry file. A native (non-script) resolution, or a script with no
    // enclosing package root, is unaffected: `kind` stays 'file' and `hash`
    // stays the plain entry-file hash computed above.
    const classification = classifyBinary(path)
    const isLauncher = !!(classification && classification.kind === 'launcher')

    // Builds the package-tree manifest and returns either its digest or an
    // UNREADABLE verdict (never both) — shared by the migration-upgrade path
    // below and the ordinary path further down, so there is exactly one place
    // that calls `buildManifest` with these options. Only ever invoked when
    // `isLauncher` is true, so `classification.entryPath`/`packageRoot` are
    // always defined here.
    const computeTreeHash = () => {
      const extraRoots = resolveHoistedOptionalDependencyRoots({
        packageRoot: classification.packageRoot,
        packageJson: classification.packageJson,
        // #8093 review C1: the RESOLVED entry path, not the caller's
        // (possibly unresolved) `path` — a bin symlink outside any
        // node_modules (bun global, yarn-classic global) makes
        // `createRequire(path)` search from the symlink's own directory,
        // which misses a hoisted platform package Node itself would find
        // from the launcher's REAL location at runtime. `classifyBinary`
        // always realpaths before returning a `launcher` classification, so
        // `classification.entryPath` is exactly that real location.
        entryPath: classification.entryPath,
      })
      const manifest = buildManifest({
        packageRoot: classification.packageRoot,
        // #8093 review C4: bind WHICH file is the entry into the digest —
        // see buildPackageTreeManifest's own docblock for why.
        entryPath: classification.entryPath,
        extraRoots,
        hashFile: hashFn,
        platform,
        maxFiles: manifestLimits.maxFiles,
        maxBytes: manifestLimits.maxBytes,
      })
      if (manifest.capped || manifest.unreadable) {
        // Same fail-closed-in-block-mode treatment as an unreadable single
        // file — a cap breach or an unwalkable tree must never be silently
        // treated as "nothing to check".
        const blocked = mode === 'block'
        return {
          verdict: {
            ok: !blocked,
            status: PROVENANCE_STATUS.UNREADABLE,
            blocked,
            path,
            hash: null,
            message: `could not verify the installed package tree (${manifest.error})`,
            remediation: 'ensure the installed package is readable and within size limits, or disable provenance pinning (binaryProvenance.mode=off)',
          },
        }
      }
      return { hash: manifest.digest }
    }

    // Fetch any existing record + refresh-on-miss (#8073) — shared by the
    // legacy-migration fast path below and the ordinary flow further down,
    // so there is exactly one fetch (plus its own reload-on-miss) per call.
    let record = ledger ? ledger.getRecord(path) : null
    if (ledger && !record && typeof ledger.reload === 'function') {
      // #8073: a miss in THIS ledger's in-memory snapshot is not the same
      // thing as "nobody has ever pinned this path" — a different process or
      // instance (the daemon vs. a standalone `chroxy resume`) can have
      // pinned it after this ledger was constructed or last flushed, and
      // that pin would otherwise stay invisible until this ledger's own
      // next flush happened to run, letting a swapped binary's first exec
      // through in the meantime. Refresh from disk before deciding this is
      // first sight — a real ledger always has `reload()` (the base class,
      // #8073); an injected fake without one (most of this file's own
      // tests) is left exactly as it was, deciding from whatever
      // `getRecord` already returned.
      ledger.reload()
      record = ledger.getRecord(path)
    }

    // #8093 review S1/C2: a launcher path with a LEGACY (non-tree) record is
    // decided against the ENTRY hash BEFORE the tree is ever walked — the
    // exact pre-#8040 comparison, so a legacy mismatch never pays for a
    // manifest build. Refresh from disk once more right before deciding:
    // this decision either upgrades the record (a WRITE) or leaves it alone,
    // and a stale in-memory legacy record could otherwise "migrate" over a
    // genuine tree pin a DIFFERENT process already wrote for this same path
    // — the explicit `approve()` write below always wins the #8068 merge,
    // so deciding from a stale snapshot would silently replace someone
    // else's real digest with our own (possibly computed against an
    // ALREADY-TAMPERED tree) and report `ok` in block mode. This mirrors the
    // first-sight branch's own refresh-on-miss above, just triggered by "is
    // this a migration" instead of "is there any record at all".
    if (isLauncher && record && record.kind !== 'tree' && typeof ledger.reload === 'function') {
      ledger.reload()
      record = ledger.getRecord(path) || record
    }

    if (isLauncher && record && record.kind !== 'tree') {
      if (record.sha256 === entryHash) {
        // Same bytes already trusted under the legacy pin: upgrade the
        // record to the tree digest. No weaker than before — everything the
        // legacy pin covered (the launcher file itself) is still covered by
        // the tree digest, which additionally covers what the legacy pin
        // never did. Treated as an explicit decision (not TOFU): the trust
        // being carried forward was already an operator/first-sight grant,
        // just re-expressed in the new representation. NOW builds the
        // manifest — never before this comparison decided it was needed.
        const treeResult = computeTreeHash()
        if (treeResult.verdict) return treeResult.verdict
        const hash = treeResult.hash
        ledger.approve(path, hash, { fields: { kind: 'tree' } })
        // #8093 review C2 (mirrors #8073 S1): the reload() above and this
        // approve()'s own internal re-read/flush are two MORE separate
        // readFileSync calls — a genuine pin from another process can still
        // land in that narrower gap. Re-read and only report OK when our
        // hash is still what the ledger holds; otherwise fall through to
        // the ordinary mismatch handling below using the record that
        // actually won, instead of claiming a verdict the ledger disagrees
        // with.
        const after = ledger.getRecord(path)
        if (!after || after.sha256 === hash) {
          return { ok: true, status: PROVENANCE_STATUS.OK, blocked: false, path, hash }
        }
        record = after
        const blockedRace = mode === 'block'
        return {
          ok: !blockedRace,
          status: PROVENANCE_STATUS.HASH_MISMATCH,
          blocked: blockedRace,
          path,
          hash,
          pinnedHash: record.sha256,
          message: `binary hash changed since it was pinned (pinned ${record.sha256.slice(0, 8)}…, now ${hash.slice(0, 8)}…)`,
          remediation: blockedRace
            ? `if this change is expected, re-approve it by removing this path's entry from the binary trust ledger and re-spawning; otherwise investigate the unexpected binary swap`
            : 'if this change is unexpected, investigate the binary swap',
        }
      }
      // Legacy hash doesn't match the CURRENT launcher file — a mismatch
      // exactly as today (pre-#8040): the launcher file itself changed.
      // NEVER builds the manifest to decide this (#8093 review S1).
      const blocked = mode === 'block'
      return {
        ok: !blocked,
        status: PROVENANCE_STATUS.HASH_MISMATCH,
        blocked,
        path,
        hash: entryHash,
        pinnedHash: record.sha256,
        message: `binary hash changed since it was pinned (pinned ${record.sha256.slice(0, 8)}…, now ${entryHash.slice(0, 8)}…)`,
        remediation: blocked
          ? `if this change is expected, re-approve it by removing this path's entry from the binary trust ledger and re-spawning; otherwise investigate the unexpected binary swap`
          : 'if this change is unexpected, investigate the binary swap',
      }
    }

    // Ordinary flow: a native resolution, a launcher whose existing record is
    // already tree-kind, or first sight (no record at all yet).
    let hash = entryHash
    let kind = 'file'
    if (isLauncher) {
      const treeResult = computeTreeHash()
      if (treeResult.verdict) return treeResult.verdict
      hash = treeResult.hash
      kind = 'tree'
    }

    if (!ledger) {
      // Pinning requested but no ledger wired — treat as skipped rather than
      // guessing. (Production always wires a ledger when mode is on.)
      return { ok: true, status: PROVENANCE_STATUS.SKIPPED, blocked: false, path, hash }
    }

    if (!record) {
      // First sight — trust-on-first-use: pin the hash and allow.
      // #8072 review C3: `firstSight: true` tags this as a TOFU pin, not an
      // operator decision — the daemon's own snapshot can be stale (e.g. it
      // hasn't seen a genuine pin `chroxy resume` just wrote for this same
      // path), so this write must not be allowed to override a pin/decision
      // this instance never saw. See `PathHashTrustLedger.flush()`'s merge.
      ledger.approve(path, hash, { firstSight: true, fields: { kind } })
      // #8073 review S1: the reload() above and this approve()'s own
      // internal re-read/flush are two separate readFileSync calls in one
      // synchronous stack — narrow, but a genuine pin from another process
      // CAN land in between. The ledger's own merge already resolves that
      // correctly (a stale TOFU write yields to a record it never saw — see
      // approve()'s `firstSight` contract), but this function had ALREADY
      // decided PINNED before that resolution could run. Re-read after the
      // write and only report PINNED when our hash is still what the ledger
      // actually holds; otherwise someone else's genuine pin won the race,
      // and this falls through to the ordinary mismatch handling below using
      // THAT record — so block mode correctly refuses the exec instead of
      // reporting an `ok: true` verdict the ledger itself disagrees with.
      record = ledger.getRecord(path)
      if (!record || record.sha256 === hash) {
        return { ok: true, status: PROVENANCE_STATUS.PINNED, blocked: false, path, hash }
      }
      // Falls through with `record` now set to the winning pin.
    } else if (record.sha256 === hash) {
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
