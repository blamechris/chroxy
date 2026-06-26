import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/providers.js'
import {
  reloadModelsOverlay,
  getRegistryForProvider,
  _resetModelsOverlayForTests,
  _resetProviderRegistryCacheForTests,
} from '../src/models.js'
import { DeepSeekSession } from '../src/deepseek-session.js'

/**
 * #6381 — a `provider`-tagged ~/.chroxy/models.json entry can re-price a
 * non-Claude model with no release. DeepSeek is the built-in beneficiary: its
 * `_getPricing` consults the registry's overlay pricing (via getOverlayPricing)
 * before the shipped static DEEPSEEK_PRICING table.
 */

let dir
function writeOverlay(obj) {
  if (!dir) dir = mkdtempSync(join(tmpdir(), 'ds-overlay-price-'))
  const path = join(dir, 'models.json')
  writeFileSync(path, JSON.stringify(obj))
  return path
}

beforeEach(() => {
  _resetProviderRegistryCacheForTests()
  _resetModelsOverlayForTests()
})
afterEach(() => {
  _resetProviderRegistryCacheForTests()
  _resetModelsOverlayForTests()
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null }
})

const OVERLAY_PRICE = { input: 99, output: 199, cacheRead: 9, cacheWrite: 19 }

describe('#6381 DeepSeek overlay pricing', () => {
  it('registry.getOverlayPricing is null with no overlay, and the entry pricing once seeded', () => {
    assert.equal(getRegistryForProvider('deepseek').getOverlayPricing('deepseek-chat'), null)

    const path = writeOverlay({ 'deepseek-chat': { provider: 'deepseek', pricing: OVERLAY_PRICE } })
    assert.equal(reloadModelsOverlay(path).reloaded, true)

    assert.deepEqual(getRegistryForProvider('deepseek').getOverlayPricing('deepseek-chat'), OVERLAY_PRICE)
  })

  it('DeepSeekSession._getPricing returns the SHIPPED static rate with no overlay', () => {
    const session = new DeepSeekSession({ cwd: '/tmp' })
    const priced = session._getPricing('deepseek-chat')
    assert.ok(priced && typeof priced === 'object', 'deepseek-chat has a shipped static price')
    assert.notDeepEqual(priced, OVERLAY_PRICE)
  })

  it('an overlay entry OVERRIDES the static rate (re-price with no release)', () => {
    const path = writeOverlay({ 'deepseek-chat': { provider: 'deepseek', pricing: OVERLAY_PRICE } })
    assert.equal(reloadModelsOverlay(path).reloaded, true)

    const session = new DeepSeekSession({ cwd: '/tmp' })
    assert.deepEqual(session._getPricing('deepseek-chat'), OVERLAY_PRICE, 'overlay pricing wins over the static table')
  })

  it('a Claude-default (untagged) overlay entry does NOT affect DeepSeek pricing', () => {
    const path = writeOverlay({ 'deepseek-chat': { pricing: OVERLAY_PRICE } }) // no provider → Claude registry
    assert.equal(reloadModelsOverlay(path).reloaded, true)

    const session = new DeepSeekSession({ cwd: '/tmp' })
    assert.notDeepEqual(session._getPricing('deepseek-chat'), OVERLAY_PRICE, 'untagged entry must not reach DeepSeek')
  })

  it('a model with neither overlay nor static pricing returns null (no fabrication)', () => {
    const session = new DeepSeekSession({ cwd: '/tmp' })
    assert.equal(session._getPricing('deepseek-nonexistent-9'), null)
  })
})
