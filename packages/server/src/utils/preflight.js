/**
 * Pre-flight binary + credential checks for provider sessions.
 *
 * Runs BEFORE `new ProviderClass(...)` in SessionManager.createSession so a
 * missing binary or credential surfaces as a clean, actionable error rather
 * than a cryptic ENOENT at spawn time. See issue #2962.
 *
 * Each provider class declares its requirements via `static get preflight()`:
 *
 *   {
 *     label: 'Codex',
 *     binary: {
 *       name: 'codex',
 *       candidates: ['/opt/homebrew/bin/codex', ...],
 *       installHint: 'install Codex CLI',
 *       minVersion: '2.1.80',            // optional — string OR thunk, see below
 *     },
 *     credentials: {
 *       envVars: ['OPENAI_API_KEY'],
 *       hint: 'set OPENAI_API_KEY',
 *       optional: false,
 *     },
 *   }
 *
 * Credentials marked `optional: true` (e.g. Claude — login subscription is a
 * valid alternative to ANTHROPIC_API_KEY) do NOT throw when no env var is set.
 *
 * Containerised providers (`capabilities.containerized === true`) are skipped
 * entirely — the binary lives inside the container and the host preflight
 * cannot meaningfully check it.
 *
 * ## Optional minimum-version gate (#7986)
 *
 * `spec.binary.minVersion` — a version string, or a thunk `() => string|null`
 * (e.g. `() => sdkClaudeCodeVersion()`, resolved once per call so a derived
 * floor stays current) — runs a cached `--version` probe against the SAME
 * healthy path verifyBinary + the provenance gate just approved, and throws
 * `ProviderBinaryVersionError` when the installed binary is older. This runs
 * strictly AFTER both of those gates: a binary that failed verification or
 * provenance is never exec'd for a version probe. A `minVersion` that resolves
 * to `null`/unparseable logs a warning and skips the check rather than
 * blocking — an SDK field that goes missing on a dependency bump must not
 * silently disable the gate, but it also must not turn into a hard failure
 * for something the operator can't fix by reinstalling a binary.
 */

import { resolveBinary } from './resolve-binary.js'
import { verifyBinary as defaultVerifyBinary, BINARY_STATUS, describeBinaryHealth } from './verify-binary.js'
import { verifyProvenance as defaultVerifyProvenance, PROVENANCE_STATUS } from './verify-provenance.js'
import { parseSemver, compareSemver, probeBinaryVersion as defaultProbeBinaryVersion } from './binary-version.js'
import { createLogger } from '../logger.js'

const log = createLogger('preflight')

/**
 * Thrown when a provider's required binary cannot be located or executed.
 */
export class ProviderBinaryNotFoundError extends Error {
  constructor({ provider, binary, candidates, installHint }) {
    const hint = installHint || `install ${binary}`
    const tried = candidates && candidates.length > 0
      ? ` (checked PATH and ${candidates.join(', ')})`
      : ' (checked PATH)'
    super(`${provider}: required binary "${binary}" not found${tried}. ${hint}.`)
    this.name = 'ProviderBinaryNotFoundError'
    this.code = 'PROVIDER_BINARY_NOT_FOUND'
    this.provider = provider
    this.binary = binary
    this.candidates = candidates || []
    this.installHint = hint
  }
}

/**
 * Thrown when a provider's binary is present but blocked by macOS Gatekeeper
 * (a `com.apple.quarantine` xattr whose assessment-OK bit is clear). Distinct
 * from ProviderBinaryNotFoundError so the client / doctor can render a
 * quarantine-specific remediation (`xattr -d …`) rather than "install …". (#6708)
 */
export class ProviderBinaryQuarantinedError extends Error {
  constructor({ provider, binary, path, quarantine, installHint }) {
    const { message } = describeBinaryHealth(
      { status: BINARY_STATUS.QUARANTINED, path },
      { binary, installHint },
    )
    super(`${provider}: ${message}`)
    this.name = 'ProviderBinaryQuarantinedError'
    this.code = 'PROVIDER_BINARY_QUARANTINED'
    this.provider = provider
    this.binary = binary
    this.path = path
    this.quarantine = quarantine || null
  }
}

