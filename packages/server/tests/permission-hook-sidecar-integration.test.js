import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const hookPath = join(__dirname, '../hooks/permission-hook.sh')

/**
 * Async wrapper around spawn(). spawnSync would block the event loop and
 * prevent the in-process mock HTTP server from accepting curl's request.
 */
function runHook({ input, env, timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [hookPath], { env })
    let stdout = ''
    let stderr = ''
    let timer = null
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.on('close', (status, signal) => {
      if (timer) clearTimeout(timer)
      resolve({ status, signal, stdout, stderr })
    })
    if (timeout) {
      timer = setTimeout(() => { child.kill('SIGKILL') }, timeout)
    }
    if (input != null) child.stdin.write(input)
    child.stdin.end()
  })
}

/**
 * Tiny HTTP server that captures /permission POSTs and replies with the
 * supplied decision. Used by the routing-fallback tests so that hook
 * scripts in approve mode have somewhere to phone home to.
 */
async function startMockPermissionServer({ decision = 'allow' } = {}) {
  const received = { body: null, headers: null, path: null, method: null, count: 0 }
  const server = createServer((req, res) => {
    received.method = req.method
    received.path = req.url
    received.headers = req.headers
    received.count++
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      received.body = body
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ decision }))
    })
  })
  await new Promise((resolve) => server.listen(0, resolve))
  const port = server.address().port
  return {
    port,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/**
 * End-to-end integration test for permission-hook.sh sidecar-file resolution
 * (#4020). The sidecar file is the IPC channel ClaudeTuiSession uses to
 * switch permission mode mid-session — see permission-hook.sh lines 29-43.
 *
 * Each test writes a real file to disk, forks /bin/bash with the
 * CHROXY_PERMISSION_MODE_FILE env var pointing at it, pipes a Claude Code
 * PreToolUse JSON payload via stdin, and asserts the hookSpecificOutput
 * stdout reflects the sidecar's contents.
 */
describe('permission-hook.sh sidecar-file integration (#4020)', () => {
  let tempDir
  let sidecarPath

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-sidecar-int-'))
    sidecarPath = join(tempDir, 'permission-mode')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  // Payload used for all routing tests — Bash command is non-file so
  // acceptEdits mode routes to the phone (curl) rather than auto-allow.
  const bashPayload = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
    session_id: 'sidecar-int-test',
  })

  // ---- Edge case 1: trailing newline ----
  it('sidecar with trailing newline is stripped and treated as auto', async () => {
    writeFileSync(sidecarPath, 'auto\n')
    const { status, stdout } = await runHook({
      input: bashPayload,
      env: {
        ...process.env,
        CHROXY_PORT: '9999', // unreachable, but auto short-circuits before curl
        CHROXY_PERMISSION_MODE: 'approve', // sidecar should override
        CHROXY_PERMISSION_MODE_FILE: sidecarPath,
      },
    })
    assert.equal(status, 0)
    const out = JSON.parse(stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow',
      'auto mode should short-circuit to allow without curl')
  })

  // ---- Edge case 2: CRLF line endings ----
  it('sidecar with CRLF line endings is stripped and treated as auto', async () => {
    writeFileSync(sidecarPath, 'auto\r\n')
    const { status, stdout } = await runHook({
      input: bashPayload,
      env: {
        ...process.env,
        CHROXY_PORT: '9999',
        CHROXY_PERMISSION_MODE: 'approve',
        CHROXY_PERMISSION_MODE_FILE: sidecarPath,
      },
    })
    assert.equal(status, 0)
    const out = JSON.parse(stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow',
      'CRLF-trimmed auto mode should short-circuit to allow')
  })

  // ---- Edge case 3: empty sidecar file ----
  it('empty sidecar falls through to CHROXY_PERMISSION_MODE env var', async () => {
    writeFileSync(sidecarPath, '')
    // Env-var mode = plan, which always returns "ask" without any curl call
    const { status, stdout } = await runHook({
      input: bashPayload,
      env: {
        ...process.env,
        CHROXY_PORT: '9999',
        CHROXY_PERMISSION_MODE: 'plan',
        CHROXY_PERMISSION_MODE_FILE: sidecarPath,
      },
    })
    assert.equal(status, 0)
    const out = JSON.parse(stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask',
      'empty sidecar must fall through to env var (plan -> ask)')
  })

  // ---- Edge case 4: whitespace-only sidecar ----
  it('whitespace-only sidecar falls through to env var', async () => {
    writeFileSync(sidecarPath, '  \t\n\r  ')
    const { status, stdout } = await runHook({
      input: bashPayload,
      env: {
        ...process.env,
        CHROXY_PORT: '9999',
        CHROXY_PERMISSION_MODE: 'plan',
        CHROXY_PERMISSION_MODE_FILE: sidecarPath,
      },
    })
    assert.equal(status, 0)
    const out = JSON.parse(stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask',
      'whitespace-only sidecar must fall through to env var')
  })

  // ---- Edge case 5: invalid mode in sidecar ----
  it('invalid mode in sidecar is forced to approve and routes to phone', async () => {
    writeFileSync(sidecarPath, 'bogus')
    const mock = await startMockPermissionServer({ decision: 'allow' })
    try {
      const { status, stdout } = await runHook({
        input: bashPayload,
        env: {
          ...process.env,
          CHROXY_PORT: String(mock.port),
          CHROXY_HOOK_SECRET: 'int-secret',
          CHROXY_PERMISSION_MODE_FILE: sidecarPath,
          // Deliberately omit CHROXY_PERMISSION_MODE — sidecar's bogus value
          // must be sanitized to approve, then routed to phone
        },
      })
      assert.equal(status, 0)
      assert.equal(mock.received.method, 'POST',
        'invalid mode -> approve -> routes to phone via curl')
      assert.equal(mock.received.path, '/permission')
      assert.equal(mock.received.body, bashPayload,
        'hook should forward stdin JSON verbatim to the server')
      const out = JSON.parse(stdout)
      assert.equal(out.hookSpecificOutput.permissionDecision, 'allow')
    } finally {
      await mock.close()
    }
  })

  // ---- Edge case 6: unreadable sidecar (permission denied) ----
  it('unreadable sidecar (chmod 000) falls through to env var', async () => {
    writeFileSync(sidecarPath, 'auto')
    chmodSync(sidecarPath, 0o000)
    try {
      // Skip on platforms where the test runs as root — root can always read
      // and the [-r ...] check would pass, defeating the test.
      if (process.getuid && process.getuid() === 0) {
        return
      }
      const { status, stdout } = await runHook({
        input: bashPayload,
        env: {
          ...process.env,
          CHROXY_PORT: '9999',
          CHROXY_PERMISSION_MODE: 'plan', // fallback target
          CHROXY_PERMISSION_MODE_FILE: sidecarPath,
        },
      })
      assert.equal(status, 0)
      const out = JSON.parse(stdout)
      assert.equal(out.hookSpecificOutput.permissionDecision, 'ask',
        'unreadable sidecar should fall through to env var (plan -> ask)')
    } finally {
      // Restore perms so afterEach can rmSync
      try { chmodSync(sidecarPath, 0o600) } catch {}
    }
  })

  // ---- Edge case 7: writeFileSync atomicity regression guard ----
  it('rapid mid-flight sidecar writes never produce a corrupt mode read', async () => {
    // Interleave writes between hook spawns. ClaudeTuiSession.setPermissionMode
    // uses writeFileSync which is atomic on POSIX for small payloads, so every
    // read must yield a valid sanitized mode — never a partial string like
    // "ap" or a concatenated "autoapprove".
    const modes = ['auto', 'approve', 'plan', 'acceptEdits']
    writeFileSync(sidecarPath, 'auto')

    // Sequence: write -> spawn -> write -> spawn... 20 iterations. Bounded
    // and event-loop-friendly (each await yields), unlike a tight while-loop
    // racing against parallel spawns which can starve the loop entirely.
    const results = []
    for (let i = 0; i < 20; i++) {
      writeFileSync(sidecarPath, modes[i % modes.length])
      results.push(await runHook({
        input: bashPayload,
        env: {
          ...process.env,
          CHROXY_PORT: '1', // unreachable port — approve mode fails curl -> ask
          CHROXY_PERMISSION_MODE: 'plan',
          CHROXY_PERMISSION_MODE_FILE: sidecarPath,
        },
        timeout: 5000,
      }))
    }

    for (const { status, stdout, stderr } of results) {
      assert.equal(status, 0, `hook exited non-zero (stderr: ${stderr})`)
      // Output must be valid JSON with one of the legal decisions. The
      // point is that NO read produced an unparseable output (which would
      // happen if a mid-write race surfaced a garbled mode string that
      // bypassed the case sanitizer).
      const out = JSON.parse(stdout)
      assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse')
      assert.ok(
        ['ask', 'allow', 'deny'].includes(out.hookSpecificOutput.permissionDecision),
        `unexpected decision: ${out.hookSpecificOutput.permissionDecision}`
      )
    }
  })

  // ---- Positive control: full end-to-end with sidecar mid-session switch ----
  it('end-to-end: write sidecar -> spawn hook -> reads sidecar mode -> emits matching decision', async () => {
    // The canonical happy path the issue references: server-side JS
    // writes the sidecar (simulated here by writeFileSync), hook is
    // invoked, hook reads the sidecar, outputs a decision matching the
    // sidecar mode. Proves the read path the JS tests can't cover.
    writeFileSync(sidecarPath, 'auto')
    const { status, stdout } = await runHook({
      input: bashPayload,
      env: {
        ...process.env,
        CHROXY_PORT: '9999',
        // CHROXY_PERMISSION_MODE is intentionally set to "approve" — if
        // the hook read the env var instead of the sidecar, we'd see a
        // curl attempt instead of auto-allow.
        CHROXY_PERMISSION_MODE: 'approve',
        CHROXY_PERMISSION_MODE_FILE: sidecarPath,
      },
    })
    assert.equal(status, 0)
    const out = JSON.parse(stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow',
      'sidecar must take precedence over CHROXY_PERMISSION_MODE env var')
  })

  // Sidecar file does not exist at all — must fall through to env var
  it('missing sidecar file falls through to env var', async () => {
    // sidecarPath was never written
    const { status, stdout } = await runHook({
      input: bashPayload,
      env: {
        ...process.env,
        CHROXY_PORT: '9999',
        CHROXY_PERMISSION_MODE: 'plan',
        CHROXY_PERMISSION_MODE_FILE: sidecarPath,
      },
    })
    assert.equal(status, 0)
    const out = JSON.parse(stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask',
      'missing sidecar must fall through to env var')
  })
})
