/**
 * Lightweight mock WebSocket server for Maestro E2E tests.
 * Speaks enough of the Chroxy protocol to land on SessionScreen.
 *
 * Usage: node mock-server.mjs [--port 9876]
 */

import { createServer } from 'http'
import { WebSocketServer } from 'ws'

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '9876', 10)
const API_TOKEN = 'test-token-maestro'
let seqCounter = 0

function send(ws, msg) {
  seqCounter++
  ws.send(JSON.stringify({ ...msg, seq: seqCounter }))
}

const httpServer = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', mode: 'cli', hostname: 'mock-server', version: '0.1.0-test' }))
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ noServer: true })

httpServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req)
  })
})

wss.on('connection', (ws) => {
  console.log('[mock] Client connected')
  seqCounter = 0

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    switch (msg.type) {
      case 'auth': {
        if (msg.token !== API_TOKEN) {
          send(ws, { type: 'auth_fail', reason: 'invalid token' })
          ws.close()
          return
        }
        // Full post-auth sequence
        send(ws, {
          type: 'auth_ok',
          clientId: 'mock-client-1',
          serverMode: 'cli',
          serverVersion: '0.1.0-test',
          latestVersion: null,
          serverCommit: 'abc1234',
          cwd: '/tmp/mock-project',
          connectedClients: [],
          encryption: 'disabled',
        })
        send(ws, { type: 'server_mode', mode: 'cli' })
        send(ws, { type: 'status', connected: true })
        send(ws, {
          type: 'session_list',
          sessions: [{
            sessionId: 'mock-sess-1',
            name: 'Mock Session',
            cwd: '/tmp/mock-project',
            type: 'cli',
            hasTerminal: false,
            model: 'sonnet',
            permissionMode: 'approve',
            isBusy: false,
            createdAt: Date.now(),
            conversationId: null,
            provider: 'claude-sdk',
            capabilities: {},
          }],
        })
        send(ws, {
          type: 'session_switched',
          sessionId: 'mock-sess-1',
          name: 'Mock Session',
          cwd: '/tmp/mock-project',
          conversationId: null,
        })
        send(ws, {
          type: 'available_models',
          models: [
            { id: 'sonnet', name: 'Sonnet', description: 'Fast and capable' },
            { id: 'opus', name: 'Opus', description: 'Most capable' },
          ],
        })
        send(ws, {
          type: 'available_permission_modes',
          modes: [
            { id: 'approve', label: 'Approve' },
            { id: 'auto', label: 'Auto' },
            { id: 'plan', label: 'Plan' },
          ],
        })
        send(ws, { type: 'claude_ready', sessionId: 'mock-sess-1' })
        send(ws, { type: 'model_changed', model: 'sonnet', sessionId: 'mock-sess-1' })
        send(ws, { type: 'permission_mode_changed', mode: 'approve', sessionId: 'mock-sess-1' })
        break
      }

      case 'mode':
        // Acknowledge mode switch
        console.log(`[mock] Client mode: ${msg.mode}`)
        break

      case 'list_slash_commands':
        send(ws, { type: 'slash_commands', commands: [] })
        break

      case 'list_agents':
        send(ws, { type: 'agent_list', agents: [] })
        break

      case 'ping':
        send(ws, { type: 'pong' })
        break

      case 'browse_files': {
        const requestedPath = msg.path || null
        if (!requestedPath) {
          // Root directory
          send(ws, {
            type: 'file_listing',
            path: '/tmp/mock-project',
            parentPath: null,
            entries: [
              { name: 'src', isDirectory: true, size: null },
              { name: 'docs', isDirectory: true, size: null },
              { name: 'package.json', isDirectory: false, size: 1234 },
              { name: 'README.md', isDirectory: false, size: 567 },
            ],
            error: null,
          })
        } else if (requestedPath === 'src' || requestedPath.endsWith('/src')) {
          send(ws, {
            type: 'file_listing',
            path: '/tmp/mock-project/src',
            parentPath: '/tmp/mock-project',
            entries: [
              { name: 'index.js', isDirectory: false, size: 2048 },
              { name: 'utils.js', isDirectory: false, size: 512 },
            ],
            error: null,
          })
        } else {
          send(ws, {
            type: 'file_listing',
            path: requestedPath,
            parentPath: '/tmp/mock-project',
            entries: [],
            error: null,
          })
        }
        break
      }

      case 'read_file':
        send(ws, {
          type: 'file_content',
          path: msg.path,
          content: '// Mock file content\nconsole.log("Hello from mock server")\n',
          language: 'javascript',
          size: 58,
          truncated: false,
          error: null,
        })
        break

      case 'input': {
        const text = msg.data || ''
        console.log(`[mock] Input: "${text}"`)
        const messageId = `msg-${Date.now()}`
        // Simulate a streamed response
        send(ws, { type: 'stream_start', messageId, sessionId: 'mock-sess-1' })
        send(ws, { type: 'agent_busy', sessionId: 'mock-sess-1' })
        const response = `I received your message: "${text}". This is a mock response for E2E testing.`
        // Send as a single delta for simplicity
        send(ws, { type: 'stream_delta', messageId, delta: response, sessionId: 'mock-sess-1' })
        send(ws, { type: 'stream_end', messageId, sessionId: 'mock-sess-1' })
        send(ws, { type: 'result', cost: 0.001, duration: 100, usage: {}, sessionId: 'mock-sess-1' })
        send(ws, { type: 'agent_idle', sessionId: 'mock-sess-1' })
        break
      }

      case 'register_push_token':
        // Silently accept
        break

      case 'request_session_context':
        send(ws, {
          type: 'session_context',
          sessionId: 'mock-sess-1',
          gitBranch: 'main',
          gitDirty: 0,
          gitAhead: 0,
          projectName: 'mock-project',
        })
        break

      default:
        console.log(`[mock] Unhandled: ${msg.type}`)
    }
  })

  ws.on('close', () => {
    console.log('[mock] Client disconnected')
  })
})

httpServer.listen(PORT, () => {
  console.log(`[mock] Chroxy mock server listening on port ${PORT}`)
  console.log(`[mock] Token: ${API_TOKEN}`)
  console.log(`[mock] Health: http://localhost:${PORT}/`)
  console.log(`[mock] WebSocket: ws://localhost:${PORT}`)
})
