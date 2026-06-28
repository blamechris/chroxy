/**
 * IDE feature-flag gate (#6481, epic #6469).
 *
 * The whole IDE surface (file navigator, symbol nav, go-to-definition,
 * find-references, edit-in-place) is OPT-IN, OFF by default, so it never risks
 * the core remote-cockpit offering. `isIdeFeatureEnabled(config)` is the single
 * source of truth: server handler registration gates on it, and the `ide`
 * capability advertised in auth_ok (ws-history.sendPostAuthInfo) is `ideEnabled
 * === true`, so clients reveal IDE UI only when the operator opts in.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isIdeFeatureEnabled } from '../src/config.js'

describe('isIdeFeatureEnabled() — IDE opt-in gate (#6481)', () => {
  let saved
  beforeEach(() => {
    saved = process.env.CHROXY_ENABLE_IDE
    delete process.env.CHROXY_ENABLE_IDE
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.CHROXY_ENABLE_IDE
    else process.env.CHROXY_ENABLE_IDE = saved
  })

  it('is OFF by default — no config, empty config, or features without ide', () => {
    assert.equal(isIdeFeatureEnabled(undefined), false)
    assert.equal(isIdeFeatureEnabled(null), false)
    assert.equal(isIdeFeatureEnabled({}), false)
    assert.equal(isIdeFeatureEnabled({ features: {} }), false)
    assert.equal(isIdeFeatureEnabled({ features: { ide: false } }), false)
  })

  it('is ON when config.features.ide === true', () => {
    assert.equal(isIdeFeatureEnabled({ features: { ide: true } }), true)
  })

  it('fail-closed: requires the EXACT boolean true (no truthy coercion)', () => {
    assert.equal(isIdeFeatureEnabled({ features: { ide: 1 } }), false)
    assert.equal(isIdeFeatureEnabled({ features: { ide: 'true' } }), false)
    assert.equal(isIdeFeatureEnabled({ features: { ide: {} } }), false)
  })

  it('CHROXY_ENABLE_IDE=1 forces it ON regardless of config (quick opt-in / dev)', () => {
    process.env.CHROXY_ENABLE_IDE = '1'
    assert.equal(isIdeFeatureEnabled(undefined), true)
    assert.equal(isIdeFeatureEnabled({}), true)
    assert.equal(isIdeFeatureEnabled({ features: { ide: false } }), true)
  })

  it('CHROXY_ENABLE_IDE other than "1" does not enable (only the explicit "1")', () => {
    process.env.CHROXY_ENABLE_IDE = '0'
    assert.equal(isIdeFeatureEnabled({}), false)
    process.env.CHROXY_ENABLE_IDE = 'true'
    assert.equal(isIdeFeatureEnabled({}), false)
    process.env.CHROXY_ENABLE_IDE = ''
    assert.equal(isIdeFeatureEnabled({}), false)
  })
})
