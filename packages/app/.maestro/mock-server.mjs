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
// #4201: per-trigger counter so repeated `show-todos` inputs don't collide
// on a single fixed id (which would cause React-key duplicates + stuck
// pending tool_use rows because tool_result only patches the first match).
let showTodosCounter = 0
// #4260: per-trigger counter for the partial-summary fixture mirrors
// the same pattern used by `show-todos` — repeated invocations need
// unique ids so React keys + tool_result patching stay independent.
let showBashPartialCounter = 0

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

        // #4195: trigger-phrase 'show-todos' emits a synthetic TodoWrite
        // tool_use + tool_result so the Maestro chat-todolist flow can
        // exercise the structured TodoList renderer end-to-end. This
        // uses the existing WS protocol (no app-side debug menu needed)
        // — same path production tool messages take, so the test pins
        // the real render path. Future structured renderers can add a
        // sibling trigger here (e.g. 'show-readlines' for the planned
        // tool_input_delta work in #4081).
        //
        // Tool-only turn — no stream_start/stream_delta/stream_end pair.
        // Pre-#4195-Copilot-fix this branch wrapped the tool events with
        // a stream_start/stream_end on a SEPARATE messageId from the
        // tool_start's, which left a phantom empty assistant bubble in
        // the chat history (the stream_start handler creates an empty
        // `response` ChatMessage regardless of subsequent content). Real
        // tool-only turns from the server elide stream_* entirely.
        if (text.trim() === 'show-todos') {
          send(ws, { type: 'agent_busy', sessionId: 'mock-sess-1' })
          // #4201: ids are stable within the test but unique per trigger
          // so repeated `show-todos` invocations don't collide on React
          // keys (handleToolStart appends, doesn't replace, outside
          // history replay) and tool_result patches each tool_use
          // independently. Maestro's selector uses the "tool-todowrite-mock-"
          // prefix with a regex so it still matches the latest entry.
          showTodosCounter += 1
          const toolUseId = `tu-todowrite-mock-${showTodosCounter}`
          const toolMessageId = `tool-todowrite-mock-${showTodosCounter}`
          send(ws, {
            type: 'tool_start',
            sessionId: 'mock-sess-1',
            tool: 'TodoWrite',
            input: { todos: [
              { id: 't1', content: 'Wrote helper', status: 'completed' },
              { id: 't2', content: 'Running tests', status: 'in_progress' },
              { id: 't3', content: 'Address review', status: 'pending' },
            ] },
            messageId: toolMessageId,
            toolUseId,
          })
          // Canonical TodoWrite executor format from
          // packages/server/src/byok-tool-executor.js runTodoWrite —
          // see #4179 / #4194 (mobile renderer). Matched by
          // packages/app/src/components/chat/TodoList.tsx parseTodoList.
          const todoResult = [
            'Todo list (3 items): 1 in progress, 1 pending, 1 completed',
            '  [x] Wrote helper (t1)',
            '  [~] Running tests (t2)',
            '  [ ] Address review (t3)',
          ].join('\n')
          send(ws, {
            type: 'tool_result',
            sessionId: 'mock-sess-1',
            toolUseId,
            result: todoResult,
          })
          send(ws, { type: 'result', cost: 0.001, duration: 100, usage: {}, sessionId: 'mock-sess-1' })
          send(ws, { type: 'agent_idle', sessionId: 'mock-sess-1' })
          break
        }

        // #4260: trigger phrase 'show-bash-partial' emits a streaming
        // Bash `tool_use` with a `toolInputPartial` that exercises the
        // mobile ToolBubble's #4243 field-priority extraction path on
        // the real RN runtime. The collapsed bubble should surface the
        // extracted `command` ("ls -la /tmp") rather than the truncated
        // raw JSON ("{"command":"ls -la /t...").
        //
        // Mirrors the production wire path: `tool_start` carries the
        // placeholder content (tool name) while `input` is empty, and
        // the in-flight buffer is shipped via `tool_input_delta` chunks
        // — see store-core/handlers/index.ts handleToolInputDelta which
        // appends each `partialJson` onto `toolInputPartial`. Once the
        // accumulated buffer reaches a parseable `}` the bubble's
        // `getPartialSummary` flips from raw-JSON-slice to the extracted
        // field. No `tool_result` is emitted — we want the bubble to
        // stay in the streaming-collapsed state for the assertion.
        if (text.trim() === 'show-bash-partial') {
          send(ws, { type: 'agent_busy', sessionId: 'mock-sess-1' })
          showBashPartialCounter += 1
          const toolUseId = `tu-bash-partial-mock-${showBashPartialCounter}`
          const toolMessageId = `tool-bash-partial-mock-${showBashPartialCounter}`
          send(ws, {
            type: 'tool_start',
            sessionId: 'mock-sess-1',
            tool: 'Bash',
            // Empty input — handleToolStart falls back to `content = tool`,
            // which is the placeholder state the #4243 partial-priority
            // path is meant to override.
            input: {},
            messageId: toolMessageId,
            toolUseId,
          })
          // Stream the JSON in chunks. The accumulator concatenates each
          // `partialJson` onto `toolInputPartial`. The final chunk closes
          // the brace, making the buffer parseable for
          // `getPartialSummary`. Mid-stream chunks remain unparseable —
          // that's expected and is handled by `tryParseCompleteJson`'s
          // parseability gate.
          const partials = [
            '{"comm',
            'and":"',
            'ls -la /tmp"}',
          ]
          for (const partialJson of partials) {
            send(ws, {
              type: 'tool_input_delta',
              sessionId: 'mock-sess-1',
              messageId: toolMessageId,
              toolUseId,
              partialJson,
            })
          }
          // Do NOT emit `tool_result` — the assertion targets the
          // streaming collapsed-preview render, not the result-arrived
          // path. Leave the agent busy so the bubble stays in-flight.
          break
        }

        // Default: simulate a normal text-only assistant response.
        const messageId = `msg-${Date.now()}`
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
