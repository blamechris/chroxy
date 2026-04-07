/**
 * chroxy status — Show whether the Chroxy server is running,
 * tunnel URL/mode, uptime, version, and active session count.
 *
 * Detection uses connection.json (written by server-cli/supervisor) which
 * is stale-checked via PID, then pings the local HTTP health endpoint.
 */
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { version: CLI_VERSION } = require('../../package.json')

function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown'
  const s = Math.floor(seconds)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rem = s % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${rem}s`
  return `${rem}s`
}

function classifyTunnel(mode, wsUrl) {
  if (mode) return mode
  if (typeof wsUrl === 'string') {
    if (wsUrl.includes('trycloudflare.com')) return 'quick'
    if (wsUrl.startsWith('wss://')) return 'named'
    if (wsUrl.startsWith('ws://')) return 'local'
  }
  return 'unknown'
}

function portFromUrl(url) {
  if (typeof url !== 'string') return null
  const m = url.match(/:(\d+)(?:\/|$)/)
  return m ? parseInt(m[1], 10) : null
}

/**
 * Collect status information. Exposed for testing.
 * @param {object} [deps]
 * @param {function} [deps.readConnectionInfo]
 * @param {function} [deps.fetchFn]
 * @param {number}   [deps.defaultPort]
 */
export async function collectStatus(deps = {}) {
  const readConnectionInfo =
    deps.readConnectionInfo ||
    (await import('../connection-info.js')).readConnectionInfo
  const fetchFn = deps.fetchFn || globalThis.fetch
  const defaultPort = deps.defaultPort || 8765

  const out = {
    version: CLI_VERSION,
    running: false,
    pid: null,
    port: null,
    tunnel: null,
    uptimeSeconds: null,
    sessions: null,
    mode: null,
  }

  const info = readConnectionInfo()
  if (info) {
    out.pid = info.pid ?? null
    out.port =
      portFromUrl(info.httpUrl) || portFromUrl(info.wsUrl) || defaultPort
    out.tunnel = {
      url: info.httpUrl || info.wsUrl || null,
      type: classifyTunnel(info.tunnelMode, info.wsUrl),
    }
    if (info.startedAt) {
      const started = Date.parse(info.startedAt)
      if (!Number.isNaN(started)) {
        out.uptimeSeconds = Math.round((Date.now() - started) / 1000)
      }
    }
  }

  // Ping local health endpoint regardless — this is the definitive
  // "is something listening" check.
  const pingPort = out.port || defaultPort
  try {
    const res = await fetchFn(`http://127.0.0.1:${pingPort}/`, {
      signal: AbortSignal.timeout(2000),
      headers: { Accept: 'application/json' },
    })
    if (res && res.ok) {
      out.running = true
      try {
        const body = await res.json()
        if (body && typeof body === 'object') {
          if (body.version) out.version = body.version
          if (body.mode) out.mode = body.mode
        }
      } catch {
        // non-JSON response — still counts as running
      }
    }
  } catch {
    // fetch failed — server not reachable on this port
  }

  // Active session count — try authenticated /metrics if we have a token.
  if (out.running && info?.apiToken) {
    try {
      const res = await fetchFn(`http://127.0.0.1:${pingPort}/metrics`, {
        signal: AbortSignal.timeout(2000),
        headers: { Authorization: `Bearer ${info.apiToken}` },
      })
      if (res && res.ok) {
        const body = await res.json()
        if (body?.sessions?.active != null) {
          out.sessions = body.sessions.active
        }
        if (body?.uptime != null && out.uptimeSeconds == null) {
          out.uptimeSeconds = body.uptime
        }
      }
    } catch {
      // Ignore — sessions remains null
    }
  }

  if (!out.running) {
    // If we can't reach the endpoint, consider it not running even if a
    // stale connection.json existed. Clear volatile fields.
    out.pid = null
  }

  return out
}

function printHuman(status) {
  const lines = []
  lines.push('')
  lines.push(`Chroxy v${status.version}`)
  lines.push('')
  if (!status.running) {
    lines.push('Status:   Not running')
    lines.push('')
    return lines.join('\n')
  }
  lines.push(
    `Status:   Running${status.pid ? ` (pid ${status.pid})` : ''}`
  )
  if (status.port != null) lines.push(`Port:     ${status.port}`)
  if (status.tunnel?.url) {
    lines.push(`Tunnel:   ${status.tunnel.url} (${status.tunnel.type})`)
  } else {
    lines.push('Tunnel:   (none)')
  }
  if (status.uptimeSeconds != null) {
    lines.push(`Uptime:   ${formatUptime(status.uptimeSeconds)}`)
  }
  if (status.sessions != null) {
    lines.push(`Sessions: ${status.sessions} active`)
  }
  lines.push('')
  return lines.join('\n')
}

export async function runStatusCmd(options = {}, deps = {}) {
  const status = await collectStatus(deps)
  if (options.json) {
    const out = (deps.write || console.log)
    out(JSON.stringify(status, null, 2))
  } else {
    const out = (deps.write || console.log)
    out(printHuman(status))
  }
  return status
}

export function registerStatusCommand(program) {
  program
    .command('status')
    .description('Show whether the Chroxy server is running and its current state')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      const status = await runStatusCmd(options)
      if (!status.running) process.exitCode = 1
    })
}
