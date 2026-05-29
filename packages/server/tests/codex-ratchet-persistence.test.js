import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Importing providers.js triggers built-in provider registration so
// getRegistryForProvider('codex') resolves to the CodexSession class.
import '../src/providers.js'
import {
  getRegistryForProvider,
  _resetProviderRegistryCacheForTests,
} from '../src/models.js'
import {
  _maybeRatchetContextWindow,
  CODEX_CONTEXT_WINDOW_HEADROOM,
  CODEX_CONTEXT_WINDOW_RATCHET_CAP,
} from '../src/codex-session.js'

// ---------------------------------------------------------------------------
// #4413 — persist Codex learn-loop ratchets across server restart.
//
// Every test uses an isolated `CHROXY_CONFIG_DIR` (the per-provider cache
// path is derived from this env var via `getProviderCachePath`). The
// provider-registry cache is purged before AND after each test so the
// codex registry rebuilds against the temp dir and never leaks into other
// suites (memory: feedback_test_state_contamination.md).
// ---------------------------------------------------------------------------

describe('#4413 Codex ratchet persistence (cross-restart)', () => {
  let tmpDir
  let origConfigDir

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-codex-ratchet-'))
    origConfigDir = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = tmpDir
    // Force a fresh codex registry so the first getRegistryForProvider()
    // call inside each test re-runs loadCache() against the temp dir.
    _resetProviderRegistryCacheForTests('codex')
  })

  afterEach(() => {
    if (origConfigDir === undefined) {
      delete process.env.CHROXY_CONFIG_DIR
    } else {
      process.env.CHROXY_CONFIG_DIR = origConfigDir
    }
    _resetProviderRegistryCacheForTests('codex')
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it('writes the per-provider cache file after a successful ratchet', () => {
    const codexPath = join(tmpDir, 'models-cache.codex.json')
    assert.equal(existsSync(codexPath), false, 'sanity: no cache file before ratchet')

    const fakeSession = { model: 'gpt-5-codex', emit: () => {} }
    // 500k input on a 400k registered window → ratchets up.
    const changed = _maybeRatchetContextWindow(fakeSession, 'gpt-5-codex', 500_000)
    assert.equal(changed, true, 'ratchet should fire for an over-budget turn')

    assert.equal(existsSync(codexPath), true,
      `expected codex-scoped cache file at ${codexPath}`)
    const parsed = JSON.parse(readFileSync(codexPath, 'utf-8'))
    assert.ok(Array.isArray(parsed.models), 'cache file should carry a models array')
    const persisted = parsed.models.find(m => m.fullId === 'gpt-5-codex')
    assert.ok(persisted, 'gpt-5-codex must be persisted')
    assert.ok(persisted.contextWindow >= 500_000 * CODEX_CONTEXT_WINDOW_HEADROOM,
      `expected persisted window >= ${500_000 * CODEX_CONTEXT_WINDOW_HEADROOM}, got ${persisted.contextWindow}`)
  })

  it('does NOT touch the default Claude cache file (models-cache.json)', () => {
    const claudePath = join(tmpDir, 'models-cache.json')
    const codexPath = join(tmpDir, 'models-cache.codex.json')

    const fakeSession = { model: 'gpt-5-codex', emit: () => {} }
    _maybeRatchetContextWindow(fakeSession, 'gpt-5-codex', 600_000)

    assert.equal(existsSync(codexPath), true, 'codex cache should exist')
    assert.equal(existsSync(claudePath), false,
      'codex ratchet must not write to the Claude registry cache (#4413 acceptance criterion)')
  })

  it('on simulated restart, the ratcheted window is restored before getModels() serves traffic', () => {
    // --- "Pre-restart" session: ratchet up to ~550k.
    const fakeSession = { model: 'gpt-5-codex', emit: () => {} }
    _maybeRatchetContextWindow(fakeSession, 'gpt-5-codex', 500_000)
    const beforeRestart = getRegistryForProvider('codex')
      .getModels().find(m => m.fullId === 'gpt-5-codex')
    assert.ok(beforeRestart.contextWindow >= 500_000 * CODEX_CONTEXT_WINDOW_HEADROOM)
    const expectedWindow = beforeRestart.contextWindow

    // --- Simulated restart: drop the cached registry. Next
    //     getRegistryForProvider('codex') call must rebuild from fallback
    //     metadata and then immediately hydrate from the on-disk cache.
    _resetProviderRegistryCacheForTests('codex')

    const restored = getRegistryForProvider('codex')
      .getModels().find(m => m.fullId === 'gpt-5-codex')
    assert.ok(restored, 'gpt-5-codex must survive the simulated restart')
    assert.equal(restored.contextWindow, expectedWindow,
      `post-restart window should match pre-restart ratcheted value (was ${beforeRestart.contextWindow}, got ${restored.contextWindow})`)
  })

  it('restored ratchet is also honored by a subsequent ratchet call (no double-bump)', () => {
    // First "session" ratchets to ~550k.
    const fakeSession = { model: 'gpt-5-codex', emit: () => {} }
    _maybeRatchetContextWindow(fakeSession, 'gpt-5-codex', 500_000)

    // Restart: drop in-memory state.
    _resetProviderRegistryCacheForTests('codex')

    // After restart, a turn that fits inside the restored window must NOT
    // re-trigger the ratchet. If persistence is broken, the registry would
    // reset to the 400k static value and 450k would look over-budget again.
    const changed = _maybeRatchetContextWindow(fakeSession, 'gpt-5-codex', 450_000)
    assert.equal(changed, false,
      'a turn inside the restored window must be a no-op — persistence not honored?')
  })

  it('persistence respects CODEX_CONTEXT_WINDOW_RATCHET_CAP', () => {
    // A wildly high observed value triggers the cap; the persisted file
    // must reflect the capped value, not the uncapped raw multiplication.
    const fakeSession = { model: 'gpt-5-codex', emit: () => {} }
    _maybeRatchetContextWindow(fakeSession, 'gpt-5-codex', 10_000_000)

    const codexPath = join(tmpDir, 'models-cache.codex.json')
    const parsed = JSON.parse(readFileSync(codexPath, 'utf-8'))
    const persisted = parsed.models.find(m => m.fullId === 'gpt-5-codex')
    assert.ok(persisted.contextWindow <= CODEX_CONTEXT_WINDOW_RATCHET_CAP,
      `persisted ratchet must respect cap of ${CODEX_CONTEXT_WINDOW_RATCHET_CAP}, got ${persisted.contextWindow}`)
  })

  it('cold boot with no cache file is a silent no-op (returns the fallback list)', () => {
    // No file written, no ratchet performed: the registry must still serve
    // the static fallback metadata so first-boot semantics are unchanged.
    const codexPath = join(tmpDir, 'models-cache.codex.json')
    assert.equal(existsSync(codexPath), false)

    const models = getRegistryForProvider('codex').getModels()
    assert.ok(models.length > 0, 'codex registry should serve fallback even with no cache')
    const gpt5 = models.find(m => m.fullId === 'gpt-5-codex')
    assert.ok(gpt5, 'gpt-5-codex fallback must be present')
    assert.equal(gpt5.contextWindow, 400_000,
      'cold boot should serve the static 400k fallback when no cache exists')
  })

  it('malformed cache file falls through to fallback list without throwing', () => {
    const codexPath = join(tmpDir, 'models-cache.codex.json')
    writeFileSync(codexPath, 'not valid json {{{')
    _resetProviderRegistryCacheForTests('codex')

    // Should not throw — loadCache returns false silently and the registry
    // serves fallback. This matches the existing Claude path's failure mode.
    const models = getRegistryForProvider('codex').getModels()
    const gpt5 = models.find(m => m.fullId === 'gpt-5-codex')
    assert.ok(gpt5)
    assert.equal(gpt5.contextWindow, 400_000,
      'malformed cache should fall through to fallback, not corrupt state')
  })

  it('Claude default registry continues to use the shared models-cache.json path', async () => {
    // Sanity: changing how non-Claude providers persist must NOT redirect
    // the Claude default registry to a per-provider path. Verifies the
    // saveCache default for the default registry still resolves to
    // `<configDir>/models-cache.json`.
    const claudePath = join(tmpDir, 'models-cache.json')
    // Use the legacy module-level Claude entry point.
    const { saveModelsCache, getRegistryForProvider: gp } = await import('../src/models.js')
    // Bump the default registry's snapshot to force a write.
    const claudeRegistry = gp('claude-sdk')
    claudeRegistry.updateContextWindow('claude-opus-4-7', 1_500_000)
    saveModelsCache()
    assert.equal(existsSync(claudePath), true,
      `default Claude cache should still land at ${claudePath}`)
    // Reset so we don't leak this contextWindow override into other suites.
    claudeRegistry.resetModels()
  })
})
