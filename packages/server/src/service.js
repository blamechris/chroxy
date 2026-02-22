import { homedir, platform } from 'os'
import { join, dirname } from 'path'
import { existsSync, readFileSync, mkdirSync, unlinkSync, readdirSync } from 'fs'
import { writeFileRestricted } from './platform.js'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const SERVICE_LABEL = 'com.chroxy.server'
const DEFAULT_CONFIG_DIR = join(homedir(), '.chroxy')

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

  throw new Error(`Platform "${plat}" is not supported. Only macOS (launchd) and Linux (systemd) are supported.`)
}

/**
 * Generate a macOS launchd plist XML string.
 */
export function generateLaunchdPlist(config) {
  const {
    nodePath,
    chroxyBin,
    cwd = homedir(),
    startAtLogin = false,
    logDir = join(homedir(), '.chroxy', 'logs'),
  } = config

  const nodeBinDir = dirname(nodePath)
  const pathValue = `${nodeBinDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${chroxyBin}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  ${startAtLogin ? '<true/>' : '<false/>'}
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${cwd}</string>
  <key>StandardOutPath</key>
  <string>${join(logDir, 'chroxy-stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(logDir, 'chroxy-stderr.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathValue}</string>
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
    cwd = homedir(),
    logDir = join(homedir(), '.chroxy', 'logs'),
  } = config

  const nodeBinDir = dirname(nodePath)
  const pathValue = `${nodeBinDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`

  return `[Unit]
Description=Chroxy remote terminal daemon
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${chroxyBin} start
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
 * Search common locations for Node 22, verify the version, and return the path.
 * Throws with a helpful message if not found.
 */
export function resolveNode22Path() {
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
    'Node 22 is required because node-pty does not compile on newer versions.'
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

  // Fall back to globally installed chroxy
  try {
    const whichChroxy = execFileSync('which', ['chroxy'], { encoding: 'utf-8' }).trim()
    if (whichChroxy && existsSync(whichChroxy)) {
      return whichChroxy
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
 * Install Chroxy as a system daemon.
 * Generates the appropriate service file, writes it, and optionally registers it.
 *
 * @param {object} config
 * @param {string} config.nodePath - Path to Node 22 binary
 * @param {string} config.chroxyBin - Path to chroxy CLI entry point
 * @param {string} [config.cwd] - Working directory for sessions
 * @param {boolean} [config.startAtLogin] - Start on login
 * @param {string} [config._servicePath] - Override service file path (testing)
 * @param {string} [config._logDir] - Override log directory (testing)
 * @param {string} [config._stateDir] - Override state directory (testing)
 * @param {boolean} [config._skipRegister] - Skip launchctl/systemctl registration (testing)
 * @param {string} [config._platform] - Override platform (testing)
 */
export function installService(config) {
  const plat = config._platform || platform()
  const paths = getServicePaths(plat)

  const servicePath = config._servicePath || (plat === 'darwin' ? paths.plistPath : paths.unitPath)
  const logDir = config._logDir || paths.logDir
  const stateDir = config._stateDir || DEFAULT_CONFIG_DIR

  // Generate service file content
  const genConfig = {
    nodePath: config.nodePath,
    chroxyBin: config.chroxyBin,
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
      execFileSync('launchctl', ['load', servicePath])
    } else {
      execFileSync('systemctl', ['--user', 'enable', 'chroxy.service'])
    }
  }

  // Save state
  saveServiceState({
    installedAt: new Date().toISOString(),
    platform: plat,
    servicePath,
    nodePath: config.nodePath,
    chroxyBin: config.chroxyBin,
    cwd: genConfig.cwd,
    startAtLogin: genConfig.startAtLogin,
  }, stateDir)
}

/**
 * Uninstall the Chroxy system daemon.
 * Stops the service if running, removes the service file and state.
 *
 * @param {object} [options]
 * @param {string} [options._stateDir] - Override state directory (testing)
 * @param {boolean} [options._skipUnregister] - Skip launchctl/systemctl unregistration (testing)
 */
export function uninstallService(options = {}) {
  const stateDir = options._stateDir || DEFAULT_CONFIG_DIR
  const state = loadServiceState(stateDir)

  if (!state) {
    throw new Error('Chroxy service is not installed. Nothing to uninstall.')
  }

  // Unregister from system (unless testing)
  if (!options._skipUnregister) {
    try {
      if (state.platform === 'darwin') {
        execFileSync('launchctl', ['unload', state.servicePath], { stdio: 'ignore' })
      } else {
        execFileSync('systemctl', ['--user', 'disable', '--now', 'chroxy.service'], { stdio: 'ignore' })
      }
    } catch {
      // Service may already be stopped/unloaded — continue cleanup
    }
  }

  // Remove service file
  if (existsSync(state.servicePath)) {
    unlinkSync(state.servicePath)
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
 * @param {boolean} [options._skipExec] - Skip actual launchctl/systemctl calls (for testing)
 * @returns {{ started: boolean, message: string }}
 */
export function startService(options = {}) {
  const plat = options._platform || platform()
  const paths = getServicePaths(plat)

  if (!options._skipExec) {
    if (paths.type === 'launchd') {
      execFileSync('launchctl', ['start', SERVICE_LABEL], { stdio: 'pipe' })
    } else {
      execFileSync('systemctl', ['--user', 'start', 'chroxy'], { stdio: 'pipe' })
    }
  }

  return { started: true, message: 'Service started' }
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

  if (!options._skipExec) {
    if (paths.type === 'launchd') {
      execFileSync('launchctl', ['stop', SERVICE_LABEL], { stdio: 'pipe' })
    } else {
      execFileSync('systemctl', ['--user', 'stop', 'chroxy'], { stdio: 'pipe' })
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
  let alive = false
  try {
    process.kill(pid, 0)
    alive = true
  } catch {
    // Process not running
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
      const port = result.connection?.wsUrl?.match(/:(\d+)/)?.[1] || 8765
      const response = await fetch(`http://127.0.0.1:${port}/`)
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
