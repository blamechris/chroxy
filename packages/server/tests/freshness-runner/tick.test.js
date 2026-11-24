/**
 * One tick of the runner over the three sources: each tick record carries the
 * build's commit, the state file's schema version and the installed daemon
 * version; the ledger must sit outside the daemon's state directory; the lease
 * must exceed the cadence; the only mode is read-only and it delivers nothing.
 * Each guard has a mutant (an edit to a copy of `src`) that must fail its check.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { cleanupTmp } from '../freshness-core/helpers/harness.js'
import { COMMIT, REAL_RUNNER, T0, cleanupVariants, install, ledgerRecords, mustKillRunner, runMain, tickArgs, withEnv, world } from './helpers/runner-harness.js'

afterEach(() => cleanupTmp())
process.on('exit', cleanupVariants)

const proves = (name, check, mutants = {}) =>
  describe(name, () => {
    it('holds on the real code', async () => {
      await check(REAL_RUNNER)
    })
    for (const [label, edits] of Object.entries(mutants)) it(`mutant "${label}" fails it`, () => mustKillRunner(check, label, edits))
  })

const edit = (file, from, to) => ({ file, from, to })
const R = 'freshness-runner/run-tick.js'
const SOURCES = ['chroxy-state-file', 'claude-session-registry', 'claude-transcript']

const tick = (M, w, i, extra = [], opts = {}) => runMain(M, tickArgs(w, extra), { packageRoot: i.pkg, now: w.now, ...opts })

proves(
  'every tick record shows the build commit, the state schema version and the daemon version',
  (M) => {
    const w = world({ stateVersion: 3 })
    const i = install({ version: '0.11.10' })
    const res = tick(M, w, i)
    assert.equal(res.code, 0, res.err)
    const want = { commit: COMMIT, state_schema_version: 3, daemon_version: '0.11.10', install: 'pinned' }
    const ticks = ledgerRecords(w).filter((r) => r.kind === 'tick')
    assert.deepEqual(ticks.map((r) => r.body.source).sort(), [...SOURCES, ...SOURCES].sort(), 'an open and a close per source')
    for (const t of ticks) assert.deepEqual(t.body.build, want, `${t.body.source} ${t.body.phase}`)
    const summary = JSON.parse(res.out)
    assert.deepEqual(summary.build, want)
    assert.deepEqual(summary.sources.map((s) => s.source), SOURCES)
    assert.equal(summary.sources.every((s) => s.ok), true)
  },
  {
    'the commit is left out': [edit('freshness-runner/build-info.js', 'return { commit: build.commit,', 'return { commit: null,')],
    'the schema version is a constant': [edit('freshness-runner/build-info.js', 'state_schema_version: stateSchemaVersion', 'state_schema_version: 1')],
    'the build is not given to the tick': [edit(R, 'rec.tick({ source, slotStart, now, build: recorded })', 'rec.tick({ source, slotStart, now })')],
    'the core drops the build': [edit('freshness/core.js', '...(build === null ? {} : { build })', '')],
  },
)

proves(
  'the state file schema version follows the file, and is null when it cannot be read',
  (M) => {
    const w = world({ stateVersion: 2 })
    const i = install()
    assert.equal(tick(M, w, i).code, 0)
    for (const t of ledgerRecords(w).filter((r) => r.kind === 'tick')) assert.equal(t.body.build.state_schema_version, 2)
    const w2 = world()
    fs.rmSync(w2.stateFile)
    assert.equal(tick(M, w2, i).code, 0)
    for (const t of ledgerRecords(w2).filter((r) => r.kind === 'tick')) assert.equal(t.body.build.state_schema_version, null)
  },
  { 'the version is read from the registry file name': [edit(R, 'readStateSchemaVersion(paths.stateFile)', 'readStateSchemaVersion(paths.registryDir)')] },
)

proves(
  'what runs is the install the runner belongs to, not whatever a checkout holds',
  (M) => {
    const w = world()
    const i = install({ version: '0.11.10' })
    // The checkout moves to another branch: another version, another stamp.
    fs.writeFileSync(path.join(i.checkout, 'package.json'), JSON.stringify({ name: '@chroxy/server', version: '9.9.9' }))
    fs.writeFileSync(path.join(i.checkout, 'build-info.json'), JSON.stringify({ commit: 'e'.repeat(40) }))
    assert.equal(tick(M, w, i).code, 0)
    for (const t of ledgerRecords(w).filter((r) => r.kind === 'tick')) assert.deepEqual([t.body.build.commit, t.body.build.daemon_version], [COMMIT, '0.11.10'])
    // Pointed at the checkout the runner refuses, with nothing read or written.
    const w2 = world()
    const refused = tick(M, w2, { pkg: i.checkout })
    assert.equal(refused.code, 2)
    assert.match(refused.err, /development checkout/)
    assert.equal(fs.existsSync(w2.ledgerDir), false)
    // Allowed explicitly, the record says it was a checkout and carries no commit.
    const w3 = world()
    assert.equal(tick(M, w3, { pkg: i.checkout }, ['--allow-dev-checkout']).code, 0)
    for (const t of ledgerRecords(w3).filter((r) => r.kind === 'tick')) assert.deepEqual(t.body.build, { commit: 'e'.repeat(40), state_schema_version: 1, daemon_version: '9.9.9', install: 'checkout' })
  },
  { 'the checkout flag is always on': [edit('freshness-runner/cli.js', "allowCheckout: values['allow-dev-checkout'] === true", 'allowCheckout: true')] },
)

proves(
  'an unstamped install is refused before anything is read or written',
  (M) => {
    const w = world()
    const res = tick(M, w, install({ stamp: false }))
    assert.equal(res.code, 2)
    assert.match(res.err, /build-info\.json/)
    assert.equal(fs.existsSync(w.ledgerDir), false)
  },
  { 'the build is not read': [edit('freshness-runner/cli.js', "const build = readBuild(packageRoot, { allowCheckout: values['allow-dev-checkout'] === true })", "const build = { install: 'pinned', commit: null, daemon_version: '0.0.0' }")] },
)

proves(
  'a ledger inside the daemon state directory, or beside the state file, is refused',
  (M) => {
    const i = install()
    const w = world()
    // The daemon's config dir, as the daemon resolves it.
    const configA = path.join(w.root, 'config-a')
    const inConfig = path.join(configA, 'freshness')
    const a = withEnv({ CHROXY_CONFIG_DIR: configA }, () => runMain(M, tickArgs({ ...w, ledgerDir: inConfig }), { packageRoot: i.pkg, now: T0 }))
    assert.equal(a.code, 2, a.err)
    assert.equal(fs.existsSync(inConfig), false)
    // The state file's own directory, when it is not the config dir.
    const w2 = world()
    const elsewhere = path.join(w2.root, 'other-config')
    const b = withEnv({ CHROXY_CONFIG_DIR: elsewhere }, () => runMain(M, tickArgs({ ...w2, ledgerDir: path.join(w2.stateDir, 'led') }), { packageRoot: i.pkg, now: T0 }))
    assert.equal(b.code, 2, b.err)
    assert.equal(fs.existsSync(path.join(w2.stateDir, 'led')), false)
    // Outside both, it runs.
    const w3 = world()
    const c = withEnv({ CHROXY_CONFIG_DIR: path.join(w3.root, 'cfg') }, () => runMain(M, tickArgs(w3), { packageRoot: i.pkg, now: T0 }))
    assert.equal(c.code, 0, c.err)
  },
  {
    "the daemon's config dir is not kept out of": [edit(R, 'keepOutOf: [configDir(), path.dirname(paths.stateFile), ...keepOutOf]', 'keepOutOf: [path.dirname(paths.stateFile), ...keepOutOf]')],
    "the state file's directory is not kept out of": [edit(R, 'keepOutOf: [configDir(), path.dirname(paths.stateFile), ...keepOutOf]', 'keepOutOf: [configDir(), ...keepOutOf]')],
  },
)

proves(
  'a lease that does not exceed the cadence is refused, and an explicit one is used',
  (M) => {
    const i = install()
    const w = world()
    const short = tick(M, w, i, ['--cadence-minutes', '30', '--lease-minutes', '10'])
    assert.equal(short.code, 2)
    assert.match(short.err, /lease/i)
    assert.equal(fs.existsSync(w.ledgerFile), false)
    const equal = tick(M, world(), i, ['--cadence-minutes', '30', '--lease-minutes', '30'])
    assert.equal(equal.code, 2)
    const ok = tick(M, w, i, ['--cadence-minutes', '20', '--lease-minutes', '21'])
    assert.equal(ok.code, 0, ok.err)
    // The cadence is the ledger's cadence.
    for (const t of ledgerRecords(w).filter((r) => r.kind === 'tick')) assert.equal(t.body.cadence_minutes, 20)
  },
  {
    'the lease is dropped': [edit(R, 'leaseMs: leaseMinutes === undefined ? undefined : leaseMinutes * 60_000', 'leaseMs: undefined')],
    'the cadence is the default': [edit(R, 'coreConfig({ cadence_minutes: cadenceMinutes,', 'coreConfig({ cadence_minutes: 30,')],
  },
)

proves(
  'a bad argument is refused with exit 2 and no ledger',
  (M) => {
    const i = install()
    const w = world()
    for (const extra of [['--mode', 'deliver'], ['--cadence-minutes', 'soon'], ['--cadence-minutes', '1e2'], ['--cadence-minutes', '0'], ['--lease-minutes', 'x'], ['--nope']]) {
      const res = tick(M, w, i, extra)
      assert.equal(res.code, 2, extra.join(' '))
      assert.equal(fs.existsSync(w.ledgerDir), false, extra.join(' '))
    }
    assert.equal(runMain(M, ['tick'], { packageRoot: i.pkg }).code, 2, 'no ledger dir')
    assert.equal(runMain(M, ['serve'], { packageRoot: i.pkg }).code, 2)
    assert.equal(runMain(M, [], { packageRoot: i.pkg }).code, 2)
  },
  {
    'any mode is accepted': [edit(R, "if (!MODES.includes(mode)) throw", 'if (false) throw')],
    'a non-number cadence is accepted': [edit('freshness-runner/cli.js', "if (!/^[0-9]+(\\.[0-9]+)?$/.test(v)) throw", 'if (false) throw')],
    'a zero cadence is accepted': [edit(R, 'if (!Number.isFinite(cadenceMinutes) || cadenceMinutes <= 0) throw', 'if (false) throw')],
  },
)

proves(
  'run as a script it executes: no arguments print the usage and exit 2, never exit 0 silently',
  (M) => {
    const cli = path.join(M.SRC_ROOT, 'freshness-runner', 'cli.js')
    const none = spawnSync(process.execPath, [cli], { encoding: 'utf8' })
    assert.equal(none.status, 2, none.stderr)
    assert.match(none.stderr, /usage: freshness tick/)
    // From a development checkout the tick is refused, and says why, before any read.
    const w = world()
    const checkout = spawnSync(process.execPath, [cli, ...tickArgs(w)], { encoding: 'utf8' })
    assert.equal(checkout.status, 2, checkout.stderr)
    assert.equal(fs.existsSync(w.ledgerDir), false)
  },
  { 'the entry guard never fires': [edit('freshness-runner/cli.js', 'if (isEntryPoint(import.meta.url)) {', 'if (false) {')] },
)
