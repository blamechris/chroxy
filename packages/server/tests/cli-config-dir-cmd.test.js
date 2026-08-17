/**
 * `chroxy config-dir status` / `chroxy config-dir migrate` CLI (#7240).
 *
 * Copies daemon state stranded at `~/.chroxy` into a relocated
 * `CHROXY_CONFIG_DIR`. Consequential — it moves an identity key and credentials
 * across a directory boundary the operator drew, possibly onto a shared, synced
 * or bind-mounted volume — so it requires `--yes`; without it the command only
 * explains what it would do.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runConfigDirStatus, runConfigDirMigrate } from '../src/cli/config-dir-cmd.js'

function capture() {
  const lines = []
  return { write: (s) => lines.push(String(s)), text: () => lines.join('\n') }
}

const NOT_RELOCATED = {
  relocated: false,
  source: '/home/u/.chroxy',
  target: '/home/u/.chroxy',
  stranded: [],
  highConsequence: [],
  unreadable: null,
}

const RELOCATED = (stranded, highConsequence = []) => ({
  relocated: true,
  source: '/home/u/.chroxy',
  target: '/srv/chroxy-state',
  stranded,
  highConsequence,
  unreadable: null,
})

describe('config-dir status (#7240)', () => {
  it('reports the root and says nothing can be stranded when not relocated', () => {
    const out = capture()
    const res = runConfigDirStatus({ write: out.write, detect: () => NOT_RELOCATED })

    assert.equal(res.relocated, false)
    assert.match(out.text(), /Not relocated/)
  })

  it('lists stranded entries and marks the high-consequence ones', () => {
    const out = capture()
    const res = runConfigDirStatus({
      write: out.write,
      detect: () => RELOCATED(['config.json', 'push-tokens.json'], ['config.json']),
    })

    assert.deepEqual(res.stranded, ['config.json', 'push-tokens.json'])
    assert.match(out.text(), /config\.json.*high consequence/)
    assert.doesNotMatch(out.text(), /push-tokens\.json.*high consequence/)
    assert.match(out.text(), /chroxy config-dir migrate --yes/)
  })

  it('surfaces an unreadable source rather than claiming nothing is stranded', () => {
    const out = capture()
    runConfigDirStatus({ write: out.write, detect: () => ({ ...RELOCATED([]), unreadable: 'EACCES' }) })

    assert.match(out.text(), /EACCES/)
    assert.doesNotMatch(out.text(), /No state stranded/)
  })
})

describe('config-dir migrate (#7240)', () => {
  it('explains and does NOT copy without --yes', () => {
    const out = capture()
    let migrateCalled = false
    const res = runConfigDirMigrate({}, {
      write: out.write,
      detect: () => RELOCATED(['config.json'], ['config.json']),
      migrate: () => { migrateCalled = true; return { copied: [], failed: [] } },
    })

    assert.equal(res.migrated, false)
    assert.equal(migrateCalled, false, 'the confirmation gate must actually gate the copy')
    assert.match(out.text(), /Re-run with --yes/)
  })

  it('warns that the copy moves secrets before asking for confirmation', () => {
    const out = capture()
    runConfigDirMigrate({}, {
      write: out.write,
      detect: () => RELOCATED(['credentials.json'], ['credentials.json']),
      migrate: () => ({ copied: [], failed: [] }),
    })

    // The whole reason this is opt-in rather than automatic: the destination may
    // be a shared/synced/bind-mounted volume, and that is the operator's call.
    assert.match(out.text(), /secrets/i)
    assert.match(out.text(), /shared, synced or bind-mounted/)
  })

  it('copies with --yes and reports what landed', () => {
    const out = capture()
    let passed = null
    const res = runConfigDirMigrate({ yes: true }, {
      write: out.write,
      detect: () => RELOCATED(['config.json', 'skills'], ['config.json']),
      migrate: (opts) => {
        passed = opts
        return { copied: ['config.json', 'skills'], failed: [], source: '/home/u/.chroxy', target: '/srv/chroxy-state' }
      },
    })

    assert.equal(res.migrated, true)
    assert.ok(passed.detection, 'the already-computed detection is reused, not recomputed')
    assert.match(out.text(), /config\.json/)
    assert.match(out.text(), /skills/)
  })

  it('reports per-entry failures', () => {
    const out = capture()
    const res = runConfigDirMigrate({ yes: true }, {
      write: out.write,
      detect: () => RELOCATED(['a', 'b']),
      migrate: () => ({
        copied: ['a'], failed: [{ name: 'b', error: 'EACCES' }],
        source: '/home/u/.chroxy', target: '/srv/chroxy-state',
      }),
    })

    assert.equal(res.result.failed.length, 1)
    assert.match(out.text(), /could NOT be copied/)
    assert.match(out.text(), /b: EACCES/)
  })

  it('does nothing when the root is not relocated', () => {
    const out = capture()
    let migrateCalled = false
    const res = runConfigDirMigrate({ yes: true }, {
      write: out.write,
      detect: () => NOT_RELOCATED,
      migrate: () => { migrateCalled = true; return { copied: [], failed: [] } },
    })

    assert.equal(res.migrated, false)
    assert.equal(migrateCalled, false)
    assert.match(out.text(), /not relocated/)
  })

  it('does nothing when there is nothing stranded', () => {
    const out = capture()
    let migrateCalled = false
    const res = runConfigDirMigrate({ yes: true }, {
      write: out.write,
      detect: () => RELOCATED([]),
      migrate: () => { migrateCalled = true; return { copied: [], failed: [] } },
    })

    assert.equal(res.migrated, false)
    assert.equal(migrateCalled, false)
    assert.match(out.text(), /already up to date/)
  })

  it('tells the operator the source is still there afterwards', () => {
    const out = capture()
    runConfigDirMigrate({ yes: true }, {
      write: out.write,
      detect: () => RELOCATED(['config.json']),
      migrate: () => ({
        copied: ['config.json'], failed: [],
        source: '/home/u/.chroxy', target: '/srv/chroxy-state',
      }),
    })

    assert.match(out.text(), /still at \/home\/u\/\.chroxy/)
  })
})
