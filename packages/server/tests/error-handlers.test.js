import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, 'fixtures')

describe('global error handlers', () => {
  describe('server-cli.js', () => {
    it('registers uncaughtException handler', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
      assert.ok(
        source.includes("process.on('uncaughtException'"),
        'server-cli.js should register uncaughtException handler'
      )
    })

    it('registers unhandledRejection handler', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
      assert.ok(
        source.includes("process.on('unhandledRejection'"),
        'server-cli.js should register unhandledRejection handler'
      )
    })

    it('uncaughtException handler includes best-effort shutdown broadcast', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
      const pattern = /process\.on\('uncaughtException',[\s\S]*?broadcastShutdown[\s\S]*?\}\)/m
      assert.ok(
        pattern.test(source),
        'uncaughtException handler should attempt broadcastShutdown for graceful client notification'
      )
    })

    it('unhandledRejection handler includes best-effort shutdown broadcast', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
      const pattern = /process\.on\('unhandledRejection',[\s\S]*?broadcastShutdown[\s\S]*?\}\)/m
      assert.ok(
        pattern.test(source),
        'broadcastShutdown should be within the unhandledRejection handler body'
      )
    })

    it('crash handlers use "crash" reason, not "shutdown"', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
      const uncaughtBlock = source.match(/process\.on\('uncaughtException',[\s\S]*?\}\)/m)
      assert.ok(uncaughtBlock, 'uncaughtException handler should exist')
      assert.ok(uncaughtBlock[0].includes("broadcastShutdown('crash'"),
        'uncaughtException should broadcast crash reason')

      const rejectionBlock = source.match(/process\.on\('unhandledRejection',[\s\S]*?\}\)/m)
      assert.ok(rejectionBlock, 'unhandledRejection handler should exist')
      assert.ok(rejectionBlock[0].includes("broadcastShutdown('crash'"),
        'unhandledRejection should broadcast crash reason')
    })
  })

  describe('#977 — deferred process.exit for flush', () => {
    it('uncaughtException handler defers process.exit via setTimeout', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
      const handler = source.match(/process\.on\('uncaughtException',[\s\S]*?\}\)/)
      assert.ok(handler, 'uncaughtException handler should exist')
      // process.exit should be inside a setTimeout, not called directly
      assert.ok(
        handler[0].includes('setTimeout'),
        'uncaughtException handler should use setTimeout to defer process.exit'
      )
    })

    it('unhandledRejection handler defers process.exit via setTimeout', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
      const handler = source.match(/process\.on\('unhandledRejection',[\s\S]*?\}\)/)
      assert.ok(handler, 'unhandledRejection handler should exist')
      assert.ok(
        handler[0].includes('setTimeout'),
        'unhandledRejection handler should use setTimeout to defer process.exit'
      )
    })
  })

  describe('server-cli-child.js', () => {
    it('registers uncaughtException handler', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli-child.js'), 'utf-8')
      assert.ok(
        source.includes("process.on('uncaughtException'"),
        'server-cli-child.js should register uncaughtException handler'
      )
    })

    it('registers unhandledRejection handler', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli-child.js'), 'utf-8')
      assert.ok(
        source.includes("process.on('unhandledRejection'"),
        'server-cli-child.js should register unhandledRejection handler'
      )
    })
  })

  describe('unhandledRejection handler logs and exits', () => {
    it('exits with code 1 on unhandled rejection', async () => {
      // Spawn a child that triggers an unhandled rejection
      const child = fork(join(fixturesDir, 'unhandled-rejection.mjs'), [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      })

      const stderr = []
      child.stderr.on('data', (chunk) => stderr.push(chunk.toString()))

      const code = await new Promise((resolve) => {
        child.on('exit', (code) => resolve(code))
      })

      const output = stderr.join('')
      assert.equal(code, 1, 'Should exit with code 1')
      assert.ok(output.includes('[fatal]'), 'Should log [fatal] prefix')
    })
  })
})

describe('token rotation QR regeneration', () => {
  it('registers token_rotated listener that regenerates QR code', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
    assert.ok(
      source.includes("token_rotated"),
      'server-cli.js should listen for token_rotated events'
    )
    assert.ok(
      /token_rotated[\s\S]*?qrcode\.generate/m.test(source),
      'token_rotated handler should regenerate QR code'
    )
  })

  it('updates connection info file on token rotation', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
    assert.ok(
      /token_rotated[\s\S]*?writeConnectionInfo/m.test(source),
      'token_rotated handler should update connection info file'
    )
  })
})

describe('#986 — no tmux references in server source', () => {
  it('server-cli.js has no tmux references', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
    const tmuxMatches = source.match(/tmux/gi) || []
    assert.equal(tmuxMatches.length, 0,
      `Found ${tmuxMatches.length} tmux reference(s) in server-cli.js — PTY/tmux was removed in v0.2.0`)
  })

  it('push.js has no tmux references', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(join(__dirname, '../src/push.js'), 'utf-8')
    const tmuxMatches = source.match(/tmux/gi) || []
    assert.equal(tmuxMatches.length, 0,
      `Found ${tmuxMatches.length} tmux reference(s) in push.js — PTY/tmux was removed in v0.2.0`)
  })

  it('server-cli.js JSDoc does not mention auto-discovering sessions', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
    assert.ok(!source.includes('Auto-discovers'),
      'JSDoc should not mention auto-discovering tmux sessions')
  })
})
