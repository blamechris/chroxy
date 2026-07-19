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
 */

import { resolveBinary } from './resolve-binary.js'
import { verifyBinary as defaultVerifyBinary, BINARY_STATUS, describeBinaryHealth } from './verify-binary.js'

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
 * @param {Function} ProviderClass - Session class with optional `preflight` getter
 * @param {object}   [options]
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - Env source (for tests)
 * @param {Function} [options.verifyBinary] - integrity checker (injected in tests)
 * @throws {ProviderBinaryNotFoundError|ProviderBinaryQuarantinedError|ProviderCredentialMissingError}
 */
export function runProviderPreflight(ProviderClass, { env = process.env, verifyBinary = defaultVerifyBinary } = {}) {
  if (!ProviderClass) return

  // Containerised providers run their binary inside the container, so a host
  // preflight check would always fail (or worse — silently pass against a
  // wrong binary). Trust the container image / health probe instead.
  if (ProviderClass.capabilities?.containerized) return

  const spec = ProviderClass.preflight
  if (!spec) return

  const providerLabel = spec.label || ProviderClass.name || 'provider'

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
  }

  if (spec.credentials && Array.isArray(spec.credentials.envVars) && spec.credentials.envVars.length > 0) {
    // Optional credentials never block creation — Claude can authenticate
    // via a prior `claude login` subscription instead of ANTHROPIC_API_KEY.
    if (spec.credentials.optional) return
    const matched = spec.credentials.envVars.find(v => env[v])
    if (!matched) {
      throw new ProviderCredentialMissingError({
        provider: providerLabel,
        envVars: spec.credentials.envVars,
        hint: spec.credentials.hint,
      })
    }
  }
}