/**
 * Thrown when the opt-in provenance gate (#6858) blocks a spawn: either the
 * binary's pinned SHA-256 changed in place (`binaryProvenance.mode: 'block'`) or
 * it failed the macOS signature/notarization gate. Distinct code so the client /
 * doctor can render a provenance-specific remediation. Never thrown when the
 * gate is off (the default) — behaviour is then identical to #6708.
 */
export class ProviderBinaryProvenanceError extends Error {
  constructor({ provider, binary, path, status, message, remediation, pinnedHash, hash }) {
    const detail = message || 'binary failed provenance verification'
    super(`${provider}: "${binary}" at ${path} ${detail}${remediation ? ` — ${remediation}` : ''}`)
    this.name = 'ProviderBinaryProvenanceError'
    this.code = 'PROVIDER_BINARY_PROVENANCE'
    this.provider = provider
    this.binary = binary
    this.path = path
    this.provenanceStatus = status
    this.remediation = remediation || null
    this.pinnedHash = pinnedHash || null
    this.hash = hash || null
  }
}

/**
 * Thrown when a provider's binary resolves + verifies + clears provenance but
 * is OLDER than the declared `spec.binary.minVersion` floor, or when its
 * version can't be determined at all (`reason: 'unreadable'`) — e.g. the
 * `--version` probe times out, the binary exits non-zero with no parseable
 * version in its output, or it was removed between verifyBinary and the probe.
 * Distinct code so the client / doctor can render a version-specific
 * remediation (`claude update`) rather than "not found". (#7986)
 */
export class ProviderBinaryVersionError extends Error {
  constructor({ provider, binary, path, found, required, reason, remediation }) {
    const detail = reason === 'unreadable'
      ? 'its version could not be determined'
      : `is older than the required ${required} (found ${found || 'unknown'})`
    super(`${provider}: "${binary}" at ${path} ${detail}${remediation ? ` — ${remediation}` : ''}`)
    this.name = 'ProviderBinaryVersionError'
    this.code = 'PROVIDER_BINARY_VERSION'
    this.provider = provider
    this.binary = binary
    this.path = path
    this.found = found ?? null
    this.required = required
    this.reason = reason
    this.remediation = remediation || null
  }
}

/**
 * Thrown when none of a provider's required credential env vars are present.
 */
export class ProviderCredentialMissingError extends Error {
  constructor({ provider, envVars, hint }) {
    const joined = envVars.join(' or ')
    const finalHint = hint || `set ${joined}`
    super(`${provider}: required credential not set — ${joined}. ${finalHint}.`)
    this.name = 'ProviderCredentialMissingError'
    this.code = 'PROVIDER_CREDENTIAL_MISSING'
    this.provider = provider
    this.envVars = envVars
    this.hint = finalHint
  }
}

/**
 * Remediation text for a `ProviderBinaryVersionError`. On Windows, an npm
 * shim (`.cmd`/`.bat`) can't satisfy the Agent SDK's native
 * `pathToClaudeCodeExecutable` spawn (no shell — see sdk-session.js #7986),
 * so an old/unreadable version at one of those extensions means "wrong kind
 * of install", not "run an updater". Every other case points at `claude
 * update`, which is the one command that fixes a stale native binary.
 *
 * @param {string} path
 * @returns {string}
 */
function versionRemediation(path) {
  if (process.platform === 'win32' && typeof path === 'string' && /\.(cmd|bat)$/i.test(path)) {
    return 'the Agent SDK spawns claude directly with no shell, so it needs the native claude.exe from the native installer, not this npm shim'
  }
  return 'run `claude update`'
}

