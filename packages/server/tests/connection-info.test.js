import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Use CHROXY_CONFIG_DIR env var to isolate tests from real config
const testDir = mkdtempSync(join(tmpdir(), 'chroxy-conn-test-'))
process.env.CHROXY_CONFIG_DIR = testDir

// Import AFTER setting env var so the module picks it up
const { writeConnectionInfo, readConnectionInfo, removeConnectionInfo, getConnectionInfoPath } = await import('../src/connection-info.js')

// Clean up after all tests
after(() => {
  try { rmSync(testDir, { recursive: true }) } catch {}
  delete process.env.CHROXY_CONFIG_DIR
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
      pid: 12345,
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
      pid: 99999,
    }
    writeConnectionInfo(info)

    const result = readConnectionInfo()
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
      pid: 54321,
    }

    writeConnectionInfo(info)
    const result = readConnectionInfo()

    assert.equal(result.wsUrl, info.wsUrl)
    assert.equal(result.httpUrl, info.httpUrl)
    assert.equal(result.apiToken, info.apiToken)
    assert.equal(result.connectionUrl, info.connectionUrl)
    assert.equal(result.tunnelMode, info.tunnelMode)
    assert.equal(result.startedAt, info.startedAt)
    assert.equal(result.pid, info.pid)
    cleanup()
  })

  it('getConnectionInfoPath() returns path inside config dir', () => {
    const path = getConnectionInfoPath()
    assert.ok(path.startsWith(testDir), 'path should be inside the config dir')
    assert.ok(path.endsWith('connection.json'), 'path should end with connection.json')
  })
})
