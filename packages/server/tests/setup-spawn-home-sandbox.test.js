/**
 * Spawn-home sandbox for the server test suite (#7269).
 *
 * The in-process fs write sandbox (`test-fs-sandbox.mjs`, #4633/#7267) stops at
 * the process boundary: it monkey-patches `node:fs` in THIS process, so it can
 * see this process's own reads/writes but is structurally blind to what a
 * SPAWNED child does once it starts running. `cli-session-spawn-admission.test.js`,
 * `codex-session.test.js`, several `lint-*.test.js` files and others spawn a real
 * OS process (often `process.execPath` standing in for the provider binary) —
 * and until this file existed, that child inherited the developer's REAL
 * `HOME` and could write to the developer's actual `~/.claude`/`~/.gemini`/
 * `~/.codex` the moment it started up, entirely outside the fs guard's reach.
 * This is the same #4633 harm arriving by a route the fs sandbox cannot cover
 * (issue #7269 provenance: adversarial review of #7266).
 *
 * `_setup.mjs` deliberately does NOT override `process.env.HOME` for the test
 * PROCESS itself (see its header, and the #7269 issue body's own "Suggested
 * fix" section) — several existing tests pass real `homedir()`/`process.env.HOME`
 * to validation helpers that compare against the live `os.homedir()`
 * (`spawn-env.test.js`, `codex-session-env.test.js`, `gemini-session-env.test.js`
 * all assert `env.HOME` against a value THEY set via `withEnv`/`process.env.HOME`
 * directly on the pure `buildSpawnEnv`/`_buildChildEnv` helpers, never through a
 * real spawn). So this sandbox works at a different layer entirely: it patches
 * `node:child_process`'s launcher functions so that whenever a call is about to
 * hand a REAL child the developer's real home, the env actually passed to the
 * OS is redirected to an isolated per-process temp dir instead — for that one
 * child, without ever touching `process.env.HOME` in this process. See
 * `scripts/lib/test-spawn-home-sandbox.mjs` for the full design note.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFile, execFileSync, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SPAWN_HOME_INSTALLED,
  SPAWN_HOME_SKIPPED,
  SPAWN_HOME_REAL,
  SPAWN_HOME_ISOLATED,
} from './_setup.mjs'
import {
  SPAWN_LAUNCHERS,
  SPAWN_EXEMPTIONS,
  SPAWN_HOME_MARKER,
} from '../../../scripts/lib/test-spawn-home-sandbox.mjs'

const execFileAsync = promisify(execFile)

// A tiny script, printed back via stdout, that reports how a child sees its
// own home. Every field is checked so a fix that redirects HOME but leaves
// USERPROFILE (or vice versa) untouched is still caught on whichever platform
// actually reads that variable.
const REPORT_HOME_SCRIPT =
  "console.log(JSON.stringify({home: require('os').homedir(), envHome: process.env.HOME, " +
  'envUserProfile: process.env.USERPROFILE, envClaudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null}))'

function parseReport(stdout) {
  const line = stdout.toString('utf8').trim().split('\n').pop()
  return JSON.parse(line)
}

describe('spawn-home sandbox: a spawned child does not see the real home (#7269)', () => {
  it('is armed for this process (sanity: _setup.mjs actually installed it)', () => {
    assert.ok(
      SPAWN_HOME_INSTALLED.length > 0,
      'No child_process launcher was patched — the sandbox from #7269 is not installed.',
    )
  })

  it('records the real home distinctly from the isolated one', () => {
    assert.equal(SPAWN_HOME_REAL, homedir())
    assert.notEqual(SPAWN_HOME_ISOLATED, SPAWN_HOME_REAL)
  })

  it('a child spawned via spawn() sees an isolated HOME, not the real one', async () => {
    const child = spawn(process.execPath, ['-e', REPORT_HOME_SCRIPT])
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    const [code] = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (c) => resolve([c]))
    })
    assert.equal(code, 0)
    const report = parseReport(stdout)
    assert.notEqual(
      report.home, SPAWN_HOME_REAL,
      `A spawned child reported os.homedir() === the developer's REAL home (${SPAWN_HOME_REAL}). ` +
      'A real provider binary spawned this way could write into the developer\'s ~/.claude or ~/.gemini (#7269).',
    )
    assert.equal(report.envHome, SPAWN_HOME_ISOLATED)
    assert.equal(
      report.envUserProfile, SPAWN_HOME_ISOLATED,
      'USERPROFILE must be redirected too — it is what os.homedir() reads on win32, ' +
      'where Server Windows Tests (a required check) runs this same suite.',
    )
    assert.ok(
      report.home.startsWith(tmpdir()) || report.home === SPAWN_HOME_ISOLATED,
      `Expected the child's homedir() to resolve under the isolated tmp dir, got ${report.home}`,
    )
  })

  it('a child spawned via spawnSync() sees an isolated HOME', () => {
    const result = spawnSync(process.execPath, ['-e', REPORT_HOME_SCRIPT])
    assert.equal(result.status, 0, result.stderr?.toString())
    const report = parseReport(result.stdout)
    assert.notEqual(report.home, SPAWN_HOME_REAL)
    assert.equal(report.envHome, SPAWN_HOME_ISOLATED)
  })

  it('a child spawned via execFile() sees an isolated HOME', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['-e', REPORT_HOME_SCRIPT])
    const report = parseReport(stdout)
    assert.notEqual(report.home, SPAWN_HOME_REAL)
    assert.equal(report.envHome, SPAWN_HOME_ISOLATED)
  })

  it('a child spawned via execFileSync() sees an isolated HOME', () => {
    const stdout = execFileSync(process.execPath, ['-e', REPORT_HOME_SCRIPT])
    const report = parseReport(stdout)
    assert.notEqual(report.home, SPAWN_HOME_REAL)
    assert.equal(report.envHome, SPAWN_HOME_ISOLATED)
  })

  describe('fork()', () => {
    let fixtureDir
    let fixtureScript

    before(() => {
      fixtureDir = mkdtempSync(join(tmpdir(), 'chroxy-spawn-home-fork-fixture-'))
      fixtureScript = join(fixtureDir, 'report-home.mjs')
      writeFileSync(
        fixtureScript,
        "import { homedir } from 'node:os'\n" +
        "process.send({home: homedir(), envHome: process.env.HOME})\n",
      )
    })

    after(() => {
      rmSync(fixtureDir, { recursive: true, force: true })
    })

    it('a child forked via fork() sees an isolated HOME', async () => {
      const child = fork(fixtureScript, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      const message = await new Promise((resolve, reject) => {
        child.on('message', resolve)
        child.on('error', reject)
        child.on('exit', (code) => {
          if (code !== 0) reject(new Error(`fork fixture exited ${code}`))
        })
      })
      child.kill()
      assert.notEqual(message.home, SPAWN_HOME_REAL)
      assert.equal(message.envHome, SPAWN_HOME_ISOLATED)
    })
  })

  it('strips an operator-exported CLAUDE_CONFIG_DIR from the redirected child too', async () => {
    const child = spawn(process.execPath, ['-e', REPORT_HOME_SCRIPT], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(SPAWN_HOME_REAL, '.claude') },
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    const report = parseReport(stdout)
    assert.equal(
      report.envClaudeConfigDir, null,
      'An operator-exported CLAUDE_CONFIG_DIR pointing at the real ~/.claude must be scrubbed ' +
      'when the child\'s HOME is redirected, or it bypasses the HOME-based isolation entirely.',
    )
  })

  it('does NOT override an env the caller already isolated on purpose', () => {
    const customHome = mkdtempSync(join(tmpdir(), 'chroxy-spawn-home-custom-'))
    try {
      const result = spawnSync(process.execPath, ['-e', REPORT_HOME_SCRIPT], {
        env: { ...process.env, HOME: customHome },
      })
      const report = parseReport(result.stdout)
      assert.equal(
        report.envHome, customHome,
        'A caller-specified custom HOME (e.g. a provider-auth test isolating its own ' +
        'creds fixture) must be respected, not clobbered by this sandbox.',
      )
    } finally {
      rmSync(customHome, { recursive: true, force: true })
    }
  })

  it('the escape hatch (CHROXY_TEST_ALLOW_REAL_HOME_WRITES=1) disables the redirect', () => {
    const prev = process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES
    process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES = '1'
    try {
      const result = spawnSync(process.execPath, ['-e', REPORT_HOME_SCRIPT])
      const report = parseReport(result.stdout)
      // Checked via the child's own os.homedir() reading, not the raw envHome
      // key directly: on win32 the AMBIENT process.env may carry USERPROFILE
      // but not HOME at all, so a child that inherited the untouched parent
      // env (this is the escape-hatch, no-override path) can legitimately
      // report envHome === undefined there. os.homedir() reads whichever
      // variable the platform actually uses, so it is the portable check.
      assert.equal(report.home, SPAWN_HOME_REAL)
    } finally {
      if (prev === undefined) delete process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES
      else process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES = prev
    }
  })

  it('never touches process.env.HOME in THIS process (the in-process guard still targets the real home)', () => {
    // The #7269 issue's own "Suggested fix" section warns that a process-wide
    // HOME override breaks tests that compare against the live os.homedir() —
    // and _setup.mjs's header says the same. This sandbox works at the
    // child_process boundary instead, so the variable THIS platform's
    // os.homedir() actually reads (HOME on POSIX, USERPROFILE on win32) must
    // be exactly what it always was.
    const homeVar = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
    assert.equal(process.env[homeVar], SPAWN_HOME_REAL)
    assert.equal(homedir(), SPAWN_HOME_REAL)
  })

  it('POSITIVE CONTROL: an in-process write to the real ~/.claude still throws CHROXY_TEST_SANDBOX', () => {
    // Proves the fs sandbox still guards the REAL tree and was not silently
    // repointed at the isolated dir by this change (the #7269 issue's own
    // warning about capture order).
    const probe = join(homedir(), '.claude', `__chroxy-spawn-home-sandbox-probe-${process.pid}.tmp`)
    assert.throws(
      () => writeFileSync(probe, 'x'),
      (err) => err.code === 'CHROXY_TEST_SANDBOX',
      'The in-process fs write sandbox no longer guards the real ~/.claude — it may have been ' +
      'repointed at the isolated home instead of the real one.',
    )
  })
})

describe('spawn-home sandbox: category coverage (#7269)', () => {
  it('every function-valued export of node:child_process is either a guarded launcher or exempt with a reason', async () => {
    const cp = await import('node:child_process')
    const guarded = new Set(SPAWN_LAUNCHERS)
    const unclassified = Object.keys(cp)
      .filter((k) => typeof cp[k] === 'function')
      .filter((k) => !guarded.has(k) && !(k in SPAWN_EXEMPTIONS))
    assert.deepEqual(
      unclassified, [],
      'This Node build exposes a child_process launcher this sandbox neither guards nor ' +
      'exempts. Classify it in scripts/lib/test-spawn-home-sandbox.mjs.',
    )
  })

  it('every guarded launcher actually carries the sandbox marker on the live module', async () => {
    const cp = await import('node:child_process')
    const marked = Object.keys(cp).filter((k) => typeof cp[k] === 'function' && cp[k][SPAWN_HOME_MARKER])
    assert.deepEqual(marked.sort(), [...SPAWN_HOME_INSTALLED].sort())
  })

  it('nothing was skipped for a reason other than "absent" or "already-guarded"', () => {
    for (const { name, reason } of SPAWN_HOME_SKIPPED) {
      assert.ok(
        reason === 'absent' || reason === 'already-guarded',
        `${name} was skipped for an unexpected reason: ${reason}`,
      )
    }
  })
})
