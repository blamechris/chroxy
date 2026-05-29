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
    reply(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mcp-stub', version: '0.1.0' } })
    // #4455: optionally emit an orphan response (id the client never sent)
    // alongside the real initialize reply. The client should silently log
    // and drop it.
    if (process.env.MCP_STUB_EMIT_ORPHAN === '1') {
      // Use a deliberately-high id so it can't collide with anything the
      // client will ever send during this short-lived test.
      reply(999_999, { fake: 'orphan' })
    }
    // #4455: optionally emit a notification (id == null) alongside the
    // real reply. Notifications must be silently dropped — no orphan log,
    // no warn. Used to assert the non-noise contract.
    if (process.env.MCP_STUB_EMIT_NOTIFICATION === '1') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { detail: 'fake notification' },
      }) + '\n')
    }
  } else if (msg.method === 'tools/list') {
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
