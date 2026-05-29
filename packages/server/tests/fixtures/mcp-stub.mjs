#!/usr/bin/env node
import { createInterface } from 'node:readline'

const tools = JSON.parse(process.env.MCP_STUB_TOOLS || '[{"name":"echo","description":"echo input","inputSchema":{"type":"object"}}]')

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id == null) return
  if (msg.method === 'initialize') {
    // #4454: optionally never respond to initialize so the client's handshake
    // timeout branch can be exercised. The stub stays alive (no exit) — the
    // client must rely on its own timeout, not on EOF.
    if (process.env.MCP_STUB_INITIALIZE_HANG === '1') return
    // #4452: optionally echo the client-supplied initialize params back via
    // stderr so tests can assert what the client actually sent on the wire.
    if (process.env.MCP_STUB_ECHO_INITIALIZE === '1') {
      process.stderr.write(`MCP_STUB_INITIALIZE_PARAMS=${JSON.stringify(msg.params)}\n`)
    }
    // #4452: allow the stub to advertise a different protocolVersion than
    // the client requested, so tests can exercise the negotiation-warn branch.
    const serverProtocolVersion = process.env.MCP_STUB_PROTOCOL_VERSION || '2024-11-05'
    reply(msg.id, { protocolVersion: serverProtocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mcp-stub', version: '0.1.0' } })
  } else if (msg.method === 'tools/list') {
    // #4454: optionally accept initialize but never reply to tools/list.
    // Exercises the *second* handshake-timeout branch which the existing
    // MCP_STUB_HANG (whole-process hang) couldn't reach because that knob
    // also blocks initialize.
    if (process.env.MCP_STUB_TOOLS_LIST_HANG === '1') return
    reply(msg.id, { tools })
  } else if (msg.method === 'tools/call') {
    if (process.env.MCP_STUB_TOOL_DIE === '1') {
      process.exit(1)
    }
    if (process.env.MCP_STUB_TOOL_HANG === '1') {
      return
    }
    if (process.env.MCP_STUB_TOOL_RPC_ERROR === '1') {
      replyError(msg.id, -32603, 'stub: forced RPC error')
      return
    }
    const args = msg.params?.arguments ?? {}
    if (process.env.MCP_STUB_TOOL_ERROR === '1') {
      reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(args) }], isError: true })
      return
    }
    reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(args) }] })
  }
})

if (process.env.MCP_STUB_DIE_AFTER_MS) {
  setTimeout(() => process.exit(1), Number(process.env.MCP_STUB_DIE_AFTER_MS))
}

if (process.env.MCP_STUB_HANG === '1') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 60_000)
}
