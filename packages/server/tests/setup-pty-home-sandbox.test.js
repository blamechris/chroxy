/**
 * node-pty HOME sandbox for the server test suite (#7949).
 *
 * `setup-spawn-home-sandbox.test.js` proves a `child_process` child cannot
 * inherit the developer's real home. node-pty's `spawn` is a separate native
 * path, so this proves the same for a REAL pty child, loaded exactly the way
 * `claude-tui-session.js` / `user-shell-session.js` load it
 * (`await import('node-pty')`), plus the other import shapes.
 *
 * Not run on Windows: `WINDOWS_EXEMPT` (node-pty / ConPTY). The install-time
 * hook itself stays active there for every other test.
 *
 * Skipped, with the reason printed, only where node-pty's native addon cannot
 * load (e.g. Docker `npm ci --ignore-scripts`). The skip is decided by actually
 * loading it, never by assuming.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import ptyDefault, { spawn as ptyNamedSpawn } from 'node-pty'

import { PTY_HOME_SANDBOX, SPAWN_HOME_REAL, SPAWN_HOME_ISOLATED } from './_setup.mjs'
import { PTY_HOME_MARKER, PTY_LAUNCHERS, NODE_PTY_ENTRY } from '../../../scripts/lib/test-pty-home-sandbox.mjs'

const require = createRequire(import.meta.url)

// Hard bounds (the file once hung a required Windows job to its 20 min kill).
// PTY_CHILD_MS bounds one child; TEST_MS bounds a whole test and must exceed it.
const PTY_CHILD_MS = 10000
const TEST_MS = 20000

// Run `node -e script` under `pty`, resolve with its output once it exits. A
// child that never exits REJECTS after PTY_CHILD_MS, and is always killed
// through the pty's own kill() in `finally`.
class PtyChildTimeout extends Error {}

async function ptyOutput(pty, script, spawnOpts) {
  let term = null
  let timer = null
  const started = Date.now()
  try {
    return await new Promise((resolve, reject) => {
      let out = ''
      term = pty.spawn(process.execPath, ['-e', script], { cols: 200, rows: 24, ...spawnOpts })
      timer = setTimeout(
        () => reject(new PtyChildTimeout(
          `pty child pid ${term.pid} did not exit within ${PTY_CHILD_MS}ms (elapsed ${Date.now() - started}ms) ` +
          `while awaiting its onExit after \`node -e\`; output so far: ${JSON.stringify(out.slice(0, 200))}`,
        )),
        PTY_CHILD_MS,
      )
      term.onData((d) => { out += d })
      term.onExit(() => resolve(out))
    })
  } finally {
    clearTimeout(timer)
    if (term) { try { term.kill() } catch { /* already exited */ } }
  }
}

// Skip ONLY when node-pty's native addon is genuinely unavailable (the import
// or the first spawn throws). A pty child that merely fails to EXIT is a real
// failure, never a skip: it is left unskipped here so each test's own spawn
// times out and fails with the PtyChildTimeout message above.
let nativeSkip = false
let ptyNs = null
try {
  ptyNs = await import('node-pty')
  // Loading the JS wrapper is not enough: the addon loads on first spawn.
  await ptyOutput(ptyNs, '', { env: { ...process.env } })
} catch (err) {
  if (!(err instanceof PtyChildTimeout)) {
    nativeSkip = `node-pty native addon unavailable here: ${err && err.message}`
  }
}
const opts = nativeSkip ? { skip: nativeSkip, timeout: TEST_MS } : { timeout: TEST_MS }

const REPORT = "console.log('HOME=' + process.env.HOME + '|UP=' + process.env.USERPROFILE + '|HD=' + require('os').homedir())"

async function runPty(pty, spawnOpts) {
  const out = await ptyOutput(pty, REPORT, spawnOpts)
  const m = /HOME=(.*?)\|UP=(.*?)\|HD=(.*)/.exec(out)
  if (!m) throw new Error(`no report in pty output: ${JSON.stringify(out.slice(0, 200))}`)
  return { home: m[1].trim(), userProfile: m[2].trim(), homedir: m[3].trim() }
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

  it('static named import shape is redirected', opts, async () => {
    const r = await runPty({ spawn: ptyNamedSpawn }, { env: { ...process.env } })
    assert.equal(r.home, SPAWN_HOME_ISOLATED)
  })

  it('node-pty\'s real entry still matches the pattern the hook relies on', { timeout: TEST_MS }, () => {
    let entry
    try {
      entry = require.resolve('node-pty')
    } catch (err) {
      assert.fail(`node-pty is a server dependency but does not resolve: ${err.message}`)
    }
    assert.ok(NODE_PTY_ENTRY.test(entry), `node-pty entry ${entry} does not match NODE_PTY_ENTRY; the sandbox would patch nothing`)
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
