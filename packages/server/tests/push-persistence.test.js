import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PushManager } from '../src/push.js'

const VALID_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'
const VALID_TOKEN_2 = 'ExponentPushToken[yyyyyyyyyyyyyyyyyyyyyy]'

describe('PushManager persistence (#1982)', () => {
  let tmpDir
  let storagePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'push-test-'))
    storagePath = join(tmpDir, 'push-tokens.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    mock.restoreAll()
  })

  it('persists tokens to disk on registerToken', () => {
    const manager = new PushManager({ storagePath })
    manager.registerToken(VALID_TOKEN)

    assert.ok(existsSync(storagePath))
    const saved = JSON.parse(readFileSync(storagePath, 'utf-8'))
    assert.deepEqual(saved, [VALID_TOKEN])
  })

  it('loads tokens from disk on construction', () => {
    writeFileSync(storagePath, JSON.stringify([VALID_TOKEN, VALID_TOKEN_2]))
    const manager = new PushManager({ storagePath })

    assert.equal(manager.tokens.size, 2)
    assert.ok(manager.tokens.has(VALID_TOKEN))
    assert.ok(manager.tokens.has(VALID_TOKEN_2))
  })

  it('persists removal to disk on removeToken', () => {
    writeFileSync(storagePath, JSON.stringify([VALID_TOKEN, VALID_TOKEN_2]))
    const manager = new PushManager({ storagePath })
    manager.removeToken(VALID_TOKEN)

    const saved = JSON.parse(readFileSync(storagePath, 'utf-8'))
    assert.deepEqual(saved, [VALID_TOKEN_2])
  })

  it('deduplicates on load when client reconnects with same token', () => {
    writeFileSync(storagePath, JSON.stringify([VALID_TOKEN]))
    const manager = new PushManager({ storagePath })
    manager.registerToken(VALID_TOKEN)

    assert.equal(manager.tokens.size, 1)
    const saved = JSON.parse(readFileSync(storagePath, 'utf-8'))
    assert.deepEqual(saved, [VALID_TOKEN])
  })

  it('persists after token pruning from Expo API errors', async () => {
    const manager = new PushManager({ storagePath })
    manager.registerToken(VALID_TOKEN)
    manager.registerToken(VALID_TOKEN_2)

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { status: 'error', message: 'DeviceNotRegistered' },
          { status: 'ok' },
        ],
      }),
    }))

    await manager.send('permission', 'Test', 'Body')

    const saved = JSON.parse(readFileSync(storagePath, 'utf-8'))
    assert.deepEqual(saved, [VALID_TOKEN_2])
  })

  it('handles missing storage file gracefully', () => {
    const manager = new PushManager({ storagePath })
    assert.equal(manager.tokens.size, 0)
  })

  it('handles corrupt storage file gracefully', () => {
    writeFileSync(storagePath, 'not-json{{{')
    const manager = new PushManager({ storagePath })
    assert.equal(manager.tokens.size, 0)
  })

  it('works without storagePath (in-memory only, backwards compatible)', () => {
    const manager = new PushManager()
    manager.registerToken(VALID_TOKEN)
    assert.ok(manager.tokens.has(VALID_TOKEN))
    // No file created anywhere
  })
})
