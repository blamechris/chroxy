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
    checks.push({
      name: 'Dependencies',
      status: 'fail',
      message: `${deps.message || 'dependencies not found'} — run npm install`,
    })
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
export function checkBinary(name, args, { parseVersion, required, installHint, candidates = [] }) {
  const resolved = resolveBinary(name, candidates)
  try {
    const output = execFileSync(resolved, args, {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { name, status: 'pass', message: parseVersion(output) }
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
