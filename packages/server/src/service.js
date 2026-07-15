import { homedir, platform } from 'os'
import { join, dirname, win32 as pathWin32 } from 'path'
import { existsSync, readFileSync, mkdirSync, unlinkSync, readdirSync, writeFileSync, chmodSync } from 'fs'
import { writeFileRestricted, isWindows } from './platform.js'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const SERVICE_LABEL = 'com.chroxy.server'
const DEFAULT_CONFIG_DIR = join(homedir(), '.chroxy')
const WRAPPER_NAME = 'service-wrapper.sh'
// Windows Task Scheduler autostart (#6647). The task name the daemon registers
// under, and the .cmd wrapper it runs (the Windows analogue of WRAPPER_NAME).
const WINDOWS_TASK_NAME = 'Chroxy'
const WINDOWS_WRAPPER_NAME = 'service-wrapper.cmd'

// Keychain coordinates for secrets resolved by the service wrapper at spawn
// time. The api-token pair mirrors keychain.js (service 'chroxy', account
// 'api-token'); the webhook pair mirrors the deployed workaround for #5490
// (service 'chroxy-discord-webhook', account 'webhook-url').
const KEYCHAIN_API_TOKEN = { service: 'chroxy', account: 'api-token', env: 'API_TOKEN' }
const KEYCHAIN_DISCORD_WEBHOOK = {
  service: 'chroxy-discord-webhook',
  account: 'webhook-url',
  env: 'CHROXY_DISCORD_WEBHOOK_URL',
}

/**
 * Escape XML special characters in a string.
 */
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Returns platform-specific service file paths.
 * @param {string} [plat] - Override platform (defaults to process.platform)
 */
export function getServicePaths(plat = platform()) {
  const logDir = join(homedir(), '.chroxy', 'logs')

  if (plat === 'darwin') {
    return {
      type: 'launchd',
      plistPath: join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
      logDir,
    }
  }

  if (plat === 'linux') {
    return {
      type: 'systemd',
      unitPath: join(homedir(), '.config', 'systemd', 'user', 'chroxy.service'),
      logDir,
    }
  }

  if (plat === 'win32') {
    return {
      type: 'windows',
      logDir,
    }
  }

  throw new Error(`Platform "${plat}" is not supported. Only macOS (launchd), Linux (systemd), and Windows are supported.`)
}

/**
 * Generate a macOS launchd plist XML string.
 */
