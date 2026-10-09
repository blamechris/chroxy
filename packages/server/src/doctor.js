import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createServer } from 'net'
import { validateConfig, resolveBinaryProvenanceMode, isBinarySignatureGateEnabled, mergeConfig } from './config.js'
import { resolveBinary } from './utils/resolve-binary.js'
import { verifyBinary as defaultVerifyBinary, BINARY_STATUS, describeBinaryHealth } from './utils/verify-binary.js'
import { resolveDeclaredMinVersion } from './utils/binary-version.js'
import { isShellShim, buildBinaryProvenanceOptions } from './utils/preflight.js'
import { verifyProvenance as defaultVerifyProvenance, PROVENANCE_STATUS } from './utils/verify-provenance.js'
import { prepareSpawn } from './utils/win-spawn.js'
import { cloudflaredInstallHint } from './platform.js'
import { getProvider, DEFAULT_PROVIDER, resolveDaemonDefaultProvider } from './providers.js'
import { registerAnthropicCompatibleProviders } from './anthropic-compatible-session.js'
import { registerOpenAiCompatibleProviders } from './openai-compatible-session.js'
import { parseTunnelArg } from './tunnel/index.js'
import { CLOUDFLARED_CANDIDATES } from './tunnel/cloudflare.js'
import { TESTED_CLAUDE_TUI_CLI_VERSION } from './claude-tui/tested-cli-version.js'
import { detectSilentMeteredDefault } from './doctor-billing.js'
import { keychainHealth } from './keychain.js'
import {
  billingClassForProvider,
  billingDetailForClass,
  isProgrammaticCreditEra,
  PROGRAMMATIC_CREDIT_ERA_START,
} from './billing-class.js'
import { checkDependencies } from './utils/check-dependencies.js'
import { configPath } from './config-dir.js'
import { applyStrandedAck, detectStrandedState } from './config-dir-migration.js'
import { CLAUDE_LOGIN_COMMAND } from './utils/claude-login-command.js'
import { BinaryProvenanceLedger } from './binary-provenance-trust.js'
import { createLogger } from './logger.js'
import { countUserLevelChroxyHooks } from './permission-hook.js'

const log = createLogger('doctor')

// Resolve the server package root (the directory containing package.json
// and node_modules) so dependency checks work regardless of where the
// server process was launched. `import.meta.url` points to this file at
// src/doctor.js — two `dirname` calls walk from the file up through
// src/ to the package root.
const __filename = fileURLToPath(import.meta.url)
const SERVER_PKG_DIR = dirname(dirname(__filename))

// Honor CHROXY_CONFIG_DIR (the repo-wide convention — connection-info.js,
// models.js, etc.) so the config read resolves to the same dir as every other
// reader. Without this, doctor read the REAL ~/.chroxy in tests despite
// tests/_setup.mjs redirecting CHROXY_CONFIG_DIR to a tmp dir — which would let
// the named-tunnel routability probe (#5328) fire a live network request from
// a maintainer's real config during the suite.
function configFile() {
  return configPath('config.json')
}

/**
 * Parse the leading `major.minor.patch` semver out of an arbitrary version
 * string (e.g. "2.1.163 (Claude Code)" → [2, 1, 163]). Returns null when no
 * leading semver is present so callers can degrade gracefully rather than
 * hard-fail on an unexpected version format. Pre-release / build suffixes
 * are ignored — only the numeric core is compared. (#3953)
 *
 * @param {string} str
 * @returns {[number, number, number] | null}
 */
