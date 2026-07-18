#!/usr/bin/env node
import { createInterface } from 'node:readline'

const tools = JSON.parse(process.env.MCP_STUB_TOOLS || '[{"name":"echo","description":"echo input","inputSchema":{"type":"object"}}]')

// #6823: prompts/resources are OPT-IN. When MCP_STUB_PROMPTS / MCP_STUB_RESOURCES
// are set, the stub advertises the matching capability on initialize and serves
// the list/get/read methods. Unset → the capability is absent, so a spec-
// compliant client never calls prompts/list or resources/list (graceful skip).
const prompts = process.env.MCP_STUB_PROMPTS ? JSON.parse(process.env.MCP_STUB_PROMPTS) : null
const resources = process.env.MCP_STUB_RESOURCES ? JSON.parse(process.env.MCP_STUB_RESOURCES) : null

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
    // #6823: advertise prompts/resources capabilities only when configured.
    const capabilities = { tools: {} }
    if (prompts) capabilities.prompts = {}
    if (resources) capabilities.resources = {}
    reply(msg.id, { protocolVersion: serverProtocolVersion, capabilities, serverInfo: { name: 'mcp-stub', version: '0.1.0' } })
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
  } else if (msg.method === 'prompts/list') {
    // #6823: a server that advertised the prompts capability but errors on
    // list (or hangs) — the client must degrade to an empty list, not crash.
    if (process.env.MCP_STUB_PROMPTS_LIST_HANG === '1') return
    if (process.env.MCP_STUB_PROMPTS_LIST_ERROR === '1') {
      replyError(msg.id, -32601, 'stub: prompts/list not supported')
      return
    }
    reply(msg.id, { prompts: prompts || [] })
  } else if (msg.method === 'prompts/get') {
    // Echo the requested name + arguments so tests can assert prompts/get
    // round-trips the argument map. A single text message is the injected turn.
    const name = msg.params?.name
    const promptArgs = msg.params?.arguments ?? {}
    reply(msg.id, {
      description: `stub prompt ${name}`,
      messages: [
        { role: 'user', content: { type: 'text', text: `PROMPT:${name} ARGS:${JSON.stringify(promptArgs)}` } },
      ],
    })
  } else if (msg.method === 'resources/list') {
    if (process.env.MCP_STUB_RESOURCES_LIST_ERROR === '1') {
      replyError(msg.id, -32601, 'stub: resources/list not supported')
      return
    }
    reply(msg.id, { resources: resources || [] })
  } else if (msg.method === 'resources/read') {
    const uri = msg.params?.uri
    reply(msg.id, { contents: [{ uri, mimeType: 'text/plain', text: `CONTENT:${uri}` }] })
  }
})

if (process.env.MCP_STUB_DIE_AFTER_MS) {
  setTimeout(() => process.exit(1), Number(process.env.MCP_STUB_DIE_AFTER_MS))
}

if (process.env.MCP_STUB_HANG === '1') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 60_000)
}
