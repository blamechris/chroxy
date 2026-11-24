/**
 * The runner's build facts: the commit stamped into an installed package, the
 * installed package's version and the state file's schema version, all read
 * from disk; a development checkout and an unstamped install are refused. Each
 * guard has a mutant (an edit to a copy of `src`) that must fail its check.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { cleanupTmp } from '../freshness-core/helpers/harness.js'
import { COMMIT, REAL_RUNNER, cleanupVariants, install, must, mustKillRunner, tmp } from './helpers/runner-harness.js'

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
const B = 'freshness-runner/build-info.js'
const S = 'freshness-runner/stamp.js'
const codeOf = (fn) => {
  try {
    fn()
  } catch (e) {
    return e?.code ?? `threw ${e?.name}`
  }
  return 'no error'
}

proves(
  'a pinned install reports its commit and its daemon version as read from disk',
  (M) => {
    const i = install({ version: '0.11.10' })
    assert.deepEqual(must(() => M.readBuild(i.pkg)), { install: 'pinned', commit: COMMIT, daemon_version: '0.11.10' })
    // Read again after the files change: nothing is cached.
    fs.writeFileSync(path.join(i.pkg, 'package.json'), JSON.stringify({ name: '@chroxy/server', version: '0.12.0-rc.1' }))
    fs.writeFileSync(path.join(i.pkg, 'build-info.json'), JSON.stringify({ commit: 'f'.repeat(40) }))
    assert.deepEqual(must(() => M.readBuild(i.pkg)), { install: 'pinned', commit: 'f'.repeat(40), daemon_version: '0.12.0-rc.1' })
  },
  {
    'the version is a constant': [edit(B, 'daemon_version: pkg.version }', "daemon_version: '0.11.10' }")],
    'the commit comes from the package version': [edit(B, 'commit = info.commit', 'commit = pkg.version')],
  },
)

proves(
  'a development checkout is refused unless allowed, and then carries no commit',
  (M) => {
    const i = install({ stamp: false })
    assert.equal(codeOf(() => M.readBuild(i.checkout)), 'development_checkout')
    assert.deepEqual(must(() => M.readBuild(i.checkout, { allowCheckout: true })), { install: 'checkout', commit: null, daemon_version: '0.11.10' })
  },
  {
    'a checkout is accepted': [edit(B, "if (install === 'checkout' && !allowCheckout) {", 'if (false) {')],
    'a checkout is told from an install by its name': [edit(B, "real.split(path.sep).includes('node_modules') ? 'pinned' : 'checkout'", "'pinned'")],
  },
)

proves(
  'an install that is not stamped, or whose stamp is not a full commit, is refused',
  (M) => {
    assert.equal(codeOf(() => M.readBuild(install({ stamp: false }).pkg)), 'unstamped')
    for (const bad of ['abc1234', 'G'.repeat(40), 'A'.repeat(40), `${COMMIT}0`, 5, null]) {
      const i = install({ stamp: bad })
      assert.equal(codeOf(() => M.readBuild(i.pkg)), 'bad_stamp', String(bad))
    }
    const garbled = install({ stamp: false })
    fs.writeFileSync(path.join(garbled.pkg, 'build-info.json'), '{ nope')
    assert.equal(codeOf(() => M.readBuild(garbled.pkg)), 'build_unreadable')
  },
  {
    'an unstamped install runs': [edit(B, "} else if (install === 'pinned') {", '} else if (false) {')],
    'a short commit is accepted': [edit(B, '/^[0-9a-f]{40}$/', '/^[0-9a-f]{4,40}$/')],
    'an upper-case commit is accepted': [edit(B, '/^[0-9a-f]{40}$/', '/^[0-9a-fA-F]{40}$/')],
    'a damaged stamp reads as none': [edit(B, "throw new BuildError('build_unreadable', `${what} is not a JSON object`)", 'return null')],
  },
)

proves(
  'only the daemon package, with a version, is accepted',
  (M) => {
    assert.equal(codeOf(() => M.readBuild(install({ name: '@chroxy/other' }).pkg)), 'not_daemon_package')
    assert.equal(codeOf(() => M.readBuild(install({ version: 'latest' }).pkg)), 'bad_version')
    assert.equal(codeOf(() => M.readBuild(path.join(tmp(), 'nothing'))), 'not_daemon_package')
  },
  {
    'any package is accepted': [edit(B, 'pkg.name !== DAEMON_PACKAGE_NAME', 'false')],
    'any version string is accepted': [edit(B, "typeof pkg.version !== 'string' || !VERSION_RE.test(pkg.version)", 'false')],
  },
)

proves(
  'a link from node_modules to a checkout is a checkout',
  (M) => {
    if (process.platform === 'win32') return
    const i = install({ stamp: COMMIT })
    fs.writeFileSync(path.join(i.checkout, 'build-info.json'), JSON.stringify({ commit: COMMIT }))
    const linked = path.join(i.root, 'linked', 'node_modules', '@chroxy', 'server')
    fs.mkdirSync(path.dirname(linked), { recursive: true })
    fs.symlinkSync(i.checkout, linked, 'dir')
    assert.equal(codeOf(() => M.readBuild(linked)), 'development_checkout')
  },
  { 'the link is not resolved': [edit(B, 'const real = fs.realpathSync(packageRoot)', 'const real = packageRoot')] },
)

proves(
  'the state file schema version is its version integer, or null',
  (M) => {
    const f = path.join(tmp(), 'session-state.json')
    const at = (text) => {
      fs.writeFileSync(f, text)
      return M.readStateSchemaVersion(f)
    }
    assert.equal(at('{"version":1,"sessions":[]}'), 1)
    assert.equal(at('{"version":7}'), 7)
    for (const bad of ['{"version":"1"}', '{"version":1.5}', '{"sessions":[]}', '[1]', 'null', '{ nope']) assert.equal(at(bad), null, bad)
    assert.equal(M.readStateSchemaVersion(path.join(tmp(), 'missing.json')), null)
  },
  {
    'a string version is accepted': [edit(B, 'Number.isSafeInteger(doc.version) ? doc.version : null', "doc.version !== undefined ? doc.version : null")],
    'the version is a constant': [edit(B, 'Number.isSafeInteger(doc.version) ? doc.version : null', '1')],
  },
)

proves(
  'a stamp is written only to an installed daemon package, for a full commit',
  (M) => {
    const i = install({ stamp: false })
    must(() => M.stampBuild(i.pkg, COMMIT))
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(i.pkg, 'build-info.json'), 'utf8')), { commit: COMMIT })
    assert.deepEqual(must(() => M.readBuild(i.pkg)), { install: 'pinned', commit: COMMIT, daemon_version: '0.11.10' })
    assert.equal(codeOf(() => M.stampBuild(i.pkg, 'abc')), 'bad_commit')
    assert.equal(codeOf(() => M.stampBuild(i.checkout, COMMIT)), 'development_checkout')
    assert.equal(fs.existsSync(path.join(i.checkout, 'build-info.json')), false)
    assert.equal(codeOf(() => M.stampBuild(install({ name: 'x' }).pkg, COMMIT)), 'not_daemon_package')
  },
  {
    'a checkout is stamped': [edit(S, "if (installKind(packageRoot) !== 'pinned') throw", 'if (false) throw')],
    'any commit is stamped': [edit(S, 'if (!isCommit(commit)) throw', 'if (false) throw')],
    'any package is stamped': [edit(S, 'if (pkg?.name !== DAEMON_PACKAGE_NAME) throw', 'if (false) throw')],
  },
)
