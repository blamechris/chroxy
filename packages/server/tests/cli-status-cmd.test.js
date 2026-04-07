import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { collectStatus, runStatusCmd } from '../src/cli/status-cmd.js'

function mockJsonResponse(body, { ok = true } = {}) {
  return {
    ok,
    async json() { return body },
  }
}

function makeFetch(routes) {
  return async (url) => {
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.includes(prefix)) return handler(url)
    }
    throw new Error(`ECONNREFUSED ${url}`)
  }
}

describe('chroxy status command', () => {
  it('reports not running when health endpoint is unreachable', async () => {
    const status = await collectStatus({
      readConnectionInfo: () => null,
      fetchFn: async () => { throw new Error('ECONNREFUSED') },
    })
    assert.equal(status.running, false)
    assert.equal(status.pid, null)
    assert.equal(status.sessions, null)
  })

  it('reports running with full details when server is up', async () => {
    const startedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString() // 3m ago
    const info = {
      wsUrl: 'wss://random.trycloudflare.com',
      httpUrl: 'https://random.trycloudflare.com',
      apiToken: 'tok',
      tunnelMode: 'quick',
      startedAt,
      pid: 12345,
    }
    const fetchFn = makeFetch({
      '/metrics': () => mockJsonResponse({
        sessions: { active: 3 },
        uptime: 180,
      }),
      '/': () => mockJsonResponse({ status: 'ok', mode: 'cli', version: '9.9.9' }),
    })
    const status = await collectStatus({
      readConnectionInfo: () => info,
      fetchFn,
      defaultPort: 8765,
    })
    assert.equal(status.running, true)
    assert.equal(status.pid, 12345)
    assert.equal(status.tunnel.type, 'quick')
    assert.equal(status.tunnel.url, 'https://random.trycloudflare.com')
    assert.equal(status.sessions, 3)
    assert.equal(status.version, '9.9.9')
    assert.equal(status.mode, 'cli')
    assert.ok(status.uptimeSeconds >= 170 && status.uptimeSeconds <= 200)
  })

  it('falls back to port 8765 when no connection info', async () => {
    let calledUrl = null
    const fetchFn = async (url) => {
      calledUrl = url
      if (url.endsWith('/')) return mockJsonResponse({ status: 'ok', version: '1.2.3' })
      throw new Error('x')
    }
    const status = await collectStatus({
      readConnectionInfo: () => null,
      fetchFn,
    })
    assert.equal(status.running, true)
    assert.ok(calledUrl.includes('127.0.0.1:8765'))
  })

  it('human output includes key fields when running', async () => {
    const info = {
      wsUrl: 'wss://host.example:443',
      httpUrl: 'https://host.example:443',
      apiToken: 't',
      tunnelMode: 'named',
      startedAt: new Date(Date.now() - 60000).toISOString(),
      pid: 42,
    }
    const fetchFn = makeFetch({
      '/metrics': () => mockJsonResponse({ sessions: { active: 1 } }),
      '/': () => mockJsonResponse({ status: 'ok', version: '1.0.0' }),
    })
    let captured = ''
    await runStatusCmd({}, {
      readConnectionInfo: () => info,
      fetchFn,
      write: (s) => { captured = s },
    })
    assert.match(captured, /Chroxy v/)
    assert.match(captured, /Status:\s+Running \(pid 42\)/)
    assert.match(captured, /Tunnel:\s+https:\/\/host\.example/)
    assert.match(captured, /\(named\)/)
    assert.match(captured, /Sessions:\s+1 active/)
  })

  it('human output shows Not running when down', async () => {
    let captured = ''
    await runStatusCmd({}, {
      readConnectionInfo: () => null,
      fetchFn: async () => { throw new Error('x') },
      write: (s) => { captured = s },
    })
    assert.match(captured, /Status:\s+Not running/)
  })

  it('json output is valid JSON with expected keys', async () => {
    const fetchFn = makeFetch({
      '/': () => mockJsonResponse({ status: 'ok', version: '2.0.0' }),
    })
    let captured = ''
    await runStatusCmd({ json: true }, {
      readConnectionInfo: () => null,
      fetchFn,
      write: (s) => { captured = s },
    })
    const parsed = JSON.parse(captured)
    assert.equal(parsed.running, true)
    assert.equal(parsed.version, '2.0.0')
    assert.ok('tunnel' in parsed)
    assert.ok('uptimeSeconds' in parsed)
    assert.ok('sessions' in parsed)
  })
})