export function parseLeadingSemver(str) {
  if (typeof str !== 'string') return null
  const m = str.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * Compare two semver values. `found` may be a string or a parsed
 * `[major, minor, patch]` tuple; `required` is a semver string. Returns a
 * negative number when `found` < `required`, 0 when equal (on the numeric
 * core), positive when greater.
 *
 * Both sides fail CLOSED: an unparseable `found` OR an unparseable
 * `required` sorts as less-than (returns negative) so the floor is treated
 * as NOT satisfied. This matters for `required` too — a provider that
 * accidentally supplies a non-`major.minor.patch` floor (e.g. ">=2.1.80"
 * or "2.1.80-beta") must not silently disable minVersion enforcement
 * (Copilot review on #3953). (#3953)
 *
 * @param {string | [number, number, number]} found
 * @param {string} required
 * @returns {number}
 */
export function compareSemver(found, required) {
  const a = Array.isArray(found) ? found : parseLeadingSemver(found)
  const b = parseLeadingSemver(required)
  // Fail closed on either side: a malformed floor (b) or version (a) is
  // treated as "not satisfied" so an enforcement gate can never pass by
  // accident. Returns negative (found < required) in every invalid case.
  if (!a || !b) return -1
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/**
 * Detect whether the server is running inside a bundled .app (Tauri) or
 * under the supervisor process. In either case, the end user cannot fix
 * a missing dependency / broken install themselves by running `npm install`
 * — they need a reinstall or rebuild. Checks affected by this distinction
 * (Dependencies, and likely cloudflared / Node version / port soon)
 * downgrade `fail` → `warn` and surface a context-appropriate hint.
 *
 * Centralised here so:
 *   - The detection lives in one place as more checks adopt it
 *   - Tests can stub `process.env` once (or import this helper directly)
 *     instead of duplicating the env-var pattern at every call site
 *
 * Exported for tests; production callers should prefer using the helper
 * from within `runDoctorChecks`.
 *
 * @returns {boolean} true when CHROXY_BUNDLED=1 OR CHROXY_SUPERVISED=1
 */
export function isBundledOrSupervisedContext() {
  return process.env.CHROXY_BUNDLED === '1' || process.env.CHROXY_SUPERVISED === '1'
}

/**
 * Resolve the list of providers to preflight check.
 *
 * #8151 review round 2 (Critical 2) — the S6 version of this function (a
 * hand-written copy of config.js's CLI > ENV > file > default precedence)
 * was itself a regression outside Docker. It read `CHROXY_PROVIDERS`
 * (plural) as a comma-separated list of PROVIDER NAMES — but
 * `CHROXY_PROVIDERS` is a REAL, documented env var for `config.providers`
 * (the anthropic-compatible/openai-compatible endpoint registrations: array
 * OR object, see config.js's `CONFIG_SCHEMA` and `parseEnvValue`), not a
 * provider roster. A daemon that set `CHROXY_PROVIDERS` to its own
 * documented JSON-object form got that comma-split into garbage tokens here
 * (3 bogus "names", `claude-sdk` never checked) — and even in the simple
 * case, `CHROXY_PROVIDER=claude-sdk` with an unrelated `CHROXY_PROVIDERS`
 * set made doctor check the WRONG provider while the daemon actually ran
 * claude-sdk, because this function answered two different questions
 * ("what provider does the daemon run" vs. "what is config.providers") with
 * the same hand-rolled env read.
 *
 * Fixed by dropping this function's own env/file reads entirely and routing
 * through the SAME shared loader `chroxy start`/`chroxy resume` use:
 * `mergeConfig` (config.js) resolves CLI > ENV > file > default — including
 * the `legacyCli` → `claude-cli` mapping — via its own
 * `parseEnvValue`/`CONFIG_SCHEMA`-aware coercion (so `CHROXY_PROVIDERS`' object
 * form is parsed as JSON, never comma-split, and is correctly ignored here
 * since it feeds `merged.providers`, a field `resolveDaemonDefaultProvider`
 * never reads). `resolveDaemonDefaultProvider` (providers.js) then reads
 * `merged.provider` — the one function both doctor and the real daemon
 * startup path share, so this can't drift from `chroxy start`'s own
 * resolution again without touching shared code both paths run.
 *
 * Precedence:
 *   1. Explicit `providers` option (array of provider names — doctor's own
 *      `--provider a,b` flag; unrelated to config.js's `providers` key)
 *   2. Everything `mergeConfig` resolves for `provider` (ENV > file >
 *      default) — exactly one name, the one `chroxy start` would run.
 *
 * Returns an array of provider name strings.
 *
 * @param {object} args
 * @param {string[]} [args.providers] - doctor's own explicit `--provider a,b`
 *   flag; still the highest-precedence override when present.
 * @param {object|null} [args.parsedConfig] - the raw parsed config.json (or
 *   null/absent), fed to mergeConfig as the file tier.
 */
function resolveProviders({ providers, parsedConfig }) {
  if (Array.isArray(providers) && providers.length > 0) return providers
  const merged = mergeConfig({
    fileConfig: parsedConfig && typeof parsedConfig === 'object' ? parsedConfig : {},
  })
  return [resolveDaemonDefaultProvider(merged)]
}

/**
 * The claude-tui provider's preflight binary candidate paths (homebrew, ~/.local,
 * npm-global, etc.), so the version-pin check resolves `claude` the same way the
 * provider preflight does. Best-effort: returns [] if the spec isn't shaped as
 * expected (the check then falls back to PATH resolution). (#5871)
 */
function claudeTuiBinaryCandidates() {
  try {
    const Provider = getProvider('claude-tui')
    const candidates = Provider?.preflight?.binary?.candidates
    return Array.isArray(candidates) ? candidates : []
  } catch {
    return []
  }
}

/**
 * Build a doctor `fail` check for a binary the opt-in provenance gate refused
 * (#8041) — a `block`-mode hash mismatch or a failed signature-gate
 * assessment. Doctor checks report status objects rather than throwing, so
 * this is the doctor-shaped equivalent of `ProviderBinaryProvenanceError` /
 * `TunnelBinaryProvenanceError`: same message shape (path, verdict status,
 * message, remediation), returned instead of thrown. Always a hard `fail`
 * regardless of whether the binary itself is `required` — a provenance
 * refusal is a security decision (the daemon never downgrades it), not an
 * advisory floor like a missing optional binary.
 *
 * @param {string} name - the doctor check's display name
 * @param {string} resolved - the resolved absolute path that was refused
 * @param {{ status: string, message?: string, remediation?: string }} verdict
 *   - the blocked verdict returned by `verifyProvenance`
 * @returns {{ name: string, status: 'fail', message: string }}
 */
function provenanceBlockedCheck(name, resolved, verdict) {
  return {
    name,
    status: 'fail',
    message: `${resolved} — provenance ${verdict.status}: ${verdict.message || 'failed provenance verification'}`
      + `${verdict.remediation ? ` — ${verdict.remediation}` : ''}`,
  }
}

/**
 * #8223: the resolve -> health-check -> provenance-gate prelude shared by every
 * doctor probe that EXECS `claude` (the claude-tui version pin and the login
 * check), lifted out of `checkClaudeTuiCliVersion` unchanged so the two cannot
 * drift on how the binary is vetted before it runs. Returns the path to exec and
 * any pending warn-mode provenance advisory, or null when `claude` cannot be run
 * (missing / quarantined / provenance-blocked) — the provider binary check
 * already reports those, so a probe adds no second row for them.
 *
 * @param {object} deps - same shape as `checkClaudeTuiCliVersion`'s
 * @param {string} probeLabel - names the probe in the provenance warn log
 * @returns {{ execPath: string, provenanceAdvisory: string|null } | null}
 */
function resolveClaudeProbeBinary({ candidates, resolveBinary: resolveClaudeBinary, verify, provenance, verifyProvenance }, probeLabel) {
  const resolved = resolveClaudeBinary('claude', candidates)
  // #8074 review C2: `verifyProvenance` must never run on an unresolved/
  // not-found path — a bare, unresolved name (`resolveBinary` returns the
  // bare name itself when nothing matched) would get hashed relative to the
  // CURRENT WORKING DIRECTORY, mislabeling a missing `claude` as a
  // provenance failure. So the #6708 health check gates the probe too, but —
  // "at minimum when a gate is on" — ONLY when `provenance` is supplied: this
  // function had NO health check at all before #8041 (unlike checkBinary),
  // and every existing caller with the gate off relies on `exec` alone
  // deciding pass/fail/missing, exactly as it always has. `null` here (not a
  // fail row) matches this function's own documented contract: the provider
  // binary check already surfaces a missing/quarantined claude.
  let execPath = resolved
  let provenanceAdvisory = null
  if (provenance) {
    const health = verify(resolved)
    if (!health.ok) {
      return null
    }
    execPath = health.path
    // #8041: route the probe through the opt-in provenance gate — a
    // `block`-mode hash mismatch or failed signature gate refuses the probe
    // outright, and the binary at `execPath` is NEVER exec'd.
    const verdict = verifyProvenance({
      resolvedPath: health.path,
      mode: provenance.mode,
      signatureGate: provenance.signatureGate === true,
      ledger: provenance.ledger || null,
    })
    if (verdict.blocked) {
      // #8074 review S3: return null, not a second `fail` row — the SAME
      // `claude` binary's own provider-preflight row (checkProvider, via
      // checkBinary against the identical provenance options) already
      // reports this exact refusal. Two rows for one blocked binary is
      // confusing, not informative, and this function's docblock already
      // promises "null when claude can't be run".
      return null
    }
    if (
      verdict.status === PROVENANCE_STATUS.HASH_MISMATCH
      || verdict.status === PROVENANCE_STATUS.SIGNATURE_INVALID
      || verdict.status === PROVENANCE_STATUS.UNREADABLE
    ) {
      log.warn(`Binary "claude" (${probeLabel} probe) provenance ${verdict.status}: ${verdict.message || ''} (allowed — mode=${provenance.mode})`)
      provenanceAdvisory = `provenance ${verdict.status}: ${verdict.message || 'unverifiable'}`
        + `${verdict.remediation ? ` — ${verdict.remediation}` : ''} (allowed — mode=${provenance.mode})`
    }
  }
  return { execPath, provenanceAdvisory }
}

/**
 * audit P1-3 / #5821: compare the installed claude CLI version against the
 * version chroxy's claude-tui form-driving was validated against
 * (TESTED_CLAUDE_TUI_CLI_VERSION). A major.minor drift is a `warn` — the
 * keystroke driving may mis-resolve forms after a CLI UI change; an exact or
 * patch-only difference is a `pass`. Returns null when claude can't be run (the
 * provider binary check already reports a missing claude). Dependency-injected
 * for tests.
 *
 * @param {object} [deps]
 * @param {(bin: string, args: string[]) => string} [deps.exec]
 * @param {string} [deps.tested]
 * @param {string[]} [deps.candidates] - fallback absolute paths for resolveBinary
 * @param {(name: string, candidates: string[]) => string} [deps.resolveBinary] -
 *   injectable resolver (test seam; defaults to the real PATH/candidate resolve)
 * @param {Function} [deps.verify] - binary health checker (injected in tests;
 *   #8074 review C2 — defaults to the real #6708 `verifyBinary`)
 * @param {{ mode: string, signatureGate: boolean, ledger: object|null }|null} [deps.provenance]
 *   - #8041: opt-in provenance options bag (`buildBinaryProvenanceOptions`); null
 *   (the default) skips the gate entirely, matching pre-#8041 behaviour.
 * @param {Function} [deps.verifyProvenance] - provenance checker (injected in tests)
 * @returns {{ name: string, status: 'pass'|'warn', message: string } | null}
 */
export function checkClaudeTuiCliVersion(deps = {}) {
  const {
    // #6484 — route through prepareSpawn so a `.cmd` shim (npm-only Windows host)
    // is run via cmd.exe instead of hitting Node 24's `.cmd` EINVAL. No-op for
    // `.exe`/POSIX. Most tests inject their own `exec`, bypassing this; the
    // win32-routing test exercises this default path directly.
    exec = (bin, args) => {
      const s = prepareSpawn(bin, args)
      return execFileSync(s.command, s.args, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], ...s.options })
    },
    tested = TESTED_CLAUDE_TUI_CLI_VERSION,
    // #5871: resolve against the SAME candidate paths the claude-tui provider
    // preflight uses, so this drift backstop isn't silently skipped in a
    // minimal-PATH (Tauri/launchd) install where the provider check still finds
    // claude via its candidate list — exactly the bundled context where a
    // silent mis-drive would otherwise go unnoticed.
    candidates = claudeTuiBinaryCandidates(),
    resolveBinary: resolveClaudeBinary = resolveBinary,
    verify = defaultVerifyBinary,
    provenance = null,
    verifyProvenance = defaultVerifyProvenance,
  } = deps
  const probe = resolveClaudeProbeBinary({ candidates, resolveBinary: resolveClaudeBinary, verify, provenance, verifyProvenance }, 'claude-tui driving')
  if (!probe) return null
  const { execPath, provenanceAdvisory } = probe
  // #8074 round-2 review: EVERY row this probe returns carries a pending
  // warn-mode advisory, not only the clean-baseline one — an earlier warn
  // (unparseable version, baseline drift) must not swallow it.
  const withAdvisory = (msg) => (provenanceAdvisory ? `${msg} — ${provenanceAdvisory}` : msg)
  let output
  try {
    output = exec(execPath, ['--version'])
  } catch {
    return null // claude missing/hung — the provider binary check surfaces that
  }
  const NAME = 'claude-tui driving'
  const found = parseLeadingSemver(output)
  const testedSemver = parseLeadingSemver(tested)
  if (found === null) {
    return { name: NAME, status: 'warn', message: withAdvisory(`Could not parse 'claude --version'; TUI form-driving is validated against ${tested}`) }
  }
  const foundStr = `${found[0]}.${found[1]}.${found[2]}`
  if (testedSemver && found[0] === testedSemver[0] && found[1] === testedSemver[1]) {
    // #8074 review S1: a pending provenance advisory (warn mode) must not be
    // silently absorbed into an otherwise-clean `pass` row.
    if (provenanceAdvisory) {
      return { name: NAME, status: 'warn', message: withAdvisory(`claude ${foundStr} matches the tested TUI-driving baseline (${tested})`) }
    }
    return { name: NAME, status: 'pass', message: `claude ${foundStr} matches the tested TUI-driving baseline (${tested})` }
  }
  return {
    name: NAME,
    status: 'warn',
    message: withAdvisory(`claude ${foundStr} differs from the tested TUI-driving baseline (${tested}) — chroxy drives the TUI by screen-scraping pinned keystrokes, so a CLI UI change can mis-drive AskUserQuestion forms silently. If question prompts misbehave, report it; re-validation will bump the baseline.`),
  }
}

const CLAUDE_LOGIN_UNREADABLE_MESSAGE = `Could not read the login state from \`claude auth status --json\` — if a claude-tui session reports AUTH_REQUIRED, run \`${CLAUDE_LOGIN_COMMAND}\` on this host.`

/**
 * #8223: report whether the `claude` on this host is logged in, from
 * `claude auth status --json` — the same question claude-tui asks before it
 * spawns a PTY. A logged-out host is otherwise discovered only when a session
 * fails to start. Never `fail`s: a doctor failure blocks `chroxy start`, and
 * "not logged in" is a state the operator fixes in a terminal, not a broken
 * install.
 *
 * Rows: `pass` "Logged in (<authMethod>[, <subscriptionType>])" for an explicit
 * `loggedIn: true`; `warn` for an explicit `loggedIn: false`, and `warn` when
 * the status cannot be read (timeout, unparseable output, no `loggedIn` field).
 * Returns null — no row — when `claude` cannot be run at all (missing,
 * quarantined, provenance-blocked): the provider binary row already says so.
 *
 * `claude auth status` exits 1 when logged out but still prints its JSON, so a
 * non-zero exit that carries stdout is read, not treated as unreadable. The
 * probe runs with ANTHROPIC_API_KEY removed from its env the way claude-tui
 * removes it from the PTY's, so it reports the subscription login rather than
 * an API key that claude-tui would never use. An EXPIRED oauth token still
 * reports `loggedIn: true`; only a live session's PTY scan sees expiry.
 *
 * @param {object} [deps] - same seams as `checkClaudeTuiCliVersion`, plus:
 * @param {(bin: string, args: string[], opts: { env: object }) => string} [deps.exec]
 *   returns stdout; may throw an error carrying `status` + `stdout` (non-zero exit)
 * @param {object} [deps.env] - environment the probe is derived from (default process.env)
 * @returns {{ name: string, status: 'pass'|'warn', message: string } | null}
 */
export function checkClaudeLogin(deps = {}) {
  const {
    // Same prepareSpawn routing as the version probe's default (#6484). The args
    // are always the literal ['auth', 'status', '--json'] from the one call below.
    exec = (bin, args, { env }) => {
      const s = prepareSpawn(bin, args)
      return execFileSync(s.command, s.args, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], env, ...s.options })
    },
    candidates = claudeTuiBinaryCandidates(),
    resolveBinary: resolveClaudeBinary = resolveBinary,
    verify = defaultVerifyBinary,
    provenance = null,
    verifyProvenance = defaultVerifyProvenance,
    env = process.env,
  } = deps
  const probe = resolveClaudeProbeBinary({ candidates, resolveBinary: resolveClaudeBinary, verify, provenance, verifyProvenance }, 'claude login')
  if (!probe) return null

  const NAME = 'Claude login'
  const probeEnv = { ...env }
  delete probeEnv.ANTHROPIC_API_KEY

  let stdout
  try {
    stdout = exec(probe.execPath, ['auth', 'status', '--json'], { env: probeEnv })
  } catch (err) {
    if (err?.code === 'ENOENT') return null // claude missing — the binary row says so
    if (typeof err?.status === 'number' && typeof err.stdout === 'string') {
      stdout = err.stdout // exit 1 = logged out, JSON still on stdout
    } else {
      return { name: NAME, status: 'warn', message: CLAUDE_LOGIN_UNREADABLE_MESSAGE }
    }
  }

  let status
  try {
    status = JSON.parse(String(stdout || ''))
  } catch {
    return { name: NAME, status: 'warn', message: CLAUDE_LOGIN_UNREADABLE_MESSAGE }
  }
  if (status?.loggedIn === true) {
    const how = [status.authMethod, status.subscriptionType].filter((v) => typeof v === 'string' && v.length > 0)
    return { name: NAME, status: 'pass', message: how.length > 0 ? `Logged in (${how.join(', ')})` : 'Logged in' }
  }
  if (status?.loggedIn === false) {
    return {
      name: NAME,
      status: 'warn',
      message: `Not logged in — run \`${CLAUDE_LOGIN_COMMAND}\` on this host. claude-tui needs it; claude-sdk needs it unless ANTHROPIC_API_KEY is set.`,
    }
  }
  return { name: NAME, status: 'warn', message: CLAUDE_LOGIN_UNREADABLE_MESSAGE }
}

