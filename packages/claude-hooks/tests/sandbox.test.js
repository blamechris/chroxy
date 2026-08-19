/**
 * Write-sandbox coverage for @chroxy/claude-hooks (#7268).
 *
 * This package's `tests/_setup.mjs` is the sibling of the server's. Until
 * #7267/#7268 the two were separate hand-written patch lists that had drifted
 * in both directions, and this one was the narrower: it patched `writeFileSync`,
 * `mkdirSync`, `renameSync`, `rmSync`, `unlinkSync`, `createWriteStream` and
 * `promises.writeFile`, and nothing else.
 *
 * `openSync` and `chmodSync` were missing, but NOT exploitable through
 * `installHooks`, and #7268 was wrong to say they were. `installer.js` writes
 * settings atomically as `mkdirSync -> openSync -> writeSync -> fsyncSync ->
 * chmodSync -> renameSync`, and `mkdirSync` was guarded — so the sequence
 * aborted at step one. Measured against a fake protected home with exactly the
 * old list installed: one guard fired (`mkdirSync`), and no directory, temp
 * file or partial write appeared. That is accidental coverage through a
 * neighbour, the same shape as `truncateSync` being covered only via
 * `openSync`; it is why the tests below assert each step is guarded ON ITS OWN
 * rather than asserting that `installHooks` throws and calling it proven.
 *
 * The error shape is the half that had already cost something: a plain `Error`
 * whose MESSAGE began `CHROXY_TEST_SANDBOX:`, with no `code`. Any caller
 * matching on `err.code` — including a probe written against the server's
 * convention — read a FIRED guard as an unrelated failure, which produced a
 * false "unguarded" reading during the #7266 review.
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

import { SANDBOX_INSTALLED, SANDBOX_SKIPPED, SANDBOX_IS_PROTECTED } from './_setup.mjs'
import {
  FS_EXEMPTIONS,
  SANDBOX_ERROR_CODE,
  SANDBOX_MARKER,
  guardedMethodNames,
} from '../../../scripts/lib/test-fs-sandbox.mjs'
import {
  probePlans, runProbe, partitionByAvailability, planLabel,
  GUARDED, REACHED_REAL_FS,
} from '../../../scripts/lib/test-fs-sandbox-probes.mjs'
import { installHooks } from '../src/installer.js'

// `_setup.mjs` relocates HOME to a throwaway dir, so `homedir()` here is the
// SANDBOX home, not the developer's. The guard locks onto the REAL one, which
// has to be recovered a way that survives layer 1: `os.userInfo()` reads the
// passwd entry (SID on Windows) and ignores $HOME, so it still points at the
// home the guard is defending. Aiming a probe at `homedir()` instead would
// target the temp dir and every assertion below would pass for free.
const PASSWD_HOME = userInfo().homedir

const PROBE_ROOT = join(PASSWD_HOME, '.chroxy', `__chroxy-hooks-sandbox-${process.pid}`)
// The other protected root. installer.js writes into ~/.claude, so the
// installer probes need a target there — with a parent that does not exist.
const REAL_CLAUDE_PROBE = join(PASSWD_HOME, '.claude', `__chroxy-hooks-sandbox-${process.pid}`)
const protectedPath = join(PROBE_ROOT, 'd', 'probe.tmp')
const spare = join(tmpdir(), `chroxy-hooks-sandbox-${process.pid}`, 'spare.tmp')
const absentSource = join(tmpdir(), `chroxy-hooks-sandbox-absent-${process.pid}`)

function removeProbeRoot () {
  const prev = process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES
  process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES = '1'
  try {
    namedRmSync(PROBE_ROOT, { recursive: true, force: true })
    namedRmSync(REAL_CLAUDE_PROBE, { recursive: true, force: true })
  } finally {
    if (prev === undefined) delete process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES
    else process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES = prev
  }
}

after(() => {
  removeProbeRoot()
  namedRmSync(join(tmpdir(), `chroxy-hooks-sandbox-${process.pid}`), { recursive: true, force: true })
})

// Only what this platform has. `lchmod`/`lchmodSync` are macOS-only, and probing
// them on Linux calls `undefined` — a test defect that says nothing about the
// guard. Dropped plans are corroborated below against the installer's own skip
// record, so "cannot run this" never becomes "nothing to check".
const { runnable, unavailable } = partitionByAvailability(
  probePlans({ protectedPath, spare, absentSource }),
  { fs: fsNamespace, promises: fspNamespace },
)

describe('claude-hooks write sandbox: the real home is refused (#7268)', () => {
  test('layer 1 relocated HOME, and the guard still points at the REAL home', () => {
    assert.notStrictEqual(
      homedir(), PASSWD_HOME,
      'tests/_setup.mjs must relocate HOME; without layer 1 the default-path code ' +
      'under test resolves straight into the developer\'s real ~/.claude.',
    )
    // Not `PROBE_ROOT.startsWith(PASSWD_HOME)` — that is built from PASSWD_HOME
    // two lines up and can never fail. The property that matters is that the
    // GUARD considers this path protected: the guard locked onto `os.homedir()`
    // (which follows $HOME) while the probe uses the passwd entry, and a
    // container job that sets HOME=/github/home makes those different. Then
    // every probe below would aim at an unprotected path and fail with a
    // message blaming #7262.
    assert.ok(
      SANDBOX_IS_PROTECTED(PROBE_ROOT),
      `The guard does not consider ${PROBE_ROOT} protected, so no probe here ` +
      `proves anything. $HOME and the passwd home have diverged.`,
    )
  })

  for (const plan of runnable) {
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
    // Platform-aware: a method Node does not define here cannot be guarded, and
    // the skip is corroborated by the loop below requiring reason 'absent'.
    const exists = (label, method, host) => typeof host[method] === 'function'
    const expected = [
      ...sync.filter((m) => exists(m, m, fsNamespace)),
      ...callback.filter((m) => exists(m, m, fsNamespace)).map((m) => `${m} (callback)`),
      ...promises.filter((m) => exists(m, m, fspNamespace)).map((m) => `promises.${m}`),
    ]
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
    const skipped = new Set(SANDBOX_SKIPPED.map((s) => s.name))
    assert.deepStrictEqual(
      unavailable.map(planLabel).filter((l) => !skipped.has(l)), [],
      'A probe was dropped as unavailable while the installer guarded the method ' +
      'anyway — the method exists and nothing proves its guard fires.',
    )
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
  // were guarded — which happened to be enough to stop THIS caller, because the
  // mkdir is first. That is exactly why the integration assertion below is not
  // sufficient on its own: it would pass against the old, narrower guard too.
  // Each step is therefore also asserted individually.
  test('installHooks against a real-home settings path is blocked', () => {
    // NOT `~/.claude/settings.json` itself. That file exists, is 0600, and holds
    // the developer's live hook configuration — and `installHooks` MERGES and
    // rewrites it. Aiming a probe there means that the moment this suite's
    // premise fails (the guard regressed), the test destroys the very thing the
    // guard exists to protect. Every other probe in this repo targets a path
    // with a MISSING PARENT so a failing run is inert; this one now does too,
    // and it is still under the protected root, which is all the guard reads.
    const settingsPath = join(REAL_CLAUDE_PROBE, 'settings.json')
    let caught = null
    try { installHooks({ settingsPath }) } catch (err) { caught = err }
    assert.ok(caught, 'installHooks reached the real ~/.claude tree')
    assert.strictEqual(caught.code, SANDBOX_ERROR_CODE, `blocked for the wrong reason: ${caught.message}`)
  })

  test('the temp file the atomic write opens is itself protected', () => {
    // The temp path is a SIBLING of the resolved settings path
    // (`<settings>.chroxy-hooks-<pid>.tmp`), so it lands under ~/.claude too.
    // Proven by calling the exact step that opens it rather than by asserting
    // the filename shape, which would be a copy of installer.js's format string
    // living in a test — a hardcoded list beside a thing that changes.
    const sibling = join(REAL_CLAUDE_PROBE, `settings.json.chroxy-hooks-${process.pid}.tmp`)
    let fd = null
    let caught = null
    try { fd = fsNamespace.openSync(sibling, 'w') } catch (err) { caught = err }
    // A bypass would return a live fd, not just create a file — close it rather
    // than leaking it into the rest of the run.
    if (fd !== null) { try { fsNamespace.closeSync(fd) } catch { /* best effort */ } }
    assert.ok(caught && caught.code === SANDBOX_ERROR_CODE, 'openSync on the atomic-write temp path was not guarded')
  })

  test('every node:fs function this package imports is guarded or exempt with a reason', () => {
    // The drift-proof half: rather than naming installer.js's write steps (a
    // list beside a set that grows), read what the source ACTUALLY imports and
    // require every name to be classified. A new `unlinkSync` in emit.js is
    // then covered the day it is written.
    //
    // Recursive, and it covers `bin/` as well as `src/` — the first version
    // walked one flat directory and would have missed a subdirectory silently.
    // It reads `node:fs` AND `node:fs/promises`, because a promise-side name is
    // classified by a different table.
    //
    // The scan runs on raw source, so an import quoted inside a comment is
    // counted. That direction is safe: it can only over-report and fail loudly.
    const { sync, callback, promises } = guardedMethodNames()
    const syncSide = new Set([...sync, ...callback])
    const promiseSide = new Set(promises)

    const roots = [
      fileURLToPath(new URL('../src/', import.meta.url)),
      fileURLToPath(new URL('../bin/', import.meta.url)),
    ]
    const files = []
    const walk = (dir) => {
      for (const entry of fsNamespace.readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(js|mjs)$/.test(entry.name)) files.push(full)
      }
    }
    for (const root of roots) if (fsNamespace.existsSync(root)) walk(root)

    const unclassified = []
    const unverifiable = []
    let importsSeen = 0
    for (const file of files) {
      const source = namedReadFileSync(file, 'utf8')
      const rel = file.slice(file.indexOf('/claude-hooks/') + 1)
      // Multi-line import blocks included on purpose: a line-anchored pattern
      // undercounts them, which is how #7266's own module count came out 41
      // instead of 45.
      for (const m of source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"](?:node:)?fs(\/promises)?['"]/g)) {
        const table = m[2] ? promiseSide : syncSide
        for (const raw of m[1].split(',')) {
          const name = raw.trim().split(/\s+as\s+/)[0].trim()
          if (!name) continue
          importsSeen++
          if (!table.has(name) && !(name in FS_EXEMPTIONS)) unclassified.push(`${rel}: ${name}`)
        }
      }
      // A default or namespace import exposes the WHOLE module, so no list of
      // names can be extracted and this check cannot speak for the file. Say so
      // instead of scanning it and reporting nothing found.
      for (const m of source.matchAll(/import\s+(?:\*\s+as\s+)?[\w$]+\s*(?:,\s*\{[\s\S]*?\}\s*)?from\s*['"](?:node:)?fs(?:\/promises)?['"]/g)) {
        unverifiable.push(`${rel}: ${m[0].trim()}`)
      }
    }
    assert.ok(files.length > 0, 'the scan walked no files at all, so it proved nothing')
    assert.ok(importsSeen > 0, 'the scan found no node:fs imports at all, so it proved nothing about this package')
    assert.deepStrictEqual(
      unverifiable, [],
      'A default or namespace `fs` import means this check cannot enumerate what ' +
      'the file uses. Switch it to named imports, or this scan silently vouches ' +
      'for a file it never examined.',
    )
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

  test('the bare protected FILE ~/.claude.json is guarded, and only that exact path', () => {
    // Same mechanism, same gap: `protectedFiles` is checked separately from the
    // roots, and nothing here proved it until a mutation removed the entry and
    // the suite stayed green.
    // `renameSync(<absent source>, target)`: ~/.claude.json's parent is $HOME and
    // EXISTS, so a write probe would overwrite the developer's real file the
    // moment the guard regressed. With a missing source a bypass fails before
    // touching the destination.
    const attempt = (target) => {
      try { fsNamespace.renameSync(absentSource, target); return 'no-error' } catch (err) { return err.code }
    }
    assert.strictEqual(attempt(join(PASSWD_HOME, '.claude.json')), SANDBOX_ERROR_CODE)
    assert.strictEqual(
      attempt(join(tmpdir(), '.claude.json')), 'ENOENT',
      'The guard matched on the file NAME rather than the full path.',
    )
  })

  test('the sandbox HOME is writable — the guard discriminates by path', () => {
    const file = join(homedir(), '.claude', 'settings.json')
    fsNamespace.mkdirSync(join(homedir(), '.claude'), { recursive: true })
    fsNamespace.writeFileSync(file, '{}')
    assert.strictEqual(namedReadFileSync(file, 'utf8'), '{}')
    // Same relative shape under the REAL home: refused. Aimed inside the
    // missing-parent probe dir rather than at the live settings.json, so a
    // regression fails the assertion instead of truncating real config.
    assert.throws(
      () => fsNamespace.writeFileSync(join(REAL_CLAUDE_PROBE, 'settings.json'), '{}'),
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
  test('no probe root exists under the real ~/.chroxy or ~/.claude', () => {
    const leaked = [PROBE_ROOT, REAL_CLAUDE_PROBE].filter((p) => namedExistsSync(p))
    if (leaked.length > 0) removeProbeRoot()
    assert.deepStrictEqual(leaked, [], 'A probe created real state under the developer\'s home.')
  })
})
