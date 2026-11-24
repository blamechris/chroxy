/**
 * chroxy agent — manage agent principals (agent-principals.md section 3).
 *
 *   chroxy agent grant --label <label> --scope <tier> (--session <id> | --cwd <root>) [--ttl <dur>]
 *   chroxy agent list
 *   chroxy agent revoke <label-or-principalId>
 *   chroxy agent disable --all | --label <label>
 *   chroxy agent enable --all | --label <label>
 *
 * `list`, `revoke`, `disable` and `enable` ASK THE RUNNING DAEMON over the strict-primary, loopback-only
 * `principal_admin_*` WebSocket types, with the primary token from connection.json,
 * exactly as `chroxy agent-control` reaches it. The CLI never reads or writes the
 * principal store: the daemon process is the only writer, so daemon and CLI cannot race.
 *
 * `grant` REFUSES until the audit writer and kill switch land (contract section 12
 * landing order): it prints "agent principals not yet enabled" and exits non-zero without
 * contacting the daemon, and no token is generated anywhere.
 */
import { PRINCIPALS_NOT_ENABLED_MESSAGE } from '../principal-store.js'

const out = (s) => process.stdout.write(`${s}\n`)
const err = (s) => process.stderr.write(`${s}\n`)

/** Connect to the local daemon as the primary client; resolves a `{ request, close }` pair. */
async function connectToLocalDaemon(deps = {}) {
  const resolveLocalConnection = deps.resolveLocalConnection || (await import('../agent-control/local-connection.js')).resolveLocalConnection
  const conn = resolveLocalConnection()
  // #9074/#9229: report the resolver's reason as it is. Every refusal happens before a
  // credential-bearing connection is returned, so no token is used on any of them.
  if (!conn.ok) return { ok: false, reason: conn.reason }
  if (!conn.token) return { ok: false, reason: 'no_token' }
  const { AgentControlClient } = deps.AgentControlClient ? { AgentControlClient: deps.AgentControlClient } : await import('../agent-control/client.js')
  const client = new AgentControlClient({ url: conn.url, token: conn.token, silent: true, deviceName: 'chroxy-agent-cli' })
  try {
    await client.connect()
  } catch (e) {
    return { ok: false, reason: 'unavailable', message: e?.message || 'connect failed' }
  }
  return {
    ok: true,
    request: (type, fields) => client.request(type, fields, { replyType: 'principal_admin_result' }),
    close: () => client.close(),
  }
}

function reportConnectFailure(result) {
  switch (result.reason) {
    case 'not_running': err('Chroxy server is not running. Start it with `chroxy start`.'); break
    case 'liveness_unverified': err('Could not verify that the Chroxy daemon in connection.json is running: the record has no valid pid, or that pid could not be inspected from here (for example inside a sandbox). Its token was not used, and the record was left in place.'); break
    case 'no_token': err('Server is running without an auth token: agent management is unavailable.'); break
    default: err(`Could not reach the daemon: ${result.message || result.reason}`)
  }
}

async function ask(type, fields, deps) {
  const conn = await (deps.connect || connectToLocalDaemon)(deps)
  if (!conn.ok) return { ok: false, transport: true, ...conn }
  try {
    return { ok: true, reply: await conn.request(type, fields) }
  } catch (e) {
    return { ok: false, transport: true, reason: 'unavailable', message: e?.message || 'request failed' }
  } finally {
    try { await conn.close() } catch { /* already closed */ }
  }
}

function formatWhen(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : '-'
}

/**
 * `chroxy agent grant`. REFUSES, and does not even contact the daemon: until the audit
 * writer and kill switch land there is nothing to ask for, and no token is generated in
 * this process or any other. Always a failure.
 */
export async function runAgentGrant(_options = {}, deps = {}) {
  const e = deps.err || err
  e(PRINCIPALS_NOT_ENABLED_MESSAGE)
  return { ok: false, refused: true, reason: 'not_enabled' }
}

export async function runAgentList(options = {}, deps = {}) {
  const w = deps.out || out
  const e = deps.err || err
  const result = await ask('principal_admin_list', {}, deps)
  if (!result.ok) { reportConnectFailure(result); return result }
  const reply = result.reply
  if (reply.ok !== true) { e(`Request refused: ${reply.message || reply.code}`); return { ok: false, reply } }
  if (options.json) { w(JSON.stringify(reply.principals, null, 2)); return { ok: true, reply } }
  if (reply.health && reply.health.ok !== true) {
    e(`Principal store is not trusted, every principal is refused: ${reply.health.reason}`)
    return { ok: false, reply, reason: 'store_invalid' }
  }
  if (reply.principals.length === 0) { w('No agent principals.'); return { ok: true, reply } }
  w(`${reply.principals.length} agent principal(s):`)
  for (const p of reply.principals) {
    w(`  ${p.label}  id=${p.principalId}  scope=${p.scope}  state=${p.state}  expires=${formatWhen(p.expiresAt)}`)
  }
  return { ok: true, reply }
}