/**
 * #5328 (WP-5.6) — default end-to-end routability probe for a named tunnel:
 * a HEAD request to the tunnel hostname with a hard timeout. ANY HTTP response
 * (even 4xx/5xx/426-upgrade, and whether it comes from the chroxy origin or a
 * Cloudflare edge error page) means the hostname resolves and the edge answered
 * — i.e. the route is live enough to reach. Only a network/DNS error or a
 * timeout (caught here, returned as `{ ok: false }`) means the path is broken.
 * Uses the Node 22 global `fetch` + `AbortController`; no new dependency.
 */
async function defaultHttpsProbe(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'manual' })
    return { ok: true, status: res.status }
  } catch (err) {
    const error = err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err?.message || String(err))
    return { ok: false, error }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * #5328 (WP-5.6) — probe whether a configured NAMED tunnel's hostname is
 * actually routable end-to-end, so `chroxy doctor` distinguishes "cloudflared
 * is installed" (the binary check) from "the edge → origin path resolves".
 *
 * Skipped (returns null) unless a named tunnel with a hostname is configured —
 * a quick tunnel's URL is random and runtime-only, so doctor can't know it
 * ahead of time. A reachable hostname is a `pass`; an unreachable one is a
 * `warn` (a diagnostic, not a hard failure: the daemon still runs on localhost).
 *
 * @param {object} [deps]
 * @param {string|null} [deps.hostname] - the configured named-tunnel hostname
 * @param {string|null} [deps.mode] - the configured tunnel mode ('named'|'quick'|'none')
 * @param {(url: string, timeoutMs: number) => Promise<{ ok: boolean, status?: number, error?: string }>} [deps.probe]
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<{ name: string, status: 'pass'|'warn', message: string } | null>}
 */
export async function checkTunnelRoutability(deps = {}) {
  const { hostname = null, mode = null, timeoutMs = 5000, probe = defaultHttpsProbe } = deps
  if (mode !== 'named' || typeof hostname !== 'string') return null
  const NAME = 'Tunnel routability'
  // Trim and reject anything that isn't a bare host — a stray scheme, path,
  // userinfo (`@`), or whitespace in the configured `tunnelHostname` would make
  // `https://${hostname}/` probe a DIFFERENT host than intended (or build an
  // invalid URL). Surface it as a warn rather than silently probing the wrong
  // place. A bare `host` or `host:port` is fine.
  const host = hostname.trim()
  if (host.length === 0) return null
  if (/[\s/@]/.test(host) || host.includes('://')) {
    return {
      name: NAME,
      status: 'warn',
      message: `Configured tunnelHostname '${hostname}' is not a bare host — expected e.g. 'tunnel.example.com', not a URL. Run 'chroxy tunnel setup' to (re)configure.`,
    }
  }
  let result
  try {
    result = await probe(`https://${host}/`, timeoutMs)
  } catch (err) {
    // A probe should resolve { ok: false }, never throw — but never let a
    // diagnostic crash the whole doctor run.
    result = { ok: false, error: err?.message || String(err) }
  }
  if (result && result.ok) {
    const code = typeof result.status === 'number' ? ` (HTTP ${result.status})` : ''
    return { name: NAME, status: 'pass', message: `${host} is reachable${code}` }
  }
  return {
    name: NAME,
    status: 'warn',
    message: `${host} did not respond${result?.error ? ` (${result.error})` : ''} — the DNS route may be missing or the named tunnel is down. Run 'chroxy tunnel setup' to (re)configure.`,
  }
}