/**
 * Run binary + credential preflight for a provider class.
 *
 * Throws ProviderBinaryNotFoundError, ProviderBinaryQuarantinedError, or
 * ProviderCredentialMissingError if the spec's requirements aren't met. No-op
 * when:
 *   - The provider doesn't declare a `static get preflight()`
 *   - The provider is containerised (binary lives inside the container)
 *
 * The binary is re-resolved fresh here (per session-create), not read off a
 * frozen module-load path, so a binary quarantined/moved AFTER daemon start is
 * caught before spawn. When the provider exposes its real spawn path via
 * `static get resolvedBinary`, we verify THAT exact path so preflight and the
 * eventual spawn can't diverge (#6708 defect #3).
 *
 * ## Opt-in provenance gate (#6858)
 *
 * When `provenance` is supplied AND enabled (`mode` is 'warn'/'block', or the
 * signature gate is on), a healthy binary is additionally run through
 * `verifyProvenance`: a SHA-256 pin-ledger check plus (opt-in) a macOS signature
 * gate. A `block`-mode hash mismatch or a failed signature gate throws
 * `ProviderBinaryProvenanceError` — fail-safe: the spawn is refused, never
 * silently allowed. A `warn`-mode issue logs and proceeds. When `provenance` is
 * absent or disabled (the default), this step is skipped entirely and behaviour
 * is identical to #6708.
 *
 * @param {Function} ProviderClass - Session class with optional `preflight` getter
 * @param {object}   [options]
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - Env source (for tests)
 * @param {Function} [options.verifyBinary] - integrity checker (injected in tests)
 * @param {{ mode?: string, signatureGate?: boolean, ledger?: object }|null} [options.provenance]
 *   - opt-in provenance config + pin ledger; null/disabled ⇒ gate skipped
 * @param {Function} [options.verifyProvenance] - provenance checker (injected in tests)
 * @param {Function} [options.probeVersion] - `(path, args) => string|null` version
 *   prober (injected in tests); only called when `spec.binary.minVersion` resolves
 *   to a valid version, and only after verifyBinary + provenance both pass (#7986)
 * @returns {{ binaryPath: string|null }} exact healthy path allowed by all enabled gates
 * @throws {ProviderBinaryNotFoundError|ProviderBinaryQuarantinedError|ProviderBinaryProvenanceError|ProviderBinaryVersionError|ProviderCredentialMissingError}
 */
