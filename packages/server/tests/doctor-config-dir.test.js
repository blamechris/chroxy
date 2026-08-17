import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runDoctorChecks } from '../src/doctor.js'

/**
 * #7240 — doctor's `Config/state root` check.
 *
 * The detection is injected via the `detectStranded` seam (the same shape as the
 * existing `tunnelProbe` seam), so these assertions never depend on whatever the
 * developer happens to have in their real `~/.chroxy` — the flakiness
 * doctor.test.js's header already warns about.
 *
 * The load-bearing case is the last one: doctor previously answered a missing
 * config.json with "run 'chroxy init' to create", which — when the real cause is
 * a CHROXY_CONFIG_DIR relocation — mints a fresh token and forces every paired
 * device to re-pair. That is worse than the problem it claims to fix.
 */

const stub = (over = {}) => () => ({
  relocated: false,
  source: '/home/u/.chroxy',
  target: '/home/u/.chroxy',
  stranded: [],
  highConsequence: [],
  unreadable: null,
  ...over,
})

const relocatedWith = (stranded, highConsequence = []) => stub({
  relocated: true,
  source: '/home/u/.chroxy',
  target: '/srv/chroxy-state',
  stranded,
  highConsequence,
})

const runWith = async (detectStranded) => {
  const { checks } = await runDoctorChecks({ providers: ['claude-sdk'], detectStranded })
  return {
    root: checks.find((c) => c.name === 'Config/state root'),
    config: checks.find((c) => c.name === 'Config'),
  }
}

describe('doctor — Config/state root (#7240)', () => {
  it('passes and names the root when nothing is stranded', async () => {
    const { root } = await runWith(stub())

    assert.equal(root.status, 'pass')
    // Pinned to the INJECTED root. This branch used to read configDir() and
    // process.env directly, which meant it reported something the caller never
    // asked about and no test could pin it.
    assert.equal(root.message, '/home/u/.chroxy')
  })

  it('passes when the root is relocated but already fully migrated', async () => {
    const { root } = await runWith(relocatedWith([]))

    assert.equal(root.status, 'pass')
    assert.equal(root.message, '/srv/chroxy-state (from CHROXY_CONFIG_DIR)')
  })

  it('warns and names the stranded entries, both roots, and the remedy', async () => {
    const { root } = await runWith(relocatedWith(['session-state.json', 'push-tokens.json']))

    assert.equal(root.status, 'warn')
    assert.match(root.message, /session-state\.json/)
    assert.match(root.message, /push-tokens\.json/)
    assert.match(root.message, /\/home\/u\/\.chroxy/)
    assert.match(root.message, /\/srv\/chroxy-state/)
    assert.match(root.message, /chroxy config-dir migrate/)
  })

  it('truncates a long stranded list but still names the high-consequence entries', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `state-${i}.json`).concat('server-identity.json')
    const { root } = await runWith(relocatedWith(many, ['server-identity.json']))

    assert.match(root.message, /and \d+ more/)
    assert.match(root.message, /server-identity\.json/,
      'the sharp entry is named outside the truncated tail')
  })

  it('warns rather than throwing when the source cannot be read', async () => {
    const { root } = await runWith(stub({ relocated: true, target: '/srv/x', unreadable: 'EACCES' }))
    assert.equal(root.status, 'warn')
    assert.match(root.message, /EACCES/)
  })

  it('degrades to a warn when detection itself throws', async () => {
    const { root } = await runWith(() => { throw new Error('boom') })
    assert.equal(root.status, 'warn')
    assert.match(root.message, /boom/)
  })

  it('does NOT recommend chroxy init when a stranded config.json is the real cause', async () => {
    const { config } = await runWith(relocatedWith(['config.json'], ['config.json']))

    assert.equal(config.status, 'fail')
    assert.doesNotMatch(config.message, /run 'chroxy init' to create/,
      'that advice mints a fresh token and forces every device to re-pair')
    assert.match(config.message, /Do NOT run 'chroxy init'/)
    assert.match(config.message, /chroxy config-dir migrate/)
  })

  it('leaves the ordinary missing-config advice alone when there is no relocation', async () => {
    // Only meaningful when the developer has no real config.json; when they do,
    // the Config check passes and there is no advice to inspect either way.
    const { config } = await runWith(stub())
    if (config.status === 'warn' && /Not found/.test(config.message)) {
      assert.match(config.message, /run 'chroxy init' to create/)
    }
  })
})
