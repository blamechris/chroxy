import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BaseSession } from '../src/base-session.js'
import { sendSessionInfo } from '../src/ws-history.js'
// Side-effect: registers built-in providers so getRegistryForProvider() works
// inside sendSessionInfo (it sends `available_models` keyed on provider).
import '../src/providers.js'
import { createSpy } from './test-helpers.js'

/**
 * #6832 — `mcp_servers` is a transient event (session-manager.js's
 * `builtinTransient` list): forwarded to currently-connected clients but
 * never recorded in history and never replayed on reconnect. A client that
 * subscribes to an already-warmed session (dashboard reconnect, second
 * client joining a shared session) previously saw "No MCP servers" until the
 * NEXT emission — for sdk/cli sessions that's once at the stream-json
 * `system/init` (i.e. never again this boot); for claude-tui (#6820/#6831)
 * it's the next respawn/resume.
 *
 * Fix: BaseSession caches the last-emitted `mcp_servers` payload (a
 * self-listener wired in the constructor, alongside the existing
 * `_setupActivityRegistry` pattern) and exposes it via
 * `getMcpServersSnapshot()`. `ws-history.sendSessionInfo` replays it to a
 * fresh subscriber, mirroring the `activity_snapshot` /
 * `permission_rules_updated` snapshot-on-subscribe pattern. The cache is
 * cleared on full session teardown (`removeAllListeners()`, the same
 * chokepoint that clears the Control Room ActivityRegistry, #5160).
 *
 * Since every emitting provider (CliSession, SdkSession, ClaudeTuiSession)
 * extends BaseSession and emits via `this.emit('mcp_servers', ...)`, caching
 * at the BaseSession level covers all of them without touching each
 * provider's emit call site.
 */

describe('BaseSession — mcp_servers snapshot cache (#6832)', () => {
  let skillsDir

  beforeEach(() => {
    // Pin skillsDir + repoSkillsDir to an empty temp dir so these tests
    // don't pick up whatever lives in the developer's real ~/.chroxy/skills/.
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-mcp-snapshot-skills-'))
  })

  afterEach(() => {
    if (skillsDir) rmSync(skillsDir, { recursive: true, force: true })
  })

  function makeSession() {
    return new BaseSession({ cwd: '/tmp', skillsDir, repoSkillsDir: null })
  }

  it('returns null before any mcp_servers event has fired', () => {
    const session = makeSession()
    assert.equal(session.getMcpServersSnapshot(), null)
  })

  it('caches the last-emitted payload as an mcp_servers wire message', () => {
    const session = makeSession()
    session.emit('mcp_servers', { servers: [{ name: 'fs', status: 'connected' }] })
    assert.deepEqual(session.getMcpServersSnapshot(), {
      type: 'mcp_servers',
      servers: [{ name: 'fs', status: 'connected' }],
    })
  })

  it('updates the snapshot on re-emission (list-replacement, not a merge)', () => {
    const session = makeSession()
    session.emit('mcp_servers', { servers: [{ name: 'fs', status: 'connected' }] })
    session.emit('mcp_servers', {
      servers: [{ name: 'gh', status: 'connected' }, { name: 'fs', status: 'error' }],
    })
    assert.deepEqual(session.getMcpServersSnapshot(), {
      type: 'mcp_servers',
      servers: [{ name: 'gh', status: 'connected' }, { name: 'fs', status: 'error' }],
    })
  })

  it('removeAllListeners (destroy chokepoint) clears the cached snapshot', () => {
    const session = makeSession()
    session.emit('mcp_servers', { servers: [{ name: 'fs', status: 'connected' }] })
    assert.ok(session.getMcpServersSnapshot(), 'sanity: snapshot cached before destroy')

    session.removeAllListeners()

    assert.equal(session.getMcpServersSnapshot(), null)
  })

  it('targeted removeAllListeners(event) does NOT clear the cached snapshot', () => {
    const session = makeSession()
    session.emit('mcp_servers', { servers: [{ name: 'fs', status: 'connected' }] })

    session.removeAllListeners('some_other_event')

    assert.ok(session.getMcpServersSnapshot(), 'a targeted removeAllListeners must not drain the cache')
  })
})

