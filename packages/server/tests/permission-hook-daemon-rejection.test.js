import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const hookPath = join(__dirname, '../hooks/permission-hook.sh')

/**
 * #7044: `POST /permission` answers `{"decision":"deny"}` with a 400 (unparseable
 * body), a 413 (oversize body) and a 500-class status on a daemon fault — none of
 * which ever reached a human. The hook used to map ANY `"decision":"deny"` to
 * "Denied by user via Chroxy mobile app", telling the model (and the transcript
 * the user later reads) that the user refused a call they never saw.
 *
 * The decision must stay DENY on every one of these paths (fail closed); only the
 * attributed REASON changes. "Denied by user" is reserved for a 200 response.
 */

function runHook({ input, env, timeout = 10000 }) {
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
    child.on('close', (status, signal) => {
      if (signal || status !== 0) {
        settle(reject, new Error(`hook exited uncleanly (status=${status}, signal=${signal})\nstderr: ${stderr}`))
        return
      }
      settle(resolve, { status, stdout, stderr })
    })
    if (timeout) timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.stdin.write(input)
    child.stdin.end()
  })
}

// Mock /permission that answers a fixed status + body.
async function startServer(status, body) {
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(body)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

const REQUEST = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })

async function hookAgainst(status, body, extraEnv = {}) {
  const srv = await startServer(status, body)
  try {
    const { stdout } = await runHook({
      input: REQUEST,
      env: {
        ...process.env,
        CHROXY_PORT: String(srv.port),
        CHROXY_HOOK_SECRET: 's',
        CHROXY_PERMISSION_MODE: 'approve',
        ...extraEnv,
      },
    })
    return JSON.parse(stdout.trim()).hookSpecificOutput
  } finally {
    await srv.close()
  }
}

describe('permission-hook attributes only a real user deny to the user (#7044)', () => {
  it('200 + deny keeps the "Denied by user" wording', async () => {
    const out = await hookAgainst(200, '{"decision":"deny"}')
    assert.equal(out.permissionDecision, 'deny')
    assert.equal(out.permissionDecisionReason, 'Denied by user via Chroxy mobile app')
  })

  it('200 + allow still allows', async () => {
    const out = await hookAgainst(200, '{"decision":"allow"}')
    assert.equal(out.permissionDecision, 'allow')
  })

  for (const [status, label] of [[400, 'unparseable body'], [413, 'oversize body'], [500, 'daemon fault'], [401, 'unauthorized'], [429, 'rate limited']]) {
    it(`${status} (${label}) + {"decision":"deny"} DENIES with an honest, non-user reason`, async () => {
      const out = await hookAgainst(status, '{"decision":"deny"}')
      assert.equal(out.permissionDecision, 'deny', 'a daemon-side rejection must fail closed')
      assert.ok(!/Denied by user/i.test(out.permissionDecisionReason), 'must not attribute a daemon rejection to the user')
      assert.ok(
        out.permissionDecisionReason.includes(`(HTTP ${status})`) && /Failing closed \(denied\)/.test(out.permissionDecisionReason),
        `reason should name the HTTP status and the fail-closed outcome, got: ${out.permissionDecisionReason}`,
      )
    })
  }

  it('a non-200 NEVER allows, even if its body claims allow', async () => {
    for (const status of [400, 413, 500]) {
      const out = await hookAgainst(status, '{"decision":"allow"}')
      assert.equal(out.permissionDecision, 'deny', `HTTP ${status} + allow body must deny`)
    }
  })

  it('a non-200 with an empty body DENIES with the status in the reason', async () => {
    const out = await hookAgainst(503, '')
    assert.equal(out.permissionDecision, 'deny')
    assert.ok(out.permissionDecisionReason.includes('(HTTP 503)'), out.permissionDecisionReason)
  })

  it('a daemon rejection DENIES even when CHROXY_HOOK_UNREACHABLE_DECISION=ask (the opt-out is for an unreachable daemon, not a rejecting one)', async () => {
    const out = await hookAgainst(400, '{"decision":"deny"}', { CHROXY_HOOK_UNREACHABLE_DECISION: 'ask' })
    assert.equal(out.permissionDecision, 'deny')
    assert.ok(out.permissionDecisionReason.includes('(HTTP 400)'))
  })

  it('200 + an unrecognized body DENIES with the unrecognized-response reason, not the user wording', async () => {
    const out = await hookAgainst(200, '{"status":"ok"}')
    assert.equal(out.permissionDecision, 'deny')
    assert.ok(!/Denied by user/i.test(out.permissionDecisionReason))
    assert.ok(/unrecognized permission response/.test(out.permissionDecisionReason), out.permissionDecisionReason)
  })

  it('a response body without a trailing newline or with CRLF still resolves the 200 deny', async () => {
    const out = await hookAgainst(200, '{"decision":"deny"}\r\n')
    assert.equal(out.permissionDecision, 'deny')
    assert.equal(out.permissionDecisionReason, 'Denied by user via Chroxy mobile app')
  })
})