export function generateLaunchdPlist(config) {
  const {
    nodePath,
    chroxyBin,
    claudeBin,
    wrapperPath,
    cwd = homedir(),
    startAtLogin = false,
    logDir = join(homedir(), '.chroxy', 'logs'),
  } = config

  // Bake a PATH that includes the node and claude bin dirs so the daemon's
  // preflight finds both under launchd's bare default PATH (#5491).
  const pathValue = buildServicePath({ nodePath, claudeBin })

  // When a wrapper is provided, exec it so keychain secrets reach the daemon
  // (#5491). Otherwise exec node+chroxy directly (legacy / no-wrapper path).
  const programArgs = wrapperPath
    ? `    <string>${escapeXml(wrapperPath)}</string>`
    : `    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(chroxyBin)}</string>
    <string>start</string>`

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key>
  ${startAtLogin ? '<true/>' : '<false/>'}
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(cwd)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logDir, 'chroxy-stdout.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logDir, 'chroxy-stderr.log'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(pathValue)}</string>
    <key>CHROXY_DAEMON</key>
    <string>1</string>
  </dict>
</dict>
</plist>
`
}

/**
 * Generate a Linux systemd user unit file string.
 */
export function generateSystemdUnit(config) {
  const {
    nodePath,
    chroxyBin,
    claudeBin,
    wrapperPath,
    cwd = homedir(),
    logDir = join(homedir(), '.chroxy', 'logs'),
  } = config

  // Bake a PATH that includes the node and claude bin dirs for parity with the
  // launchd plist (#5491).
  const pathValue = buildServicePath({ nodePath, claudeBin })

  // Prefer the wrapper (resolves keychain secrets) when provided.
  const execStart = wrapperPath
    ? `ExecStart=${wrapperPath}`
    : `ExecStart="${nodePath}" "${chroxyBin}" start`

  return `[Unit]
Description=Chroxy remote terminal daemon
After=network.target

[Service]
Type=simple
${execStart}
WorkingDirectory=${cwd}
Restart=on-failure
RestartSec=5
Environment=PATH=${pathValue}
Environment=CHROXY_DAEMON=1
StandardOutput=file:${join(logDir, 'chroxy-stdout.log')}
StandardError=file:${join(logDir, 'chroxy-stderr.log')}

[Install]
WantedBy=default.target
`
}

/**
 * Returns alternative methods for running Chroxy as a service on Windows.
 * Since Windows doesn't have a native equivalent to launchd/systemd user agents,
 * we provide guidance on third-party tools and built-in alternatives.
 */
export function getWindowsAlternatives() {
  return [
    {
      name: 'Task Scheduler',
      description: 'Built-in Windows tool. Create a task that runs at logon with "Run whether user is logged on or not".',
      command: 'schtasks /create /tn "Chroxy" /tr "node <chroxy-path> start" /sc onlogon /rl highest',
    },
    {
      name: 'NSSM (Non-Sucking Service Manager)',
      description: 'Lightweight tool that wraps any executable as a Windows service. Install from nssm.cc.',
      command: 'nssm install Chroxy node <chroxy-path> start',
    },
    {
      name: 'PM2',
      description: 'Node.js process manager with Windows service support via pm2-windows-service.',
      command: 'pm2 start <chroxy-path> -- start && pm2 save && pm2-service-install',
    },
  ]
}

/**
 * Generate the Windows `.cmd` service wrapper that Task Scheduler runs (#6647).
 *
 * `schtasks`' basic `/Create` flags can neither set a working directory nor
 * capture the daemon's stdout/stderr, so — mirroring the POSIX wrapper (#5491) —
 * a small batch file sets the cwd, prepends node + claude to PATH, and runs the
 * daemon with output redirected to the log dir.
 *
 * Unlike launchd/systemd there is NO keychain to resolve here, so NOTHING
 * sensitive is written into this file or the task action: the daemon reads its
 * config/credentials from its own store at runtime (today plaintext under
 * `~/.chroxy`; DPAPI-encrypted per-user storage is planned in #6644, and the
 * wrapper runs AS the user so those creds will be reachable once it lands).
 * Keeping secrets out of the task action is an explicit #6647 goal.
 *
 * @param {object} config
 * @param {string} config.nodePath - Resolved node binary path.
 * @param {string} config.chroxyBin - Resolved chroxy CLI entry point.
 * @param {string} [config.claudeBin] - Resolved claude binary (its dir is added to PATH).
 * @param {string} [config.cwd] - Working directory for the daemon.
 * @param {string} [config.logDir] - Log directory for stdout/stderr redirection.
 * @returns {string} Windows batch (.cmd) script.
 */
export function generateWindowsServiceWrapper(config) {
  const {
    nodePath,
    chroxyBin,
    claudeBin,
    cwd = homedir(),
    logDir = join(homedir(), '.chroxy', 'logs'),
  } = config

  // Use Windows path semantics regardless of host so the generated batch is
  // correct even when this runs on a POSIX CI runner under test (#6647).
  const pathPrepend = [pathWin32.dirname(nodePath), claudeBin ? pathWin32.dirname(claudeBin) : '']
    .filter(Boolean)
    .join(';')
  const stdoutLog = pathWin32.join(logDir, 'chroxy-stdout.log')
  const stderrLog = pathWin32.join(logDir, 'chroxy-stderr.log')

  // CRLF line endings + ASCII-only (no em-dash): a .cmd is read by cmd.exe in
  // the OEM code page, where a UTF-8 em-dash renders as garbage, and CRLF is the
  // conventional/robust ending for a generated batch file (#6647 review).
  const lines = [
    '@echo off',
    'rem Chroxy service wrapper - generated by `chroxy service install` (#6647).',
    'rem Runs the daemon under Windows Task Scheduler. Regenerated on every',
    'rem `service install`; edits are lost.',
    `set "PATH=${pathPrepend};%PATH%"`,
    'set "CHROXY_DAEMON=1"',
    `cd /d "${cwd}"`,
    `"${nodePath}" "${chroxyBin}" start >> "${stdoutLog}" 2>> "${stderrLog}"`,
  ]
  return lines.join('\r\n') + '\r\n'
}

/**
 * Search common locations for Node 22, verify the version, and return the path.
 * Throws with a helpful message if not found.
 */
export function resolveNode22Path() {
  if (isWindows) return resolveWindowsNodePath()

  const candidates = []

  // Homebrew (Apple Silicon)
  candidates.push('/opt/homebrew/opt/node@22/bin/node')
  // Homebrew (Intel)
  candidates.push('/usr/local/opt/node@22/bin/node')

  // nvm — glob for latest v22.*
  const nvmDir = join(homedir(), '.nvm', 'versions', 'node')
  if (existsSync(nvmDir)) {
    try {
      const dirs = readdirSync(nvmDir)
        .filter(d => d.startsWith('v22.'))
        .sort()
        .reverse()
      for (const d of dirs) {
        candidates.push(join(nvmDir, d, 'bin', 'node'))
      }
    } catch {
      // ignore read errors
    }
  }

  // Check each candidate
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const version = execFileSync(candidate, ['--version'], { encoding: 'utf-8' }).trim()
        if (version.startsWith('v22')) {
          return candidate
        }
      } catch {
        // candidate didn't work, try next
      }
    }
  }

  // Fall back to `which node` and check version
  try {
    const whichNode = execFileSync('which', ['node'], { encoding: 'utf-8' }).trim()
    if (whichNode && existsSync(whichNode)) {
      const version = execFileSync(whichNode, ['--version'], { encoding: 'utf-8' }).trim()
      if (version.startsWith('v22')) {
        return whichNode
      }
    }
  } catch {
    // not found via which
  }

  throw new Error(
    'Could not find Node.js 22. Install it via:\n' +
    '  brew install node@22\n' +
    '  or use nvm: nvm install 22\n' +
    'Node 22 is the minimum supported version.'
  )
}

/**
 * Windows node resolution (#6647). Unlike POSIX — where the daemon is pinned to a
 * Homebrew/nvm `node@22` — Windows has no pinning convention, so accept any Node
 * >= 22 (the documented minimum). The installer already runs under Node, so if
 * that interpreter satisfies the minimum, reuse its absolute path; otherwise fall
 * back to `where node`.
 */
function resolveWindowsNodePath() {
  const major = (v) => parseInt(String(v).replace(/^v/, '').split('.')[0], 10)

  const running = process.versions?.node
  if (running && major(running) >= 22) return process.execPath

  try {
    const out = execFileSync('where', ['node'], { encoding: 'utf-8' })
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (first && existsSync(first)) {
      const version = execFileSync(first, ['--version'], { encoding: 'utf-8' }).trim()
      if (major(version) >= 22) return first
    }
  } catch {
    // `where` missing or node not on PATH — fall through to the error below.
  }

  throw new Error(
    'Could not find Node.js >= 22 (the minimum supported version). Install it via:\n' +
    '  winget install OpenJS.NodeJS.LTS\n' +
    '  or nvm-windows: nvm install 22\n' +
    'then re-run `chroxy service install`.'
  )
}

/**
 * Find the chroxy CLI entry point.
 * First checks if we're running from the monorepo source, then falls back to `which chroxy`.
 */
export function resolveChroxyBin() {
  // Check monorepo location relative to this file
  const thisDir = dirname(fileURLToPath(import.meta.url))
  const monorepoCliPath = join(thisDir, 'cli.js')
  if (existsSync(monorepoCliPath)) {
    return monorepoCliPath
  }

  // Fall back to globally installed chroxy (`where` on Windows, `which` on POSIX;
  // `where` can print several lines, so take the first resolvable one — #6647).
  try {
    const out = execFileSync(isWindows ? 'where' : 'which', ['chroxy'], { encoding: 'utf-8' })
    const resolved = out.split(/\r?\n/).map((s) => s.trim()).find((p) => p && existsSync(p))
    if (resolved) {
      return resolved
    }
  } catch {
    // not found
  }

  throw new Error(
    'Could not find chroxy CLI. Make sure you are running from the chroxy project directory\n' +
    'or install globally: npm install -g chroxy'
  )
}

/**
 * Resolve the `claude` CLI binary from the installer's environment.
 *
 * The Agent SDK requires the Claude Code CLI on PATH. launchd/systemd run the
 * daemon with a bare PATH (`/usr/bin:/bin:...`), so `claude` (commonly under
 * `~/.local/bin`) is invisible and preflight fails (#5491). We capture the
 * resolved location at install time via `which` so it can be baked into the
 * service's PATH.
 *
 * Throws with an actionable message if `claude` cannot be resolved — install
 * MUST fail loudly rather than register a job that crash-loops on preflight.
 *
 * @param {object} [options]
 * @param {(cmd: string, args: string[], opts: object) => string} [options._which]
 *   Injectable exec for testing (defaults to execFileSync).
 * @returns {string} Absolute path to the `claude` binary.
 */
export function resolveClaudeBin(options = {}) {
  const which = options._which || execFileSync
  // `where` on Windows (it can print several lines — take the first resolvable
  // one), `which` on POSIX (#6647).
  try {
    const out = which(isWindows ? 'where' : 'which', ['claude'], { encoding: 'utf-8' })
    const resolved = String(out).split(/\r?\n/).map((s) => s.trim()).find((p) => p && existsSync(p))
    if (resolved) {
      return resolved
    }
  } catch {
    // fall through to the actionable error below
  }

  throw new Error(
    "Could not find the 'claude' CLI (required by the Agent SDK).\n" +
    'Install Claude Code (https://claude.ai/code) and ensure `claude` is on your PATH,\n' +
    'then re-run `chroxy service install`. The resolved location is baked into the\n' +
    'service so the daemon can find it under launchd/systemd.'
  )
}

/**
 * Build the PATH value baked into the service definition.
 *
 * Includes the directories holding the resolved `node` and `claude` binaries
 * (deduplicated, in that priority order) ahead of the standard system dirs,
 * so the daemon's preflight finds both even under a bare launchd/systemd PATH.
 *
 * @param {object} args
 * @param {string} args.nodePath - Resolved node binary path.
 * @param {string} [args.claudeBin] - Resolved claude binary path.
 * @returns {string} Colon-separated PATH.
 */
export function buildServicePath({ nodePath, claudeBin }) {
  const dirs = []
  const push = (p) => {
    if (!p) return
    const d = dirname(p)
    if (!dirs.includes(d)) dirs.push(d)
  }
  push(nodePath)
  push(claudeBin)
  for (const sys of ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    if (!dirs.includes(sys)) dirs.push(sys)
  }
  return dirs.join(':')
}

/**
 * Generate the service wrapper script the service definition execs.
 *
 * launchd resolves keychain items in a context where the daemon's own
 * `getToken()` fails even though `security find-generic-password` succeeds in a
 * shell spawned by the same job (#5491). This wrapper resolves the secrets via
 * `/usr/bin/security` at spawn time, exports them, and execs the server.
 *
 * Secret resolution is graceful: a failed/empty keychain read leaves the env
 * var unset so config-file / `--no-auth` setups still work. The token itself is
 * NEVER written into the plist — only this 0700 wrapper reads it.
 *
 * @param {object} config
 * @param {string} config.nodePath - Resolved node binary path.
 * @param {string} config.chroxyBin - Resolved chroxy CLI entry point.
 * @param {string} config.pathValue - PATH to export (from buildServicePath).
 * @param {string} [config.cwd] - Working directory (informational; the service
 *   definition sets the actual cwd).
 * @returns {string} POSIX sh script.
 */
export function generateServiceWrapper(config) {
  const { nodePath, chroxyBin, pathValue } = config

  const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
  const keychainBlock = ({ service, account, env }) => `
# ${env} — resolve from the keychain at spawn time (graceful: skip on failure)
if _val="$(/usr/bin/security find-generic-password -s ${sh(service)} -a ${sh(account)} -w 2>/dev/null)"; then
  if [ -n "$_val" ]; then
    export ${env}="$_val"
  fi
fi`

  return `#!/bin/sh
# Chroxy service wrapper — generated by \`chroxy service install\` (#5491).
# Resolves keychain secrets unavailable to the launchd/systemd daemon context
# and execs the server. Regenerated on every \`service install\`; edits are lost.
set -e

export PATH=${sh(pathValue)}
export CHROXY_DAEMON=1
${keychainBlock(KEYCHAIN_API_TOKEN)}
${keychainBlock(KEYCHAIN_DISCORD_WEBHOOK)}

exec ${sh(nodePath)} ${sh(chroxyBin)} start
`
}

/**
 * Load service state from the config directory.
 * @param {string} [configDir] - Override config directory (for testing)
 * @returns {object|null}
 */
export function loadServiceState(configDir = DEFAULT_CONFIG_DIR) {
  const statePath = join(configDir, 'service.json')
  if (!existsSync(statePath)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Save service state to the config directory.
 * @param {object} state
 * @param {string} [configDir] - Override config directory (for testing)
 */
export function saveServiceState(state, configDir = DEFAULT_CONFIG_DIR) {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }
  const statePath = join(configDir, 'service.json')
  writeFileRestricted(statePath, JSON.stringify(state, null, 2))
}

/**
 * Write the service wrapper script to disk with 0700 perms (owner rwx only).
 *
 * The wrapper resolves keychain secrets at spawn time (#5491); it is owner-only
 * executable because it is what the service execs and it reads secrets.
 *
 * @param {string} wrapperPath - Absolute path to write the wrapper to.
 * @param {string} content - Wrapper script body (from generateServiceWrapper).
 * @returns {string} The wrapper path written.
 */
export function writeServiceWrapper(wrapperPath, content) {
  const dir = dirname(wrapperPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  // 0600 first (no world/group bits during the write window), then 0700 so the
  // service can exec it. The script holds no secret itself — only the security
  // invocations that read them — but owner-only is defense in depth.
  writeFileSync(wrapperPath, content, { mode: 0o600 })
  chmodSync(wrapperPath, 0o700)
  return wrapperPath
}

/**
 * Install Chroxy as a system daemon.
 * Generates the appropriate service file, writes it, and optionally registers it.
 *
 * @param {object} config
 * @param {string} config.nodePath - Path to Node 22 binary
 * @param {string} config.chroxyBin - Path to chroxy CLI entry point
 * @param {string} [config.claudeBin] - Path to the claude CLI (baked into PATH)
 * @param {string} [config.cwd] - Working directory for sessions
 * @param {boolean} [config.startAtLogin] - Start on login
 * @param {string} [config._servicePath] - Override service file path (testing)
 * @param {string} [config._logDir] - Override log directory (testing)
 * @param {string} [config._stateDir] - Override state directory (testing)
 * @param {string} [config._wrapperPath] - Override wrapper script path (testing)
 * @param {boolean} [config._skipRegister] - Skip launchctl/systemctl registration (testing)
 * @param {string} [config._platform] - Override platform (testing)
 */
export function installService(config) {
  const plat = config._platform || platform()
  const paths = getServicePaths(plat)

  if (plat === 'win32') {
    return installWindowsService(config, paths)
  }

  const servicePath = config._servicePath || (plat === 'darwin' ? paths.plistPath : paths.unitPath)
  const logDir = config._logDir || paths.logDir
  const stateDir = config._stateDir || DEFAULT_CONFIG_DIR
  const wrapperPath = config._wrapperPath || join(stateDir, WRAPPER_NAME)

  // Bake the resolved binary locations into the service PATH so the daemon's
  // preflight finds node + claude under the bare launchd/systemd PATH (#5491).
  const pathValue = buildServicePath({
    nodePath: config.nodePath,
    claudeBin: config.claudeBin,
  })

  // Write the wrapper that resolves keychain secrets at spawn time (#5491).
  const wrapperContent = generateServiceWrapper({
    nodePath: config.nodePath,
    chroxyBin: config.chroxyBin,
    pathValue,
    cwd: config.cwd || homedir(),
  })
  writeServiceWrapper(wrapperPath, wrapperContent)

  // Generate service file content
  const genConfig = {
    nodePath: config.nodePath,
    chroxyBin: config.chroxyBin,
    claudeBin: config.claudeBin,
    wrapperPath,
    cwd: config.cwd || homedir(),
    startAtLogin: config.startAtLogin || false,
    logDir,
  }

  let content
  if (plat === 'darwin') {
    content = generateLaunchdPlist(genConfig)
  } else {
    content = generateSystemdUnit(genConfig)
  }

  // Create log directory
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true })
  }

  // Create service file parent directory
  const serviceDir = dirname(servicePath)
  if (!existsSync(serviceDir)) {
    mkdirSync(serviceDir, { recursive: true })
  }

  // Write service file
  writeFileRestricted(servicePath, content)

  // Register with system (unless testing)
  if (!config._skipRegister) {
    if (plat === 'darwin') {
      execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, servicePath])
    } else {
      execFileSync('systemctl', ['--user', 'enable', '--now', 'chroxy.service'])
    }
  }

  // Save state
  saveServiceState({
    installedAt: new Date().toISOString(),
    platform: plat,
    servicePath,
    nodePath: config.nodePath,
    chroxyBin: config.chroxyBin,
    claudeBin: config.claudeBin,
    wrapperPath,
    cwd: genConfig.cwd,
    startAtLogin: genConfig.startAtLogin,
  }, stateDir)
}

/**
 * Register Chroxy as a Windows autostart via Task Scheduler (#6647).
 *
 * Writes the `.cmd` wrapper, then `schtasks /Create /TN Chroxy /TR <wrapper>
 * /SC ONLOGON /RL HIGHEST /IT /F`:
 *   - `/SC ONLOGON`  — start when the user logs on (NOT `/SC ONSTART`).
 *   - `/RL HIGHEST`  — run with the user's highest privileges.
 *   - `/IT`          — interactive token: run only while the user is logged on,
 *                      using their session token, so NO stored password is
 *                      required (schtasks would otherwise prompt for one).
 *   - `/F`           — overwrite an existing task (idempotent reinstall).
 *
 * ONLOGON + `/IT` (vs `/SC ONSTART` with `/RU SYSTEM`) is deliberate: Chroxy is a
 * per-user dev daemon. Running at boot as SYSTEM would start it before anyone
 * logs on, as SYSTEM rather than the user — no interactive session, and (once
 * per-user credential encryption lands, DPAPI, #6644) no access to the user's
 * credentials — wrong for this workload. The trade-off (daemon starts at logon,
 * not boot) is documented for the user in `service-cmd.js`.
 *
 * NOTE: creating an ONLOGON task requires an elevated (Administrator) token —
 * a non-elevated `schtasks /Create /SC ONLOGON` fails with "Access is denied."
 * The catch below surfaces that stderr and tells the user to re-run elevated.
 *
 * @param {object} config - Same shape as installService's config.
 * @param {object} paths - getServicePaths('win32') result.
 * @returns {{ installed: true, platform: 'win32', taskName: string, wrapperPath: string }}
 */
function installWindowsService(config, paths) {
  const stateDir = config._stateDir || DEFAULT_CONFIG_DIR
  const logDir = config._logDir || paths.logDir
  const wrapperPath = config._wrapperPath || join(stateDir, WINDOWS_WRAPPER_NAME)
  const taskName = config._taskName || WINDOWS_TASK_NAME
  const exec = config._exec || execFileSync
  const cwd = config.cwd || homedir()

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true })
  }

  // Write the wrapper Task Scheduler runs (sets cwd + PATH + log redirection).
  const wrapperContent = generateWindowsServiceWrapper({
    nodePath: config.nodePath,
    chroxyBin: config.chroxyBin,
    claudeBin: config.claudeBin,
    cwd,
    logDir,
  })
  writeServiceWrapper(wrapperPath, wrapperContent)

  // Register the scheduled task. `/TR` is quoted so a wrapper path with spaces
  // runs correctly; it holds only the wrapper path — never a secret (#6647).
  if (!config._skipRegister) {
    try {
      exec('schtasks', [
        '/Create',
        '/TN', taskName,
        '/TR', `"${wrapperPath}"`,
        '/SC', 'ONLOGON',
        '/RL', 'HIGHEST',
        '/IT',
        '/F',
      ], { stdio: 'pipe' })
    } catch (err) {
      // `schtasks` runs with piped stdio, so on failure execFileSync throws a
      // generic "Command failed" and drops the real reason. Surface schtasks'
      // stderr, and — since creating an ONLOGON task requires elevation, so a
      // non-elevated install fails with "Access is denied." — add the fix (#6647).
      const detail = String(err?.stderr || '').trim()
      const denied = /access is denied/i.test(detail)
      throw new Error(
        `schtasks could not register the Chroxy task${detail ? `: ${detail}` : ` (${err.message})`}` +
        (denied
          ? '\nRegistering a logon-triggered task requires elevation — run `chroxy service install` from an Administrator terminal.'
          : ''),
      )
    }
  }

  saveServiceState({
    installedAt: new Date().toISOString(),
    platform: 'win32',
    taskName,
    // servicePath mirrors the wrapper so the generic uninstall cleanup removes it.
    servicePath: wrapperPath,
    wrapperPath,
    nodePath: config.nodePath,
    chroxyBin: config.chroxyBin,
    claudeBin: config.claudeBin,
    cwd,
    // ONLOGON always starts the daemon at login; there is no separate toggle.
    startAtLogin: true,
  }, stateDir)

  return { installed: true, platform: 'win32', taskName, wrapperPath }
}

/**
 * Query the Windows scheduled task's registration + run state via
 * `schtasks /Query /TN Chroxy /V /FO LIST` (#6647). Best-effort: returns
 * `{ registered: false }` when the task is absent or schtasks is unavailable.
 *
 * @param {object} [options]
 * @param {(cmd: string, args: string[], opts: object) => string} [options._exec]
 * @param {string} [options._taskName]
 * @returns {{ registered: boolean, status: string|null }}
 */
export function getWindowsTaskStatus(options = {}) {
  const exec = options._exec || execFileSync
  const taskName = options._taskName || WINDOWS_TASK_NAME
  try {
    const out = String(exec('schtasks', ['/Query', '/TN', taskName, '/V', '/FO', 'LIST'], { encoding: 'utf-8' }))
    // The `/V /FO LIST` output has a `Status:  Running|Ready|Disabled` line.
    const m = out.match(/^\s*Status:\s*(.+?)\s*$/mi)
    return { registered: true, status: m ? m[1].trim() : null }
  } catch {
    return { registered: false, status: null }
  }
}

/**
 * Uninstall the Chroxy system daemon.
 * Stops the service if running, removes the service file and state.
 *
 * @param {object} [options]
 * @param {string} [options._stateDir] - Override state directory (testing)
 * @param {boolean} [options._skipUnregister] - Skip launchctl/systemctl/schtasks unregistration (testing)
 * @param {(cmd: string, args: string[], opts: object) => void} [options._exec]
 *   Injectable exec for testing (defaults to execFileSync).
 */
export function uninstallService(options = {}) {
  const stateDir = options._stateDir || DEFAULT_CONFIG_DIR
  const state = loadServiceState(stateDir)

  if (!state) {
    throw new Error('Chroxy service is not installed. Nothing to uninstall.')
  }

  // Unregister from system (unless testing)
  if (!options._skipUnregister) {
    const exec = options._exec || execFileSync
    try {
      if (state.platform === 'darwin') {
        exec('launchctl', ['bootout', `gui/${process.getuid()}/${SERVICE_LABEL}`], { stdio: 'ignore' })
      } else if (state.platform === 'win32') {
        exec('schtasks', ['/Delete', '/TN', state.taskName || WINDOWS_TASK_NAME, '/F'], { stdio: 'ignore' })
      } else {
        exec('systemctl', ['--user', 'disable', '--now', 'chroxy.service'], { stdio: 'ignore' })
      }
    } catch {
      // Service may already be stopped/unloaded — continue cleanup
    }
  }

  // Remove service file
  if (existsSync(state.servicePath)) {
    unlinkSync(state.servicePath)
  }

  // Remove the generated wrapper script (#5491)
  const wrapperPath = state.wrapperPath || join(stateDir, WRAPPER_NAME)
  if (existsSync(wrapperPath)) {
    unlinkSync(wrapperPath)
  }

  // Remove state file
  const statePath = join(stateDir, 'service.json')
  if (existsSync(statePath)) {
    unlinkSync(statePath)
  }
}

/**
 * Start the system service.
 * @param {object} [options] - Options
 * @param {string} [options._platform] - Override platform for testing
 * @param {string} [options._stateDir] - Override state directory (for testing)
 * @param {boolean} [options._skipExec] - Skip actual launchctl/systemctl calls (for testing)
 * @param {(cmd: string, args: string[], opts: object) => void} [options._exec]
 *   Injectable exec for testing (defaults to execFileSync).
 * @returns {{ started: boolean, message: string }}
 */
export function startService(options = {}) {
  const plat = options._platform || platform()
  const paths = getServicePaths(plat)
  const stateDir = options._stateDir || DEFAULT_CONFIG_DIR
  const exec = options._exec || execFileSync

  if (plat === 'win32') {
    // Run the registered scheduled task now (#6647).
    const taskName = options._taskName || WINDOWS_TASK_NAME
    if (!options._skipExec) {
      exec('schtasks', ['/Run', '/TN', taskName], { stdio: 'pipe' })
    }
    return { started: true, message: 'Service started' }
  }

  if (!options._skipExec) {
    if (paths.type === 'launchd') {
      const state = loadServiceState(stateDir)
      let plistPath
      if (state?.servicePath) {
        if (!existsSync(state.servicePath)) {
          throw new Error(
            `Service file not found at ${state.servicePath}. ` +
            "The service state is stale. Run 'chroxy service install' to reinstall."
          )
        }
        plistPath = state.servicePath
      } else if (existsSync(paths.plistPath)) {
        // Service file exists but state is missing/stale — use the default path
        plistPath = paths.plistPath
      } else {
        throw new Error(
          "Service not installed. Run 'chroxy service install' first."
        )
      }
      bootstrapLaunchd(plistPath, exec)
    } else {
      exec('systemctl', ['--user', 'start', 'chroxy.service'], { stdio: 'pipe' })
    }
  }

  return { started: true, message: 'Service started' }
}

/**
 * Idempotently (re)start a launchd job: bootout any existing instance of the
 * label first, then bootstrap (#5491).
 *
 * launchd refuses to bootstrap a label that is already registered. A stale
 * label left from a prior run makes the first `service start` fail with the
 * opaque `Bootstrap failed: 5: Input/output error`. Booting out first makes
 * start idempotent; if bootstrap still fails with EIO we translate it into an
 * actionable hint instead of surfacing the raw launchd error.
 *
 * @param {string} plistPath - Path to the plist to bootstrap.
 * @param {(cmd: string, args: string[], opts: object) => void} exec - exec impl.
 */
function bootstrapLaunchd(plistPath, exec) {
  const domain = `gui/${process.getuid()}`

  // Bootout a stale label first — failure is fine (label may not be loaded).
  try {
    exec('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`], { stdio: 'pipe' })
  } catch {
    // Not currently loaded — nothing to bootout.
  }

  try {
    exec('launchctl', ['bootstrap', domain, plistPath], { stdio: 'pipe' })
  } catch (err) {
    const detail = String(err?.stderr || err?.message || '')
    // `Bootstrap failed: 5: Input/output error` — usually a stale/duplicate
    // label or a job still shutting down. Surface an actionable hint (#5491).
    if (/Input\/output error|: 5:/.test(detail)) {
      throw new Error(
        'launchd could not bootstrap the Chroxy service (Bootstrap failed: 5: Input/output error).\n' +
        'This usually means a previous instance is still registered or shutting down. Try:\n' +
        `  launchctl bootout ${domain}/${SERVICE_LABEL}\n` +
        '  chroxy service start\n' +
        "If it persists, reinstall with 'chroxy service uninstall && chroxy service install'."
      )
    }
    throw err
  }
}