/**
 * #8263: warn about a chroxy permission-hook entry in the USER-LEVEL Claude
 * settings. claude-tui children load that file as well as their per-session
 * settings, so a stranded entry used to double every permission prompt. The
 * hook script now stays inert for it inside a TUI child, so this is a hygiene
 * warning, not a live fault. Read-only: the daemon does not sweep or clean the
 * user-level file, because the entry may belong to a live claude-cli session of
 * another daemon (#8350) — the operator removes it.
 *
 * A file that exists but cannot be read or parsed is reported too: "could not
 * look" must not read the same as "nothing there" (a missing file is not an
 * error, and still yields null).
 *
 * @param {{settingsPath?: string}} [deps]
 * @returns {{ name: string, status: 'warn', message: string } | null} null when none found
 */
export function checkUserLevelChroxyHook({ settingsPath } = {}) {
  const { found, settingsPath: target, error } = countUserLevelChroxyHooks({ settingsPath })
  const NAME = 'User-level permission hook'
  if (error) {
    return {
      name: NAME,
      status: 'warn',
      message: `could not read user-level settings: ${error} (${target}) — a chroxy permission-hook entry there, if any, was not checked`,
    }
  }
  if (found === 0) return null
  return {
    name: NAME,
    status: 'warn',
    message: `${found} chroxy permission-hook entr${found === 1 ? 'y' : 'ies'} in ${target} — fix: remove the hooks.PreToolUse entry that runs permission-hook.sh from that file by hand (only when no claude-cli session is running; it is ignored inside claude-tui sessions)`,
  }
}

/**
 * Run all preflight dependency checks and return results.
 *
 * Provider-aware: only runs the binary/credential checks for the
 * provider(s) configured for this install. A Gemini-only user won't
 * fail because `claude` is missing, and a Claude-only user won't be
 * warned about missing `codex` or `OPENAI_API_KEY` (issue #2951).
 *
 * @param {Object} [options]
 * @param {number} [options.port] - Port to test availability for
 * @param {string[]} [options.providers] - Override configured providers (mainly for tests)
 * @param {boolean} [options.verbose]
 * @param {string} [options.pkgDir] - Override directory used to locate node_modules for the
 *   Dependencies check. Defaults to the server package root. Relative paths are resolved to
 *   absolute at call time so the check is fully decoupled from process.cwd(). Exposed so
 *   tests can point the check at a temp directory without mutating process.cwd().
 * @param {string|null} [options.tunnelMode] - #8116: override the named-tunnel mode used by
 *   the routability probe (step 5.6, #5328 WP-5.6). `undefined` (the default) reads it from
 *   doctor's own default config file, unchanged — `chroxy doctor` never passes this. Supplied
 *   (including `null`, meaning "no tunnel") it REPLACES the file-derived value entirely —
 *   `chroxy start` passes the MERGED config's own resolved tunnel mode (same seam shape as
 *   `binaryProvenanceMode`, #8074).
 * @param {string|null} [options.tunnelHostname] - Same override shape as `tunnelMode`, for the
 *   named-tunnel hostname.
 * @returns {{ checks: Array<{ name: string, status: 'pass'|'warn'|'fail', message: string, provider?: string }>, passed: boolean, providers: string[] }}
 */
