import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { createServer } from 'net'
import { validateConfig } from './config.js'
import { resolveBinary } from './utils/resolve-binary.js'
import { prepareSpawn } from './utils/win-spawn.js'
import { cloudflaredInstallHint } from './platform.js'
import { getProvider, DEFAULT_PROVIDER } from './providers.js'
import { registerAnthropicCompatibleProviders } from './anthropic-compatible-session.js'
import { registerOpenAiCompatibleProviders } from './openai-compatible-session.js'
import { parseTunnelArg } from './tunnel/index.js'
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
const CONFIG_FILE = join(process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy'), 'config.json')

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
 * Precedence:
 *   1. Explicit `providers` option (array of provider names)
 *   2. `provider` field from loaded config file
 *   3. DEFAULT_PROVIDER (see providers.js)
 *
 * Returns an array of provider name strings.
 */
function resolveProviders({ providers, configProvider }) {
  if (Array.isArray(providers) && providers.length > 0) return providers
  if (typeof configProvider === 'string' && configProvider.length > 0) return [configProvider]
  return [DEFAULT_PROVIDER]
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
  } = deps
  let output
  try {
    output = exec(resolveBinary('claude', candidates), ['--version'])
  } catch {
    return null // claude missing/hung — the provider binary check surfaces that
  }
  const NAME = 'claude-tui driving'
  const found = parseLeadingSemver(output)
  const testedSemver = parseLeadingSemver(tested)
  if (found === null) {
    return { name: NAME, status: 'warn', message: `Could not parse 'claude --version'; TUI form-driving is validated against ${tested}` }
  }
  const foundStr = `${found[0]}.${found[1]}.${found[2]}`
  if (testedSemver && found[0] === testedSemver[0] && found[1] === testedSemver[1]) {
    return { name: NAME, status: 'pass', message: `claude ${foundStr} matches the tested TUI-driving baseline (${tested})` }
  }
  return {
    name: NAME,
    status: 'warn',
    message: `claude ${foundStr} differs from the tested TUI-driving baseline (${tested}) — chroxy drives the TUI by screen-scraping pinned keystrokes, so a CLI UI change can mis-drive AskUserQuestion forms silently. If question prompts misbehave, report it; re-validation will bump the baseline.`,
  }
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
 * @returns {{ checks: Array<{ name: string, status: 'pass'|'warn'|'fail', message: string, provider?: string }>, passed: boolean, providers: string[] }}
 */
export async function runDoctorChecks({ port, providers, verbose: _verbose, pkgDir = SERVER_PKG_DIR, now = Date.now(), tunnelProbe } = {}) {
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

  // 2. cloudflared
  checks.push(checkBinary('cloudflared', ['--version'], {
    parseVersion: (out) => out.trim().split('\n')[0],
    required: true,
    candidates: [
      '/opt/homebrew/bin/cloudflared',
      '/usr/local/bin/cloudflared',
      join(homedir(), '.local/bin/cloudflared'),
    ],
    installHint: cloudflaredInstallHint(),
  }))

  // 3. Load config (once) — used for both the Config check and provider resolution.
  let configProvider = null
  let configCheck = null
  // #5328 (WP-5.6): named-tunnel coordinates for the routability probe (step 5.6).
  let tunnelMode = null
  let tunnelHostname = null
  if (existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
      if (typeof config.provider === 'string') configProvider = config.provider
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
        configCheck = { name: 'Config', status: 'pass', message: CONFIG_FILE }
      } else {
        configCheck = { name: 'Config', status: 'warn', message: `${CONFIG_FILE} — ${warnings.join('; ')}` }
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        configCheck = { name: 'Config', status: 'fail', message: `${CONFIG_FILE} — invalid JSON: ${err.message}` }
      } else {
        configCheck = { name: 'Config', status: 'fail', message: `${CONFIG_FILE} — ${err.message}` }
      }
    }
  } else {
    configCheck = { name: 'Config', status: 'warn', message: `Not found — run 'npx chroxy init' to create` }
  }

  // 4. Provider-specific checks. Each configured provider contributes its
  // own binary and credential checks. Providers not in the user's config
  // are skipped entirely — a Gemini-only install does NOT fail because
  // `claude` is missing (#2951).
  const resolvedProviders = resolveProviders({ providers, configProvider })
  for (const providerName of resolvedProviders) {
    const providerChecks = checkProvider(providerName)
    for (const c of providerChecks) checks.push(c)
  }

  // 5. Config check — appended after provider checks so per-provider
  // sections group together in the output report.
  checks.push(configCheck)

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
    const tuiCheck = checkClaudeTuiCliVersion()
    if (tuiCheck) checks.push(tuiCheck)
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
 * @returns {Array<{ name: string, status: 'pass'|'warn'|'fail', message: string, provider: string }>}
 */
function checkProvider(providerName) {
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
    const bin = checkBinary(spec.binary.name, spec.binary.args || ['--version'], {
      parseVersion: spec.binary.parseVersion || ((out) => out.trim().split('\n')[0]),
      required: true,
      candidates: spec.binary.candidates || [],
      installHint: spec.binary.installHint || `install ${spec.binary.name}`,
      // #3953: providers may declare a minimum binary version (e.g.
      // claude-channel needs `claude` ≥ 2.1.80 for the --channels MCP
      // transport). checkBinary parses the leading semver out of the
      // version output and fails when it's below the floor.
      minVersion: spec.binary.minVersion || null,
    })
    bin.provider = providerName
    out.push(bin)
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
 * Exported for tests — callers in production should use `runDoctorChecks`.
 */
export function checkBinary(name, args, { parseVersion, required, installHint, candidates = [], minVersion = null }) {
  const resolved = resolveBinary(name, candidates)
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
    if (minVersion) {
      const found = parseLeadingSemver(message)
      if (found === null) {
        return {
          name,
          status: 'warn',
          message: `${message} — could not parse version to verify ≥ ${minVersion}`,
        }
      }
      if (compareSemver(found, minVersion) < 0) {
        return {
          name,
          status: required ? 'fail' : 'warn',
          message: `${message} — requires ${name} ≥ ${minVersion}; ${installHint}`,
        }
      }
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
