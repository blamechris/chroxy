#!/usr/bin/env node
import { createInterface } from 'node:readline'

const tools = JSON.parse(process.env.MCP_STUB_TOOLS || '[{"name":"echo","description":"echo input","inputSchema":{"type":"object"}}]')

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id == null) return
  if (msg.method === 'initialize') {
    reply(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mcp-stub', version: '0.1.0' } })
  } else if (msg.method === 'tools/list') {
    reply(msg.id, { tools })
  }
})

if (process.env.MCP_STUB_DIE_AFTER_MS) {
  setTimeout(() => process.exit(1), Number(process.env.MCP_STUB_DIE_AFTER_MS))
}

if (process.env.MCP_STUB_HANG === '1') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 60_000)
}
