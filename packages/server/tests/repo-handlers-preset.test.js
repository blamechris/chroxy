import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { repoHandlers } from '../src/handlers/repo-handlers.js'

/**
 * #5553 — repo-handlers per-repo preset surface: host-authority gate, the
 * daemon-override config write path, and approve/revoke. Uses a stubbed
 * sessionManager + a temp config so no real state is touched.
 */

function makeWs() {
  const messages = []
  return {
    readyState: 1,
    send: (raw) => messages.push(JSON.parse(raw)),
    _messages: messages,
  }
}

function makeCtx(overrides = {}) {
  const sent = []
  return {
    send: (_ws, msg) => sent.push(msg),
    config: {},
    _sent: sent,
    ...overrides,
  }
}

describe('repo-handlers session preset', () => {
  let root
  let configPath

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-rh-preset-'))
    configPath = join(root, 'config.json')
    writeFileSync(configPath, JSON.stringify({ repos: [] }))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('authority', () => {
    it('rejects a session-bound (non-host) client', () => {
      const ctx = makeCtx({ sessionManager: { resolveSessionPresetForCwd: () => null } })
      const ws = makeWs()
      const client = { boundSessionId: 'abc' }
      repoHandlers.session_preset_get(ws, client, { cwd: '/x' }, ctx)
      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.equal(ctx._sent[0].code, 'NOT_AUTHORIZED')
    })

    it('rejects a non-host client on the write path before any config write', () => {
      let wrote = false
      const ctx = makeCtx({
        sessionManager: { resolveSessionPresetForCwd: () => null },
        writeSessionPresetOverrideToConfig: () => { wrote = true },
      })
      const ws = makeWs()
      repoHandlers.session_preset_set(ws, { boundSessionId: 'abc' }, { cwd: root, preset: { preamble: 'X' } }, ctx)
      assert.equal(wrote, false, 'no config write for an unauthorised client')
      assert.equal(ctx._sent[0].code, 'NOT_AUTHORIZED')
    })
  })

  describe('session_preset_get', () => {
    it('returns the resolver snapshot for a host client', () => {
      const fake = {
        source: 'repo', active: false, trustState: 'pending', enabled: true,
        preamble: 'P', seed: 'S', preambleLength: 1, seedLength: 1, capped: false, repoPath: root,
      }
      const ctx = makeCtx({ sessionManager: { resolveSessionPresetForCwd: () => fake } })
      const ws = makeWs()
      repoHandlers.session_preset_get(ws, {}, { cwd: root, requestId: 'r1' }, ctx)
      const reply = ctx._sent[0]
      assert.equal(reply.type, 'session_preset_snapshot')
      assert.equal(reply.cwd, root)
      assert.equal(reply.requestId, 'r1')
      assert.equal(reply.preset.trustState, 'pending')
      assert.equal(reply.preset.preamble, 'P')
    })
  })

  describe('session_preset_set (daemon override write)', () => {
    it('persists a validated override and replies with the re-resolved snapshot', () => {
      // Use the REAL config writer against the temp config; stub the resolver.
      const ctx = makeCtx({
        sessionManager: {
          resolveSessionPresetForCwd: () => ({
            source: 'daemon', active: true, trustState: 'trusted', enabled: true,
            preamble: 'DAEMON', seed: '', preambleLength: 6, seedLength: 0, capped: false, repoPath: root,
          }),
        },
        config: { configPath, workspaceRoots: [root] },
      })
      const ws = makeWs()
      repoHandlers.session_preset_set(ws, {}, { cwd: root, preset: { preamble: 'DAEMON' } }, ctx)

      // The handler keys the override by realpathSync(cwd) (symlink-resolved).
      const realRoot = realpathSync(root)
      const written = JSON.parse(readFileSync(configPath, 'utf-8'))
      const entry = written.repos.find(r => r.path === realRoot)
      assert.ok(entry, 'a repos[] entry was created for the override')
      assert.equal(entry.sessionPreset.preamble, 'DAEMON')
      assert.equal(ctx._sent[0].type, 'session_preset_snapshot')
      assert.equal(ctx._sent[0].preset.source, 'daemon')
    })

    it('clears the override when preset is null', () => {
      const realRoot = realpathSync(root)
      writeFileSync(configPath, JSON.stringify({
        repos: [{ path: realRoot, sessionPreset: { preamble: 'OLD' } }],
      }))
      const ctx = makeCtx({
        sessionManager: { resolveSessionPresetForCwd: () => null },
        config: { configPath, workspaceRoots: [root] },
      })
      repoHandlers.session_preset_set(makeWs(), {}, { cwd: root, preset: null }, ctx)
      const written = JSON.parse(readFileSync(configPath, 'utf-8'))
      const entry = written.repos.find(r => r.path === realRoot)
      assert.ok(entry, 'the repo entry survives')
      assert.equal(entry.sessionPreset, undefined, 'the override is cleared')
    })

    it('rejects a missing cwd', () => {
      const ctx = makeCtx({ sessionManager: { resolveSessionPresetForCwd: () => null } })
      repoHandlers.session_preset_set(makeWs(), {}, { preset: { preamble: 'X' } }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
    })
  })

  describe('session_preset_approve / revoke', () => {
    it('approve calls the manager and returns the snapshot', () => {
      let approvedCwd = null
      const ctx = makeCtx({
        sessionManager: {
          approveSessionPreset: (cwd) => { approvedCwd = cwd; return { source: 'repo', active: true, trustState: 'trusted', enabled: true, preamble: 'P', seed: '', preambleLength: 1, seedLength: 0, capped: false, repoPath: cwd } },
        },
      })
      repoHandlers.session_preset_approve(makeWs(), {}, { cwd: root }, ctx)
      assert.equal(approvedCwd, root)
      assert.equal(ctx._sent[0].preset.trustState, 'trusted')
    })

    it('revoke calls the manager and returns the snapshot', () => {
      let revokedCwd = null
      const ctx = makeCtx({
        sessionManager: {
          revokeSessionPreset: (cwd) => { revokedCwd = cwd; return { source: 'repo', active: false, trustState: 'pending', enabled: true, preamble: 'P', seed: '', preambleLength: 1, seedLength: 0, capped: false, repoPath: cwd } },
        },
      })
      repoHandlers.session_preset_revoke(makeWs(), {}, { cwd: root }, ctx)
      assert.equal(revokedCwd, root)
      assert.equal(ctx._sent[0].preset.trustState, 'pending')
    })
  })

  it('does not leak preset content in a write failure message', () => {
    const ctx = makeCtx({
      sessionManager: { resolveSessionPresetForCwd: () => null },
      writeSessionPresetOverrideToConfig: () => { throw new Error('disk full') },
      config: { workspaceRoots: [root] },
    })
    repoHandlers.session_preset_set(makeWs(), {}, { cwd: root, preset: { preamble: 'SECRET-CONTENT' } }, ctx)
    const err = ctx._sent[0]
    assert.equal(err.type, 'session_error')
    assert.ok(!err.message.includes('SECRET-CONTENT'), 'error must not echo preset content')
  })
})