export function runProviderPreflight(ProviderClass, {
  env = process.env,
  verifyBinary = defaultVerifyBinary,
  provenance = null,
  verifyProvenance = defaultVerifyProvenance,
  probeVersion = defaultProbeBinaryVersion,
} = {}) {
  if (!ProviderClass) return { binaryPath: null }

  // Containerised providers run their binary inside the container, so a host
  // preflight check would always fail (or worse — silently pass against a
  // wrong binary). Trust the container image / health probe instead.
  if (ProviderClass.capabilities?.containerized) return { binaryPath: null }

  const spec = ProviderClass.preflight
  if (!spec) return { binaryPath: null }

  const providerLabel = spec.label || ProviderClass.name || 'provider'
  let binaryPath = null

  if (spec.binary && spec.binary.name) {
    const candidates = spec.binary.candidates || []
    // Prefer the provider's live spawn path when it exposes one — that is the
    // exact path child_process.spawn will exec — so the existence gate and the
    // real spawn always agree. Fall back to a fresh PATH/candidate resolve.
    let resolved
    try {
      resolved = ProviderClass.resolvedBinary
    } catch { /* subclass throws if unset — fall through */ }
    if (typeof resolved !== 'string' || resolved.length === 0) {
      resolved = resolveBinary(spec.binary.name, candidates)
    }
    const health = verifyBinary(resolved)
    if (health.status === BINARY_STATUS.QUARANTINED) {
      throw new ProviderBinaryQuarantinedError({
        provider: providerLabel,
        binary: spec.binary.name,
        path: health.path,
        quarantine: health.quarantine,
        installHint: spec.binary.installHint,
      })
    }
    // NOT_FOUND / NOT_EXECUTABLE both mean "can't spawn it" — resolveBinary
    // returns the bare name when nothing matched, which verifyBinary reports as
    // NOT_FOUND.
    if (!health.ok) {
      throw new ProviderBinaryNotFoundError({
        provider: providerLabel,
        binary: spec.binary.name,
        candidates,
        installHint: spec.binary.installHint,
      })
    }
    binaryPath = health.path

    // #6858: opt-in provenance gate on the SAME healthy path the spawn will use.
    // Skipped entirely unless the operator opted in (mode warn/block or the
    // signature gate). Fail-safe: a `block`-mode hash mismatch or a failed
    // signature gate throws; a `warn`-mode issue logs and proceeds.
    const provenanceOn = provenance
      && (provenance.mode === 'warn' || provenance.mode === 'block' || provenance.signatureGate === true)
    if (provenanceOn) {
      const verdict = verifyProvenance({
        resolvedPath: health.path,
        mode: provenance.mode,
        signatureGate: provenance.signatureGate === true,
        ledger: provenance.ledger || null,
      })
      if (verdict.blocked) {
        throw new ProviderBinaryProvenanceError({
          provider: providerLabel,
          binary: spec.binary.name,
          path: verdict.path,
          status: verdict.status,
          message: verdict.message,
          remediation: verdict.remediation,
          pinnedHash: verdict.pinnedHash,
          hash: verdict.hash,
        })
      }
      if (
        verdict.status === PROVENANCE_STATUS.HASH_MISMATCH
        || verdict.status === PROVENANCE_STATUS.SIGNATURE_INVALID
        || verdict.status === PROVENANCE_STATUS.UNREADABLE
      ) {
        // warn-mode (or unverifiable-but-allowed) — surface loudly, still spawn.
        log.warn(`Provider "${spec.binary.name}" provenance ${verdict.status}: ${verdict.message || ''} (allowed — mode=${provenance.mode})`)
      }
    }

    // #7986: optional minimum-version gate. Runs ONLY after verifyBinary and
    // the provenance gate above both passed — binaryPath is the same healthy,
    // provenance-cleared path the spawn will use, so this never execs a
    // binary that failed either gate.
    if (Object.prototype.hasOwnProperty.call(spec.binary, 'minVersion')) {
      const rawMinVersion = typeof spec.binary.minVersion === 'function'
        ? spec.binary.minVersion()
        : spec.binary.minVersion
      const required = parseSemver(rawMinVersion)
      if (!required) {
        // A thunk that returns null (e.g. the SDK's claudeCodeVersion field
        // went missing on a dependency bump) or a malformed string must not
        // silently disable the gate NOR hard-fail a session the operator has
        // no way to fix — surfaced loudly, then skipped.
        log.warn(`Provider "${spec.binary.name}" declared an invalid/empty minVersion (${JSON.stringify(rawMinVersion)}) — skipping the version check`)
      } else {
        const found = probeVersion(binaryPath, spec.binary.args || ['--version'])
        if (!found) {
          throw new ProviderBinaryVersionError({
            provider: providerLabel,
            binary: spec.binary.name,
            path: binaryPath,
            found: null,
            required: rawMinVersion,
            reason: 'unreadable',
            remediation: versionRemediation(binaryPath),
          })
        }
        if (compareSemver(found, required) < 0) {
          throw new ProviderBinaryVersionError({
            provider: providerLabel,
            binary: spec.binary.name,
            path: binaryPath,
            found,
            required: rawMinVersion,
            reason: 'too_old',
            remediation: versionRemediation(binaryPath),
          })
        }
      }
    }
  }

  if (spec.credentials && Array.isArray(spec.credentials.envVars) && spec.credentials.envVars.length > 0) {
    // Optional credentials never block creation — Claude can authenticate
    // via a prior `claude login` subscription instead of ANTHROPIC_API_KEY.
    if (spec.credentials.optional) return { binaryPath }
    const matched = spec.credentials.envVars.find(v => env[v])
    if (!matched) {
      throw new ProviderCredentialMissingError({
        provider: providerLabel,
        envVars: spec.credentials.envVars,
        hint: spec.credentials.hint,
      })
    }
  }
  return { binaryPath }
}