export async function runDoctorChecks({
  port, providers, verbose: _verbose, pkgDir = SERVER_PKG_DIR, now = Date.now(),
  tunnelProbe, detectStranded = detectStrandedState, platform = process.platform,
  // #8116 — same seam shape as #8074's binaryProvenanceMode / #8115's
  // providers: `undefined` (the default) means "read the named-tunnel
  // coordinates for the routability probe (step 5.6 below) from doctor's own
  // default config file", exactly as before — `chroxy doctor` (doctor-cmd.js)
  // never passes these and is therefore unaffected. Supplied (even `null`,
  // meaning "no tunnel"), they REPLACE the file-derived value entirely —
  // `chroxy start` (server-cmd.js) passes both from the MERGED config it
  // already resolved (-c <path> / --tunnel / --tunnel-hostname /
  // CHROXY_TUNNEL* env), so the probe always targets the tunnel the daemon
  // it's about to start actually uses, not whichever tunnel the default file
  // happens to name.
  tunnelMode: tunnelModeOverride,
  tunnelHostname: tunnelHostnameOverride,
  // #8041 — test seams for the opt-in binary-provenance gate applied to the
  // cloudflared / provider-binary / claude-tui version probes below. All
  // default to the real production resolution so `chroxy doctor` / `chroxy
  // start` are unaffected:
  //   - `binaryProvenanceMode` / `binarySignatureGate` override the config +
  //     env resolution (`resolveBinaryProvenanceMode` / `isBinarySignatureGateEnabled`)
  //     entirely when supplied — a plain function-argument seam so a test can
  //     set the gate's mode WITHOUT resolving it from a real config file or
  //     `process.env`, exercising the gate logic directly. (#8074 review N4:
  //     this is not about test concurrency — this test runner's default is
  //     to run sibling `it()`s within one file SEQUENTIALLY; the seam exists
  //     so tests don't need a real config file at all, not to avoid a race.)
  //   - `binaryProvenanceLedger` overrides the lazily-constructed default-path
  //     ledger (undefined ⇒ construct one only when the gate resolves on,
  //     same as `resolveVerifiedClaudeBinary` in cli/session-cmd.js).
  verifyProvenance = defaultVerifyProvenance,
  binaryProvenanceLedger: binaryProvenanceLedgerOverride,
  binaryProvenanceMode: binaryProvenanceModeOverride,
  binarySignatureGate: binarySignatureGateOverride,
  // #8074 review C3(c): test-only resolver override for the claude-tui
  // version-pin probe specifically (see the call site below) — undefined in
  // production, so `checkClaudeTuiCliVersion` uses its own real resolver.
  claudeTuiResolveBinary,
  // #8223 test seam: overrides for the claude login probe (step 5.7) — `exec`,
  // `resolveBinary`, `verify`, `env`. Undefined in production, which uses the real
  // ones; without it a test would resolve and exec a REAL `claude` on the host.
  claudeLoginDeps = {},
  // #8041 test seam: cloudflared's fallback candidate paths, so a test can
  // point resolution at a fixture without depending on whether a REAL
  // cloudflared happens to be installed at one of the fixed production
  // candidates on the machine running the suite. Defaults to
  // `CLOUDFLARED_CANDIDATES`, imported from `tunnel/cloudflare.js` (#8074
  // review S2) rather than a second hand-kept copy — that module's own
  // `_verifyCloudflaredProvenance` gates the daemon's tunnel spawn against
  // this EXACT list, so doctor's pre-flight check and the daemon's real gate
  // can never silently diverge on which paths count as "cloudflared".
  cloudflaredCandidates = CLOUDFLARED_CANDIDATES,
  // #8263: opt-in (`chroxy doctor` passes true) so `chroxy start`'s preflight and
  // the unit tests never read the operator's real ~/.claude/settings.json.
  // `userHookSettingsPath` is the test seam for that read.
  checkUserLevelHook = false,
  userHookSettingsPath,
} = {}) {
  const checks = []

  // 1. Node.js version
  const nodeVersion = process.versions.node
  const major = parseInt(nodeVersion.split('.')[0], 10)
  if (major === 22) {
    checks.push({ name: 'Node.js', status: 'pass', message: `v${nodeVersion}` })
  } else if (major > 22) {
    checks.push({ name: 'Node.js', status: 'warn', message: `v${nodeVersion} — Node 22 is recommended` })
  } else {
    checks.push({ name: 'Node.js', status: 'fail', message: `v${nodeVersion} — Node 22 required` })
  }

  // 2. Load config (once) — used for the Config check, provider resolution,
  // AND (#8041) the binary-provenance gate below. Moved ahead of the
  // cloudflared check (previously step 2) because that check now needs the
  // gate's resolved mode/signatureGate before it can run.
  let configCheck = null
  // #5328 (WP-5.6): named-tunnel coordinates for the routability probe (step 5.6).
  let tunnelMode = null
  let tunnelHostname = null
  // #8041: the raw parsed config object, kept around (in addition to the
  // narrower locals above) so resolveBinaryProvenanceMode /
  // isBinarySignatureGateEnabled can read config.binaryProvenance the same
  // way chroxy start / chroxy resume do. Stays null when the file is
  // missing or fails to parse — both resolvers treat a missing
  // `binaryProvenance` key as gate-off, matching every other check in this
  // function's existing "a corrupt config degrades gracefully" behaviour
  // rather than hard-failing doctor itself.
  let parsedConfig = null
  if (existsSync(configFile())) {
    try {
      const config = JSON.parse(readFileSync(configFile(), 'utf-8'))
      parsedConfig = config
      // Normalize the tunnel mode through parseTunnelArg so aliases resolve —
      // e.g. `cloudflare:named` (a documented --tunnel form persisted verbatim)
      // maps to mode 'named' and isn't silently skipped by the routability
      // probe. parseTunnelArg throws on an unknown value; validateConfig already
      // surfaces that, so treat it as "no probe" here rather than crashing doctor.
      if (typeof config.tunnel === 'string') {
        try {
          tunnelMode = parseTunnelArg(config.tunnel)?.mode ?? null
        } catch {
          tunnelMode = null
        }
      }
      if (typeof config.tunnelHostname === 'string') tunnelHostname = config.tunnelHostname
      // #5419: register config-driven Anthropic-compatible endpoints before
      // provider resolution so a config.provider pointing at one preflights
      // its credential spec instead of failing as "Unknown provider".
      // Invalid entries are warned about (and surface again through
      // validateConfig below) and skipped.
      registerAnthropicCompatibleProviders(config)
      // #5420: register config-driven OpenAI-compatible endpoints too, same
      // rationale as above — a config.provider pointing at one preflights its
      // credential spec instead of failing as "Unknown provider".
      registerOpenAiCompatibleProviders(config)
      const { valid, warnings } = validateConfig(config)
      if (valid) {
        configCheck = { name: 'Config', status: 'pass', message: configFile() }
      } else {
        configCheck = { name: 'Config', status: 'warn', message: `${configFile()} — ${warnings.join('; ')}` }
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        configCheck = { name: 'Config', status: 'fail', message: `${configFile()} — invalid JSON: ${err.message}` }
      } else {
        configCheck = { name: 'Config', status: 'fail', message: `${configFile()} — ${err.message}` }
      }
    }
  } else {
    configCheck = { name: 'Config', status: 'warn', message: `Not found — run 'chroxy init' to create` }
  }

  // #8116: an explicit override REPLACES the file-derived coordinates above,
  // independently for mode and hostname (mirrors binaryProvenanceMode /
  // binarySignatureGate's independent-override shape below) — `undefined`
  // leaves the file-derived value in place, so `chroxy doctor` (which never
  // supplies either) is byte-identical to before this issue.
  if (tunnelModeOverride !== undefined) tunnelMode = tunnelModeOverride
  if (tunnelHostnameOverride !== undefined) tunnelHostname = tunnelHostnameOverride

  // 3. #8041 — resolve the opt-in binary-provenance gate ONCE, from the SAME
  // config + env precedence `chroxy start` / `chroxy resume` use
  // (resolveBinaryProvenanceMode / isBinarySignatureGateEnabled — env vars
  // CHROXY_BINARY_PROVENANCE / CHROXY_BINARY_SIGNATURE_GATE outrank the
  // config file), normalized through the SAME `buildBinaryProvenanceOptions`
  // helper #8065 added (utils/preflight.js) so "the gate is off" is defined
  // in exactly one place, not a second copy for doctor. The resolved bag is
  // shared by the cloudflared check below, every provider's binary check
  // (step 5), and the claude-tui version-pin probe (step 5.6) — one gate
  // resolution, one ledger instance, not three.
  //
  // The ledger is opened lazily, and only when a gate is actually ON
  // (#8065 review nitpick 3's rationale, reapplied here): a default
  // `chroxy doctor` / `chroxy start` run with gates off must never touch —
  // or warn about — the real `binary-trust.json`, since `buildBinaryProvenanceOptions`
  // is about to discard it anyway (returns null when the gate is off).
  const provenanceMode = binaryProvenanceModeOverride !== undefined
    ? binaryProvenanceModeOverride
    : resolveBinaryProvenanceMode(parsedConfig || {})
  const provenanceSignatureGate = binarySignatureGateOverride !== undefined
    ? binarySignatureGateOverride
    : isBinarySignatureGateEnabled(parsedConfig || {})
  const provenanceGateOn = provenanceMode !== 'off' || provenanceSignatureGate === true
  const binaryProvenanceLedger = binaryProvenanceLedgerOverride !== undefined
    ? binaryProvenanceLedgerOverride
    : (provenanceGateOn ? new BinaryProvenanceLedger() : null)
  const provenanceOptions = buildBinaryProvenanceOptions({
    mode: provenanceMode,
    signatureGate: provenanceSignatureGate,
    ledger: binaryProvenanceLedger,
  })

  // 4. cloudflared. #8041: gated through the SAME opt-in provenance options
  // the daemon's tunnel adapter uses (`_verifyCloudflaredProvenance`,
  // tunnel/cloudflare.js) — a block-mode hash mismatch or failed signature
  // gate now reports `fail` here WITHOUT ever exec'ing `cloudflared --version`.
  checks.push(checkBinary('cloudflared', ['--version'], {
    parseVersion: (out) => out.trim().split('\n')[0],
    required: true,
    candidates: cloudflaredCandidates,
    installHint: cloudflaredInstallHint(),
    provenance: provenanceOptions,
    verifyProvenance,
  }))

  // #7240 — state stranded at ~/.chroxy by a CHROXY_CONFIG_DIR relocation.
  // Computed before the Config check is pushed so the "Not found" branch above
  // can be corrected: recommending `chroxy init` when the real cause is an
  // unmoved config.json mints a fresh token and forces every device to re-pair,
  // which is strictly worse than the problem it purports to fix.
  let strandedCheck = null
  try {
    const raw = detectStranded()
    // #7244 — entries the operator acknowledged with `chroxy config-dir ack`
    // are dropped here; one that appeared afterwards is not, and still warns.
    // The same helper the startup warning uses, so the two cannot disagree.
    const stranded = applyStrandedAck(raw)
    if (stranded.unreadable) {
      strandedCheck = {
        name: 'Config/state root',
        status: 'warn',
        message: `${stranded.target} — could not check ${stranded.source} for stranded state: ${stranded.unreadable}`,
      }
    } else if (stranded.stranded.length > 0) {
      const sharp = stranded.highConsequence.length > 0
        ? ` (including ${stranded.highConsequence.join(', ')})`
        : ''
      // Bounded: a relocated root can strand an arbitrary number of entries and
      // doctor output is a single line per check. The high-consequence ones are
      // named separately above, so the truncated tail never hides the sharp cases.
      const MAX_NAMED = 8
      const named = stranded.stranded.slice(0, MAX_NAMED).join(', ')
      const rest = stranded.stranded.length - MAX_NAMED
      strandedCheck = {
        name: 'Config/state root',
        status: 'warn',
        message: `${stranded.target} (from CHROXY_CONFIG_DIR) — ${stranded.stranded.length} `
          + `state ${stranded.stranded.length === 1 ? 'entry is' : 'entries are'} still at `
          + `${stranded.source}${sharp}: ${named}${rest > 0 ? `, and ${rest} more` : ''}`
          + (stranded.acknowledged.length > 0 ? ` (${stranded.acknowledged.length} more acknowledged earlier)` : '')
          + ` — fix: chroxy config-dir migrate (or chroxy config-dir ack to keep this root on purpose)`,
      }
    } else {
      // Read the root off the detection, NOT from configDir()/process.env
      // directly: the detection is injectable, and a branch that bypasses the
      // seam reports something the caller did not ask about — which also makes
      // this message the one branch a test cannot pin.
      const acked = stranded.acknowledged.length
      strandedCheck = {
        name: 'Config/state root',
        status: 'pass',
        message: `${stranded.target}${stranded.relocated ? ' (from CHROXY_CONFIG_DIR)' : ''}`
          + (acked > 0
            ? ` — ${acked} state ${acked === 1 ? 'entry' : 'entries'} at ${stranded.source} acknowledged (chroxy config-dir ack)`
            : ''),
      }
    }
    // Judged on the RAW detection, not the acknowledgement-filtered one: an
    // acknowledged config.json is still absent from the root the daemon reads,
    // so "run 'chroxy init'" would still be the wrong advice for a missing
    // Config (#7244 — an acknowledgement quiets a warning, not a diagnosis).
    if (raw.relocated && !raw.unreadable && raw.highConsequence.includes('config.json')) {
      configCheck = {
        name: 'Config',
        status: 'fail',
        message: `Not found at ${configPath('config.json')} — it is still at `
          + `${join(raw.source, 'config.json')}. Do NOT run 'chroxy init' `
          + `(it mints a fresh token and forces every device to re-pair) — `
          + `run 'chroxy config-dir migrate' instead`,
      }
    }
  } catch (err) {
    strandedCheck = { name: 'Config/state root', status: 'warn', message: `Check failed: ${err.message}` }
  }

  // 5. Provider-specific checks. Each configured provider contributes its
  // own binary and credential checks. Providers not in the user's config
  // are skipped entirely — a Gemini-only install does NOT fail because
  // `claude` is missing (#2951).
  const resolvedProviders = resolveProviders({ providers, parsedConfig })
  for (const providerName of resolvedProviders) {
    const providerChecks = checkProvider(providerName, { platform, provenance: provenanceOptions, verifyProvenance })
    for (const c of providerChecks) checks.push(c)
  }

  // 5. Config check — appended after provider checks so per-provider
  // sections group together in the output report.
  checks.push(configCheck)
  // #7240 — immediately after Config: the root is the context that explains it.
  if (strandedCheck) checks.push(strandedCheck)

  // Credential storage (#6236). Surface WHERE the API token + credentials
  // actually live and whether the OS keychain is healthy — the #6235 fallback to
  // the 0600 file on a broken/missing login keychain is otherwise silent. A
  // broken keychain is a WARN (secrets work but aren't in the keychain + the
  // operator gets a repair hint); disabled/unsupported/usable are informational
  // PASS. keychainHealth() is non-prompting, so this never pops the macOS modal.
  const kh = keychainHealth()
  checks.push({
    name: 'Credential storage',
    status: kh.status === 'broken' ? 'warn' : 'pass',
    message:
      kh.status === 'usable'
        ? 'OS keychain'
        : kh.repairHint
          ? `file fallback — ${kh.detail} — fix: ${kh.repairHint}`
          : `file fallback — ${kh.detail}`,
  })

  if (checkUserLevelHook) {
    const hookCheck = checkUserLevelChroxyHook({ settingsPath: userHookSettingsPath })
    if (hookCheck) checks.push(hookCheck)
  }

  // 5.6 Tunnel routability (#5328 WP-5.6). For a configured NAMED tunnel, probe
  // the hostname end-to-end so a broken DNS route / down tunnel is visible here
  // rather than only as a failed remote connection later. Skipped for quick /
  // no tunnel (no stable hostname to probe). `tunnelProbe` is injectable so the
  // check is testable without a real network round-trip.
  const tunnelCheck = await checkTunnelRoutability({
    hostname: tunnelHostname,
    mode: tunnelMode,
    ...(tunnelProbe ? { probe: tunnelProbe } : {}),
  })
  if (tunnelCheck) checks.push(tunnelCheck)

  // 5.5 Billing canary (#5821, audit rec #4). Standalone-feasible half of the
  // canary: the silent-metered-default check needs only the resolved default
  // provider + the clock. (The reclassification + datacenter-egress checks in
  // doctor-billing.js need live daemon state / a network lookup, so they're
  // consumed by the daemon/dashboard, not this preflight.) Use the same
  // resolution as the provider checks above — explicit `providers` override
  // wins (for tests), else config.provider, else DEFAULT_PROVIDER — so the
  // billing line tracks whichever provider a zero-config session would use.
  const effectiveDefault = resolvedProviders[0] || DEFAULT_PROVIDER
  // billing-class refinement: claude-sdk authed with an explicit ANTHROPIC_API_KEY
  // bills the raw API account (api-key), not the metered credit pool — so a BYOK
  // default must not trip a false silent-metered warning. claude-cli strips the key
  // before spawn, so the env var doesn't change its class; only claude-sdk honours
  // it here, matching sdk-session's auth resolution.
  const apiKeyAuth = effectiveDefault === 'claude-sdk' && Boolean(process.env.ANTHROPIC_API_KEY)
  const meteredWarnings = detectSilentMeteredDefault(effectiveDefault, now, { apiKeyAuth })
  if (meteredWarnings.length > 0) {
    checks.push({ name: 'Billing', status: 'warn', message: meteredWarnings[0].message })
  } else {
    const billingClass = billingClassForProvider(effectiveDefault, now, { apiKeyAuth })
    const detail = billingDetailForClass(billingClass)
    if (isProgrammaticCreditEra(now)) {
      checks.push({
        name: 'Billing',
        status: 'pass',
        message: `Default provider '${effectiveDefault}' — ${detail}`,
      })
    } else {
      // Pre-cutover: nothing meters yet, but surface the upcoming boundary and
      // what the default will bill once it lands.
      const cutover = new Date(PROGRAMMATIC_CREDIT_ERA_START).toISOString().slice(0, 10)
      checks.push({
        name: 'Billing',
        status: 'pass',
        message: `Default provider '${effectiveDefault}' — ${detail}. Programmatic-credit cutover: ${cutover}.`,
      })
    }
  }

  // 5.6 claude-tui CLI version pin (audit P1-3, #5821 backstop). The claude-tui
  // provider drives the real `claude` TUI by screen-scraping pinned keystrokes
  // (no structured answer channel), so a CLI UI change can mis-drive
  // AskUserQuestion forms SILENTLY. Surface a major.minor drift from the tested
  // version as a measured warning instead. Only meaningful when the default
  // provider actually drives the TUI.
  if (effectiveDefault === 'claude-tui') {
    // #8074 review C3(c): `claudeTuiResolveBinary` is a test-only seam
    // (undefined in production, so `checkClaudeTuiCliVersion` falls back to
    // its own real `resolveBinary`) — it lets a test point this probe's
    // resolution at a fixture, so the provenance-gate WIRING between
    // `runDoctorChecks` and `checkClaudeTuiCliVersion` (mutant R2: the probe
    // called with `provenance` dropped) is testable hermetically, without
    // depending on whether a real `claude` binary happens to resolve on the
    // machine running the suite.
    const tuiCheck = checkClaudeTuiCliVersion({
      provenance: provenanceOptions,
      verifyProvenance,
      ...(claudeTuiResolveBinary ? { resolveBinary: claudeTuiResolveBinary } : {}),
    })
    if (tuiCheck) checks.push(tuiCheck)
  }

  // 5.7 Claude login (#8223). claude-tui always needs the subscription login;
  // claude-sdk needs it unless ANTHROPIC_API_KEY supplies the credential, so a
  // BYOK-key host is not warned about a login it does not use. `claudeLoginDeps`
  // is the test seam (exec / resolver / env); production passes nothing.
  const needsClaudeLogin = resolvedProviders.includes('claude-tui')
    || (resolvedProviders.includes('claude-sdk') && !process.env.ANTHROPIC_API_KEY)
  if (needsClaudeLogin) {
    const loginCheck = checkClaudeLogin({
      provenance: provenanceOptions,
      verifyProvenance,
      ...claudeLoginDeps,
    })
    if (loginCheck) checks.push(loginCheck)
  }

  // 6. Dependencies
  // Resolve deps relative to the server package, not process.cwd() — Tauri
  // launches the server with cwd='/' under launchd, which would always
  // fail a `${process.cwd()}/node_modules` check. Tests may override
  // `pkgDir` to point at a temp directory. Normalize to an absolute
  // path so a relative `pkgDir` can't reintroduce cwd coupling.
  //
  // Also handles npm workspace hoisting: deps may live in a parent
  // node_modules/ when installed via `npm ci --workspace=@chroxy/server`.
  // The helper walks up the tree and uses createRequire as a reliable
  // proxy for whether deps are installed.
  //
  // Context-aware severity: when running inside a bundled .app (Tauri) or
  // under the supervisor, a missing node_modules is unactionable for the
  // end user — they can't run `npm install` to fix it, they need a new
  // build or reinstall. In that context we downgrade to `warn` and provide
  // an appropriate message. In a dev environment the original `fail` +
  // "run npm install" message is preserved.
  if (typeof pkgDir !== 'string' || pkgDir.length === 0) {
    throw new TypeError(`pkgDir must be a non-empty string, got ${typeof pkgDir}`)
  }
  const absPkgDir = isAbsolute(pkgDir) ? pkgDir : resolve(pkgDir)
  const deps = checkDependencies({
    startDir: absPkgDir,
    probes: ['commander', 'ws', '@anthropic-ai/claude-agent-sdk'],
  })
  if (deps.ok) {
    checks.push({ name: 'Dependencies', status: 'pass', message: `resolved via ${deps.foundAt}` })
  } else {
    if (isBundledOrSupervisedContext()) {
      checks.push({
        name: 'Dependencies',
        status: 'warn',
        message: `${deps.message || 'dependencies not found'} — reinstall Chroxy or rebuild the app`,
      })
    } else {
      checks.push({
        name: 'Dependencies',
        status: 'fail',
        message: `${deps.message || 'dependencies not found'} — run npm install`,
      })
    }
  }

  // 7. Port availability
  const checkPort = port || 8765
  try {
    await checkPortAvailable(checkPort)
    checks.push({ name: 'Port', status: 'pass', message: `${checkPort} is available` })
  } catch {
    checks.push({ name: 'Port', status: 'warn', message: `${checkPort} is in use (server may already be running)` })
  }

  const passed = checks.every(c => c.status !== 'fail')
  return { checks, passed, providers: resolvedProviders }
}