describe('sendSessionInfo — mcp_servers replay on subscribe (#6832)', () => {
  let skillsDir

  beforeEach(() => {
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-mcp-snapshot-ws-skills-'))
  })

  afterEach(() => {
    if (skillsDir) rmSync(skillsDir, { recursive: true, force: true })
  })

  function makeSession() {
    return new BaseSession({ cwd: '/tmp', skillsDir, repoSkillsDir: null })
  }

  function makeCtx(session) {
    const sends = []
    const ctx = {
      sessionManager: { getSession: () => ({ session, provider: null }) },
      send: createSpy((ws, msg) => sends.push(msg)),
    }
    ctx._sends = sends
    return ctx
  }

  function makeFakeWs(readyState = 1) {
    return { readyState, send: () => {}, close: () => {} }
  }

  it('replays the cached mcp_servers list to a late subscriber', () => {
    const session = makeSession()
    session.emit('mcp_servers', { servers: [{ name: 'fs', status: 'connected' }] })
    const ctx = makeCtx(session)

    sendSessionInfo(ctx, makeFakeWs(), 'sess-1')

    const mcpMsg = ctx._sends.find((m) => m.type === 'mcp_servers')
    assert.ok(mcpMsg, 'mcp_servers was not replayed on subscribe')
    assert.equal(mcpMsg.sessionId, 'sess-1')
    assert.deepEqual(mcpMsg.servers, [{ name: 'fs', status: 'connected' }])
  })

  it('replays the LATEST snapshot after re-emission, not a stale first payload', () => {
    const session = makeSession()
    session.emit('mcp_servers', { servers: [{ name: 'fs', status: 'connected' }] })
    session.emit('mcp_servers', {
      servers: [{ name: 'fs', status: 'connected' }, { name: 'gh', status: 'connected' }],
    })
    const ctx = makeCtx(session)

    sendSessionInfo(ctx, makeFakeWs(), 'sess-1')

    const mcpMsg = ctx._sends.find((m) => m.type === 'mcp_servers')
    assert.deepEqual(mcpMsg.servers, [
      { name: 'fs', status: 'connected' },
      { name: 'gh', status: 'connected' },
    ])
  })

  it('does not send mcp_servers for a session that never emitted one', () => {
    const session = makeSession()
    const ctx = makeCtx(session)

    sendSessionInfo(ctx, makeFakeWs(), 'sess-1')

    assert.equal(ctx._sends.find((m) => m.type === 'mcp_servers'), undefined)
  })

  it('clears the snapshot on destroy — a client subscribing post-destroy gets no replay', () => {
    const session = makeSession()
    session.emit('mcp_servers', { servers: [{ name: 'fs', status: 'connected' }] })
    session.removeAllListeners()
    const ctx = makeCtx(session)

    sendSessionInfo(ctx, makeFakeWs(), 'sess-1')

    assert.equal(ctx._sends.find((m) => m.type === 'mcp_servers'), undefined)
  })

  it('does not throw for a legacy/mock session lacking getMcpServersSnapshot', () => {
    // Defensive: a session type that hasn't grown the method yet (or a
    // hand-rolled test double) must not crash sendSessionInfo — it simply
    // skips the mcp_servers replay, same as the getPermissionRules /
    // getActivitySnapshot guards above it.
    const session = { isReady: false, model: null, permissionMode: 'approve' }
    const ctx = makeCtx(session)

    assert.doesNotThrow(() => sendSessionInfo(ctx, makeFakeWs(), 'sess-1'))
    assert.equal(ctx._sends.find((m) => m.type === 'mcp_servers'), undefined)
  })
})
