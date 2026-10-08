import { describe, it, beforeEach, afterEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { PermissionManager } from '../src/permission-manager.js'
import { createPermissionHandler } from '../src/ws-permissions.js'
import { ClaudeByokSession } from '../src/byok-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import {
  describeToolInput,
  describeByNamedField,
  describeComposedText,
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

// A synthetic webhook credential (the shape the value redactor recognises),
// placed in a property NAME: the sanitizer masks values and copies names as-is.
const HOOK_TOKEN = 'SYNTHETICFIXTURE0000AAAA1111BBBB'
const HOOK_URL = `https://discord.com/api/webhooks/123456789012345678/${HOOK_TOKEN}`
const KEYED_SECRET = { requests: { [HOOK_URL]: { method: 'POST' } } }
// The same, with the token starting near character 190 of the serialization, so
// a 200-char clip would leave its first characters behind.
const KEYED_STRADDLING = { requests: { [`${'a'.repeat(123)} ${HOOK_URL}`]: { method: 'POST' } } }
// Property names whose credential the sanitizer's own 10K clip would cut below
// the pattern minimum (a long key first, then the credential key).
const KEYED_OVERSIZE = { [`sk-proj-${'a'.repeat(10154)}`]: 1, [HOOK_URL]: 2 }
// A control character before the credential: JSON-escaped, `\n` leaves a word
// character in front of `https`, which defeats a pattern that needs a boundary.
const ESCAPED_PREFIXES = ['\n', '\t', '\r', '\u0000'].flatMap((c) => [
  { [`${c}${HOOK_URL}`]: 1 },
  { note: `${c}${HOOK_URL}` },
])
// A credential inside a long string VALUE, starting about 85 characters in.
const VALUE_STRADDLING = { note: `${'a'.repeat(85)} ${HOOK_URL}` }
const KEY_CASES = [KEYED_SECRET, KEYED_STRADDLING, KEYED_OVERSIZE, VALUE_STRADDLING, ...ESCAPED_PREFIXES]
// The masked field as the description shows it. The description's final scan
// (the shared redactor, which now also masks a QUOTED key's quoted value, #8443)
// may drop the placeholder's own quotes: `"password": [REDACTED]`.
const MASKED_PASSWORD = /"password":\s*"?\[REDACTED\]"?/
const OWN_TRUNCATED_FIELD = { _truncated: true, id: 'resource-123' }

function assertNoHookToken(text, label) {
  assert.ok(!String(text).includes(HOOK_TOKEN), `${label} carries the credential`)
  assert.ok(!String(text).includes(HOOK_TOKEN.slice(0, 8)), `${label} carries a prefix of the credential`)
}

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
    assert.ok(MASKED_PASSWORD.test(text), 'the masked field is shown masked')
  })

  it('redacts before it clips', () => {
    assertNoSecret(describeToolInput(STRADDLING), 'description')
  })

  it('masks a credential in a property name', () => {
    const text = describeToolInput(KEYED_SECRET)
    assertNoHookToken(text, 'description')
    assert.ok(text.includes('[REDACTED]'), text)
  })

  it('scans the whole serialization before clipping, so no prefix of a credential in a name survives', () => {
    const text = describeToolInput(KEYED_STRADDLING)
    assertNoHookToken(text, 'description')
    assert.ok(text.length <= 200)
  })

  it('masks a credential in a property name whatever the input is or how it is escaped', () => {
    for (const input of KEY_CASES) assertNoHookToken(describeToolInput(input), JSON.stringify(input).slice(0, 40))
  })

  it('masks a credential key that follows a key the sanitizer would clip through', () => {
    const text = describeToolInput(KEYED_OVERSIZE)
    assertNoHookToken(text, 'description')
    assert.ok(text.length <= 200)
  })

  it('masks a short quoted value behind a quoted credential-named key (the shared redactor, #8443)', () => {
    const text = describeToolInput({ api_token: 'short1', host: 'example.com' })
    assert.ok(!text.includes('short1'), text)
    assert.ok(text.includes('example.com'), text)
  })

  it('describes an input that carries its own _truncated field by its content', () => {
    assert.ok(describeToolInput(OWN_TRUNCATED_FIELD, 'Tool').includes('resource-123'))
  })

  it('describes an oversized input from its own redacted entries', () => {
    const text = describeToolInput({ a: 'x'.repeat(20000), b: 'short', password: SECRET })
    assert.ok(text.startsWith('{"a":"[omitted]"'), text.slice(0, 40))
    assert.ok(text.includes('"b":"short"'), text)
    assertNoSecret(text, 'description')
  })

  it('describeComposedText redacts the bounded scan, then clips to what a client shows', () => {
    assert.equal(describeComposedText('Spawn x running /bin/y'), 'Spawn x running /bin/y')
    assert.equal(describeComposedText(`Spawn x running ${'a'.repeat(9000)}`), 'Spawn x running')
    assert.equal(describeComposedText('w '.repeat(300)).length, 200)
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

  it('masks a credential in a property name, even where a clip would split it', () => {
    for (const input of KEY_CASES) {
      const { payload } = raiseOn(pm, 'CustomTool', input)
      assertNoHookToken(payload.description, 'description')
    }
  })

  it('masks a short quoted value behind a quoted credential-named key', () => {
    const { payload } = raiseOn(pm, 'CustomTool', { api_token: 'short1', host: 'example.com' })
    assert.ok(!payload.description.includes('short1'), payload.description)
  })

  it('describes an input with its own _truncated field by its content', () => {
    const { payload } = raiseOn(pm, 'CustomTool', OWN_TRUNCATED_FIELD)
    assert.ok(payload.description.includes('resource-123'), payload.description)
  })

  it('describes the mcp_spawn prompt as it always has, and bounds the scan of a huge command', async () => {
    const shown = []
    pm.on('permission_request', (d) => shown.push(d))
    const first = pm.requestMcpTrust({ name: 'files', command: '/usr/local/bin/mcp-files', args: ['--root', '/tmp'], envKeys: [] })
    const second = pm.requestMcpTrust({ name: 'files', command: 'a'.repeat(9000), args: [], envKeys: [] })
    assert.equal(shown[0].description, 'Spawn MCP server "files" running /usr/local/bin/mcp-files --root')
    assert.equal(shown[0].recordDescription, shown[0].description)
    assert.equal(shown[1].description, 'Spawn MCP server "files" running')
    assert.equal(shown[1].recordDescription, shown[1].description)
    pm.clearAll()
    await Promise.all([first, second])
  })

  it('masks the field in the description exactly as it is masked in `input`', () => {
    const { payload } = raiseOn(pm, 'CustomTool', NO_NAMED_FIELD)
    assert.equal(payload.input.password, '[REDACTED]')
    assert.ok(MASKED_PASSWORD.test(payload.description), payload.description)
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

  it('masks a credential in a property name', () => {
    for (const input of KEY_CASES) {
      let payload
      session.once('permission_request', (d) => { payload = d })
      session._permissions.handlePermission('CustomTool', input, null, 'approve')
      assertNoHookToken(payload.description, 'description')
    }
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

  for (const owner of ['cli', 'tui']) {
    it(`${owner}: masks a credential in a property name, even where a clip would split it`, async () => {
      for (const input of KEY_CASES) {
        const { message } = await raise(owner, input)
        assertNoHookToken(message.description, 'description')
      }
    })
  }

  it('describes an input with its own _truncated field by its content', async () => {
    const { message } = await raise('cli', OWN_TRUNCATED_FIELD)
    assert.ok(message.description.includes('resource-123'), message.description)
  })

  it('masks the field in the description exactly as it is masked in `input`', async () => {
    const { message } = await raise('tui', NO_NAMED_FIELD)
    assert.equal(message.input.password, '[REDACTED]')
    assert.ok(MASKED_PASSWORD.test(message.description), message.description)
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