/**
 * Run the binary + credential preflight for a single registered provider.
 *
 * Reads `ProviderClass.preflight` to learn what binary and env vars the
 * provider needs. Unknown providers contribute a single `fail` check so
 * bad config is reported rather than silently ignored.
 *
 * @param {string} providerName
 * @param {object} [opts]
 * @param {string} [opts.platform] - defaults to `process.platform`; injectable
 *   for tests exercising the `requiresDirectExec` shim refusal (#7986 review S2)
 * @param {{ mode: string, signatureGate: boolean, ledger: object|null }|null} [opts.provenance]
 *   - #8041: opt-in provenance options (`buildBinaryProvenanceOptions`); forwarded
 *   to `checkBinary`. null (the default) skips the gate entirely.
 * @param {Function} [opts.verifyProvenance] - provenance checker (injected in tests)
 * @returns {Array<{ name: string, status: 'pass'|'warn'|'fail', message: string, provider: string }>}
 */
function checkProvider(providerName, { platform = process.platform, provenance = null, verifyProvenance = defaultVerifyProvenance } = {}) {
  let ProviderClass
  try {
    ProviderClass = getProvider(providerName)
  } catch (err) {
    return [{
      name: `Provider: ${providerName}`,
      status: 'fail',
      message: err.message,
      provider: providerName,
    }]
  }

  const spec = ProviderClass.preflight
  if (!spec) {
    // Provider doesn't declare preflight requirements — nothing to check.
    // Not a failure; e.g. docker-cli/docker-sdk reuse upstream provider
    // binaries and can opt out.
    return []
  }

  const out = []
  if (spec.binary) {
    // #7986 review S2: a provider that declares `requiresDirectExec: true`
    // (the Agent SDK spawns its binary with no shell) can never run a
    // Windows npm shim (`claude.cmd`/`claude.bat`) — `chroxy start`'s own
    // preflight refuses it via ProviderBinaryUnsupportedError, but `doctor`
    // runs its OWN binary check (checkBinary, below) rather than
    // runProviderPreflight, so it needs the same refusal or it would report
    // a shim as a healthy "pass". Checked BEFORE the exec-for-version probe:
    // resolve the exact path the real spawn would use (the provider's live
    // `resolvedBinary` when it exposes one, else a fresh candidate resolve —
    // same preference order runProviderPreflight uses) and fail the row
    // outright when that path is a shell shim, without ever exec'ing it.
    let shimResolvedPath = null
    if (spec.binary.requiresDirectExec === true) {
      // Same guard runProviderPreflight uses: a subclass getter may throw.
      try {
        shimResolvedPath = ProviderClass.resolvedBinary
      } catch { /* fall through to a fresh candidate resolve */ }
      if (typeof shimResolvedPath !== 'string' || shimResolvedPath.length === 0) {
        shimResolvedPath = resolveBinary(spec.binary.name, spec.binary.candidates || [])
      }
    }
    if (shimResolvedPath !== null && isShellShim(shimResolvedPath, platform)) {
      out.push({
        name: spec.binary.name,
        status: 'fail',
        message: `${shimResolvedPath} — the ${spec.label || providerName} provider spawns ${spec.binary.name} directly without a shell, so it needs the native executable (for claude, \`claude.exe\` from the native installer), not an npm shim`,
        provider: providerName,
      })
    } else {
      const bin = checkBinary(spec.binary.name, spec.binary.args || ['--version'], {
        parseVersion: spec.binary.parseVersion || ((out) => out.trim().split('\n')[0]),
        required: true,
        candidates: spec.binary.candidates || [],
        installHint: spec.binary.installHint || `install ${spec.binary.name}`,
        // #3953: providers may declare a minimum binary version (e.g.
        // claude-channel needs `claude` ≥ 2.1.80 for the --channels MCP
        // transport). checkBinary parses the leading semver out of the
        // version output and fails when it's below the floor. The field may be
        // a thunk (claude-sdk derives its floor from the SDK, #7986), so it is
        // resolved through the same helper preflight uses, never read raw.
        minVersion: resolveDeclaredMinVersion(spec.binary.minVersion),
        // #8031: a soft, advisory floor — below it downgrades to `warn`
        // (never blocks server startup), same resolve helper as minVersion.
        recommendedVersion: resolveDeclaredMinVersion(spec.binary.recommendedVersion),
        updateHint: spec.binary.updateHint,
        // #8041: opt-in provenance gate, forwarded straight through to
        // checkBinary — see its docblock for the gate's shape.
        provenance,
        verifyProvenance,
      })
      bin.provider = providerName
      out.push(bin)
    }
  }

  if (spec.credentials && Array.isArray(spec.credentials.envVars) && spec.credentials.envVars.length > 0) {
    const matched = spec.credentials.envVars.find(v => process.env[v])
    const credName = `${spec.label || providerName} credentials`
    if (matched) {
      out.push({ name: credName, status: 'pass', message: `${matched} is set`, provider: providerName })
    } else {
      const joined = spec.credentials.envVars.join(' or ')
      const hint = spec.credentials.hint || `set ${joined}`
      // Optional credentials (e.g. Claude — login subscription also works)
      // downgrade to `warn` so absent env vars don't block server startup.
      const status = spec.credentials.optional ? 'warn' : 'fail'
      out.push({
        name: credName,
        status,
        message: `${joined} not set — ${hint}`,
        provider: providerName,
      })
    }
  }

  return out
}

