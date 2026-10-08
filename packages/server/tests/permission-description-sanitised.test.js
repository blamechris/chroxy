import { describe, it, beforeEach, afterEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { PermissionManager, wirePermissionManager } from '../src/permission-manager.js'
import { createPermissionHandler } from '../src/ws-permissions.js'
import { ClaudeByokSession } from '../src/byok-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import {
  describeToolInput,
  describeByNamedField,
  RECORD_DESCRIPTION_MAX,
} from '../src/redaction.js'

/**
 * #8384 / #8397 -- a permission prompt's `description` is built from the
 * SANITIZED tool input, and the `recordDescription` the session keeps for its
 * transcript is clipped where it is produced and never leaves the process.
 *
 * Every producer of a description is driven here through its own entry point:
 *
 *   - in-process (claude-sdk, codex): PermissionManager.handlePermission;
 *   - BYOK: the same manager, owned by a real ClaudeByokSession;
 *   - hook-routed (claude-cli, claude-tui): the HTTP handler in ws-permissions.js,
 *     with a real ClaudeTuiSession as the owning session for the claude-tui leg.
 *
 * The value redactor does not recognise a secret behind a QUOTED JSON key
 * (`"password":"..."`), so an input without an identifying field, described by
 * serializing the RAW input, kept the value next to an `input` that masked it.
 */

const SECRET = 'hunter2-s3cr3t-valueX'
const NO_NAMED_FIELD = { url: 'https://example.com/x', password: SECRET }
const NESTED = { config: { token: SECRET, host: 'example.com' } }
// A secret that a 200-char clip of the RAW serialization would cut in two,
// leaving a prefix no pattern recognises.
const STRADDLING = { filler: 'x'.repeat(160), password: SECRET }

let tmpDir
function tmpStateFile() {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'perm-desc-'))
  return join(tmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }) })

function assertNoSecret(text, label) {
  assert.ok(!String(text).includes(SECRET), `${label} carries the secret value`)
  assert.ok(!String(text).includes(SECRET.slice(0, 8)), `${label} carries a prefix of the secret value`)
}

const quietLog = { info() {}, warn() {}, error() {} }

/** Raise a prompt on a manager and return the emitted permission_request payload. */
function raiseOn(pm, tool, input) {
  let payload
  pm.once('permission_request', (d) => { payload = d })
  const decided = pm.handlePermission(tool, input, null, 'approve')
  return { payload, decided }
}

describe('describeToolInput (#8384)', () => {
  it('serializes the sanitized input, so a masked field reads the same as in `input`', () => {
    const text = describeToolInput(NO_NAMED_FIELD)
    assertNoSecret(text, 'description')
    assert.ok(text.includes('"password":"[REDACTED]"'), 'the masked field is shown masked')
  })

  it('redacts before it clips', () => {
    assertNoSecret(describeToolInput(STRADDLING), 'description')
  })

  it('describes an input by its identifying field when it has one', () => {
    assert.equal(describeToolInput({ command: 'ls -la', password: SECRET }), 'ls -la')
  })

  it('returns the fallback for an input with nothing to describe', () => {
    assert.equal(describeToolInput({}, 'Bash'), 'Bash')
    assert.equal(describeToolInput(null, 'Bash'), 'Bash')
  })

  it('describeByNamedField clips to the persisted length where it produces the value', () => {
    const out = describeByNamedField({ command: 'a '.repeat(3000) })
    assert.ok(out.length <= RECORD_DESCRIPTION_MAX, `clipped (${out.length})`)
    assert.equal(describeByNamedField({ url: 'x' }), undefined)
  })
})

