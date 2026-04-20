import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir, platform } from 'os'
import { createServer } from 'net'
import { validateConfig } from './config.js'
import { resolveBinary } from './utils/resolve-binary.js'

const CONFIG_FILE = join(homedir(), '.chroxy', 'config.json')

/**
 * Run all preflight dependency checks and return results.
 * @param {{ port?: number, verbose?: boolean }} options
 * @returns {{ checks: Array<{ name: string, status: 'pass'|'warn'|'fail', message: string }>, passed: boolean }}
 */
export async function runDoctorChecks({ port, verbose: _verbose } = {}) {
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

  // 3. claude CLI
  // GUI-launched processes on macOS inherit a minimal PATH that omits
  // user-local install dirs. Check known install locations directly so
  // the preflight doesn't falsely fail when chroxy is spawned by Tauri.
  checks.push(checkBinary('claude', ['--version'], {
    parseVersion: (out) => out.trim().split('\n')[0],
    required: true,
    candidates: [
      join(homedir(), '.local/bin/claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      join(homedir(), '.claude/local/node_modules/.bin/claude'),
      join(homedir(), '.npm-global/bin/claude'),
    ],
    installHint: 'install Claude Code CLI',
  }))

  // 5. Config file
  if (existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
      const { valid, warnings } = validateConfig(config)
      if (valid) {
        checks.push({ name: 'Config', status: 'pass', message: CONFIG_FILE })
      } else {
        checks.push({ name: 'Config', status: 'warn', message: `${CONFIG_FILE} — ${warnings.join('; ')}` })
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        checks.push({ name: 'Config', status: 'fail', message: `${CONFIG_FILE} — invalid JSON: ${err.message}` })
      } else {
        checks.push({ name: 'Config', status: 'fail', message: `${CONFIG_FILE} — ${err.message}` })
      }
    }
  } else {
    checks.push({ name: 'Config', status: 'warn', message: `Not found — run 'npx chroxy init' to create` })
  }

  // 6. node_modules
  const nodeModulesPath = join(process.cwd(), 'node_modules')
  if (existsSync(nodeModulesPath)) {
    checks.push({ name: 'Dependencies', status: 'pass', message: 'node_modules found' })
  } else {
    checks.push({ name: 'Dependencies', status: 'fail', message: 'node_modules not found — run npm install' })
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
  return { checks, passed }
}

/**
 * Check if a binary is available and return its version.
 * Differentiates between not-found and timeout errors.
 *
 * `candidates` gives fallback absolute paths to try when the binary is not
 * on PATH — important for GUI-launched processes (e.g. Tauri) whose
 * inherited PATH excludes user-local install dirs.
 */
function checkBinary(name, args, { parseVersion, required, installHint, candidates = [] }) {
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