export async function runAgentRevoke(target, _options = {}, deps = {}) {
  const w = deps.out || out
  const e = deps.err || err
  if (typeof target !== 'string' || target.length === 0) {
    e('Name the principal to revoke: a label or a principal id (see: chroxy agent list).')
    return { ok: false, reason: 'bad_args' }
  }
  // A label never contains an uppercase letter or a dot, and an id may; the daemon
  // resolves a label among live grants and an id exactly, so ask with both selectors
  // off one word: id first, then label.
  let result = await ask('principal_admin_revoke', { principalId: target }, deps)
  if (result.ok && result.reply?.code === 'NOT_FOUND') result = await ask('principal_admin_revoke', { label: target }, deps)
  if (!result.ok) { reportConnectFailure(result); return result }
  const reply = result.reply
  if (reply.ok !== true) { e(`Revoke refused: ${reply.message || reply.code}`); return { ok: false, reply } }
  if (reply.durable === false) {
    e(`${reply.message || 'Revoked, but NOT durable: revoke again once the principal store is writable.'}`)
    return { ok: false, reply, reason: 'not_durable' }
  }
  w(`Revoked ${reply.principalId}${reply.alreadyRevoked ? ' (it was already revoked)' : ''}. Its connections are closed.`)
  return { ok: true, reply }
}

/** `--all` xor `--label <label>`. Returns the request fields or null. */
function switchFields(options) {
  const hasAll = options?.all === true
  const hasLabel = typeof options?.label === 'string' && options.label.length > 0
  if (hasAll === hasLabel) return null
  return hasAll ? { all: true } : { label: options.label }
}

function describeSwitch(fields) {
  return fields.all === true ? 'every agent principal' : `agent principals labelled ${fields.label}`
}

/**
 * `chroxy agent disable --all | --label <label>`: the persistent kill switch. The daemon
 * flips it in memory, persists it, then acknowledges; the exit status is non-zero when the
 * switch could not be confirmed durable (it is still ON in the running daemon).
 */
export async function runAgentDisable(options = {}, deps = {}) {
  const w = deps.out || out
  const e = deps.err || err
  const fields = switchFields(options)
  if (fields === null) {
    e('Name what to disable: --all, or --label <label> (not both).')
    return { ok: false, reason: 'bad_args' }
  }
  const result = await ask('principal_admin_disable', fields, deps)
  if (!result.ok) { reportConnectFailure(result); return result }
  const reply = result.reply
  if (reply.ok !== true) { e(`Disable refused: ${reply.message || reply.code}`); return { ok: false, reply } }
  if (reply.durable === false) {
    e(`${reply.message || 'Disabled, but NOT durable: disable again once the config directory is writable.'}`)
    return { ok: false, reply, reason: 'not_durable' }
  }
  w(`Disabled ${describeSwitch(fields)} (durable). Their connections are closed; re-enable with: chroxy agent enable ${fields.all ? '--all' : `--label ${fields.label}`}`)
  return { ok: true, reply }
}

/** `chroxy agent enable --all | --label <label>`: explicit re-enable; never automatic. */
export async function runAgentEnable(options = {}, deps = {}) {
  const w = deps.out || out
  const e = deps.err || err
  const fields = switchFields(options)
  if (fields === null) {
    e('Name what to enable: --all, or --label <label> (not both).')
    return { ok: false, reason: 'bad_args' }
  }
  const result = await ask('principal_admin_enable', fields, deps)
  if (!result.ok) { reportConnectFailure(result); return result }
  const reply = result.reply
  if (reply.ok !== true) { e(`Enable refused: ${reply.message || reply.code}`); return { ok: false, reply } }
  if (reply.durable === false) {
    e(`${reply.message || 'Enabled, but NOT durable.'}`)
    return { ok: false, reply, reason: 'not_durable' }
  }
  w(`Enabled ${describeSwitch(fields)} (durable).`)
  return { ok: true, reply }
}

export function registerAgentCommand(program) {
  const agent = program.command('agent').description('Manage agent principals: scoped, revocable credentials for a supervisor agent (agent-principals.md)')

  agent
    .command('grant')
    .description('Grant a principal (refuses until agent principals are enabled)')
    .option('--label <label>', 'Operator label, ^[a-z0-9_-]{1,32}$')
    .option('--scope <tier>', 'observe | steer | drive | answer')
    .option('--session <id>', 'Limit the grant to one session id')
    .option('--cwd <root>', 'Limit the grant to sessions under a working-directory root')
    .option('--ttl <dur>', 'Lifetime, at most 7 days (default 24h)')
    .action(async (options) => {
      await runAgentGrant(options)
      process.exitCode = 1
    })

  agent
    .command('list')
    .description('List agent principals and their state')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      const r = await runAgentList(options)
      if (!r.ok) process.exitCode = 1
    })

  agent
    .command('revoke <principal>')
    .description('Revoke a principal by label or principal id, and close its connections')
    .action(async (principal, options) => {
      const r = await runAgentRevoke(principal, options)
      if (!r.ok) process.exitCode = 1
    })

  agent
    .command('disable')
    .description('Kill switch: disable every agent principal (--all) or one label (--label), persistently, and close their connections')
    .option('--all', 'Disable every agent principal')
    .option('--label <label>', 'Disable the principals carrying this label')
    .action(async (options) => {
      const r = await runAgentDisable(options)
      if (!r.ok) process.exitCode = 1
    })

  agent
    .command('enable')
    .description('Re-enable disabled agent principals (--all or --label); never automatic')
    .option('--all', 'Re-enable every agent principal')
    .option('--label <label>', 'Re-enable the principals carrying this label')
    .action(async (options) => {
      const r = await runAgentEnable(options)
      if (!r.ok) process.exitCode = 1
    })
}