describe('in-process producer: PermissionManager.handlePermission (claude-sdk, codex) (#8384)', () => {
  let pm
  beforeEach(() => { pm = new PermissionManager({ log: quietLog }) })
  afterEach(() => { pm.clearAll() })

  for (const [label, input] of [
    ['a credential under a sensitive key', NO_NAMED_FIELD],
    ['a credential nested under a sensitive key', NESTED],
    ['a credential a 200-char clip of the raw input would cut in two', STRADDLING],
  ]) {
    it(`broadcasts a description without ${label}`, () => {
      const { payload } = raiseOn(pm, 'CustomTool', input)
      assert.ok(payload, 'a permission_request was emitted')
      assertNoSecret(payload.description, 'description')
      assertNoSecret(JSON.stringify(payload.input), 'input')
      assertNoSecret(JSON.stringify(pm._lastPermissionData.get(payload.requestId)), 'the held payload')
    })
  }

  it('masks the field in the description exactly as it is masked in `input`', () => {
    const { payload } = raiseOn(pm, 'CustomTool', NO_NAMED_FIELD)
    assert.equal(payload.input.password, '[REDACTED]')
    assert.ok(payload.description.includes('"password":"[REDACTED]"'), payload.description)
  })

  it('still describes a call by its identifying field', () => {
    const { payload } = raiseOn(pm, 'Bash', { command: 'git status', password: SECRET })
    assert.equal(payload.description, 'git status')
  })

  it('clips recordDescription where it is produced, and holds only the clipped copy', () => {
    const { payload } = raiseOn(pm, 'Bash', { command: 'word '.repeat(2000) })
    assert.ok(payload.recordDescription.length <= RECORD_DESCRIPTION_MAX, `emitted ${payload.recordDescription.length}`)
    const held = pm._lastPermissionData.get(payload.requestId)
    assert.ok(held.recordDescription.length <= RECORD_DESCRIPTION_MAX, `held ${held.recordDescription.length}`)
  })

  it('records the mcp_spawn prompt description (redacted and clipped)', async () => {
    let payload
    pm.once('permission_request', (d) => { payload = d })
    const decided = pm.requestMcpTrust({ name: 'files', command: '/usr/local/bin/mcp-files', args: [], envKeys: [] })
    assert.ok(payload, 'a permission_request was emitted')
    assert.equal(payload.tool, 'mcp_spawn')
    assert.ok(payload.recordDescription.includes('files'), payload.recordDescription)
    assert.equal(payload.recordDescription, payload.description)
    assert.ok(payload.recordDescription.length <= RECORD_DESCRIPTION_MAX)
    pm.clearAll()
    await decided
  })
})

describe('BYOK producer: ClaudeByokSession (#8384, #8397)', () => {
  let session
  beforeEach(() => { session = new ClaudeByokSession({ cwd: '/tmp' }) })
  afterEach(async () => { await session.destroy() })

  it('broadcasts a description built from the sanitized input', () => {
    let payload
    session.once('permission_request', (d) => { payload = d })
    session._permissions.handlePermission('CustomTool', NO_NAMED_FIELD, null, 'approve')
    assert.ok(payload, 'the session re-emitted the permission_request')
    assertNoSecret(payload.description, 'description')
    assert.equal(payload.input.password, '[REDACTED]')
  })

  it('drops recordDescription from a child prompt relayed upward', () => {
    const seen = []
    session.on('agent_event', (e) => seen.push(e))
    session._emitAgentEvent('tu_task', 'permission_request', {
      requestId: 'perm-1', tool: 'Bash', description: 'ls', input: {}, recordDescription: 'ls',
    })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].payload.requestId, 'perm-1', 'the prompt itself is still relayed')
    assert.equal(seen[0].payload.description, 'ls')
    assert.ok(!('recordDescription' in seen[0].payload), 'recordDescription is not relayed')
  })

  it('leaves the payload of every other relayed event untouched', () => {
    const seen = []
    session.on('agent_event', (e) => seen.push(e))
    session._emitAgentEvent('tu_task', 'tool_start', { toolUseId: 'a', recordDescription: 'kept' })
    assert.equal(seen[0].payload.recordDescription, 'kept')
  })
})