/**
 * Stop the system service.
 * @param {object} [options] - Options
 * @param {string} [options._platform] - Override platform for testing
 * @param {boolean} [options._skipExec] - Skip actual launchctl/systemctl calls (for testing)
 * @returns {{ stopped: boolean, message: string }}
 */
export function stopService(options = {}) {
  const plat = options._platform || platform()
  const paths = getServicePaths(plat)
  const exec = options._exec || execFileSync

  if (plat === 'win32') {
    // End the running scheduled task's action (#6647).
    const taskName = options._taskName || WINDOWS_TASK_NAME
    if (!options._skipExec) {
      exec('schtasks', ['/End', '/TN', taskName], { stdio: 'pipe' })
    }
    return { stopped: true, message: 'Service stopped' }
  }

  if (!options._skipExec) {
    if (paths.type === 'launchd') {
      exec('launchctl', ['bootout', `gui/${process.getuid()}/${SERVICE_LABEL}`], { stdio: 'pipe' })
    } else {
      exec('systemctl', ['--user', 'stop', 'chroxy.service'], { stdio: 'pipe' })
    }
  }

  return { stopped: true, message: 'Service stopped' }
}

/**
 * Check if the service is currently running by checking PID file.
 * @param {object} [options]
 * @param {string} [options.configDir] - Override config dir for testing
 * @returns {{ installed: boolean, running: boolean, pid: number|null, stale: boolean }}
 */
