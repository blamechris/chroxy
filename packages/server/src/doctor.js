import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { homedir, platform } from 'os'
import { createServer } from 'net'
import { validateConfig } from './config.js'
import { resolveBinary } from './utils/resolve-binary.js'
import { getProvider } from './providers.js'
import { checkDependencies } from './utils/check-dependencies.js'

// Resolve the server package root (the directory containing package.json
// and node_modules) so dependency checks work regardless of where the
// server process was launched. `import.meta.url` points to this file at
// src/doctor.js — two `dirname` calls walk from the file up through
// src/ to the package root.
const __filename = fileURLToPath(import.meta.url)
const SERVER_PKG_DIR = dirname(dirname(__filename))

const CONFIG_FILE = join(homedir(), '.chroxy', 'config.json')

/**
 * Default provider used when no config file exists and no explicit
 * provider is passed. Mirrors server-cli.js `config.provider || 'claude-sdk'`.
 */
const DEFAULT_PROVIDER = 'claude-sdk'

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
 *   3. DEFAULT_PROVIDER ('claude-sdk')
 *
 * Returns an array of provider name strings.
 */
function resolveProviders({ providers, configProvider }) {
  if (Array.isArray(providers) && providers.length > 0) return providers
  if (typeof configProvider === 'string' && configProvider.length > 0) return [configProvider]
  return [DEFAULT_PROVIDER]
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
export async function runDoctorChecks({ port, providers, verbose: _verbose, pkgDir = SERVER_PKG_DIR } = {}) {
  const checks = []
  const isMac = platform() === 'darwin'
  const isLinux = platform() === 'linux'

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
    installHint: isMac ? 'brew install cloudflared'
      : isLinux ? 'see https://pkg.cloudflare.com/ for installation'
      : 'see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
  }))

  // 3. Load config (once) — used for both the Config check and provider resolution.
  let configProvider = null
  let configCheck = null
  if (existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
      if (typeof config.provider === 'string') configProvider = config.provider
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
    const output = execFileSync(resolved, args, {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
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
