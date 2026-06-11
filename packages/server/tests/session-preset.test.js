import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  validatePreset,
  foldPreamble,
  findRepoPresetFile,
  readRepoPresetFile,
  readDaemonOverride,
  resolveSessionPreset,
  presetContentHash,
  SESSION_PREAMBLE_MAX_LENGTH,
  SESSION_SEED_MAX_LENGTH,
} from '../src/session-preset.js'
import { SESSION_PREAMBLE_MAX_LENGTH as BASE_PREAMBLE_MAX } from '../src/base-session.js'
import { SessionPresetTrustStore } from '../src/session-preset-trust.js'

/**
 * Tests for the #5553 per-repo session preset resolver + trust gate.
 *
 * Every filesystem touchpoint is a temp dir (the sandbox guard would otherwise
 * fire). The trust store is always constructed with an explicit temp filePath.
 */

function writePreset(repoRoot, obj) {
  const dir = join(repoRoot, '.chroxy')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.json'), JSON.stringify(obj))
  return join(dir, 'session.json')
}

describe('session-preset', () => {
  let root
  let trustPath

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-preset-'))
    trustPath = join(root, 'trust.json')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('cap constant parity', () => {
    it('SESSION_PREAMBLE_MAX_LENGTH matches base-session', () => {
      assert.equal(SESSION_PREAMBLE_MAX_LENGTH, BASE_PREAMBLE_MAX)
    })
  })

  describe('validatePreset', () => {
    it('returns null for non-objects', () => {
      assert.equal(validatePreset(null), null)
      assert.equal(validatePreset('x'), null)
      assert.equal(validatePreset(['a']), null)
    })

    it('returns null when neither channel is present', () => {
      assert.equal(validatePreset({ enabled: true }), null)
      assert.equal(validatePreset({ preamble: '   ', seed: '' }), null)
    })

    it('trims and defaults enabled to true', () => {
      const p = validatePreset({ preamble: '  hello  ' })
      assert.equal(p.preamble, 'hello')
      assert.equal(p.enabled, true)
      assert.equal(p.preambleLength, 5)
    })

    it('only an explicit false disables', () => {
      assert.equal(validatePreset({ seed: 's', enabled: false }).enabled, false)
      assert.equal(validatePreset({ seed: 's', enabled: 0 }).enabled, true)
    })

    it('flags (does NOT truncate) an over-cap preamble', () => {
      const big = 'a'.repeat(SESSION_PREAMBLE_MAX_LENGTH + 10)
      const p = validatePreset({ preamble: big })
      assert.equal(p.capped, true)
      assert.equal(p.preamble.length, big.length, 'preamble is not truncated at validation')
    })

    it('truncates an over-cap seed and flags capped', () => {
      const big = 'b'.repeat(SESSION_SEED_MAX_LENGTH + 50)
      const p = validatePreset({ seed: big })
      assert.equal(p.capped, true)
      assert.equal(p.seed.length, SESSION_SEED_MAX_LENGTH)
    })
  })

  describe('foldPreamble', () => {
    it('concatenates repo first', () => {
      const { value, capped } = foldPreamble('REPO', 'SESSION')
      assert.equal(value, 'REPO\n\nSESSION')
      assert.equal(capped, false)
    })

    it('returns one side when the other is empty', () => {
      assert.equal(foldPreamble('REPO', '').value, 'REPO')
      assert.equal(foldPreamble('', 'SESSION').value, 'SESSION')
      assert.equal(foldPreamble('', '').value, '')
    })

    it('caps the combined result at SESSION_PREAMBLE_MAX_LENGTH', () => {
      const repo = 'r'.repeat(3000)
      const session = 's'.repeat(3000)
      const { value, capped } = foldPreamble(repo, session)
      assert.equal(value.length, SESSION_PREAMBLE_MAX_LENGTH)
      assert.equal(capped, true)
      assert.ok(value.startsWith('r'), 'repo content comes first in the capped result')
    })
  })

  describe('findRepoPresetFile (walk-up)', () => {
    it('finds the preset at the repo root', () => {
      const file = writePreset(root, { preamble: 'x' })
      assert.equal(findRepoPresetFile(root), file)
    })

    it('walks up from a nested subdirectory', () => {
      const file = writePreset(root, { preamble: 'x' })
      const nested = join(root, 'a', 'b', 'c')
      mkdirSync(nested, { recursive: true })
      assert.equal(findRepoPresetFile(nested), file)
    })

    it('inherits the parent repo preset from a worktree-style sibling dir', () => {
      // Simulate a worktree: the preset lives at the repo root, the session
      // cwd is a deep nested dir under the same root (the walk-up reaches it).
      const file = writePreset(root, { seed: 'x' })
      const worktreeLike = join(root, 'worktrees', 'session-abc', 'pkg', 'src')
      mkdirSync(worktreeLike, { recursive: true })
      assert.equal(findRepoPresetFile(worktreeLike), file)
    })

    it('returns null when no preset exists in the chain', () => {
      const nested = join(root, 'a', 'b')
      mkdirSync(nested, { recursive: true })
      assert.equal(findRepoPresetFile(nested), null)
    })

    it('returns null for nullish cwd', () => {
      assert.equal(findRepoPresetFile(null), null)
      assert.equal(findRepoPresetFile(''), null)
    })
  })

  describe('readRepoPresetFile (fail-closed)', () => {
    it('reads a valid file', () => {
      const file = writePreset(root, { preamble: 'hi', seed: 'go', enabled: true })
      const p = readRepoPresetFile(file)
      assert.equal(p.preamble, 'hi')
      assert.equal(p.seed, 'go')
      assert.ok(p.path)
    })

    it('returns null for malformed JSON without throwing or echoing content', () => {
      const dir = join(root, '.chroxy')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'session.json')
      writeFileSync(file, '{ not json SECRET_LEAK')
      assert.equal(readRepoPresetFile(file), null)
    })

    it('returns null for a missing file', () => {
      assert.equal(readRepoPresetFile(join(root, 'nope.json')), null)
    })
  })

  describe('presetContentHash', () => {
    it('is stable and changes when content changes', () => {
      const a = presetContentHash({ preamble: 'x', seed: 'y', enabled: true })
      const b = presetContentHash({ preamble: 'x', seed: 'y', enabled: true })
      const c = presetContentHash({ preamble: 'x2', seed: 'y', enabled: true })
      assert.equal(a, b)
      assert.notEqual(a, c)
      assert.ok(/^[0-9a-f]{64}$/.test(a))
    })
  })

  describe('resolveSessionPreset — trust gating', () => {
    it('treats a first-seen repo-local preset as pending (inert)', () => {
      writePreset(root, { preamble: 'P', seed: 'S' })
      const store = new SessionPresetTrustStore({ filePath: trustPath })
      const r = resolveSessionPreset(root, { trustStore: store })
      assert.equal(r.source, 'repo')
      assert.equal(r.trustState, 'pending')
      assert.equal(r.active, false, 'pending preset is inert')
    })

    it('activates a repo-local preset once its hash is approved', () => {
      writePreset(root, { preamble: 'P', seed: 'S' })
      const store = new SessionPresetTrustStore({ filePath: trustPath })
      const pending = resolveSessionPreset(root, { trustStore: store })
      store.approve(pending.path, pending.hash)
      const trusted = resolveSessionPreset(root, { trustStore: store })
      assert.equal(trusted.trustState, 'trusted')
      assert.equal(trusted.active, true)
    })

    it('re-gates when the content hash changes after approval', () => {
      const file = writePreset(root, { preamble: 'P1', seed: 'S' })
      const store = new SessionPresetTrustStore({ filePath: trustPath })
      const pending = resolveSessionPreset(root, { trustStore: store })
      store.approve(pending.path, pending.hash)
      assert.equal(resolveSessionPreset(root, { trustStore: store }).active, true)
      // Mutate the file — the content hash changes, trust must re-gate.
      writeFileSync(file, JSON.stringify({ preamble: 'EVIL', seed: 'S' }))
      const after = resolveSessionPreset(root, { trustStore: store })
      assert.equal(after.trustState, 'pending')
      assert.equal(after.active, false)
    })

    it('a disabled (enabled:false) but trusted preset is inactive', () => {
      writePreset(root, { preamble: 'P', enabled: false })
      const store = new SessionPresetTrustStore({ filePath: trustPath })
      const pending = resolveSessionPreset(root, { trustStore: store })
      store.approve(pending.path, pending.hash)
      const r = resolveSessionPreset(root, { trustStore: store })
      assert.equal(r.trustState, 'trusted')
      assert.equal(r.enabled, false)
      assert.equal(r.active, false)
    })

    it('returns null when there is no preset at all', () => {
      const store = new SessionPresetTrustStore({ filePath: trustPath })
      assert.equal(resolveSessionPreset(root, { trustStore: store }), null)
    })
  })

  describe('resolveSessionPreset — daemon override precedence', () => {
    it('a daemon override is pre-trusted and wins over the repo file', () => {
      writePreset(root, { preamble: 'REPO', seed: 'repo-seed' })
      const configPath = join(root, 'config.json')
      writeFileSync(configPath, JSON.stringify({
        repos: [{ path: root, sessionPreset: { preamble: 'DAEMON', seed: 'daemon-seed' } }],
      }))
      const store = new SessionPresetTrustStore({ filePath: trustPath })
      const r = resolveSessionPreset(root, { trustStore: store, configPath })
      assert.equal(r.source, 'daemon')
      assert.equal(r.trustState, 'trusted')
      assert.equal(r.active, true)
      assert.equal(r.preamble, 'DAEMON')
      assert.equal(r.seed, 'daemon-seed')
    })

    it('readDaemonOverride matches by normalised path and returns null otherwise', () => {
      const configPath = join(root, 'config.json')
      writeFileSync(configPath, JSON.stringify({
        repos: [{ path: root, sessionPreset: { preamble: 'D' } }],
      }))
      assert.ok(readDaemonOverride(root, configPath))
      assert.equal(readDaemonOverride(join(root, 'other'), configPath), null)
    })
  })

  describe('SessionPresetTrustStore persistence', () => {
    it('survives a reload from disk', () => {
      writePreset(root, { preamble: 'P' })
      const store1 = new SessionPresetTrustStore({ filePath: trustPath })
      const pending = resolveSessionPreset(root, { trustStore: store1 })
      store1.approve(pending.path, pending.hash)
      // New store instance reading the same ledger file.
      const store2 = new SessionPresetTrustStore({ filePath: trustPath })
      assert.equal(store2.isTrusted(pending.path, pending.hash), true)
    })

    it('revoke drops the record so the preset goes inert again', () => {
      writePreset(root, { preamble: 'P' })
      const store = new SessionPresetTrustStore({ filePath: trustPath })
      const pending = resolveSessionPreset(root, { trustStore: store })
      store.approve(pending.path, pending.hash)
      assert.equal(store.isTrusted(pending.path, pending.hash), true)
      store.revoke(pending.path)
      assert.equal(store.isTrusted(pending.path, pending.hash), false)
    })

    it('rejects a non-hex hash on approve', () => {
      const store = new SessionPresetTrustStore({ filePath: trustPath })
      assert.equal(store.approve('/x/session.json', 'not-a-hash'), false)
    })
  })
})
