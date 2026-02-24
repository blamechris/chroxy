import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { DevPreviewManager } from '../src/dev-preview.js'

describe('DevPreviewManager', () => {
  let manager

  beforeEach(() => {
    manager = new DevPreviewManager()
  })

  describe('detectPort', () => {
    it('detects "listening on port XXXX"', () => {
      assert.equal(manager.detectPort('Server listening on port 3000'), 3000)
    })

    it('detects "listening at port XXXX"', () => {
      assert.equal(manager.detectPort('App listening at port 8080'), 8080)
    })

    it('detects "http://localhost:XXXX"', () => {
      assert.equal(manager.detectPort('Started at http://localhost:5173'), 5173)
    })

    it('detects "http://127.0.0.1:XXXX"', () => {
      assert.equal(manager.detectPort('Server running on http://127.0.0.1:4000'), 4000)
    })

    it('detects Vite-style "Local: http://localhost:XXXX"', () => {
      assert.equal(manager.detectPort('  Local:   http://localhost:5173/'), 5173)
    })

    it('detects "ready on 0.0.0.0:XXXX"', () => {
      assert.equal(manager.detectPort('Server ready on 0.0.0.0:3000'), 3000)
    })

    it('detects "started on port XXXX"', () => {
      assert.equal(manager.detectPort('Express started on port 4567'), 4567)
    })

    it('detects "server is running on port XXXX"', () => {
      assert.equal(manager.detectPort('Server is running on port 8000'), 8000)
    })

    it('detects "running on localhost:XXXX"', () => {
      assert.equal(manager.detectPort('App running on localhost:3001'), 3001)
    })

    it('detects "serving on port XXXX"', () => {
      assert.equal(manager.detectPort('Static files serving on port 9000'), 9000)
    })

    it('returns null for non-matching text', () => {
      assert.equal(manager.detectPort('Hello world'), null)
    })

    it('returns null for null/undefined input', () => {
      assert.equal(manager.detectPort(null), null)
      assert.equal(manager.detectPort(undefined), null)
    })

    it('returns null for empty string', () => {
      assert.equal(manager.detectPort(''), null)
    })

    it('ignores well-known non-dev ports', () => {
      assert.equal(manager.detectPort('listening on port 22'), null)
      assert.equal(manager.detectPort('listening on port 80'), null)
      assert.equal(manager.detectPort('listening on port 443'), null)
    })

    it('ignores ports below 1024', () => {
      assert.equal(manager.detectPort('listening on port 80'), null)
    })

    it('ignores database ports', () => {
      assert.equal(manager.detectPort('PostgreSQL listening on port 5432'), null)
      assert.equal(manager.detectPort('MySQL listening on port 3306'), null)
      assert.equal(manager.detectPort('Redis listening on port 6379'), null)
    })

    it('handles multi-line output and matches first pattern', () => {
      const output = `
        Building...
        Done in 1.2s
        Local:   http://localhost:5173
        Network: http://192.168.1.5:5173
      `
      assert.equal(manager.detectPort(output), 5173)
    })
  })

  describe('handleToolResult', () => {
    it('emits dev_preview_started for detected port (mocked)', async () => {
      // Replace _createPreviewTunnel to avoid real cloudflared
      let capturedArgs = null
      manager._createPreviewTunnel = async (sessionId, port) => {
        capturedArgs = { sessionId, port }
      }

      await manager.handleToolResult('sess-1', 'Server listening on port 3000')
      assert.deepEqual(capturedArgs, { sessionId: 'sess-1', port: 3000 })
    })

    it('does nothing for non-matching output', async () => {
      let called = false
      manager._createPreviewTunnel = async () => { called = true }

      await manager.handleToolResult('sess-1', 'npm install completed')
      assert.equal(called, false)
    })

    it('does not create duplicate tunnels for same session+port', async () => {
      let callCount = 0
      manager._createPreviewTunnel = async (sessionId, port) => {
        callCount++
        // Simulate having a tunnel
        if (!manager._tunnels.has(sessionId)) manager._tunnels.set(sessionId, new Map())
        manager._tunnels.get(sessionId).set(port, { url: 'https://test.trycloudflare.com' })
      }

      await manager.handleToolResult('sess-1', 'listening on port 3000')
      await manager.handleToolResult('sess-1', 'listening on port 3000')
      assert.equal(callCount, 1)
    })

    it('allows different ports for same session', async () => {
      let ports = []
      manager._createPreviewTunnel = async (sessionId, port) => {
        ports.push(port)
        if (!manager._tunnels.has(sessionId)) manager._tunnels.set(sessionId, new Map())
        manager._tunnels.get(sessionId).set(port, { url: `https://test${port}.trycloudflare.com` })
      }

      await manager.handleToolResult('sess-1', 'listening on port 3000')
      await manager.handleToolResult('sess-1', 'listening on port 5173')
      assert.deepEqual(ports, [3000, 5173])
    })
  })

  describe('getActivePreviews', () => {
    it('returns empty array for unknown session', () => {
      assert.deepEqual(manager.getActivePreviews('unknown'), [])
    })

    it('returns active previews', () => {
      manager._tunnels.set('sess-1', new Map([
        [3000, { url: 'https://a.trycloudflare.com' }],
        [5173, { url: 'https://b.trycloudflare.com' }],
      ]))

      const previews = manager.getActivePreviews('sess-1')
      assert.equal(previews.length, 2)
      assert.equal(previews[0].port, 3000)
      assert.equal(previews[0].url, 'https://a.trycloudflare.com')
    })
  })

  describe('closePreview', () => {
    it('removes a specific tunnel and emits event', async () => {
      let stopped = false
      manager._tunnels.set('sess-1', new Map([
        [3000, { stop: async () => { stopped = true }, url: 'https://a.trycloudflare.com' }],
      ]))

      let emitted = null
      manager.on('dev_preview_stopped', (data) => { emitted = data })

      await manager.closePreview('sess-1', 3000)
      assert.equal(stopped, true)
      assert.deepEqual(emitted, { sessionId: 'sess-1', port: 3000 })
      assert.deepEqual(manager.getActivePreviews('sess-1'), [])
    })

    it('does nothing for non-existent tunnel', async () => {
      await manager.closePreview('sess-1', 3000) // should not throw
    })
  })

  describe('closeSession', () => {
    it('closes all tunnels for a session', async () => {
      let stoppedPorts = []
      manager._tunnels.set('sess-1', new Map([
        [3000, { stop: async () => { stoppedPorts.push(3000) }, url: 'https://a.trycloudflare.com' }],
        [5173, { stop: async () => { stoppedPorts.push(5173) }, url: 'https://b.trycloudflare.com' }],
      ]))

      await manager.closeSession('sess-1')
      assert.deepEqual(stoppedPorts.sort(), [3000, 5173])
      assert.equal(manager._tunnels.has('sess-1'), false)
    })
  })

  describe('closeAll', () => {
    it('closes tunnels across all sessions', async () => {
      let stopped = []
      manager._tunnels.set('sess-1', new Map([
        [3000, { stop: async () => { stopped.push('sess-1:3000') }, url: 'https://a.trycloudflare.com' }],
      ]))
      manager._tunnels.set('sess-2', new Map([
        [8080, { stop: async () => { stopped.push('sess-2:8080') }, url: 'https://b.trycloudflare.com' }],
      ]))

      await manager.closeAll()
      assert.deepEqual(stopped.sort(), ['sess-1:3000', 'sess-2:8080'])
      assert.equal(manager._tunnels.size, 0)
    })
  })
})
