import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildFolderTrustStateMessage, buildFolderTrustStateMessageForDisplay, folderTrustAppliesFrom } from '../src/folder-trust-wire.js'
import { invalidateFolderTrustCache, getFolderTrustState } from '../src/folder-trust.js'
import { trustReviewed } from './helpers/trust-folder.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { sendSessionInfo } from '../src/ws-history.js'
import { frameForBoundClient } from '../src/outgoing-policy.js'
import { ServerFolderTrustStateSchema } from '@chroxy/protocol'

let root
let saved
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'folder-trust-wire-')))
  saved = { c: process.env.CHROXY_CONFIG_DIR, k: process.env.CLAUDE_CONFIG_DIR }
  process.env.CHROXY_CONFIG_DIR = join(root, 'chroxy')
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
  invalidateFolderTrustCache()
})
afterEach(() => {
  for (const [k, v] of [['CHROXY_CONFIG_DIR', saved.c], ['CLAUDE_CONFIG_DIR', saved.k]]) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
  invalidateFolderTrustCache()
})

function project(name, withMcp = true) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (withMcp) writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { s: { command: 'x', env: { K: 'v' } } } }))
  return dir
}

describe('buildFolderTrustStateMessage', () => {
  it('a folder with nothing command-bearing is untrusted too (no implicit loading), and says so', () => {
    const msg = buildFolderTrustStateMessage('s1', { cwd: project('n', false), provider: 'claude-sdk' })
    assert.equal(msg.status, 'untrusted')
    assert.equal(msg.summary.hasCommandBearingFiles, false)
    assert.match(msg.digest, /^[0-9a-f]{64}$/)
    ServerFolderTrustStateSchema.parse(msg)
  })

  it('untrusted then trusted, both with a summary that validates against the schema', async () => {
    const cwd = project('p')
    const entry = { cwd, provider: 'claude-tui' }
    const before = buildFolderTrustStateMessage('s1', entry)
    assert.equal(before.status, 'untrusted')
    assert.equal(before.appliesFrom, 'restart')
    assert.deepEqual(before.summary.mcpServers[0].envKeys, ['K'])
    ServerFolderTrustStateSchema.parse(before)
    await trustReviewed(cwd)
    const after = buildFolderTrustStateMessage('s1', entry)
    assert.equal(after.status, 'trusted')
    assert.equal(after.digest, before.digest)
    ServerFolderTrustStateSchema.parse(after)
  })

  it('a provider that does not run claude gets no frame and no scan', () => {
    assert.equal(buildFolderTrustStateMessage('s1', { cwd: project('g'), provider: 'gemini' }), null)
    assert.equal(buildFolderTrustStateMessage('s1', { cwd: join(root, 'missing-and-unscanned'), provider: 'codex' }), null)
  })

  it('launchedWithProject reports what a running claude-cli/claude-tui process started with', () => {
    const cwd = project('p')
    const session = { launchedWithProject: true }
    assert.equal(buildFolderTrustStateMessage('s1', { cwd, provider: 'claude-tui', session }).launchedWithProject, true)
    assert.equal(buildFolderTrustStateMessage('s1', { cwd, provider: 'claude-cli', session: { launchedWithProject: false } }).launchedWithProject, false)
    assert.equal('launchedWithProject' in buildFolderTrustStateMessage('s1', { cwd, provider: 'claude-tui', session: {} }), false, 'unknown until launched')
    assert.equal('launchedWithProject' in buildFolderTrustStateMessage('s1', { cwd, provider: 'claude-sdk', session }), false, 'claude-sdk re-reads each turn')
  })

  it('appliesFrom by provider', () => {
    assert.equal(folderTrustAppliesFrom('claude-sdk'), 'next_turn')
    assert.equal(folderTrustAppliesFrom('docker-sdk'), 'next_turn')
    for (const p of ['claude-cli', 'claude-tui', 'docker-cli', 'docker']) assert.equal(folderTrustAppliesFrom(p), 'restart')
    for (const p of ['gemini', 'codex', 'docker-byok', undefined]) assert.equal(folderTrustAppliesFrom(p), 'n/a')
  })

  it('no folder, no message', () => {
    assert.equal(buildFolderTrustStateMessage('s1', { provider: 'claude-sdk' }), null)
  })
})

describe('when the state is sent', () => {
  it('a session becoming ready carries folder_trust_state', () => {
    const cwd = project('p')
    const normalizer = new EventNormalizer({ flushIntervalMs: 10 })
    getFolderTrustState(cwd, { cached: true }) // `ready` answers only from a warm cache
    try {
      const entry = { cwd, provider: 'claude-sdk', session: { model: 'm', permissionMode: 'approve' } }
      const out = normalizer.normalize('ready', {}, { sessionId: 's1', mode: 'multi', getSessionEntry: () => entry })
      const msg = out.messages.map((m) => m.msg).find((m) => m.type === 'folder_trust_state')
      assert.equal(msg.sessionId, 's1')
      assert.equal(msg.status, 'untrusted')
    } finally {
      normalizer.destroy()
    }
  })

  it('a client that switches to or subscribes to a session is sent it', async () => {
    const cwd = project('p')
    const sent = []
    const session = { isReady: false, getMcpServersSnapshot: () => null }
    const ctx = {
      sessionManager: { getSession: () => ({ cwd, provider: 'claude-cli', session }) },
      send: (_ws, m) => sent.push(m),
      clients: new Map(),
    }
    sendSessionInfo(ctx, {}, 's1', { skipModels: true })
    assert.equal(sent.some((m) => m.type === 'folder_trust_state'), false, 'never inline: the scan is off-thread and the frame goes last')
    for (let i = 0; i < 200 && !sent.some((m) => m.type === 'folder_trust_state'); i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(sent.at(-1).type, 'folder_trust_state', 'strictly after the frames that precede it')
    const msg = sent.find((m) => m.type === 'folder_trust_state')
    assert.equal(msg.status, 'untrusted')
    assert.equal(msg.appliesFrom, 'restart')
  })
})

describe('a session-bound client', () => {
  it('receives the status but not the summary or digest', () => {
    const frame = { type: 'folder_trust_state', sessionId: 's1', status: 'untrusted', appliesFrom: 'restart', summary: { files: [{ path: '/x/.mcp.json' }] }, digest: 'a'.repeat(64) }
    const out = frameForBoundClient(frame)
    assert.equal(out.status, 'untrusted')
    assert.equal('summary' in out, false)
    assert.equal('digest' in out, false)
  })

  it('never receives folder_trust_result', () => {
    assert.equal(frameForBoundClient({ type: 'folder_trust_result', sessionId: 's1', ok: true, status: 'trusted' }), null)
  })
})

describe('off-thread display scan', () => {
  it('buildFolderTrustStateMessageForDisplay returns the same frame the in-thread builder does', async () => {
    const cwd = project('p')
    const entry = { cwd, provider: 'claude-tui', session: { launchedWithProject: false } }
    const off = await buildFolderTrustStateMessageForDisplay('s1', entry)
    assert.deepEqual(off, buildFolderTrustStateMessage('s1', entry))
    assert.equal(await buildFolderTrustStateMessageForDisplay('s1', { cwd, provider: 'gemini' }), null)
  })

  it('a trust change is seen by the next display scan (no stale cached scan)', async () => {
    const cwd = project('p')
    const entry = { cwd, provider: 'claude-sdk' }
    assert.equal((await buildFolderTrustStateMessageForDisplay('s1', entry)).status, 'untrusted')
    await trustReviewed(cwd)
    assert.equal((await buildFolderTrustStateMessageForDisplay('s1', entry)).status, 'trusted')
  })
})
