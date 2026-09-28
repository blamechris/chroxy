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
 * ## Optional minimum-version gate (#7986), and a soft advisory floor (#8031)
 *
 * `spec.binary.minVersion` — a version string, or a thunk `() => string|null`
 * (resolved once per call so a derived floor stays current) — runs a cached
 * `--version` probe against the SAME healthy path verifyBinary + the
 * provenance gate just approved, and throws `ProviderBinaryVersionError` when
 * the installed binary is older. This runs strictly AFTER both of those
 * gates: a binary that failed verification or provenance is never exec'd for
 * a version probe. A `minVersion` that resolves to `null`/unparseable logs a
 * warning and skips the check rather than blocking — a value that goes
 * missing on a dependency bump must not silently disable the gate, but it
 * also must not turn into a hard failure for something the operator can't
 * fix by reinstalling a binary. (`claude-sdk` itself declares a hand-kept
 * constant, `CLAUDE_SDK_MIN_CLI_VERSION`, as its `minVersion` — the thunk
 * form is what it uses for `recommendedVersion` instead, below.)
 *
 * `spec.binary.recommendedVersion` — same shape (string or thunk), resolved
 * through the same `resolveDeclaredMinVersion` helper — is a SOFT floor: when
 * the probed version is below it, preflight does NOT throw. It logs a
 * one-line `log.warn` and returns a `versionAdvisory` describing the gap
 * instead. This is the #8031 fix for `claude-sdk`, which used to declare its
 * installed Agent SDK's own `claudeCodeVersion` field as a HARD `minVersion` —
 * that field is the CLI build the SDK was *published alongside*, not a
 * genuine minimum, so every SDK bump instantly hard-blocked any `claude` CLI
 * on a lagging release channel (e.g. npm `stable`, which trails `latest`).
 * `claude-sdk` now declares a small, hand-raised, deliberately-conservative
 * `minVersion` (`CLAUDE_SDK_MIN_CLI_VERSION`) as the hard floor, and the SDK's
 * `claudeCodeVersion` as the soft `recommendedVersion` — below the hard floor
 * still throws; between the two floors just warns; at or above the soft floor
 * is silent. The probe still runs AT MOST ONCE per call even when both fields
 * are declared: the same probed `found` version feeds both checks. A
 * `recommendedVersion` that resolves to `null`/unparseable is silently
 * ignored — a soft check exists to advise, never to invent a failure or a
 * warning of its own.
 *
 * ## Direct-exec refusal (#7986 review S2)
 *
 * `spec.binary.requiresDirectExec: true` declares that the provider spawns its
 * binary directly with no shell (e.g. the Agent SDK's `pathToClaudeCodeExecutable`
 * — see sdk-session.js), so a Windows npm shim (`claude.cmd`/`claude.bat`) can
 * never actually run: `child_process.spawn` on a `.cmd`/`.bat` with no shell
 * throws `EINVAL`. This used to surface only as a SIDE EFFECT of the version
 * probe failing in a confusing way, and only when a `minVersion` was also
 * declared and resolved to a real value. Declaring the flag makes it an
 * explicit, unconditional check: it runs right after `verifyBinary` passes,
 * BEFORE provenance and the version probe (a shim is refused before it is
 * ever exec'd for anything), and throws `ProviderBinaryUnsupportedError`
 * regardless of whether the provider declares a `minVersion` at all.
 *
 * ## Per-spawn re-verification (#8030)
 *
 * A provider that execs a NEW process on every turn (the Agent SDK) can't rely
 * on "verified once at session-create" — a background auto-update or a PATH
 * change between turns would spawn an unverified binary on turn two onward.
 * Two options thread that need through this same function rather than adding
 * a parallel code path:
 *
 *   - `options.pinnedPath` (string|null, default null): when supplied as a
 *     non-empty string, verify EXACTLY that path instead of resolving one.
 *     Both `ProviderClass.resolvedBinary` and a fresh `resolveBinary()` call
 *     are skipped entirely — the caller has already decided which path this
 *     spawn must use (typically the exact path preflight verified at
 *     session-create), and this call's job is only to re-run the existence /
 *     quarantine / shim / provenance / version gates against THAT path. Every
 *     gate downstream of resolution runs unchanged, so a pinned path that
 *     fails any of them throws the same errors a resolved path would.
 *   - `options.warnAdvisory` (boolean, default true): when false, the #8031
 *     soft-floor `log.warn` for a `recommendedVersion` gap is suppressed —
 *     re-logging that advisory on every single turn would spam the log for a
 *     condition that hasn't changed since the last turn. The `versionAdvisory`
 *     return value is unaffected; only the log line is gated. A hard
 *     `minVersion` failure still throws regardless of this flag — it is
 *     never merely advisory.
 */

import { resolveBinary } from './resolve-binary.js'
import { isBatchShim } from './win-spawn.js'
import { verifyBinary as defaultVerifyBinary, BINARY_STATUS, describeBinaryHealth } from './verify-binary.js'
import { verifyProvenance as defaultVerifyProvenance, PROVENANCE_STATUS } from './verify-provenance.js'
import { parseSemver, compareSemver, resolveDeclaredMinVersion, probeBinaryVersion as defaultProbeBinaryVersion } from './binary-version.js'
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
 * True when `path` is an npm shim that a no-shell `spawn` can't run directly:
 * Windows, and the path ends in `.cmd` or `.bat` (case-insensitive — Windows
 * paths are case-insensitive and `resolveBinary`/`where` output isn't
 * normalized to one case). Off-Windows this is always false: on POSIX an npm
 * shim IS the real executable (a shebang script), so there is nothing to
 * refuse there.
 *
 * @param {string} path
 * @param {string} [platform] - defaults to `process.platform`; injectable for tests.
 * @returns {boolean}
 */
export function isShellShim(path, platform = process.platform) {
  return platform === 'win32' && isBatchShim(path)
}

/**
 * Thrown when a provider declares `binary.requiresDirectExec: true` and its
 * resolved binary is a shell shim (a Windows npm `.cmd`/`.bat`) that a no-shell
 * spawn can never actually run. Distinct code so the client / doctor can
 * render a shim-specific remediation ("install the native executable")
 * instead of a version or not-found message. (#7986 review S2)
 */
export class ProviderBinaryUnsupportedError extends Error {
  constructor({ provider, binary, path, remediation }) {
    super(`${provider}: "${binary}" at ${path} cannot be spawned — ${remediation}`)
    this.name = 'ProviderBinaryUnsupportedError'
    this.code = 'PROVIDER_BINARY_UNSUPPORTED'
    this.provider = provider
    this.binary = binary
    this.path = path
    this.remediation = remediation || null
  }
}

/**
 * Remediation text for `ProviderBinaryUnsupportedError`: the provider spawns
 * its binary directly (no shell), so an npm shim can't satisfy it — only the
 * platform's native executable can. Names `claude.exe` specifically for the
 * `claude` binary since that's the concrete fix an operator needs; every
 * other binary gets the generic phrasing.
 *
 * @param {string} binaryName
 * @returns {string}
 */
function shimRemediation(binaryName) {
  const example = binaryName === 'claude' ? ' (for claude, `claude.exe` from the native installer)' : ''
  return `spawns the binary directly without a shell, so it needs the native executable${example}, not an npm shim`
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
 * Remediation text for a `ProviderBinaryVersionError`. Generic across every
 * provider that declares a `minVersion` — the Windows shell-shim case is no
 * longer special-cased here (#7986 review S2): a provider that declares
 * `requiresDirectExec: true` now refuses a `.cmd`/`.bat` outright, before the
 * version probe ever runs (see `isShellShim` + the check in
 * `runProviderPreflight`), so this function never has to guess "wrong kind of
 * install" from a path suffix. Preference order: the provider's own
 * `updateHint` (e.g. claude-sdk's `` run `claude update` ``), else its
 * `installHint`, else a generic `update <name>`.
 *
 * @param {object} binarySpec - `spec.binary`.
 * @returns {string}
 */
function versionRemediation(binarySpec) {
  return binarySpec.updateHint || binarySpec.installHint || `update ${binarySpec.name}`
}

/**
 * Build the `provenance` options bag `runProviderPreflight` expects from
 * already-resolved `mode` / `signatureGate` / `ledger` values, or `null` when
 * the operator has not opted into either gate (mode 'off' AND no signature
 * gate) — passing `null` makes `runProviderPreflight` skip the whole
 * provenance step, byte-identical to the pre-#6858 spawn path.
 *
 * This is the single normalization both `SessionManager._binaryProvenanceOptions()`
 * (the daemon's create-time / per-turn / one-shot gate, reading its own
 * `_binaryProvenanceMode` / `_binarySignatureGate` / `binaryProvenanceLedger`
 * instance fields) and the `chroxy session resume` CLI gate (#8061, which has
 * no `SessionManager` to read those fields off of — it resolves mode and
 * signatureGate straight from the loaded config instead) now share, so what
 * counts as "the gate is off" is defined in exactly one place rather than two
 * copies that could drift on the answer.
 *
 * @param {{ mode: string, signatureGate: boolean, ledger: object|null }} opts
 * @returns {{ mode: string, signatureGate: boolean, ledger: object|null }|null}
 */
export function buildBinaryProvenanceOptions({ mode, signatureGate, ledger }) {
  return (mode !== 'off' || signatureGate === true)
    ? { mode, signatureGate: signatureGate === true, ledger: ledger || null }
    : null
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
 *   prober (injected in tests); called AT MOST ONCE per call, when either
 *   `spec.binary.minVersion` OR `spec.binary.recommendedVersion` resolves to a
 *   valid version, and only after verifyBinary + provenance both pass (#7986,
 *   #8031)
 * @param {string} [options.platform] - defaults to `process.platform`; injectable
 *   for tests exercising the `requiresDirectExec` shim refusal (#7986 review S2)
 * @param {string|null} [options.pinnedPath=null] - #8030: when a non-empty
 *   string, verify EXACTLY this path (skip `ProviderClass.resolvedBinary` AND
 *   `resolveBinary`) — see the "Per-spawn re-verification" docblock section.
 * @param {boolean} [options.warnAdvisory=true] - #8030: when false, suppress the
 *   #8031 soft-floor `log.warn` (the returned `versionAdvisory` is unaffected).
 * @returns {{ binaryPath: string|null, versionAdvisory: object|null }} the exact
 *   healthy path allowed by all enabled gates, plus a soft-floor advisory
 *   (#8031) — `{ provider, binary, path, found, recommended, remediation }` —
 *   when the probed version is below `spec.binary.recommendedVersion` but at
 *   or above `spec.binary.minVersion`; `null` when there is no such gap (or no
 *   `recommendedVersion` declared, or the min gate already threw).
 * @throws {ProviderBinaryNotFoundError|ProviderBinaryQuarantinedError|ProviderBinaryProvenanceError|ProviderBinaryUnsupportedError|ProviderBinaryVersionError|ProviderCredentialMissingError}
 */
export function runProviderPreflight(ProviderClass, {
  env = process.env,
  verifyBinary = defaultVerifyBinary,
  provenance = null,
  verifyProvenance = defaultVerifyProvenance,
  probeVersion = defaultProbeBinaryVersion,
  platform = process.platform,
  pinnedPath = null,
  warnAdvisory = true,
} = {}) {
  if (!ProviderClass) return { binaryPath: null, versionAdvisory: null }

  // Containerised providers run their binary inside the container, so a host
  // preflight check would always fail (or worse — silently pass against a
  // wrong binary). Trust the container image / health probe instead.
  if (ProviderClass.capabilities?.containerized) return { binaryPath: null, versionAdvisory: null }

  const spec = ProviderClass.preflight
  if (!spec) return { binaryPath: null, versionAdvisory: null }

  const providerLabel = spec.label || ProviderClass.name || 'provider'
  let binaryPath = null
  let versionAdvisory = null

  if (spec.binary && spec.binary.name) {
    const candidates = spec.binary.candidates || []
    const hasPinnedPath = typeof pinnedPath === 'string' && pinnedPath.length > 0
    // #8030: a pinned path means the caller already decided which exact path
    // this spawn must re-verify (typically the path preflight verified at
    // session-create) — skip BOTH the live-spawn-path read and a fresh
    // resolve so a PATH change or a resolver quirk can never substitute a
    // different binary than the one being pinned.
    let resolved = hasPinnedPath ? pinnedPath : undefined
    if (!hasPinnedPath) {
      // Prefer the provider's live spawn path when it exposes one — that is the
      // exact path child_process.spawn will exec — so the existence gate and the
      // real spawn always agree. Fall back to a fresh PATH/candidate resolve.
      try {
        resolved = ProviderClass.resolvedBinary
      } catch { /* subclass throws if unset — fall through */ }
      if (typeof resolved !== 'string' || resolved.length === 0) {
        resolved = resolveBinary(spec.binary.name, candidates)
      }
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

    // #7986 review S2: an explicit, unconditional refusal for a provider that
    // spawns its binary directly (no shell) — runs BEFORE provenance and the
    // version probe, right after the binary is confirmed to exist/be
    // executable/not-quarantined. Previously this only surfaced as a side
    // effect of the version probe's EINVAL, which meant: (1) it vanished
    // whenever minVersion resolved to null (the .cmd passed preflight and
    // failed mid-turn instead), and (2) it never ran at all for a provider
    // with no minVersion declared.
    if (spec.binary.requiresDirectExec === true && isShellShim(binaryPath, platform)) {
      throw new ProviderBinaryUnsupportedError({
        provider: providerLabel,
        binary: spec.binary.name,
        path: binaryPath,
        remediation: shimRemediation(spec.binary.name),
      })
    }

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

    // #7986 / #8031: optional minimum-version gate (hard `minVersion`) plus a
    // soft, advisory `recommendedVersion`. Both run ONLY after verifyBinary
    // and the provenance gate above both passed — binaryPath is the same
    // healthy, provenance-cleared path the spawn will use, so this never
    // execs a binary that failed either gate.
    const hasMinVersion = Object.prototype.hasOwnProperty.call(spec.binary, 'minVersion')
    let rawMinVersion = null
    let required = null
    if (hasMinVersion) {
      rawMinVersion = resolveDeclaredMinVersion(spec.binary.minVersion)
      required = parseSemver(rawMinVersion)
      if (!required) {
        // A thunk that returns null (e.g. the SDK's claudeCodeVersion field
        // went missing on a dependency bump) or a malformed string must not
        // silently disable the gate NOR hard-fail a session the operator has
        // no way to fix — surfaced loudly, then skipped.
        log.warn(`Provider "${providerLabel}" (binary "${spec.binary.name}") declared an invalid/empty minVersion (${JSON.stringify(rawMinVersion)}) — skipping the version check`)
      }
    }

    // #8031: `recommendedVersion` shares the exact same resolve step, but an
    // invalid/null result is silently ignored — a soft check exists to
    // advise, never to invent a warning or a failure of its own.
    const hasRecommendedVersion = Object.prototype.hasOwnProperty.call(spec.binary, 'recommendedVersion')
    let rawRecommendedVersion = null
    let recommended = null
    if (hasRecommendedVersion) {
      rawRecommendedVersion = resolveDeclaredMinVersion(spec.binary.recommendedVersion)
      recommended = parseSemver(rawRecommendedVersion)
    }

    // The probe runs AT MOST ONCE per call — when EITHER field resolved to a
    // valid version — and its result feeds both checks below (#8031).
    if (required || recommended) {
      const found = probeVersion(binaryPath, spec.binary.args || ['--version'])

      if (required) {
        if (!found) {
          throw new ProviderBinaryVersionError({
            provider: providerLabel,
            binary: spec.binary.name,
            path: binaryPath,
            found: null,
            required: rawMinVersion,
            reason: 'unreadable',
            remediation: versionRemediation(spec.binary),
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
            remediation: versionRemediation(spec.binary),
          })
        }
      }

      // The min gate above either passed or wasn't declared (a thrown
      // ProviderBinaryVersionError would have already unwound out of this
      // function), so a found version here is a green light for the soft
      // check too. A `found === null` here only happens when `required` is
      // falsy (an unreadable probe with `required` set always throws above)
      // — i.e. ONLY recommendedVersion was declared and the probe couldn't
      // read a version; a soft check never blocks and never invents a
      // failure, so that case is silently skipped, not warned.
      if (recommended && found && compareSemver(found, recommended) < 0) {
        const remediation = versionRemediation(spec.binary)
        versionAdvisory = {
          provider: providerLabel,
          binary: spec.binary.name,
          path: binaryPath,
          found,
          recommended: rawRecommendedVersion,
          remediation,
        }
        // #8030: a per-turn re-verification call passes warnAdvisory:false so
        // this doesn't re-log the same gap on every turn — the advisory is
        // still computed and returned either way.
        if (warnAdvisory) {
          log.warn(`Provider "${providerLabel}" (binary "${spec.binary.name}") at ${binaryPath} is version ${found}, older than the recommended ${rawRecommendedVersion} — ${remediation}`)
        }
      }
    }
  }

  if (spec.credentials && Array.isArray(spec.credentials.envVars) && spec.credentials.envVars.length > 0) {
    // Optional credentials never block creation — Claude can authenticate
    // via a prior `claude login` subscription instead of ANTHROPIC_API_KEY.
    if (spec.credentials.optional) return { binaryPath, versionAdvisory }
    const matched = spec.credentials.envVars.find(v => env[v])
    if (!matched) {
      throw new ProviderCredentialMissingError({
        provider: providerLabel,
        envVars: spec.credentials.envVars,
        hint: spec.credentials.hint,
      })
    }
  }
  return { binaryPath, versionAdvisory }
}
