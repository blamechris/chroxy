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
    // token_rotated calls displayQr() which internally calls qrcode.generate
    assert.ok(
      source.includes('displayQr') && source.includes('qrcode.generate'),
      'server-cli.js should regenerate QR code via displayQr helper'
    )
  })

  it('updates connection info file on token rotation', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
    // displayQr helper calls writeConnectionInfo internally
    assert.ok(
      source.includes('displayQr') && source.includes('writeConnectionInfo'),
      'displayQr helper should update connection info file'
    )
  })
})


describe('#990 — crash handler cleanup', () => {
  describe('server-cli.js crash handlers', () => {
    it('uncaughtException calls sessionManager.destroyAll()', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
      const handler = source.match(/process\.on\('uncaughtException',[\s\S]*?\}\)/)
      assert.ok(handler, 'uncaughtException handler should exist')
      assert.ok(handler[0].includes('sessionManager.destroyAll()'),
        'uncaughtException should call sessionManager.destroyAll()')
    })

    it('uncaughtException calls removeConnectionInfo()', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
      const handler = source.match(/process\.on\('uncaughtException',[\s\S]*?\}\)/)
      assert.ok(handler, 'uncaughtException handler should exist')
      assert.ok(handler[0].includes('removeConnectionInfo()'),
        'uncaughtException should call removeConnectionInfo()')
    })

    it('unhandledRejection calls sessionManager.destroyAll()', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
      const handler = source.match(/process\.on\('unhandledRejection',[\s\S]*?\}\)/)
      assert.ok(handler, 'unhandledRejection handler should exist')
      assert.ok(handler[0].includes('sessionManager.destroyAll()'),
        'unhandledRejection should call sessionManager.destroyAll()')
    })

    it('unhandledRejection calls removeConnectionInfo()', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
      const handler = source.match(/process\.on\('unhandledRejection',[\s\S]*?\}\)/)
      assert.ok(handler, 'unhandledRejection handler should exist')
      assert.ok(handler[0].includes('removeConnectionInfo()'),
        'unhandledRejection should call removeConnectionInfo()')
    })

    it('uncaughtException calls tunnel.stop()', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
      const handler = source.match(/process\.on\('uncaughtException',[\s\S]*?\}\)/)
      assert.ok(handler, 'uncaughtException handler should exist')
      assert.ok(handler[0].includes('tunnel.stop()'),
        'uncaughtException should call tunnel.stop()')
    })

    it('unhandledRejection calls tunnel.stop()', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
      const handler = source.match(/process\.on\('unhandledRejection',[\s\S]*?\}\)/)
      assert.ok(handler, 'unhandledRejection handler should exist')
      assert.ok(handler[0].includes('tunnel.stop()'),
        'unhandledRejection should call tunnel.stop()')
    })
  })

  describe('server-cli-child.js crash handlers', () => {
    it('uncaughtException calls broadcastShutdown', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli-child.js'), 'utf-8')
      const handler = source.match(/process\.on\('uncaughtException',[\s\S]*?\}\)/)
      assert.ok(handler, 'uncaughtException handler should exist')
      assert.ok(handler[0].includes('broadcastShutdown'),
        'uncaughtException should call broadcastShutdown')
    })

    it('uncaughtException calls destroyAll', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli-child.js'), 'utf-8')
      const handler = source.match(/process\.on\('uncaughtException',[\s\S]*?\}\)/)
      assert.ok(handler, 'uncaughtException handler should exist')
      assert.ok(handler[0].includes('destroyAll'),
        'uncaughtException should call destroyAll')
    })

    it('uncaughtException calls wsServer.close()', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli-child.js'), 'utf-8')
      const handler = source.match(/process\.on\('uncaughtException',[\s\S]*?\}\)/)
      assert.ok(handler, 'uncaughtException handler should exist')
      assert.ok(handler[0].includes('close()'),
        'uncaughtException should call wsServer.close()')
    })

    it('uncaughtException defers process.exit via setTimeout', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli-child.js'), 'utf-8')
      const handler = source.match(/process\.on\('uncaughtException',[\s\S]*?\}\)/)
      assert.ok(handler, 'uncaughtException handler should exist')
      assert.ok(handler[0].includes('setTimeout'),
        'uncaughtException should defer exit with setTimeout')
    })

    it('unhandledRejection calls broadcastShutdown', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli-child.js'), 'utf-8')
      const handler = source.match(/process\.on\('unhandledRejection',[\s\S]*?\}\)/)
      assert.ok(handler, 'unhandledRejection handler should exist')
      assert.ok(handler[0].includes('broadcastShutdown'),
        'unhandledRejection should call broadcastShutdown')
    })

    it('unhandledRejection calls destroyAll', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli-child.js'), 'utf-8')
      const handler = source.match(/process\.on\('unhandledRejection',[\s\S]*?\}\)/)
      assert.ok(handler, 'unhandledRejection handler should exist')
      assert.ok(handler[0].includes('destroyAll'),
        'unhandledRejection should call destroyAll')
    })

    it('unhandledRejection calls wsServer.close()', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli-child.js'), 'utf-8')
      const handler = source.match(/process\.on\('unhandledRejection',[\s\S]*?\}\)/)
      assert.ok(handler, 'unhandledRejection handler should exist')
      assert.ok(handler[0].includes('close()'),
        'unhandledRejection should call wsServer.close()')
    })

    it('unhandledRejection defers process.exit via setTimeout', async () => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync(join(__dirname, '../src/server-cli-child.js'), 'utf-8')
      const handler = source.match(/process\.on\('unhandledRejection',[\s\S]*?\}\)/)
      assert.ok(handler, 'unhandledRejection handler should exist')
      assert.ok(handler[0].includes('setTimeout'),
        'unhandledRejection should defer exit with setTimeout')
    })
  })
})

describe('--no-encrypt + tunnel guard (#1850)', () => {
  it('server-cli.js rejects --no-encrypt with tunnel enabled', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
    assert.ok(
      source.includes('noEncrypt') && source.includes('tunnel') && source.includes('process.exit'),
      'server-cli.js should guard against --no-encrypt + tunnel combination'
    )
  })
})
