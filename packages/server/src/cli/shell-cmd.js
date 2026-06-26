/**
 * chroxy shell — host-local approval for user-shell spawns (#6277).
 *
 *   chroxy shell list            → list shells pending host approval
 *   chroxy shell approve <id>    → approve a held shell (it spawns)
 *   chroxy shell deny <id>       → decline a held shell
 *
 * These talk to the daemon's SEPARATE host-local approval listener — bound to
 * 127.0.0.1 on an ephemeral port the Cloudflare tunnel never forwards (see
 * shell-approval-info.js) — using the primary token from connection.json. So
 * approval can only ever originate from the host machine, never over the tunnel.
 */

async function approvalRequest(method, path, deps = {}) {
  const readConnectionInfo =
    deps.readConnectionInfo || (await import('../connection-info.js')).readConnectionInfo
  const readShellApprovalInfo =
    deps.readShellApprovalInfo || (await import('../shell-approval-info.js')).readShellApprovalInfo
  const fetchFn = deps.fetchFn || globalThis.fetch

  const conn = readConnectionInfo()
  if (!conn) return { ok: false, reason: 'not_running' }
  if (!conn.apiToken) return { ok: false, reason: 'no_token' }
  const approval = readShellApprovalInfo()
  if (!approval || !Number.isInteger(approval.port)) return { ok: false, reason: 'approval_disabled' }

  const headers = { Authorization: `Bearer ${conn.apiToken}`, Accept: 'application/json' }
  try {
    const res = await fetchFn(`http://127.0.0.1:${approval.port}${path}`, {
      method,
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    let json = null
    try { json = await res.json() } catch { /* non-JSON body */ }
    if (!res.ok) {
      return { ok: false, reason: 'http_error', status: res.status, message: json?.error || `HTTP ${res.status}` }
    }
    return { ok: true, json }
  } catch (err) {
    return { ok: false, reason: 'unavailable', message: err?.message || 'request failed' }
  }
}

function reportFailure(result, writeErr) {
  switch (result.reason) {
    case 'not_running':
      writeErr('Chroxy server is not running. Start it with `chroxy start`.')
      break
    case 'no_token':
      writeErr('Server is running without an auth token — shell approval is unavailable.')
      break
    case 'approval_disabled':
      writeErr('User-shell approval is not enabled. Set userShell.requireApproval and restart the daemon.')
      break
    case 'http_error':
      if (result.status === 404) writeErr('No pending approval with that id (it may have expired or already been used).')
      else if (result.status === 403) writeErr(result.message === 'expired' ? 'That approval has expired.' : 'Not authorized — the primary token is required.')
      else writeErr(`Request failed: ${result.message || result.status}`)
      break
    default:
      writeErr(`Request failed: ${result.message || result.reason}`)
  }
}

export async function runShellListCmd(options = {}, deps = {}) {
  const out = deps.out || ((s) => process.stdout.write(s + '\n'))
  const err = deps.err || ((s) => process.stderr.write(s + '\n'))
  const result = await approvalRequest('GET', '/api/shell/pending', deps)
  if (!result.ok) { reportFailure(result, err); return result }
  const pending = result.json?.pending || []
  if (options.json) { out(JSON.stringify(pending, null, 2)); return result }
  if (pending.length === 0) { out('No shells pending approval.'); return result }
  out(`${pending.length} shell(s) pending host approval:`)
  for (const p of pending) {
    out(`  ${p.approvalId}  cwd=${p.cwd || '(default)'}  device=${p.deviceName || '(unknown)'}`)
  }
  return result
}

async function runShellDecisionCmd(decision, id, options = {}, deps = {}) {
  const out = deps.out || ((s) => process.stdout.write(s + '\n'))
  const err = deps.err || ((s) => process.stderr.write(s + '\n'))
  if (typeof id !== 'string' || id.length === 0) {
    err('An approval id is required.')
    return { ok: false, reason: 'bad_args' }
  }
  const result = await approvalRequest('POST', `/api/shell/${decision}?id=${encodeURIComponent(id)}`, deps)
  if (!result.ok) { reportFailure(result, err); return result }
  if (options.json) { out(JSON.stringify(result.json || { ok: true }, null, 2)); return result }
  if (decision === 'approve') out(`Approved — shell spawned (session ${result.json?.sessionId || '?'}).`)
  else out('Declined.')
  return result
}

export async function runShellApproveCmd(id, options = {}, deps = {}) {
  return runShellDecisionCmd('approve', id, options, deps)
}

export async function runShellDenyCmd(id, options = {}, deps = {}) {
  return runShellDecisionCmd('deny', id, options, deps)
}

export function registerShellApprovalCommand(program) {
  const shell = program.command('shell').description('Approve or deny host-local user-shell spawns (#6277)')
  shell
    .command('list')
    .description('List shells pending host approval')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      const r = await runShellListCmd(options)
      if (!r.ok) process.exitCode = 1
    })
  shell
    .command('approve <id>')
    .description('Approve a held shell — it spawns on the host')
    .option('--json', 'Output machine-readable JSON')
    .action(async (id, options) => {
      const r = await runShellApproveCmd(id, options)
      if (!r.ok) process.exitCode = 1
    })
  shell
    .command('deny <id>')
    .description('Decline a held shell')
    .option('--json', 'Output machine-readable JSON')
    .action(async (id, options) => {
      const r = await runShellDenyCmd(id, options)
      if (!r.ok) process.exitCode = 1
    })
}