describe('hook-routed producer: ws-permissions.js (claude-cli, claude-tui) (#8384)', () => {
  const HOOK_SECRET = 'hook-secret-8384'
  let mgr
  let broadcastFn
  let handler
  let pendingPermissions
  let tuiSkillsDir
  let owners

  function makeReq(body) {
    const emitter = new EventEmitter()
    emitter.method = 'POST'
    emitter.headers = { authorization: `Bearer ${HOOK_SECRET}` }
    emitter.socket = { remoteAddress: '127.0.0.1' }
    process.nextTick(() => {
      emitter.emit('data', Buffer.from(body))
      emitter.emit('end')
    })
    emitter.destroy = mock.fn()
    emitter.setEncoding = mock.fn()
    emitter.pause = mock.fn()
    return emitter
  }
  function makeRes() {
    const listeners = {}
    return {
      statusCode: null,
      body: null,
      headersSent: false,
      writeHead: mock.fn(function (code) { this.statusCode = code; this.headersSent = true }),
      end: mock.fn(function (b) { this.body = b }),
      on(event, cb) { listeners[event] = cb; return this },
      emit(event, ...args) { if (listeners[event]) listeners[event](...args) },
    }
  }

  beforeEach(() => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    tuiSkillsDir = mkdtempSync(join(tmpdir(), 'perm-desc-tui-'))
    const cli = new EventEmitter()
    cli.isRunning = false
    cli.destroy = () => {}
    cli.cwd = '/tmp'
    const tui = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: tuiSkillsDir, repoSkillsDir: null })
    owners = { cli, tui }
    for (const [sid, session] of [['cli', cli], ['tui', tui]]) {
      mgr._sessions.set(sid, { session, name: sid, cwd: '/tmp' })
    }
    mgr._wireSessionEvents('cli', cli)
    pendingPermissions = new Map()
    broadcastFn = mock.fn()
    let current = 'cli'
    handler = createPermissionHandler({
      sendFn: mock.fn(),
      broadcastFn,
      validateBearerAuth: mock.fn(() => true),
      pushManager: null,
      pendingPermissions,
      permissionSessionMap: new Map(),
      getSessionManager: () => mgr,
      findSessionByHookSecret: (token) => (token === HOOK_SECRET ? { session: owners[current], sessionId: current } : null),
    })
    handler.__use = (sid) => { current = sid }
  })
  afterEach(() => {
    handler.destroy()
    mgr.destroyAll()
    rmSync(tuiSkillsDir, { recursive: true, force: true })
  })

  async function raise(owner, toolInput, tool = 'CustomTool') {
    handler.__use(owner)
    handler.handlePermissionRequest(makeReq(JSON.stringify({ tool_name: tool, tool_input: toolInput })), makeRes())
    await new Promise((r) => setImmediate(r))
    const message = broadcastFn.mock.calls.at(-1)?.arguments[0]
    assert.ok(message, 'the prompt was broadcast')
    const requestId = [...pendingPermissions.keys()].at(-1)
    return { message, requestId }
  }

  for (const owner of ['cli', 'tui']) {
    const provider = owner === 'tui' ? 'claude-tui' : 'claude-cli'
    for (const [label, input] of [
      ['a credential under a sensitive key', NO_NAMED_FIELD],
      ['a credential nested under a sensitive key', NESTED],
      ['a credential a 200-char clip of the raw input would cut in two', STRADDLING],
    ]) {
      it(`${provider}: broadcasts a description without ${label}`, async () => {
        const { message, requestId } = await raise(owner, input)
        assertNoSecret(message.description, 'description')
        assertNoSecret(JSON.stringify(message.input), 'input')
        assertNoSecret(mgr._permissionRequests.get(requestId)?.description ?? '', 'the transcript description')
      })
    }
  }

  it('masks the field in the description exactly as it is masked in `input`', async () => {
    const { message } = await raise('tui', NO_NAMED_FIELD)
    assert.equal(message.input.password, '[REDACTED]')
    assert.ok(message.description.includes('"password":"[REDACTED]"'), message.description)
  })

  it('still describes a call by its identifying field', async () => {
    const { message } = await raise('cli', { command: 'git status', password: SECRET }, 'Bash')
    assert.equal(message.description, 'git status')
  })

  it('clips the transcript description where the hook producer builds it', async () => {
    const { requestId } = await raise('cli', { command: 'word '.repeat(2000) }, 'Bash')
    const held = mgr._permissionRequests.get(requestId)
    assert.ok(held, 'the prompt is tracked for its outcome')
    assert.ok(held.description.length <= RECORD_DESCRIPTION_MAX, `held ${held.description.length}`)
  })
})
