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

import { existsSync, accessSync, constants } from 'fs'
import { isAbsolute } from 'path'
import { resolveBinary } from './resolve-binary.js'

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
 * Verify a binary path exists and is executable by the current process.
 * Returns true if the resolved path is absolute, exists, and the X bit is set.
 *
 * @param {string} resolvedPath
 * @returns {boolean}
 */
function isExecutableFile(resolvedPath) {
  if (!isAbsolute(resolvedPath)) return false
  if (!existsSync(resolvedPath)) return false
  try {
    accessSync(resolvedPath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Run binary + credential preflight for a provider class.
 *
 * Throws ProviderBinaryNotFoundError or ProviderCredentialMissingError if
 * the spec's requirements aren't met. No-op when:
 *   - The provider doesn't declare a `static get preflight()`
 *   - The provider is containerised (binary lives inside the container)
 *
 * @param {Function} ProviderClass - Session class with optional `preflight` getter
 * @param {object}   [options]
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - Env source (for tests)
 * @throws {ProviderBinaryNotFoundError|ProviderCredentialMissingError}
 */
export function runProviderPreflight(ProviderClass, { env = process.env } = {}) {
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
    const resolved = resolveBinary(spec.binary.name, candidates)
    // resolveBinary returns the bare name when nothing on PATH or in
    // candidates matched — that's the failure signal.
    if (!isExecutableFile(resolved)) {
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
