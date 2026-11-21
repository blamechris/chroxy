/**
 * trust_folder / untrust_folder handlers.
 *
 * Gate: the primary token, on a connection not bound to a session, with no agent
 * principal. Everything else is refused BEFORE the session is looked up or the
 * store is touched. The folder comes from the server's session record: a `cwd` or
 * `path` on the message is ignored. A change is broadcast to every session whose
 * folder has the same real path.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { folderTrustStorePath, isFolderTrusted, invalidateFolderTrustCache } from '../src/folder-trust.js'
import { addLogListener, removeLogListener } from '../src/logger.js'
import { nsCtx } from './test-helpers.js'
import { principalClient } from './principal-test-helpers.js'

const trust = settingsHandlers.trust_folder
const untrust = settingsHandlers.untrust_folder
const WS = { readyState: 1 }

let root
let savedChroxy
let savedClaude

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'folder-trust-handlers-')))
  savedChroxy = process.env.CHROXY_CONFIG_DIR
  savedClaude = process.env.CLAUDE_CONFIG_DIR
  process.env.CHROXY_CONFIG_DIR = join(root, 'chroxy')
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
  invalidateFolderTrustCache()
})

afterEach(() => {
  if (savedChroxy === undefined) delete process.env.CHROXY_CONFIG_DIR
  else process.env.CHROXY_CONFIG_DIR = savedChroxy
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedClaude
  rmSync(root, { recursive: true, force: true })
  invalidateFolderTrustCache()
})

function folder(name, command = 'x') {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { s: { command } } }))
  return dir
}

function makeCtx(sessions) {
  const entries = new Map(Object.entries(sessions))
  const getSession = mock.fn((id) => entries.get(id) ?? null)
  const send = mock.fn()
  const broadcastToSession = mock.fn()
  const ctx = nsCtx({
    sessionManager: {
      getSession,
      listSessions: () => [...entries].map(([sessionId, e]) => ({ sessionId, cwd: e.cwd })),
    },
    send,
    broadcastToSession,
  })
  return { ctx, getSession, send, broadcastToSession }
}

const primary = (over = {}) => ({ id: 'c1', isPrimaryToken: true, boundSessionId: null, ...over })

async function captureLogs(fn) {
  const entries = []
  const listener = (entry) => entries.push(entry)
  addLogListener(listener)
  try { await fn() } finally { removeLogListener(listener) }
  return entries
}

describe('trust_folder gate', () => {
  const refused = {
    'a non-primary unbound client': { id: 'c', isPrimaryToken: false, boundSessionId: null },
    'a session-bound client (even on the primary token)': { id: 'c', isPrimaryToken: true, boundSessionId: 's1' },
    'an agent principal': principalClient({ isPrimaryToken: false }),
    'an agent principal that claims the primary flag': principalClient({ isPrimaryToken: true }),
  }
  for (const [label, client] of Object.entries(refused)) {
    for (const [name, handler] of [['trust_folder', trust], ['untrust_folder', untrust]]) {
      it(`${name} refuses ${label} and leaves the store untouched`, async () => {
        const cwd = folder('p')
        const { ctx, getSession, send } = makeCtx({ s1: { cwd, provider: 'claude-sdk' } })
        await handler(WS, client, { type: name, sessionId: 's1', requestId: 'r1' }, ctx)
        const frames = send.mock.calls.map((c) => c.arguments[1])
        assert.equal(frames.length, 1)
        assert.equal(frames[0].type, 'error')
        assert.equal(frames[0].code, 'FOLDER_TRUST_FORBIDDEN')
        assert.equal(frames[0].requestId, 'r1')
        assert.equal(getSession.mock.callCount(), 0, 'refused before the session is looked up')
        assert.equal(existsSync(folderTrustStorePath()), false, 'the store was not written')
        assert.equal(isFolderTrusted(cwd), false)
      })
    }
  }
})

describe('trust_folder / untrust_folder', () => {
  it('a primary client trusts the session folder and gets a folder_trust_result', async () => {
    const cwd = folder('p')
    const { ctx, send } = makeCtx({ s1: { cwd, provider: 'claude-sdk' } })
    await trust(WS, primary(), { type: 'trust_folder', sessionId: 's1', requestId: 'r1' }, ctx)
    assert.equal(isFolderTrusted(cwd), true)
    const result = send.mock.calls.map((c) => c.arguments[1]).find((m) => m.type === 'folder_trust_result')
    assert.deepEqual(result, { type: 'folder_trust_result', sessionId: 's1', ok: true, status: 'trusted', requestId: 'r1' })
  })

  it('takes the folder from the session record even if the message carries a cwd or path', async () => {
    const cwd = folder('real')
    const decoy = folder('decoy')
    const { ctx } = makeCtx({ s1: { cwd, provider: 'claude-sdk' } })
    await trust(WS, primary(), { type: 'trust_folder', sessionId: 's1', cwd: decoy, path: decoy, folder: decoy }, ctx)
    assert.equal(isFolderTrusted(cwd), true)
    assert.equal(isFolderTrusted(decoy), false)
  })

  it('an unknown session is an error and writes nothing', async () => {
    const { ctx, send } = makeCtx({})
    await trust(WS, primary(), { type: 'trust_folder', sessionId: 'nope', requestId: 'r1' }, ctx)
    const frame = send.mock.calls[0].arguments[1]
    assert.equal(frame.code, 'FOLDER_TRUST_NOT_APPLIED')
    assert.equal(existsSync(folderTrustStorePath()), false)
  })

  it('broadcasts folder_trust_state to every session in the same folder (by real path), and only those', async () => {
    const cwd = folder('shared')
    const alias = join(root, 'alias')
    symlinkSync(cwd, alias)
    const other = folder('other')
    const { ctx, broadcastToSession } = makeCtx({
      a: { cwd, provider: 'claude-sdk' },
      b: { cwd: alias, provider: 'claude-tui' },
      c: { cwd: other, provider: 'claude-sdk' },
      d: { cwd, provider: 'gemini' },
    })
    await trust(WS, primary(), { type: 'trust_folder', sessionId: 'a' }, ctx)
    const sent = Object.fromEntries(broadcastToSession.mock.calls.map((c) => [c.arguments[0], c.arguments[1]]))
    assert.deepEqual(Object.keys(sent).sort(), ['a', 'b', 'd'])
    assert.equal(sent.a.type, 'folder_trust_state')
    assert.equal(sent.a.status, 'trusted')
    assert.equal(sent.a.appliesFrom, 'next_turn')
    assert.equal(sent.b.appliesFrom, 'restart')
    assert.equal(sent.d.appliesFrom, 'n/a')
    assert.equal(sent.a.sessionId, 'a')
    assert.ok(sent.a.summary.files.length > 0)
  })

  it('untrust_folder removes trust and broadcasts the untrusted state', async () => {
    const cwd = folder('p')
    const { ctx, broadcastToSession, send } = makeCtx({ s1: { cwd, provider: 'claude-cli' } })
    await trust(WS, primary(), { type: 'trust_folder', sessionId: 's1' }, ctx)
    await untrust(WS, primary(), { type: 'untrust_folder', sessionId: 's1', requestId: 'r2' }, ctx)
    assert.equal(isFolderTrusted(cwd), false)
    const last = broadcastToSession.mock.calls.at(-1).arguments[1]
    assert.equal(last.status, 'untrusted')
    const result = send.mock.calls.map((c) => c.arguments[1]).filter((m) => m.type === 'folder_trust_result').at(-1)
    assert.equal(result.status, 'untrusted')
    assert.equal(result.requestId, 'r2')
  })

  it('logs the folder path and not the summary', async () => {
    const cwd = folder('logged', 'secret-command-name')
    const { ctx } = makeCtx({ s1: { cwd, provider: 'claude-sdk' } })
    const entries = await captureLogs(() => trust(WS, primary(), { type: 'trust_folder', sessionId: 's1' }, ctx))
    const text = entries.map((e) => e.message).join('\n')
    assert.ok(text.includes(cwd), 'the folder path is in the log')
    assert.equal(text.includes('secret-command-name'), false, 'the summary is not')
  })

  it('a store failure is reported as ok:false and nothing is claimed trusted', async () => {
    const cwd = folder('p')
    // A directory where the store file should go makes the atomic rename fail.
    mkdirSync(folderTrustStorePath(), { recursive: true })
    const { ctx, send } = makeCtx({ s1: { cwd, provider: 'claude-sdk' } })
    await trust(WS, primary(), { type: 'trust_folder', sessionId: 's1', requestId: 'r1' }, ctx)
    const result = send.mock.calls.map((c) => c.arguments[1]).find((m) => m.type === 'folder_trust_result')
    assert.equal(result.ok, false)
    assert.equal(isFolderTrusted(cwd), false)
  })
})
