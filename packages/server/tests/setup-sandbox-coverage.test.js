/**
 * CATEGORY coverage for the write sandbox in `tests/_setup.mjs` (#7267).
 *
 * Its sibling `setup-sandbox-binding-forms.test.js` answers "is the patch
 * VISIBLE?" — the #7262 axis, how `fs` was imported. This file answers the
 * other question: "is the patch WIDE ENOUGH?"
 *
 * Until #7267 the answer was no, and the shape was `docs/false-safety-guards.md`
 * cause #1 — a hardcoded list next to a set that grows. The sandbox named seven
 * sync methods and five `promises` methods, so everything that deletes, copies,
 * links or chmods reached the developer's real `~/.chroxy` unimpeded, including
 * `unlinkSync` (52 call sites under `src/`, more than `openSync` has) and the
 * whole CALLBACK surface down to plain `fs.writeFile(path, data, cb)`. The
 * guard reported success the entire time, because every method it did name
 * worked perfectly.
 *
 * ── Why this file cannot drift from the guard ───────────────────────────────
 *
 * There is ONE array. `FS_PATH_MUTATORS` in `scripts/lib/test-fs-sandbox.mjs`
 * expands to the methods the sandbox patches AND to the probes asserted here,
 * so a row added there is automatically installed and automatically proven. The
 * old per-method suite in the binding-forms file kept a second, hand-written
 * list beside the first — the same defect one level up, and it is deleted.
 *
 * Three assertions keep that honest, because "derived from one array" only
 * moves the question to whether the array is complete:
 *
 *   1. every method the guard ACTUALLY installed is probed  (installed -> probed)
 *   2. every method probed was actually installed           (probed -> installed)
 *   3. GUARDED union EXEMPT covers the live `fs` surface exactly, with a
 *      recorded reason for each exemption   (the category, not a list)
 *
 * (3) is the one that survives a Node upgrade: when `fs` gains a path-taking
 * mutator, this suite goes red and someone has to classify it, instead of the
 * hole widening in silence.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert'

import * as fsNamespace from 'node:fs'
import * as fspNamespace from 'node:fs/promises'
import { writeFileSync as namedWriteFileSync, existsSync as namedExistsSync, rmSync as namedRmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// The guard's own record of what it installed — read from the SAME module the
// harness ran, not re-derived. `--import ./tests/_setup.mjs` has already
// evaluated it, so this import is a registry cache hit and installs nothing a
// second time (proven below: a re-run would report `already-guarded` skips).
import { SANDBOX_INSTALLED, SANDBOX_SKIPPED } from './_setup.mjs'
import {
  FS_PATH_MUTATORS,
  FS_STREAM_MUTATORS,
  FS_EXEMPTIONS,
  FS_PROMISES_EXEMPTIONS,
  SANDBOX_MARKER,
  guardedMethodNames,
} from '../../../scripts/lib/test-fs-sandbox.mjs'
import { probePlans, runProbe, PROBE_EXTRA_ARGS, GUARDED, REACHED_REAL_FS } from '../../../scripts/lib/test-fs-sandbox-probes.mjs'

// A dedicated root under the REAL protected tree. Nothing below it is ever
// created by a PASSING run — the guard throws before the syscall — and the last
// suite asserts that a failing one created nothing either.
const PROBE_ROOT = join(homedir(), '.chroxy', `__chroxy-sandbox-coverage-${process.pid}`)
const protectedPath = join(PROBE_ROOT, 'd', 'probe.tmp')
const spare = join(tmpdir(), `chroxy-sandbox-coverage-${process.pid}`, 'spare.tmp')
const absentSource = join(tmpdir(), `chroxy-sandbox-coverage-absent-${process.pid}`)

// Removing anything under the protected root needs the documented opt-out —
// the guard blocks the cleanup too, which is itself a small proof that it is
// armed. Scoped to the call and restored immediately; node:test runs top-level
// tests in a file sequentially, so no concurrent probe sees the flag.
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
  namedRmSync(join(tmpdir(), `chroxy-sandbox-coverage-${process.pid}`), { recursive: true, force: true })
})

const plans = probePlans({ protectedPath, spare, absentSource })

describe('write sandbox: every guarded fs method refuses the real home (#7267)', () => {
  for (const plan of plans) {
    test(`${plan.label} is guarded`, async () => {
      const verdict = await runProbe(plan, {
        fs: fsNamespace,
        promises: fspNamespace,
        cleanup: removeProbeRoot,
      })
      assert.strictEqual(
        verdict, GUARDED,
        `${plan.label} reached the real filesystem. The sandbox must refuse every ` +
        `path-taking fs mutator aimed at ~/.chroxy or ~/.claude (#4633, #7267).`,
      )
    })
  }

  // The sweep above drives the NAMESPACE binding. That is only equivalent to
  // the named form — the one 45 modules under `src/` use, and the one #7262
  // left unguarded — because both read the same synthetic-module snapshot.
  // Pinned rather than assumed, so the whole sweep cannot quietly become a test
  // of a binding form nobody ships.
  test('the namespace binding IS the named binding, which is what the sweep rides on', () => {
    assert.strictEqual(
      fsNamespace.writeFileSync, namedWriteFileSync,
      'node:fs namespace and named imports must resolve to the same binding; if ' +
      'they diverge, the sweep above no longer says anything about named imports.',
    )
  })
})

describe('write sandbox: the probe list and the patch list cannot drift (#7267)', () => {
  const probed = new Set(plans.map((p) => {
    if (p.surface === 'promises') return `promises.${p.method}`
    if (p.surface === 'callback') return `${p.method} (callback)`
    return p.method
  }))

  test('every method the guard installed is probed', () => {
    const unprobed = SANDBOX_INSTALLED.filter((name) => !probed.has(name))
    assert.deepStrictEqual(
      unprobed, [],
      'These methods are patched by the sandbox but nothing here proves the patch ' +
      'fires. A guard that is never made to fail is not a guard ' +
      '(docs/false-safety-guards.md).',
    )
  })

  test('every method probed was actually installed', () => {
    const missing = [...probed].filter((name) => !SANDBOX_INSTALLED.includes(name))
    assert.deepStrictEqual(
      missing, [],
      'These probes target methods the sandbox did not install, so they can only ' +
      'be passing for some other reason.',
    )
  })

  test('the only reason to skip a method is that this platform lacks it', () => {
    // `lchmod`/`lchmodSync` are macOS-only, so a skip is legitimate — but ONLY
    // for that reason. An `already-guarded` skip would mean `_setup.mjs` ran
    // twice, which would leave the second (correct) root unenforced.
    for (const { name, reason } of SANDBOX_SKIPPED) {
      assert.strictEqual(reason, 'absent', `${name} was skipped for an unexpected reason: ${reason}`)
      const base = name.replace(/ \(callback\)$/, '').replace(/^promises\./, '')
      const host = name.startsWith('promises.') ? fspNamespace : fsNamespace
      assert.strictEqual(
        typeof host[base], 'undefined',
        `${name} was skipped as "absent" but it exists on this platform.`,
      )
    }
  })

  test('the installed set matches the functions actually carrying the guard marker', () => {
    // Read back off the live objects rather than trusting the return value:
    // a patch that was installed and then overwritten by a later import would
    // still be listed as installed.
    // The marker already carries the label the sandbox reported installing
    // (`promises.rm`, `rm (callback)`, `rmSync`), so it is read verbatim — a
    // prefix rebuilt here would be a second naming scheme to keep in step.
    const marked = []
    for (const host of [fsNamespace, fspNamespace]) {
      for (const key of Object.keys(host)) {
        const fn = host[key]
        if (typeof fn === 'function' && fn[SANDBOX_MARKER]) marked.push(fn[SANDBOX_MARKER])
      }
    }
    assert.deepStrictEqual(
      marked.sort(), [...SANDBOX_INSTALLED].sort(),
      'The live fs objects do not carry exactly the guards the sandbox reports ' +
      'installing — something re-assigned an fs method after the patch.',
    )
  })
})

describe('write sandbox: two-path operations guard BOTH paths (#7267)', () => {
  // The one property the derived list cannot pin about itself.
  //
  // `probePlans` reads the same `paths` field the installer reads, so narrowing
  // a row from `paths: 2` to `paths: 1` removes the guard on the second
  // argument AND the probe that would have caught it — the suite stays green
  // while `rename(tmp, '~/.chroxy/session-state.json')` walks straight through.
  // Measured: that exact mutation passed every other assertion in this file.
  //
  // So this table is stated INDEPENDENTLY, on purpose, and it is the only thing
  // in the change deliberately written twice. It is a specification, not a copy
  // of the implementation: each row says why the argument nobody thinks about
  // is dangerous.
  const TWO_PATH_OPERATIONS = [
    ['rename', 'moving real state OUT is data loss, not only moving something IN'],
    ['cp', 'dest creates (and creates its parents); src reads real user state into a fixture'],
    ['copyFile', 'the single-file form of the same'],
    ['link', 'newPath creates a hard link; existingPath is the inode being aliased'],
    ['symlink', 'path creates — and a link whose TARGET is the real tree defeats this ' +
                'guard wholesale, because path.resolve() does not follow links: writes ' +
                'through the alias never look like ~/.chroxy at all'],
  ]

  test('the table covers exactly the operations declared to take two paths', () => {
    assert.deepStrictEqual(
      TWO_PATH_OPERATIONS.map(([op]) => op).sort(),
      FS_PATH_MUTATORS.filter((m) => m.paths === 2).map((m) => m.base).sort(),
      'A two-path operation exists that this suite does not probe in both ' +
      'positions, or vice versa. Add it here WITH the reason its second path ' +
      'matters — that reason is the whole content of this table.',
    )
  })

  for (const [base, why] of TWO_PATH_OPERATIONS) {
    for (const [position, args] of [
      ['first', [protectedPath, spare]],
      ['second', [absentSource, protectedPath]],
    ]) {
      for (const surface of ['sync', 'callback', 'promises']) {
        const method = surface === 'sync' ? `${base}Sync` : base
        const label = surface === 'promises' ? `promises.${base}` : surface === 'callback' ? `${base} (callback)` : `${base}Sync`
        test(`${label} guards its ${position} path argument`, async () => {
          const verdict = await runProbe(
            { base, surface, method, args, extra: PROBE_EXTRA_ARGS[base]() },
            { fs: fsNamespace, promises: fspNamespace, cleanup: removeProbeRoot },
          )
          assert.strictEqual(verdict, GUARDED, `${label} ignored its ${position} path argument — ${why}`)
        })
      }
    }
  }
})

describe('write sandbox: the guard is a category, not a list (#7267)', () => {
  const { sync, callback, promises } = guardedMethodNames()

  test('every function on node:fs is either guarded or exempt with a reason', () => {
    const guarded = new Set([...sync, ...callback])
    const unclassified = Object.keys(fsNamespace)
      .filter((k) => typeof fsNamespace[k] === 'function')
      .filter((k) => !guarded.has(k) && !(k in FS_EXEMPTIONS))
    assert.deepStrictEqual(
      unclassified, [],
      'This Node build exposes fs functions the sandbox neither guards nor exempts. ' +
      'Classify each one in scripts/lib/test-fs-sandbox.mjs: add it to ' +
      'FS_PATH_MUTATORS if it takes a path and mutates the filesystem, or to ' +
      'FS_EXEMPTIONS with the reason it cannot corrupt user state.',
    )
  })

  test('every function on fs.promises is either guarded or exempt with a reason', () => {
    const guarded = new Set(promises)
    const unclassified = Object.keys(fspNamespace)
      .filter((k) => typeof fspNamespace[k] === 'function')
      .filter((k) => !guarded.has(k) && !(k in FS_PROMISES_EXEMPTIONS))
    assert.deepStrictEqual(unclassified, [], 'Classify these in FS_PROMISES_EXEMPTIONS or FS_PATH_MUTATORS.')
  })

  test('nothing is both guarded and exempt', () => {
    const guarded = new Set([...sync, ...callback])
    assert.deepStrictEqual(
      Object.keys(FS_EXEMPTIONS).filter((k) => guarded.has(k)), [],
      'An exemption for a guarded method is a contradiction: whichever list is ' +
      'read first decides, and the other silently means nothing.',
    )
    assert.deepStrictEqual(
      Object.keys(FS_PROMISES_EXEMPTIONS).filter((k) => new Set(promises).has(k)), [],
    )
  })

  test('the exemptions are not a dumping ground — every reason is one of the known kinds', () => {
    const KNOWN = new Set(['read', 'fd', 'class', 'class-known-residual', 'internal'])
    const odd = Object.entries({ ...FS_EXEMPTIONS, ...FS_PROMISES_EXEMPTIONS })
      .filter(([, reason]) => !KNOWN.has(reason))
    assert.deepStrictEqual(odd, [], 'Unknown exemption reason — see the header of test-fs-sandbox.mjs.')
  })

  test('the mutator table has no duplicate rows', () => {
    const bases = FS_PATH_MUTATORS.map((m) => m.base)
    assert.deepStrictEqual(
      bases.filter((b, i) => bases.indexOf(b) !== i), [],
      'A duplicated base would install one guard over another and report both.',
    )
    const streams = FS_STREAM_MUTATORS.map((m) => m.name)
    assert.deepStrictEqual(streams.filter((s, i) => streams.indexOf(s) !== i), [])
  })
})

describe('write sandbox: controls (#7267)', () => {
  // POSITIVE CONTROL. Every assertion above passes on CHROXY_TEST_SANDBOX and
  // fails on ENOENT. That distinction is worthless unless ENOENT is genuinely
  // what a bypass looks like here — otherwise the suite would be green because
  // nothing ever reaches the syscall, not because the guard is armed. Same
  // shape, same missing parent, only the root differs.
  test('an UNPROTECTED missing-parent path reaches the real fs (ENOENT)', async () => {
    const control = probePlans({
      protectedPath: join(tmpdir(), `chroxy-sandbox-control-${process.pid}`, 'probe.tmp'),
      spare,
      absentSource,
    })
    const write = control.find((p) => p.label === 'writeFileSync')
    const unlink = control.find((p) => p.label === 'unlink (callback)')
    const rm = control.find((p) => p.label === 'promises.rm')
    for (const plan of [write, unlink, rm]) {
      assert.strictEqual(
        await runProbe(plan, { fs: fsNamespace, promises: fspNamespace }),
        REACHED_REAL_FS,
        `The control (${plan.label}) did not reach the real fs, so ENOENT is not a ` +
        `valid signature for "bypassed" and the assertions above prove nothing.`,
      )
    }
  })

  test('the guard discriminates by path, not by throwing at everything', () => {
    const dir = join(tmpdir(), `chroxy-sandbox-coverage-ok-${process.pid}`)
    try {
      fsNamespace.mkdirSync(dir, { recursive: true })
      const file = join(dir, 'legit.txt')
      namedWriteFileSync(file, 'ok')
      fsNamespace.chmodSync(file, 0o600)
      fsNamespace.copyFileSync(file, join(dir, 'copy.txt'))
      fsNamespace.unlinkSync(join(dir, 'copy.txt'))
      assert.strictEqual(fsNamespace.readFileSync(file, 'utf8'), 'ok')
    } finally {
      namedRmSync(dir, { recursive: true, force: true })
    }
  })

  test('reads of the real home are still allowed', () => {
    // Deliberate: `providers.test.js` and friends legitimately read the
    // developer's real config. A guard that blocked reads would be "safer" and
    // would break the suite, so the exemption is pinned, not assumed.
    assert.doesNotThrow(() => fsNamespace.existsSync(join(homedir(), '.chroxy')))
    assert.doesNotThrow(() => fsNamespace.readdirSync(homedir()))
  })
})

describe('write sandbox: the probes created nothing under the real home (#7267)', () => {
  // The acceptance criterion #7267 was filed on. `cpSync` is why it is asserted
  // rather than reasoned: it creates the destination's parent chain before it
  // fails, so a probe aimed at a NON-EXISTENT path under ~/.chroxy left a real
  // directory there — through an armed sandbox — while every other probe in
  // this file is safe by construction. This assertion runs last on purpose.
  test('no probe root exists under ~/.chroxy', () => {
    const leaked = namedExistsSync(PROBE_ROOT)
    if (leaked) removeProbeRoot()
    assert.strictEqual(
      leaked, false,
      `A probe created real state at ${PROBE_ROOT}. It has been removed, but the ` +
      `sandbox let a write through — that is the #4633 bug, live.`,
    )
  })
})
