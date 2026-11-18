import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { probePidLiveness } from '../src/utils/pid-liveness.js'
import { join } from 'path'
import { tmpdir } from 'os'

// Save original env var value and use temp dir to isolate tests from real config
const originalConfigDir = process.env.CHROXY_CONFIG_DIR
const testDir = mkdtempSync(join(tmpdir(), 'chroxy-conn-test-'))
process.env.CHROXY_CONFIG_DIR = testDir

// Import AFTER setting env var so the module picks it up
const { writeConnectionInfo, readConnectionInfo, removeConnectionInfo, getConnectionInfoPath } = await import('../src/connection-info.js')

// Clean up after all tests and restore original env var
after(() => {
  try { rmSync(testDir, { recursive: true }) } catch {}
  if (originalConfigDir !== undefined) {
    process.env.CHROXY_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CHROXY_CONFIG_DIR
  }
})

function cleanup() {
  try { rmSync(join(testDir, 'connection.json')) } catch {}
}

describe('connection-info', () => {
  it('writeConnectionInfo() creates the file with correct content', () => {
    cleanup()
    const info = {
      wsUrl: 'wss://example.com',
      httpUrl: 'https://example.com',
      apiToken: 'test-token-123',
      connectionUrl: 'chroxy://example.com?token=test-token-123',
      tunnelMode: 'cloudflare:quick',
      startedAt: '2026-02-22T00:00:00.000Z',
      pid: 4242,
    }
    writeConnectionInfo(info)

    const filePath = getConnectionInfoPath()
    assert.ok(existsSync(filePath), 'connection.json should exist')

    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    assert.deepEqual(parsed, info)
    cleanup()
  })

  it('readConnectionInfo() returns parsed JSON', () => {
    cleanup()
    const info = {
      wsUrl: 'wss://test.example.com',
      httpUrl: 'https://test.example.com',
      apiToken: 'tok-read-test',
      connectionUrl: 'chroxy://test.example.com?token=tok-read-test',
      tunnelMode: 'cloudflare:named',
      startedAt: '2026-02-22T12:00:00.000Z',
      pid: 4242, // synthetic: the read below mocks the probe (#9074)
    }
    writeConnectionInfo(info)

    const result = readConnectionInfo({ probePidLiveness: (pid) => probePidLiveness(pid, { kill: () => {} }) })
    assert.deepEqual(result, info)
    cleanup()
  })

  it('readConnectionInfo() returns null when file does not exist', () => {
    cleanup()
    const result = readConnectionInfo()
    assert.equal(result, null)
  })

  it('removeConnectionInfo() removes the file', () => {
    cleanup()
    writeConnectionInfo({ wsUrl: 'wss://remove-test.com' })
    const filePath = getConnectionInfoPath()
    assert.ok(existsSync(filePath), 'file should exist before removal')

    removeConnectionInfo()
    assert.ok(!existsSync(filePath), 'file should not exist after removal')
  })

  it('removeConnectionInfo() does not throw when file does not exist', () => {
    cleanup()
    // Should not throw
    removeConnectionInfo()
  })

  it('round-trip: write then read preserves all fields', () => {
    cleanup()
    const info = {
      wsUrl: 'wss://roundtrip.example.com',
      httpUrl: 'https://roundtrip.example.com',
      apiToken: 'tok-roundtrip-abc123',
      connectionUrl: 'chroxy://roundtrip.example.com?token=tok-roundtrip-abc123',
      tunnelMode: 'cloudflare:quick',
      startedAt: '2026-02-22T08:30:00.000Z',
      pid: 4242, // synthetic: the read below mocks the probe (#9074)
    }

    writeConnectionInfo(info)
    const result = readConnectionInfo({ probePidLiveness: (pid) => probePidLiveness(pid, { kill: () => {} }) })

    assert.equal(result.wsUrl, info.wsUrl)
    assert.equal(result.httpUrl, info.httpUrl)
    assert.equal(result.apiToken, info.apiToken)
    assert.equal(result.connectionUrl, info.connectionUrl)
    assert.equal(result.tunnelMode, info.tunnelMode)
    assert.equal(result.startedAt, info.startedAt)
    assert.equal(result.pid, info.pid)
    cleanup()
  })

  // #9074: the liveness of the recorded pid, by MOCKED errno only (no real pid is
  // probed here). Only a verified-alive record is returned, and the read never
  // deletes the file, whatever the probe says.
  describe('liveness (#9074)', () => {
    const errno = (code) => Object.assign(new Error(code), { code })
    const probeWith = (kill) => (pid) => probePidLiveness(pid, { kill })
    const record = (extra = {}) => ({ wsUrl: 'wss://liveness.example.com', apiToken: 'tok-liveness', pid: 4242, ...extra })

    it('a verified-alive pid returns the record', () => {
      cleanup()
      writeConnectionInfo(record())
      assert.deepEqual(readConnectionInfo({ probePidLiveness: probeWith(() => {}) }), record())
      cleanup()
    })

    it('a dead pid (ESRCH) returns null and does NOT delete the file', () => {
      // Mutation: restore the read-time unlink -> the file is gone and this goes red.
      cleanup()
      writeConnectionInfo(record())
      assert.equal(readConnectionInfo({ probePidLiveness: probeWith(() => { throw errno('ESRCH') }) }), null)
      assert.ok(existsSync(getConnectionInfoPath()), 'a read never deletes the record (a restarting daemon may have just written it)')
      cleanup()
    })

    it('an unverified pid (EPERM) returns null and keeps the file', () => {
      // Mutation: classify EPERM as alive -> the record (and its token) comes back.
      cleanup()
      writeConnectionInfo(record())
      assert.equal(readConnectionInfo({ probePidLiveness: probeWith(() => { throw errno('EPERM') }) }), null, 'unverified is not healthy')
      assert.ok(existsSync(getConnectionInfoPath()), 'unverified is not dead either')
      cleanup()
    })

    it('any other probe error is unverified: null, file kept', () => {
      cleanup()
      writeConnectionInfo(record())
      assert.equal(readConnectionInfo({ probePidLiveness: probeWith(() => { throw errno('EINVAL') }) }), null)
      assert.ok(existsSync(getConnectionInfoPath()))
      cleanup()
    })

    it('a missing or malformed pid fails closed without probing: null, file kept', () => {
      for (const pid of [undefined, null, 0, -1, 1.5, '4242', 2 ** 53]) {
        cleanup()
        writeConnectionInfo(record({ pid }))
        let probed = 0
        const result = readConnectionInfo({ probePidLiveness: probeWith(() => { probed++ }) })
        assert.equal(result, null, `pid ${JSON.stringify(pid)} is never treated as alive`)
        assert.equal(probed, 0, `pid ${JSON.stringify(pid)} is never probed (0 and negatives address process groups)`)
        assert.ok(existsSync(getConnectionInfoPath()))
      }
      cleanup()
    })

    it('malformed JSON returns null and keeps the file', () => {
      cleanup()
      writeConnectionInfo(record())
      writeFileSync(getConnectionInfoPath(), '{ not json', 'utf-8')
      assert.equal(readConnectionInfo({ probePidLiveness: probeWith(() => {}) }), null)
      assert.ok(existsSync(getConnectionInfoPath()))
      cleanup()
    })
  })

  it('getConnectionInfoPath() returns path inside config dir', () => {
    const path = getConnectionInfoPath()
    assert.ok(path.startsWith(testDir), 'path should be inside the config dir')
    assert.ok(path.endsWith('connection.json'), 'path should end with connection.json')
  })
})
