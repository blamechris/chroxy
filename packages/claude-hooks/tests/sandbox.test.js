/**
 * Write-sandbox coverage for @chroxy/claude-hooks (#7268).
 *
 * This package's `tests/_setup.mjs` is the sibling of the server's. Until
 * #7267/#7268 the two were separate hand-written patch lists that had drifted
 * in both directions, and this one was the narrower: it patched `writeFileSync`,
 * `mkdirSync`, `renameSync`, `rmSync`, `unlinkSync`, `createWriteStream` and
 * `promises.writeFile`, and nothing else.
 *
 * `openSync` was the load-bearing omission. `installer.js` writes settings
 * atomically as `mkdirSync -> openSync -> writeSync -> fsyncSync -> chmodSync
 * -> renameSync`, and only the first and last of those were guarded — so a
 * partial write that never reached the rename went to the real `~/.claude`
 * unopposed. `chmodSync` was missing too, on a file the installer deliberately
 * mode-preserves.
 *
 * The errors were the second half of the bug: a plain `Error` whose MESSAGE
 * began `CHROXY_TEST_SANDBOX:`, with no `code`. Any caller matching on
 * `err.code` — including a probe written against the server's convention —
 * read a FIRED guard as an unrelated failure, which cost a false reading during
 * the #7266 review.
 *
 * Both halves are fixed by there being one implementation
 * (`scripts/lib/test-fs-sandbox.mjs`), so the assertions here are mostly about
 * proving THIS package installed it and that its own code cannot slip past.
 *
 * Deliberate asymmetry with the server suite: there is no import-graph walk
 * here. The server's `setup-sandbox-binding-forms.test.js` walks the shared
 * module — the file both packages depend on — and the only residual is this
 * package's own `_setup.mjs`, whose behavioural probes below go red instantly
 * if an ESM `node:fs` import is reintroduced. Reaching the server's comment
 * stripper from this package would couple two packages' test trees to save an
 * error message, so it is not done; the probe failure message names the cause
 * instead.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert'

import * as fsNamespace from 'node:fs'
import * as fspNamespace from 'node:fs/promises'
import { readFileSync as namedReadFileSync, existsSync as namedExistsSync, rmSync as namedRmSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SANDBOX_INSTALLED, SANDBOX_SKIPPED } from './_setup.mjs'
import {
  FS_EXEMPTIONS,
  SANDBOX_ERROR_CODE,
  SANDBOX_MARKER,
  guardedMethodNames,
} from '../../../scripts/lib/test-fs-sandbox.mjs'
import { probePlans, runProbe, GUARDED, REACHED_REAL_FS } from '../../../scripts/lib/test-fs-sandbox-probes.mjs'
import { installHooks } from '../src/installer.js'

// `_setup.mjs` relocates HOME to a throwaway dir, so `homedir()` here is the
// SANDBOX home, not the developer's. The guard locks onto the REAL one, which
// has to be recovered a way that survives layer 1: `os.userInfo()` reads the
// passwd entry (SID on Windows) and ignores $HOME, so it still points at the
// home the guard is defending. Aiming a probe at `homedir()` instead would
// target the temp dir and every assertion below would pass for free.
const PASSWD_HOME = userInfo().homedir

const PROBE_ROOT = join(PASSWD_HOME, '.chroxy', `__chroxy-hooks-sandbox-${process.pid}`)
const protectedPath = join(PROBE_ROOT, 'd', 'probe.tmp')
const spare = join(tmpdir(), `chroxy-hooks-sandbox-${process.pid}`, 'spare.tmp')
const absentSource = join(tmpdir(), `chroxy-hooks-sandbox-absent-${process.pid}`)

function removeProbeRoot () {
  const prev = process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES
  process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES = '1'
  try { namedRmSync(PROBE_ROOT, { recursive: true, force: true }) } finally {
    if (prev === undefined) delete process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES
    else process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES = prev
  }
}

after(() => {
  removeProbeRoot()
  namedRmSync(join(tmpdir(), `chroxy-hooks-sandbox-${process.pid}`), { recursive: true, force: true })
})

describe('claude-hooks write sandbox: the real home is refused (#7268)', () => {
  test('layer 1 relocated HOME, and the guard still points at the REAL home', () => {
    assert.notStrictEqual(
      homedir(), PASSWD_HOME,
      'tests/_setup.mjs must relocate HOME; without layer 1 the default-path code ' +
      'under test resolves straight into the developer\'s real ~/.claude.',
    )
    assert.ok(PROBE_ROOT.startsWith(PASSWD_HOME), 'the probe must aim at the real home, or it proves nothing')
  })

  for (const plan of probePlans({ protectedPath, spare, absentSource })) {
    test(`${plan.label} is guarded`, async () => {
      const verdict = await runProbe(plan, {
        fs: fsNamespace,
        promises: fspNamespace,
        cleanup: removeProbeRoot,
      })
      assert.strictEqual(
        verdict, GUARDED,
        `${plan.label} reached the real filesystem. If EVERY probe in this file ` +
        `failed at once, something in tests/_setup.mjs is ESM-importing 'node:fs' ` +
        `again — that snapshots the unpatched exports before the body runs and ` +
        `disarms the guard for named and namespace consumers (#7262).`,
      )
    })
  }
})

describe('claude-hooks write sandbox: the error shape matches the server (#7268)', () => {
  test('the guard error carries code CHROXY_TEST_SANDBOX, not just a message prefix', () => {
    let caught = null
    try { fsNamespace.writeFileSync(protectedPath, 'probe') } catch (err) { caught = err }
    assert.ok(caught, 'the guard did not fire at all')
    assert.strictEqual(
      caught.code, SANDBOX_ERROR_CODE,
      'This guard used to throw a bare Error with the token only in its message, so ' +
      'a caller matching on `err.code` classified a FIRED guard as an unrelated ' +
      'failure (#7268). The code is the contract; the message is for humans.',
    )
    assert.match(caught.message, /CHROXY_TEST_SANDBOX/, 'the human-readable token is still expected in the message')
  })

  test('the same guard is installed here as in the server package', () => {
    const { sync, callback, promises } = guardedMethodNames()
    const expected = [...sync, ...callback.map((m) => `${m} (callback)`), ...promises.map((m) => `promises.${m}`)]
    const missing = expected.filter((m) => !SANDBOX_INSTALLED.includes(m))
    assert.deepStrictEqual(
      missing, [],
      'This package installs fewer guards than the shared module defines. The two ' +
      'sandboxes drifted apart once (#7268) and converged on one list precisely so ' +
      'this cannot happen silently again.',
    )
    for (const { reason } of SANDBOX_SKIPPED) {
      assert.strictEqual(reason, 'absent', 'the only legitimate reason to skip is that the platform lacks the method')
    }
  })

  test('the live fs objects carry exactly the guards that were reported installed', () => {
    const marked = []
    for (const host of [fsNamespace, fspNamespace]) {
      for (const key of Object.keys(host)) {
        const fn = host[key]
        if (typeof fn === 'function' && fn[SANDBOX_MARKER]) marked.push(fn[SANDBOX_MARKER])
      }
    }
    assert.deepStrictEqual(marked.sort(), [...SANDBOX_INSTALLED].sort())
  })
})

describe('claude-hooks write sandbox: installer.js cannot reach the real ~/.claude (#7268)', () => {
  // `writeSettingsAtomic` is `mkdirSync -> openSync -> writeSync -> fsyncSync ->
  // chmodSync -> renameSync`. Before #7268 only `mkdirSync` and `renameSync`
  // were guarded here, so the OPEN — the step that actually creates the temp
  // file — was unopposed.
  test('installHooks against the real settings path is blocked', () => {
    const realSettings = join(PASSWD_HOME, '.claude', 'settings.json')
    let caught = null
    try { installHooks({ settingsPath: realSettings }) } catch (err) { caught = err }
    assert.ok(caught, 'installHooks wrote to the developer\'s real ~/.claude/settings.json')
    assert.strictEqual(caught.code, SANDBOX_ERROR_CODE, `blocked for the wrong reason: ${caught.message}`)
  })

  test('the temp file the atomic write opens is itself protected', () => {
    // The temp path is a SIBLING of the resolved settings path
    // (`<settings>.chroxy-hooks-<pid>.tmp`), so it lands under ~/.claude too.
    // Proven by calling the exact step that opens it rather than by asserting
    // the filename shape, which would be a copy of installer.js's format string
    // living in a test — a hardcoded list beside a thing that changes.
    const sibling = join(PASSWD_HOME, '.claude', `settings.json.chroxy-hooks-${process.pid}.tmp`)
    let caught = null
    try { fsNamespace.openSync(sibling, 'w') } catch (err) { caught = err }
    assert.ok(caught && caught.code === SANDBOX_ERROR_CODE, 'openSync on the atomic-write temp path was not guarded')
  })

  test('every node:fs function this package imports is guarded or exempt with a reason', () => {
    // The drift-proof half: rather than naming installer.js's four write steps
    // (a list beside a set that grows), read what the source ACTUALLY imports
    // and require every one of them to be classified. A new `unlinkSync` in
    // emit.js is then covered the day it is written.
    //
    // The scan runs on raw source, so an `import { … } from 'node:fs'` quoted
    // inside a comment would be counted. That direction is safe: it can only
    // over-report and fail loudly, never under-report and pass.
    const { sync, callback } = guardedMethodNames()
    const guarded = new Set([...sync, ...callback])
    const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
    const unclassified = []
    let importsSeen = 0
    for (const file of fsNamespace.readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
      const source = namedReadFileSync(join(srcDir, file), 'utf8')
      // Multi-line import blocks included on purpose: a line-anchored pattern
      // undercounts them, which is how #7266's own module count came out 41
      // instead of 45.
      for (const m of source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"](?:node:)?fs['"]/g)) {
        for (const raw of m[1].split(',')) {
          const name = raw.trim().split(/\s+as\s+/)[0].trim()
          if (!name) continue
          importsSeen++
          if (!guarded.has(name) && !(name in FS_EXEMPTIONS)) unclassified.push(`${file}: ${name}`)
        }
      }
    }
    assert.ok(importsSeen > 0, 'the scan found no node:fs imports at all, so it proved nothing about this package')
    assert.deepStrictEqual(
      unclassified, [],
      'These fs functions are used by claude-hooks but the sandbox neither guards ' +
      'nor exempts them. Classify each in scripts/lib/test-fs-sandbox.mjs.',
    )
  })
})

describe('claude-hooks write sandbox: controls (#7268)', () => {
  test('an UNPROTECTED missing-parent path reaches the real fs (ENOENT)', async () => {
    const control = probePlans({
      protectedPath: join(tmpdir(), `chroxy-hooks-control-${process.pid}`, 'probe.tmp'),
      spare,
      absentSource,
    })
    for (const label of ['writeFileSync', 'unlink (callback)', 'promises.rm']) {
      const plan = control.find((p) => p.label === label)
      assert.strictEqual(
        await runProbe(plan, { fs: fsNamespace, promises: fspNamespace }),
        REACHED_REAL_FS,
        `The control (${label}) did not reach the real fs, so ENOENT is not a valid ` +
        `signature for "bypassed" and every assertion above proves nothing.`,
      )
    }
  })

  test('the sandbox HOME is writable — the guard discriminates by path', () => {
    const file = join(homedir(), '.claude', 'settings.json')
    fsNamespace.mkdirSync(join(homedir(), '.claude'), { recursive: true })
    fsNamespace.writeFileSync(file, '{}')
    assert.strictEqual(namedReadFileSync(file, 'utf8'), '{}')
    // Same relative path, real home: refused.
    assert.throws(
      () => fsNamespace.writeFileSync(join(PASSWD_HOME, '.claude', 'settings.json'), '{}'),
      (err) => err.code === SANDBOX_ERROR_CODE,
    )
  })

  test('installHooks into the sandbox HOME still works end to end', () => {
    const settingsPath = join(homedir(), '.claude', 'install-probe.json')
    assert.strictEqual(installHooks({ settingsPath }), settingsPath)
    const written = JSON.parse(namedReadFileSync(settingsPath, 'utf8'))
    assert.ok(written.hooks, 'installHooks wrote no hooks — the guard may be blocking legitimate writes')
  })
})

describe('claude-hooks write sandbox: the probes created nothing under the real home (#7268)', () => {
  test('no probe root exists under the real ~/.chroxy', () => {
    const leaked = namedExistsSync(PROBE_ROOT)
    if (leaked) removeProbeRoot()
    assert.strictEqual(leaked, false, `A probe created real state at ${PROBE_ROOT}.`)
  })
})
