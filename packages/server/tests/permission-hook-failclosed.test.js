import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const hookPath = join(__dirname, '../hooks/permission-hook.sh')

/**
 * #5330: when the permission hook cannot obtain an explicit user decision —
 * the daemon is unreachable (curl fails) or the response is unparseable — the
 * old behavior emitted permissionDecision:"ask". In chroxy's remote model the
 * user is on their phone, not at the PTY, so "ask" wedges the session on an
 * unanswerable native dialog. The hook must fail CLOSED ("deny") by default,
 * with CHROXY_HOOK_UNREACHABLE_DECISION=ask as an opt-out for local-PTY setups.
 */

function runHook({ input, env, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [hookPath], { env })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null
    const settle = (fn, arg) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(arg) }
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.on('error', (err) => settle(reject, err))
    child.on('close', () => settle(resolve, { stdout, stderr }))
    if (timeout) timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    if (input != null) child.stdin.write(input)
    child.stdin.end()
  })
}

// A port nothing listens on → curl gets connection-refused immediately (no
// --max-time wait). Open on :0 to claim a real free port, then close it.
async function getClosedPort() {
  const srv = createServer()
  await new Promise((r) => srv.listen(0, r))
  const port = srv.address().port
  await new Promise((r) => srv.close(r))
  return port
}

// Mock /permission server that replies 200 with an arbitrary body (no
// recognizable "decision" field) to exercise the unparseable-response path.
async function startNoDecisionServer() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}') })
  })
  await new Promise((r) => server.listen(0, r))
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

const REQUEST = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })

function parse(stdout) { return JSON.parse(stdout.trim()).hookSpecificOutput }

describe('permission-hook fail-closed fallback (#5330)', () => {
  it('curl failure (daemon unreachable) DENIES by default — never wedges on "ask"', async () => {
    const port = await getClosedPort()
    const { stdout } = await runHook({
      input: REQUEST,
      env: { ...process.env, CHROXY_PORT: String(port), CHROXY_HOOK_SECRET: 's', CHROXY_PERMISSION_MODE: 'approve' },
    })
    const out = parse(stdout)
    assert.equal(out.permissionDecision, 'deny', 'unreachable daemon must fail closed, not ask')
    assert.match(out.permissionDecisionReason, /could not reach|failing closed/i)
  })

  it('CHROXY_HOOK_UNREACHABLE_DECISION=ask restores the old "ask" fallback', async () => {
    const port = await getClosedPort()
    const { stdout } = await runHook({
      input: REQUEST,
      env: {
        ...process.env, CHROXY_PORT: String(port), CHROXY_HOOK_SECRET: 's',
        CHROXY_PERMISSION_MODE: 'approve', CHROXY_HOOK_UNREACHABLE_DECISION: 'ask',
      },
    })
    assert.equal(parse(stdout).permissionDecision, 'ask', 'opt-out env var must restore ask for local-PTY')
  })

  it('an unparseable daemon response also fails closed (deny)', async () => {
    const srv = await startNoDecisionServer()
    try {
      const { stdout } = await runHook({
        input: REQUEST,
        env: { ...process.env, CHROXY_PORT: String(srv.port), CHROXY_HOOK_SECRET: 's', CHROXY_PERMISSION_MODE: 'approve' },
      })
      const out = parse(stdout)
      assert.equal(out.permissionDecision, 'deny', 'unrecognized response must fail closed')
      assert.match(out.permissionDecisionReason, /unrecognized|failing closed/i)
    } finally {
      await srv.close()
    }
  })

  it('an invalid CHROXY_HOOK_UNREACHABLE_DECISION value falls back to deny (fail closed)', async () => {
    const port = await getClosedPort()
    const { stdout } = await runHook({
      input: REQUEST,
      env: {
        ...process.env, CHROXY_PORT: String(port), CHROXY_HOOK_SECRET: 's',
        CHROXY_PERMISSION_MODE: 'approve', CHROXY_HOOK_UNREACHABLE_DECISION: 'allow-everything',
      },
    })
    assert.equal(parse(stdout).permissionDecision, 'deny', 'a bogus value must not weaken the safe default')
  })
})
