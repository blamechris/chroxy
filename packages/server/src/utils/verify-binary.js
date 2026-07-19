/**
 * Pre-spawn binary integrity + quarantine verification (#6708).
 *
 * Chroxy execs external provider binaries (`claude`, `codex`, `gemini`,
 * `cloudflared`) resolved off PATH. Before this module the only gate was
 * "exists + X-bit" (see the old `isExecutableFile` in preflight.js), which
 * green-lights a binary that macOS Gatekeeper will refuse to launch: a
 * quarantined binary keeps its execute bit and only fails at `exec()`, so the
 * failure surfaced later as a confusing mid-turn error instead of a clean,
 * actionable preflight rejection.
 *
 * `verifyBinary()` classifies a resolved path into one of {@link BINARY_STATUS}
 * and (on macOS) detects a **blocking `com.apple.quarantine` xattr** so the
 * caller can distinguish "quarantined/blocked by Gatekeeper" from "not
 * installed". The mac-specific probe is cleanly skipped on Linux/Windows —
 * there the check is exactly the existence + executable check it always was.
 *
 * ## Why the assessment-OK flag matters (no false positives)
 *
 * The `com.apple.quarantine` xattr value is `flags;timestamp;agent;uuid`. The
 * low bits of the first (hex) field encode quarantine state; bit `0x0040`
 * (`QTN_FLAG_ASSESSMENT_OK`) is set once Gatekeeper has assessed the file OK or
 * the user has approved it — such a binary launches normally and MUST NOT be
 * flagged. We therefore treat a quarantine xattr as *blocking* only when that
 * bit is CLEAR. An unparseable flags field is treated conservatively as
 * blocking (surfaced as a labeled, fixable error rather than a silent exec
 * failure). Homebrew / package-manager installs strip the xattr entirely and
 * so are never flagged.
 *
 * Signature / notarization gating (`codesign`/`spctl`) is deliberately NOT done
 * here: chroxy's bundled provider binaries are ad-hoc/linker-signed and
 * `spctl --assess` rejects them, so a hard spctl gate would break every
 * un-notarized provider. That is P2 (opt-in) territory — see
 * docs/security/spawned-binary-provenance.md.
 *
 * Every filesystem / subprocess touchpoint is an injectable seam so the whole
 * module is unit-testable over a mocked fs/xattr layer with no real quarantined
 * binary required.
 */

import { existsSync as fsExistsSync, accessSync as fsAccessSync, constants as fsConstants } from 'fs'
import { isAbsolute as pathIsAbsolute } from 'path'
import { execFileSync } from 'child_process'

/**
 * Classification of a resolved binary path.
 * @enum {string}
 */
export const BINARY_STATUS = Object.freeze({
  /** Absolute path, exists, executable, and not blocked by Gatekeeper. */
  OK: 'ok',
  /** Path is not absolute, or does not exist on disk. */
  NOT_FOUND: 'not_found',
  /** Exists but the current process cannot execute it (no X bit / EACCES). */
  NOT_EXECUTABLE: 'not_executable',
  /** macOS: present + executable but carries a blocking com.apple.quarantine xattr. */
  QUARANTINED: 'quarantined',
})

// macOS quarantine flag: Gatekeeper assessment passed / user approved. When set,
// the binary launches normally, so a quarantine xattr with this bit is NOT a block.
const QTN_FLAG_ASSESSMENT_OK = 0x0040

/**
 * Default macOS reader for the `com.apple.quarantine` xattr. Returns the raw
 * attribute value, or `null` when the attribute is absent (the common case —
 * `xattr -p` exits non-zero, which we swallow). Only ever called on darwin.
 *
 * @param {string} path
 * @returns {string|null}
 */