/**
 * Check if a binary is available and return its version.
 * Differentiates between not-found and timeout errors.
 *
 * `candidates` gives fallback absolute paths to try when the binary is not
 * on PATH — important for GUI-launched processes (e.g. Tauri) whose
 * inherited PATH excludes user-local install dirs.
 *
 * #8041: `provenance` is the opt-in provenance options bag
 * (`buildBinaryProvenanceOptions`, utils/preflight.js) — null (the default)
 * skips the gate entirely, byte-identical to pre-#8041 behaviour. When
 * supplied and enabled, the SAME `verifyProvenance` (utils/verify-provenance.js)
 * the daemon's `runProviderPreflight` and the tunnel adapter's
 * `_verifyCloudflaredProvenance` both call is run against `resolved`, BEFORE
 * the version-probe exec below: a `block`-mode hash mismatch or failed
 * signature gate returns a `fail` check and the binary is NEVER exec'd. A
 * `warn`-mode (or unverifiable-but-allowed) issue is logged and the check
 * proceeds to exec as normal.
 *
 * Exported for tests — callers in production should use `runDoctorChecks`.
 */
export function checkBinary(name, args, {
  parseVersion, required, installHint, candidates = [], minVersion = null,
  recommendedVersion = null, updateHint = null, verify = defaultVerifyBinary,
  provenance = null, verifyProvenance = defaultVerifyProvenance,
}) {
  // #8074 review N3: this re-resolves via `resolveBinary(name, candidates)`
  // rather than preferring `ProviderClass.resolvedBinary` the way
  // `runProviderPreflight` (and `checkProvider`'s own shim check, just above
  // in this file) do. That is a live parity ASSUMPTION, not a proof: every
  // provider's `resolvedBinary` getter today is `resolveBinary(spec.binary.name,
  // spec.binary.candidates)` — the identical call — so the two can't diverge
  // currently. If a provider ever overrides `resolvedBinary` with something
  // that does NOT reduce to that same call (e.g. a live, already-spawned
  // process's actual path), this check and the real spawn could gate/probe
  // different paths. Passing the pre-resolved path through would make that
  // parity structural instead of assumed; left as a comment (optional per
  // review) since no current provider does this.
  const resolved = resolveBinary(name, candidates)
  // #6708 — integrity gate BEFORE we try to exec for a version. A macOS
  // Gatekeeper-quarantined binary keeps its X bit, and a present-but-non-
  // executable binary throws EACCES in the version probe — in both cases the
  // catch below would mislabel it "Not found — install …". Detect them up front
  // so doctor reports "quarantined/blocked" and "not executable" distinctly from
  // "not installed", each with its own fix-it hint. The quarantine step is a
  // no-op off darwin; NOT_FOUND still falls through to the version probe (whose
  // catch owns the install message).
  const health = verify(resolved)
  if (health.status === BINARY_STATUS.QUARANTINED || health.status === BINARY_STATUS.NOT_EXECUTABLE) {
    const { message } = describeBinaryHealth(health, { binary: name, installHint })
    return { name, status: required ? 'fail' : 'warn', message }
  }
  // #8041 — opt-in provenance gate, on the SAME healthy `resolved` path,
  // BEFORE the version-probe exec below. Fail-safe: a `block`-mode hash
  // mismatch or a failed signature gate reports `fail` here and returns
  // immediately — the try block below (the only exec in this function) never
  // runs. Always a hard `fail` (never downgraded by `required`) — see
  // `provenanceBlockedCheck`'s docblock.
  //
  // #8074 review C2: the gate must never run on a path `verify()` didn't
  // confirm healthy (i.e. `!health.ok` — NOT_FOUND, since QUARANTINED/
  // NOT_EXECUTABLE already returned above). `verifyProvenance`'s contract
  // assumes an otherwise-healthy, absolute, resolved path — the SAME
  // precondition `runProviderPreflight` and the tunnel adapter's
  // `_verifyCloudflaredProvenance` already honor ("provenance must not mask
  // 'cloudflared not installed'"). Skipping this check meant a bare,
  // unresolved name (`resolveBinary` returns the bare `name` itself when
  // nothing matched) got hashed relative to the CURRENT WORKING DIRECTORY —
  // mislabeling a genuinely missing binary as a provenance failure in block
  // mode ("provenance unreadable" instead of "Not found"), and in warn mode
  // could TOFU-pin a same-named file that happens to sit in cwd under that
  // bare, relative key — a path the real exec never runs, since its OWN
  // PATH lookup resolves independently. So: report the ordinary "Not found"
  // failure immediately, exactly as the exec's own catch block would below,
  // without ever calling `verifyProvenance` or attempting the exec.
  if (provenance && !health.ok) {
    return { name, status: required ? 'fail' : 'warn', message: `Not found — ${installHint}` }
  }
  // #8074 review S1: a warn-mode (or unverifiable-but-allowed) provenance
  // issue used to ONLY log — the doctor row itself stayed `pass`, so `chroxy
  // doctor`/`chroxy start` printed a clean "[ OK ]" for a binary whose
  // provenance just flagged an issue. `provenanceAdvisory` carries that note
  // through to the row built below (the check still execs normally and
  // reports the real version — warn mode is "surfaced but allowed", not
  // "skip the probe", matching every other warn-mode consumer of this gate)
  // rather than short-circuiting before the exec. `server-cmd.js` only
  // filters on `status === 'fail'`, so `chroxy start` still only stops on a
  // `block`-mode refusal above — this never blocks startup.
  let provenanceAdvisory = null
  if (provenance) {
    const verdict = verifyProvenance({
      resolvedPath: health.path,
      mode: provenance.mode,
      signatureGate: provenance.signatureGate === true,
      ledger: provenance.ledger || null,
    })
    if (verdict.blocked) {
      return provenanceBlockedCheck(name, health.path, verdict)
    }
    if (
      verdict.status === PROVENANCE_STATUS.HASH_MISMATCH
      || verdict.status === PROVENANCE_STATUS.SIGNATURE_INVALID
      || verdict.status === PROVENANCE_STATUS.UNREADABLE
    ) {
      log.warn(`Binary "${name}" provenance ${verdict.status}: ${verdict.message || ''} (allowed — mode=${provenance.mode})`)
      provenanceAdvisory = `provenance ${verdict.status}: ${verdict.message || 'unverifiable'}`
        + `${verdict.remediation ? ` — ${verdict.remediation}` : ''} (allowed — mode=${provenance.mode})`
    }
  }
  // #8074 round-2 review: every version row below carries the advisory — a
  // min/recommended-version warn or fail returning first must not drop it.
  const withAdvisory = (msg) => (provenanceAdvisory ? `${msg} — ${provenanceAdvisory}` : msg)
  try {
    // #6484 — a resolved `.cmd` shim (npm-only Windows host) can't be spawned
    // directly on Node 24; route it through cmd.exe via prepareSpawn. No-op for
    // a `.exe` and on POSIX, so non-Windows binary checks are unchanged.
    const spawnSpec = prepareSpawn(resolved, args)
    const output = execFileSync(spawnSpec.command, spawnSpec.args, {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], ...spawnSpec.options,
    })
    const message = parseVersion(output)
    // #3953: when the provider declares a minimum version, parse the
    // leading semver out of the (already pretty-printed) version message
    // and fail the check below the floor. If the version can't be parsed
    // we don't block the user — we surface a warn so a format change in
    // the upstream CLI doesn't hard-fail an otherwise-working install.
    // #8031: `recommendedVersion` is a SOFT floor, checked with the same
    // parsed `found` — below it downgrades to `warn` regardless of
    // `required` (a soft check never aborts `chroxy start`), never `fail`.
    let found = null
    if (minVersion || recommendedVersion) {
      found = parseLeadingSemver(message)
    }
    if (minVersion) {
      if (found === null) {
        return {
          name,
          status: 'warn',
          message: withAdvisory(`${message} — could not parse version to verify ≥ ${minVersion}`),
        }
      }
      if (compareSemver(found, minVersion) < 0) {
        return {
          name,
          status: required ? 'fail' : 'warn',
          message: withAdvisory(`${message} — requires ${name} ≥ ${minVersion}; ${installHint}`),
        }
      }
    }
    // Only reached once the hard floor (if any) is satisfied. When ONLY
    // `recommendedVersion` is declared and `found` couldn't be parsed, this
    // is silently skipped — an unparseable version is not itself a defect
    // for a soft, advisory check (the hard-floor branch above already owns
    // the "could not parse" warning when a min is also declared). A
    // `recommendedVersion` that is itself unparseable is ignored the same
    // way: compareSemver fails CLOSED on a malformed floor, which is right
    // for minVersion but would turn a bad advisory into a spurious warn —
    // preflight gates this check on a parsed recommended version too.
    if (recommendedVersion && found !== null && parseLeadingSemver(recommendedVersion) !== null
      && compareSemver(found, recommendedVersion) < 0) {
      return {
        name,
        status: 'warn',
        message: withAdvisory(`${message} — older than the recommended ${name} ${recommendedVersion}; ${updateHint || installHint}`),
      }
    }
    if (provenanceAdvisory) {
      return { name, status: 'warn', message: withAdvisory(message) }
    }
    return { name, status: 'pass', message }
  } catch (err) {
    if (err.killed || err.signal === 'SIGTERM') {
      // Timeout — binary exists but hung
      return {
        name,
        status: required ? 'fail' : 'warn',
        message: `Timed out — ${name} may be hanging or misconfigured`,
      }
    }
    return {
      name,
      status: required ? 'fail' : 'warn',
      message: `Not found — ${installHint}`,
    }
  }
}

function checkPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (err) => {
      reject(err)
    })
    server.once('listening', () => {
      server.close(() => resolve())
    })
    server.listen(port, '127.0.0.1')
  })
}
