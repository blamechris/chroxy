import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createServer } from 'net'

const CONFIG_FILE = join(homedir(), '.chroxy', 'config.json')

/**
 * Run all preflight dependency checks and return results.
 * @param {{ port?: number, verbose?: boolean }} options
 * @returns {{ checks: Array<{ name: string, status: 'pass'|'warn'|'fail', message: string }>, passed: boolean }}
 */
export async function runDoctorChecks({ port, verbose } = {}) {
  const checks = []

  // 1. Node.js version
  const nodeVersion = process.versions.node
  const major = parseInt(nodeVersion.split('.')[0], 10)
  if (major === 22) {
    checks.push({ name: 'Node.js', status: 'pass', message: `v${nodeVersion}` })
  } else if (major > 22) {
    checks.push({ name: 'Node.js', status: 'warn', message: `v${nodeVersion} — node-pty requires Node 22 (PTY mode only)` })
  } else {
    checks.push({ name: 'Node.js', status: 'fail', message: `v${nodeVersion} — Node 22 required` })
  }

  // 2. cloudflared
  try {
    const version = execFileSync('cloudflared', ['--version'], {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split('\n')[0]
    checks.push({ name: 'cloudflared', status: 'pass', message: version })
  } catch {
    checks.push({ name: 'cloudflared', status: 'fail', message: 'Not found — install with: brew install cloudflared' })
  }

  // 3. tmux (optional — only needed for PTY mode)
  try {
    const version = execFileSync('tmux', ['-V'], {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    checks.push({ name: 'tmux', status: 'pass', message: `${version} (optional — PTY mode only)` })
  } catch {
    checks.push({ name: 'tmux', status: 'warn', message: 'Not found — only needed for --terminal mode (brew install tmux)' })
  }

  // 4. claude CLI
  try {
    const version = execFileSync('claude', ['--version'], {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split('\n')[0]
    checks.push({ name: 'claude', status: 'pass', message: version })
  } catch {
    checks.push({ name: 'claude', status: 'fail', message: 'Not found — install Claude Code CLI' })
  }

  // 5. Config file
  if (existsSync(CONFIG_FILE)) {
    try {
      JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
      checks.push({ name: 'Config', status: 'pass', message: CONFIG_FILE })
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

  // 6. Port availability
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

function checkPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') reject(err)
      else resolve()
    })
    server.once('listening', () => {
      server.close(() => resolve())
    })
    server.listen(port, '127.0.0.1')
  })
}
