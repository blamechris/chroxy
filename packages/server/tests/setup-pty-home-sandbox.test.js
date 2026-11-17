/**
 * node-pty HOME sandbox for the server test suite (#7949).
 *
 * `setup-spawn-home-sandbox.test.js` proves a `child_process` child cannot
 * inherit the developer's real home. node-pty's `spawn` is a separate native
 * path, so this proves the same for a REAL pty child, loaded exactly the way
 * `claude-tui-session.js` / `user-shell-session.js` load it
 * (`await import('node-pty')`), plus the other import shapes.
 *
 * Skipped, with the reason printed, only where node-pty's native addon cannot
 * load (e.g. Docker `npm ci --ignore-scripts`). The skip is decided by actually
 * loading it, never by assuming.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import ptyDefault from 'node-pty'

import { PTY_HOME_SANDBOX, SPAWN_HOME_REAL, SPAWN_HOME_ISOLATED } from './_setup.mjs'
import { PTY_HOME_MARKER, PTY_LAUNCHERS } from '../../../scripts/lib/test-pty-home-sandbox.mjs'

const require = createRequire(import.meta.url)

let nativeSkip = false
let ptyNs = null
try {
  ptyNs = await import('node-pty')
  // Loading the JS wrapper is not enough: the addon loads on first spawn.
  const probe = ptyNs.spawn(process.execPath, ['-e', ''], { env: { ...process.env } })
  await new Promise((resolve) => { probe.onExit(resolve) })
} catch (err) {
  nativeSkip = `node-pty native addon unavailable here: ${err && err.message}`
}
const opts = nativeSkip ? { skip: nativeSkip } : {}

const REPORT = "console.log('HOME=' + process.env.HOME + '|UP=' + process.env.USERPROFILE + '|HD=' + require('os').homedir())"

function runPty(pty, spawnOpts) {
  return new Promise((resolve, reject) => {
    let out = ''
    const t = pty.spawn(process.execPath, ['-e', REPORT], { cols: 200, rows: 24, ...spawnOpts })
    const timer = setTimeout(() => { try { t.kill() } catch {} reject(new Error('pty child timed out')) }, 15000)
    t.onData((d) => { out += d })
    t.onExit(() => {
      clearTimeout(timer)
      const m = /HOME=(.*?)\|UP=(.*?)\|HD=(.*)/.exec(out)
      if (!m) return reject(new Error(`no report in pty output: ${JSON.stringify(out.slice(0, 200))}`))
      resolve({ home: m[1].trim(), userProfile: m[2].trim(), homedir: m[3].trim() })
    })
  })
}

describe('node-pty sandbox: a real pty child does not see the real home (#7949)', () => {
  it('is armed (the _load hook patched node-pty when it was first loaded)', opts, () => {
    for (const name of PTY_LAUNCHERS) {
      assert.ok(ptyNs[name][PTY_HOME_MARKER], `node-pty ${name} was not patched`)
    }
    assert.ok(PTY_HOME_SANDBOX.patched().includes('spawn'))
  })

  it('dynamic import() shape (what src/ uses): explicit real-home env is redirected', opts, async () => {
    const r = await runPty(ptyNs, { env: { ...process.env, HOME: SPAWN_HOME_REAL, USERPROFILE: SPAWN_HOME_REAL } })
    assert.notEqual(r.homedir, SPAWN_HOME_REAL, 'pty child saw the developer\'s REAL home')
    assert.equal(r.home, SPAWN_HOME_ISOLATED)
    assert.equal(r.userProfile, SPAWN_HOME_ISOLATED)
  })

  it('no env option at all (inherits process.env) is redirected', opts, async () => {
    const r = await runPty(ptyNs, {})
    assert.equal(r.home, SPAWN_HOME_ISOLATED)
    assert.equal(r.userProfile, SPAWN_HOME_ISOLATED)
    assert.notEqual(r.homedir, SPAWN_HOME_REAL)
  })

  it('static default import shape is redirected', opts, async () => {
    const r = await runPty(ptyDefault, { env: { ...process.env } })
    assert.equal(r.home, SPAWN_HOME_ISOLATED)
  })

  it('createRequire shape is redirected', opts, async () => {
    const r = await runPty(require('node-pty'), { env: { ...process.env } })
    assert.equal(r.home, SPAWN_HOME_ISOLATED)
  })

  it('an env the caller already isolated is respected, not clobbered', opts, async () => {
    const mine = SPAWN_HOME_ISOLATED + '-mine'
    const r = await runPty(ptyNs, { env: { ...process.env, HOME: mine, USERPROFILE: mine } })
    assert.equal(r.home, mine)
  })

  it('sanity: the real home is not the isolated one', () => {
    assert.equal(SPAWN_HOME_REAL, homedir())
    assert.notEqual(SPAWN_HOME_ISOLATED, SPAWN_HOME_REAL)
  })
})
