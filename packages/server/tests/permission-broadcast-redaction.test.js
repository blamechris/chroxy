import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionManager } from '../src/permission-manager.js'

/**
 * #6038 — the SDK/TUI provider permission path (permission-manager.js) builds the
 * broadcast `permission_request` payload with `input` and `description` derived
 * from the RAW tool input, then emits it to every subscribed client. That is the
 * same credential-leak class #6029/#6037 fixed on the hook path. These tests pin
 * that the broadcast payload is redacted (key-name + value-shape, at any depth)
 * before it is emitted, while the raw input is still available for execution.
 *
 * NOTE: the secret strings below are synthetic placeholders shaped to match the
 * detection patterns; no real credentials are present.
 */

const silentLog = { info() {}, warn() {}, error() {}, debug() {} }
const FAKE_ANT_KEY = 'sk-ant-api03-' + 'A'.repeat(50)

describe('#6038 SDK permission broadcast redaction', () => {
  it('redacts a secret-shaped value under a benign key before broadcast', () => {
    const pm = new PermissionManager({ log: silentLog })
    const events = []
    pm.on('permission_request', (d) => events.push(d))

    pm.handlePermission('Bash', { command: `export TOKEN=${FAKE_ANT_KEY}` }, null, 'approve')

    const ev = events[0]
    assert.ok(ev, 'permission_request should be emitted')
    assert.ok(!JSON.stringify(ev.input).includes(FAKE_ANT_KEY), 'secret must not leak in broadcast input')
    assert.ok(!ev.description.includes(FAKE_ANT_KEY), 'secret must not leak in the description fallback')
    assert.ok(ev.input.command.includes('[REDACTED]'), 'redaction marker should be present')

    pm.destroy()
  })

  it('redacts a secret nested inside an object value', () => {
    const pm = new PermissionManager({ log: silentLog })
    const events = []
    pm.on('permission_request', (d) => events.push(d))

    pm.handlePermission('mcp_tool', { env: { TOKEN: FAKE_ANT_KEY } }, null, 'approve')

    const ev = events[0]
    assert.ok(ev, 'permission_request should be emitted')
    assert.ok(!JSON.stringify(ev.input).includes(FAKE_ANT_KEY), 'nested secret must not leak in broadcast input')

    pm.destroy()
  })

  it('leaves the raw input intact for execution (only the broadcast copy is redacted)', () => {
    const pm = new PermissionManager({ log: silentLog })
    const events = []
    pm.on('permission_request', (d) => events.push(d))

    const requestId = events.length
    pm.handlePermission('Bash', { command: `export TOKEN=${FAKE_ANT_KEY}` }, null, 'approve')
    const ev = events[0]

    // The pending entry (used to resolve/execute) keeps the raw value.
    const pending = pm._pendingPermissions.get(ev.requestId)
    assert.ok(pending, 'pending entry should exist')
    assert.ok(
      JSON.stringify(pending.input).includes(FAKE_ANT_KEY),
      'the execution-path input must remain raw (redaction is broadcast-only)',
    )

    pm.destroy()
    void requestId
  })
})
