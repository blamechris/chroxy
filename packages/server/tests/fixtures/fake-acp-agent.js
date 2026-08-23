#!/usr/bin/env node
// Scripted ND-JSON ACP agent fixture (#7319). Speaks the agent-facing half of
// the Agent Client Protocol (https://agentclientprotocol.com) well enough to
// drive AcpSession's real translation + persistence code through a REAL
// spawned child process — no live third-party agent required, no network.
//
// Scenario is selected by the PROMPT TEXT the test sends (substring match),
// so ONE process instance can serve every scenario across a sequence of
// prompts — needed by the interrupt/persistence test, which sends two
// different prompts to the SAME child and asserts the pid never changes.
//
// Supported prompt markers:
//   WITH_TOOL          — stream a thought chunk, a tool_call, a completed
//                         tool_call_update, then a closing message chunk,
//                         then respond { stopReason: 'end_turn' }.
//   WITH_PERMISSION    — send a session/request_permission request mid-turn;
//                         whatever the client answers (optionId, or
//                         'cancelled') is echoed back as an
//                         agent_message_chunk "PERMISSION_RESULT:<value>" so
//                         a test can assert on the decision without any
//                         protocol extension. Then respond end_turn.
//   HANG_UNTIL_CANCEL  — do NOT respond to this session/prompt until a
//                         session/cancel notification arrives for the same
//                         session id; then respond { stopReason: 'cancelled' }.
//   (anything else)    — stream "Hello " + "world", respond end_turn.
import { createInterface } from 'node:readline'

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

let nextId = 1
const pendingOurRequests = new Map() // id -> resolve
let pendingCancel = null // { sessionId, resolve } — armed while HANG_UNTIL_CANCEL waits

function requestClient(method, params) {
  const id = `fixture-${nextId++}`
  return new Promise((resolve) => {
    pendingOurRequests.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })
}

async function handlePrompt(id, params) {
  const sessionId = params.sessionId
  const text = Array.isArray(params.prompt)
    ? params.prompt.map((b) => (b && b.type === 'text' ? b.text : '')).join('')
    : ''

  const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } })

  if (text.includes('HANG_UNTIL_CANCEL')) {
    // Emit an observable signal the moment we're about to hang, so a test
    // driving the REAL client can deterministically wait for "the fixture
    // has received the prompt and is now waiting on cancel" via the actual
    // production event pipeline, instead of guessing at a timing window
    // across two independently-issued client calls (sendMessage + interrupt).
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAITING' } })
    await new Promise((resolve) => { pendingCancel = { sessionId, resolve } })
    send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } })
    return
  }

  if (text.includes('WITH_TOOL')) {
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking it through' } })
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read file', kind: 'read', status: 'pending' })
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }],
    })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } })
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    return
  }

  if (text.includes('WITH_PERMISSION')) {
    const response = await requestClient('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'tc-perm', title: 'Run a risky command' },
      options: [
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    })
    const outcome = response && response.outcome
    const label = outcome && outcome.outcome === 'selected' ? outcome.optionId : 'cancelled'
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `PERMISSION_RESULT:${label}` } })
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    return
  }

  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } })
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } })
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }

  // A response to one of OUR requests (session/request_permission): carries
  // an id WE generated and no `method`.
  if (m.method === undefined && m.id !== undefined && pendingOurRequests.has(m.id)) {
    const resolve = pendingOurRequests.get(m.id)
    pendingOurRequests.delete(m.id)
    resolve(m.result)
    return
  }

  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } })
    return
  }

  if (m.method === 'session/new') {
    send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'fake-acp-session-1' } })
    return
  }

  if (m.method === 'session/cancel') {
    if (pendingCancel && pendingCancel.sessionId === (m.params && m.params.sessionId)) {
      const { resolve } = pendingCancel
      pendingCancel = null
      resolve()
    }
    return
  }

  if (m.method === 'session/prompt') {
    handlePrompt(m.id, m.params)
  }
})