function defaultReadQuarantineXattr(path) {
  try {
    const out = execFileSync('xattr', ['-p', 'com.apple.quarantine', path], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
    const trimmed = out.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    // No such xattr (exit 1) or xattr unavailable — treat as "not quarantined".
    return null
  }
}

/**
 * Decide whether a `com.apple.quarantine` xattr value blocks launch. Blocks
 * unless the ASSESSMENT_OK bit is set. An unparseable flags field is treated
 * as blocking (conservative — better a fixable labeled error than a silent
 * exec failure).
 *
 * @param {string|null|undefined} xattrValue
 * @returns {boolean}
 */
export function isBlockingQuarantine(xattrValue) {
  if (typeof xattrValue !== 'string' || xattrValue.length === 0) return false
  const firstField = xattrValue.split(';')[0].trim()
  const flags = parseInt(firstField, 16)
  if (Number.isNaN(flags)) return true
  return (flags & QTN_FLAG_ASSESSMENT_OK) === 0
}

/**
 * @typedef {Object} BinaryHealth
 * @property {boolean}     ok         True only when status === 'ok'.
 * @property {string}      status     One of {@link BINARY_STATUS}.
 * @property {string}      path       The resolved path that was checked.
 * @property {string|null} quarantine Raw quarantine xattr value when blocking, else null.
 */

/**
 * Verify a resolved binary path is safe to spawn: absolute, present,
 * executable, and (macOS) not blocked by a quarantine xattr.
 *
 * Pure/deterministic given its injected seams — pass mocks in tests; production
 * calls pass nothing and use the real fs + `xattr`.
 *
 * @param {string} resolvedPath - absolute path from resolveBinary()
 * @param {object} [opts]
 * @param {string} [opts.platform=process.platform]
 * @param {(p:string)=>boolean}     [opts.existsSync]
 * @param {(p:string,mode:number)=>void} [opts.accessSync] - throws when not accessible
 * @param {(p:string)=>boolean}     [opts.isAbsolute]
 * @param {(p:string)=>(string|null)} [opts.readQuarantineXattr] - macOS xattr reader
 * @returns {BinaryHealth}
 */
export function verifyBinary(resolvedPath, {
  platform = process.platform,
  existsSync = fsExistsSync,
  accessSync = fsAccessSync,
  isAbsolute = pathIsAbsolute,
  readQuarantineXattr = defaultReadQuarantineXattr,
} = {}) {
  const path = typeof resolvedPath === 'string' ? resolvedPath : ''

  // resolveBinary returns the bare name when nothing matched — a non-absolute
  // path is the "not found on PATH or in candidates" signal.
  if (!path || !isAbsolute(path) || !existsSync(path)) {
    return { ok: false, status: BINARY_STATUS.NOT_FOUND, path, quarantine: null }
  }

  try {
    accessSync(path, fsConstants.X_OK)
  } catch {
    return { ok: false, status: BINARY_STATUS.NOT_EXECUTABLE, path, quarantine: null }
  }

  // macOS-only: a Gatekeeper-quarantined binary keeps its X bit but refuses to
  // launch. Skip entirely off darwin — there is no equivalent block.
  if (platform === 'darwin') {
    const xattrValue = readQuarantineXattr(path)
    if (isBlockingQuarantine(xattrValue)) {
      return { ok: false, status: BINARY_STATUS.QUARANTINED, path, quarantine: xattrValue }
    }
  }

  return { ok: true, status: BINARY_STATUS.OK, path, quarantine: null }
}

/**
 * Build a user-facing message + remediation for a non-OK {@link BinaryHealth}.
 * Centralised so preflight errors, the spawn-time catch, and `chroxy doctor`
 * all speak the same language about what is wrong and how to fix it.
 *
 * @param {BinaryHealth} health
 * @param {object} [ctx]
 * @param {string} [ctx.binary]     - binary name (e.g. 'codex')
 * @param {string} [ctx.installHint] - how to (re)install, e.g. 'install Codex CLI'
 * @returns {{ message: string, remediation: string }}
 */
export function describeBinaryHealth(health, { binary, installHint } = {}) {
  const name = binary || 'binary'
  const path = health && health.path ? health.path : ''
  switch (health && health.status) {
    case BINARY_STATUS.QUARANTINED: {
      const remediation = `verify its provenance, then run: xattr -d com.apple.quarantine ${path} (or approve it in System Settings → Privacy & Security), or re-download ${name}`
      return {
        message: `"${name}" at ${path} is quarantined/blocked by macOS Gatekeeper — ${remediation}`,
        remediation,
      }
    }
    case BINARY_STATUS.NOT_EXECUTABLE: {
      const remediation = `run: chmod +x ${path}`
      return {
        message: `"${name}" at ${path} exists but is not executable — ${remediation}`,
        remediation,
      }
    }
    case BINARY_STATUS.NOT_FOUND:
    default: {
      const remediation = installHint || `install ${name}`
      return {
        message: `"${name}" not found — ${remediation}`,
        remediation,
      }
    }
  }
}
