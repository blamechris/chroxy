// #5413 Phase 4: bin entry pins (the exact surface Claude Code invokes).
//
//   - `emit <type>` with a payload on stdin → POSTs the envelope, exit 0
//   - `emit` ALWAYS exits 0: daemon down, no secret, garbage stdin
//   - nothing is ever printed to stdout in emit mode (hook-safety)
//   - install/uninstall round-trip against a temp settings.json via
//     CHROXY_HOOKS_SETTINGS_PATH
//
// Spawns the real bin with env overrides only — no real ~/.chroxy or
// ~/.claude involved.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN_PATH = fileURLToPath(new URL('../bin/chroxy-hooks.js', import.meta.url))
const SECRET = 'bin-test-secret'

function runBin(args, { env = {}, stdin = null } = {}) {
  return new Promise((resolvePromise) => {
    const child = execFile(process.execPath, [BIN_PATH, ...args], {
      env: { ...process.env, ...env },
      timeout: 10_000,
    }, (error, stdout, stderr) => {
      resolvePromise({ code: error?.code ?? 0, stdout, stderr })
    })
    if (stdin !== null) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

describe('chroxy-hooks bin', () => {
  let server
  let url
  const received = []

  before(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        received.push({ auth: req.headers['authorization'], body: JSON.parse(body) })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    url = `http://127.0.0.1:${server.address().port}/api/events`
  })

  after(() => server.close())

  it('emit posts the envelope and exits 0 with silent stdout', async () => {
    const { code, stdout } = await runBin(['emit', 'notification'], {
      env: { CHROXY_INGEST_URL: url, CHROXY_INGEST_SECRET: SECRET },
      stdin: JSON.stringify({ hook_event_name: 'Notification', session_id: 'bin-1', message: 'Waiting on you' }),
    })
    assert.equal(code, 0)
    assert.equal(stdout, '')
    const req = received.at(-1)
    assert.equal(req.auth, `Bearer ${SECRET}`)
    assert.equal(req.body.type, 'notification')
    assert.equal(req.body.sessionId, 'bin-1')
    assert.equal(req.body.data.message, 'Waiting on you')
  })

  it('emit exits 0 when the daemon is down', async () => {
    const { code, stdout } = await runBin(['emit', 'session_start'], {
      env: { CHROXY_INGEST_URL: 'http://127.0.0.1:1/api/events', CHROXY_INGEST_SECRET: SECRET },
      stdin: '{}',
    })
    assert.equal(code, 0)
    assert.equal(stdout, '')
  })

  it('emit exits 0 with no secret and on garbage stdin', async () => {
    const emptyCfg = mkdtempSync(join(tmpdir(), 'bin-nosecret-'))
    const { code, stdout } = await runBin(['emit', 'session_end'], {
      env: { CHROXY_INGEST_URL: url, CHROXY_CONFIG_DIR: emptyCfg, CHROXY_INGEST_SECRET: '' },
      stdin: 'not json at all',
    })
    assert.equal(code, 0)
    assert.equal(stdout, '')
  })

  it('install + uninstall round-trip via CHROXY_HOOKS_SETTINGS_PATH', async () => {
    const settingsPath = join(mkdtempSync(join(tmpdir(), 'bin-install-')), 'settings.json')
    const install = await runBin(['install'], { env: { CHROXY_HOOKS_SETTINGS_PATH: settingsPath } })
    assert.equal(install.code, 0)
    const installed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.ok(installed.hooks.SessionStart.length >= 1)
    assert.ok(JSON.stringify(installed).includes('chroxy-hooks'))

    const uninstall = await runBin(['uninstall'], { env: { CHROXY_HOOKS_SETTINGS_PATH: settingsPath } })
    assert.equal(uninstall.code, 0)
    const cleaned = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.equal(JSON.stringify(cleaned).includes('chroxy-hooks'), false)
  })

  it('unknown commands exit non-zero with usage on stderr', async () => {
    const { code, stderr } = await runBin(['bogus'])
    assert.notEqual(code, 0)
    assert.match(stderr, /Usage: chroxy-hooks/)
  })
})