export function getServiceStatus(options = {}) {
  const configDir = options.configDir || DEFAULT_CONFIG_DIR
  const state = loadServiceState(configDir)

  if (!state) {
    return { installed: false, running: false, pid: null, stale: false }
  }

  const pidFile = join(configDir, 'supervisor.pid')
  if (!existsSync(pidFile)) {
    return { installed: true, running: false, pid: null, stale: false }
  }

  let pid
  try {
    pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
  } catch {
    return { installed: true, running: false, pid: null, stale: false }
  }

  if (isNaN(pid)) {
    return { installed: true, running: false, pid: null, stale: false }
  }

  // Check if process is alive (signal 0 = check existence only)
  // EPERM means the process exists but we lack permission — still alive
  // ESRCH means the process does not exist
  let alive = false
  try {
    process.kill(pid, 0)
    alive = true
  } catch (err) {
    alive = err.code === 'EPERM'
  }

  return {
    installed: true,
    running: alive,
    pid: alive ? pid : null,
    stale: !alive,
  }
}

/**
 * Get comprehensive service info for the status command.
 * Includes health endpoint check, connection info, and recent logs.
 * @param {object} [options]
 * @param {string} [options.configDir] - Override config dir for testing
 * @returns {Promise<object>} Full status including health, connection info, etc.
 */
export async function getFullServiceStatus(options = {}) {
  const configDir = options.configDir || DEFAULT_CONFIG_DIR
  const status = getServiceStatus({ configDir })
  const result = { ...status }

  // Try to read connection info
  const connFile = join(configDir, 'connection.json')
  if (existsSync(connFile)) {
    try {
      result.connection = JSON.parse(readFileSync(connFile, 'utf-8'))
    } catch {
      // Ignore malformed connection.json
    }
  }

  // If running, try health endpoint
  if (status.running) {
    try {
      // Parse port: prefer config.json, then connection.json URL, then default (#745)
      let port = 8765
      const configFile = join(configDir, 'config.json')
      if (existsSync(configFile)) {
        try {
          const cfg = JSON.parse(readFileSync(configFile, 'utf-8'))
          if (cfg.port && typeof cfg.port === 'number') port = cfg.port
        } catch {
          // Ignore malformed config.json
        }
      }
      if (port === 8765 && result.connection?.wsUrl) {
        const urlPort = result.connection.wsUrl.match(/:(\d+)/)?.[1]
        if (urlPort) port = parseInt(urlPort, 10)
      }
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(3000),
      })
      result.health = await response.json()
    } catch {
      result.health = null
    }
  }

  // Read recent log lines
  const logFile = join(configDir, 'logs', 'chroxy-stdout.log')
  if (existsSync(logFile)) {
    try {
      const content = readFileSync(logFile, 'utf-8')
      const lines = content.trim().split('\n')
      result.recentLogs = lines.slice(-5)
    } catch {
      // Ignore read errors
    }
  }

  return result
}
