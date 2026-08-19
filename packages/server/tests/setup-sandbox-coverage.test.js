/**
 * CATEGORY coverage for the write sandbox in `tests/_setup.mjs` (#7267).
 *
 * Its sibling `setup-sandbox-binding-forms.test.js` answers "is the patch
 * VISIBLE?" — the #7262 axis, how `fs` was imported. This file answers the
 * other question: "is the patch WIDE ENOUGH?"
 *
 * Until #7267 the answer was no, and the shape was the
 * "Checked a subset" mode in `docs/false-safety-guards.md` — a hardcoded list
 * next to a set that grows. The sandbox named seven
 * sync methods and five `promises` methods, so everything that deletes, copies,
 * links or chmods reached the developer's real `~/.chroxy` unimpeded, including
 * `unlinkSync` (34 call sites under `src/`, more than `openSync`'s 14) and the
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
import {
  writeFileSync as namedWriteFileSync,
  existsSync as namedExistsSync,
  rmSync as namedRmSync,
  renameSync as namedRenameSync,
  openSync as namedOpenSync,
  constants as fsConstants,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join, sep } from 'node:path'

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
import {
  probePlans, runProbe, partitionByAvailability, planLabel,
  PROBE_EXTRA_ARGS, GUARDED, REACHED_REAL_FS,
} from '../../../scripts/lib/test-fs-sandbox-probes.mjs'

// A dedicated root under the REAL protected tree. Nothing below it is ever
// created by a PASSING run — the guard throws before the syscall — and the last
// suite asserts that a failing one created nothing either.
const PROBE_ROOT = join(homedir(), '.chroxy', `__chroxy-sandbox-coverage-${process.pid}`)
const protectedPath = join(PROBE_ROOT, 'd', 'probe.tmp')
// The OTHER protected root. `_setup.mjs` hands the guard both, and until this
// existed every probe aimed at `.chroxy` — so shrinking `protectedRoots` to one
// entry was an unobserved change.
const claudeProbe = join(homedir(), '.claude', `__chroxy-sandbox-coverage-${process.pid}`, 'probe.tmp')
const spare = join(tmpdir(), `chroxy-sandbox-coverage-${process.pid}`, 'spare.tmp')
const absentSource = join(tmpdir(), `chroxy-sandbox-coverage-absent-${process.pid}`)

// Removing anything under the protected root needs the documented opt-out —
// the guard blocks the cleanup too, which is itself a small proof that it is
// armed. Scoped to the call and restored immediately; node:test runs top-level
// tests in a file sequentially, so no concurrent probe sees the flag.
function removeProbeRoot () {
  const prev = process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES
  process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES = '1'
  try {
    namedRmSync(PROBE_ROOT, { recursive: true, force: true })
    namedRmSync(join(homedir(), '.claude', `__chroxy-sandbox-coverage-${process.pid}`), { recursive: true, force: true })
  } finally {
    if (prev === undefined) delete process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES
    else process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES = prev
  }
}

after(() => {
  removeProbeRoot()
  namedRmSync(join(tmpdir(), `chroxy-sandbox-coverage-${process.pid}`), { recursive: true, force: true })
})

// Probe what this platform actually has. `lchmod`/`lchmodSync` are macOS-only,
// and probing them on Linux calls `undefined` — a test defect that says nothing
// about the guard. The dropped plans are NOT forgotten: the suite below requires
// the installer to have skipped the same methods for the same reason, so
// "cannot run this" cannot quietly become "nothing to check".
// Returns the error code a call produced, or 'no-error' if it succeeded.
function probeSyncLocal (fn) {
  try { fn(); return 'no-error' } catch (err) { return err.code || err.message }
}

const allPlans = probePlans({ protectedPath, spare, absentSource })
const { runnable: plans, unavailable } = partitionByAvailability(allPlans, {
  fs: fsNamespace,
  promises: fspNamespace,
})

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
  const probed = new Set(plans.map(planLabel))

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

  test('every probe this platform cannot run was skipped by the installer too', () => {
    // The dangerous direction. A plan dropped here is a method nobody proves,
    // so it must be corroborated INDEPENDENTLY — by the installer having
    // recorded the same method as absent. Two separate readings of the same
    // platform fact, from two different code paths.
    const skipped = new Set(SANDBOX_SKIPPED.map((s) => s.name))
    const uncorroborated = unavailable
      .map(planLabel)
      .filter((label) => !skipped.has(label))
    assert.deepStrictEqual(
      uncorroborated, [],
      'These probes were dropped as "the platform lacks this method", but the ' +
      'sandbox installed a guard for them anyway — so the method exists and the ' +
      'probe was skipped for the wrong reason. That is a silently unproven guard.',
    )
    assert.ok(
      plans.length > unavailable.length,
      `Only ${plans.length} of ${allPlans.length} probes ran. A filter that drops ` +
      `most of the suite is a broken filter, not a platform difference.`,
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
        const label = planLabel({ surface, method })
        const host = surface === 'promises' ? fspNamespace : fsNamespace
        if (typeof host[method] !== 'function') continue
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
    const KNOWN = new Set([
      'read', 'fd', 'fd-metadata-known-residual',
      'class', 'class-known-residual', 'internal',
    ])
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

describe('write sandbox: the mutator table is complete (#7267)', () => {
  // S2's axis. Every FIELD of a spec row is pinned — arity by
  // TWO_PATH_OPERATIONS, a deleted row by the category check, a silent install
  // skip by probed<->installed. What was NOT pinned is whether a row belongs in
  // the table at all: MOVING one into FS_EXEMPTIONS deletes the guard AND its
  // probe AND satisfies the category check, all at once. Measured: relocating
  // `rmdir` that way left the suite green while `rmdirSync` removed a real
  // directory under the protected root.
  //
  // So the roster is stated independently. It is the answer to "which fs
  // operations mutate a path", which is a fact about Node, not about this code.
  const MUST_BE_GUARDED = [
    'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lchmod', 'lchown', 'link',
    'lutimes', 'mkdir', 'mkdtemp', 'open', 'rename', 'rm', 'rmdir', 'symlink',
    'truncate', 'unlink', 'utimes', 'writeFile',
  ]

  test('every path-mutating fs operation is in the table, and nothing else is', () => {
    assert.deepStrictEqual(
      FS_PATH_MUTATORS.map((m) => m.base).sort(), [...MUST_BE_GUARDED].sort(),
      'The mutator table and the roster disagree. If Node gained or lost an ' +
      'operation, update BOTH — the point of the second list is that moving a ' +
      'row into FS_EXEMPTIONS can otherwise delete a guard, its probe, and the ' +
      'category check\'s objection to it in one edit.',
    )
    assert.deepStrictEqual(FS_STREAM_MUTATORS.map((m) => m.name), ['createWriteStream'])
  })
})

describe('write sandbox: open is gated by write intent, both directions (#7267)', () => {
  // `open` is the only row whose decision is not purely path-based, which makes
  // it the one carrying the most logic and — until this suite — the least
  // coverage. Its numeric branch was measurably wrong: the mask was written as
  // literals from Linux, where O_CREAT is 64, while on darwin it is 512 and on
  // Windows 256. `openSync(protected, O_TRUNC)` emptied a real file through an
  // armed sandbox.
  const NUMERIC_WRITE_FLAGS = ['O_WRONLY', 'O_RDWR', 'O_CREAT', 'O_TRUNC', 'O_APPEND']

  for (const flag of NUMERIC_WRITE_FLAGS) {
    test(`openSync with numeric ${flag} is guarded`, () => {
      assert.strictEqual(
        probeSyncLocal(() => namedOpenSync(protectedPath, fsConstants[flag])),
        'CHROXY_TEST_SANDBOX',
        `A numeric ${flag} (${fsConstants[flag]} on ${process.platform}) was read as a ` +
        `non-write open. Derive the mask from fs.constants, never from literals.`,
      )
    })
  }

  // The ALLOW direction, which no assertion covered: `isWriteIntent -> true`
  // left the suite fully green, and would have started throwing inside
  // skills-loader.js and jsonl-reader.js — which openSync(path, 'r') the
  // developer's real config on purpose — with nothing naming the cause.
  test('a READ open of a protected path is allowed through', () => {
    assert.strictEqual(
      probeSyncLocal(() => namedOpenSync(protectedPath, 'r')), 'ENOENT',
      'Reads of the real home are deliberately permitted (providers.test.js and ' +
      'skills-loader depend on it). A guarded read means isWriteIntent is ' +
      'answering true for everything.',
    )
    assert.strictEqual(probeSyncLocal(() => namedOpenSync(protectedPath, fsConstants.O_RDONLY)), 'ENOENT')
  })
})

describe('write sandbox: every path TYPE Node accepts is checked (#7267)', () => {
  // `isProtected` decodes three shapes and used to return false — unprotected —
  // for anything else. Node also accepts a bare Uint8Array as a path, and a
  // Uint8Array is not `instanceof Buffer`, so one went through unexamined.
  // "Unrecognised shape filtered out instead of raising" is a false-safety mode
  // in its own right, so unknown shapes now fail CLOSED.
  const shapes = [
    ['string', () => protectedPath],
    ['URL', () => pathToFileURL(protectedPath)],
    ['Buffer', () => Buffer.from(protectedPath)],
    ['Uint8Array', () => new Uint8Array(Buffer.from(protectedPath))],
  ]
  for (const [label, build] of shapes) {
    test(`a protected path passed as a ${label} is guarded`, () => {
      assert.strictEqual(
        probeSyncLocal(() => namedWriteFileSync(build(), 'probe')), 'CHROXY_TEST_SANDBOX',
        `A ${label} path bypassed the guard.`,
      )
    })
  }

  test('a case-variant of the protected root is guarded where the fs is case-insensitive', () => {
    // On APFS and NTFS `~/.Chroxy/x` IS `~/.chroxy/x`. A case-sensitive compare
    // does not match it, so the guard would wave through a path that resolves to
    // real user state. Both platforms this repo's CI runs on are affected.
    const variant = protectedPath.replace(`${sep}.chroxy${sep}`, `${sep}.Chroxy${sep}`)
    assert.notStrictEqual(variant, protectedPath, 'the probe did not actually change case')
    const expected = (process.platform === 'darwin' || process.platform === 'win32')
      ? 'CHROXY_TEST_SANDBOX'
      : 'ENOENT'
    assert.strictEqual(
      probeSyncLocal(() => namedWriteFileSync(variant, 'probe')), expected,
      process.platform === 'linux'
        ? 'On a case-sensitive fs .Chroxy is a genuinely different directory and must NOT be guarded.'
        : 'A case-variant of the protected root reached the real filesystem.',
    )
  })

  test('an unrecognised path shape fails CLOSED', () => {
    assert.strictEqual(
      probeSyncLocal(() => namedWriteFileSync({ toString: () => protectedPath }, 'probe')),
      'CHROXY_TEST_SANDBOX',
      'A shape the guard cannot decode must be refused, not waved through. A ' +
      'false positive here is a loud failure with the value in hand; a false ' +
      'negative is #4633.',
    )
  })

  test('the same shapes are NOT guarded when the path is unprotected', () => {
    // Otherwise the four assertions above would pass for a guard that refuses
    // every non-string argument.
    //
    // The control path is built as a STRING and then encoded — never by
    // `.toString()`-ing the shape. A Uint8Array stringifies to its decimal bytes
    // ("47,85,115,…"), which is a RELATIVE path: the first version of this test
    // wrote three junk files into packages/server/ instead of tmpdir.
    const controlPath = join(tmpdir(), `chroxy-shape-${process.pid}`, 'probe.tmp')
    const encode = {
      string: (str) => str,
      URL: (str) => pathToFileURL(str),
      Buffer: (str) => Buffer.from(str),
      Uint8Array: (str) => new Uint8Array(Buffer.from(str)),
    }
    for (const [label] of shapes) {
      assert.strictEqual(
        probeSyncLocal(() => namedWriteFileSync(encode[label](controlPath), 'probe')),
        'ENOENT',
        `${label} control: an unprotected path of this shape must reach the real fs.`,
      )
    }
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

  test('the bare protected FILE ~/.claude.json is guarded, and only that exact path', () => {
    // `protectedFiles` is a separate mechanism from `protectedRoots`: ~/.claude.json
    // sits NEXT TO the protected dirs, not inside them, so the root prefix check
    // never sees it. Nothing proved it until a mutation removed the entry and the
    // whole suite stayed green — the #7267 defect, in the #7267 fix.
    // `renameSync(<absent source>, target)`, NOT writeFileSync. ~/.claude.json's
    // parent is $HOME, which EXISTS — so a plain write probe would overwrite the
    // developer's real 168KB file the moment the guard regressed, which is the
    // one scenario this assertion is for. With an absent source, a bypass fails
    // on the source before it touches the destination (measured), so a failing
    // run is inert.
    assert.strictEqual(
      probeSyncLocal(() => namedRenameSync(absentSource, join(homedir(), '.claude.json'))),
      'CHROXY_TEST_SANDBOX',
      'byok-mcp-config writes ~/.claude.json; the guard must refuse it.',
    )
    // Discrimination: the guard matches that exact path, not the basename.
    assert.strictEqual(
      probeSyncLocal(() => namedRenameSync(absentSource, join(tmpdir(), '.claude.json'))),
      'ENOENT',
      'The guard matched on the file NAME rather than the full path.',
    )
  })

  test('the OTHER protected root, ~/.claude, is guarded too', () => {
    assert.strictEqual(
      probeSyncLocal(() => namedWriteFileSync(claudeProbe, 'probe')), 'CHROXY_TEST_SANDBOX',
      '_setup.mjs passes both ~/.chroxy and ~/.claude as protected roots; every ' +
      'other probe here aims at the first, so the second was unobserved.',
    )
  })

  test('reads of the real home are still allowed', () => {
    // Deliberate: `providers.test.js` and friends legitimately read the
    // developer's real config. A guard that blocked reads would be "safer" and
    // would break the suite, so the exemption is pinned, not assumed.
    //
    // These are PATCHED functions asked to do a read-shaped thing. `existsSync`
    // and `readdirSync` used to stand here and could not fail: both are in
    // FS_EXEMPTIONS, so the guard never wrapped them and the test observed
    // nothing. `openSync(..., 'r')` goes through the wrapper and out the other
    // side, which is the property that actually matters.
    assert.strictEqual(probeSyncLocal(() => namedOpenSync(protectedPath, 'r')), 'ENOENT')
    // A read that reaches the real fs and is refused BY THE KERNEL, not by us.
    assert.strictEqual(
      probeSyncLocal(() => fsNamespace.readFileSync(join(homedir(), '.chroxy', 'no-such-file'), 'utf8')),
      'ENOENT',
    )
  })
})

describe('write sandbox: the probes created nothing under the real home (#7267)', () => {
  // The acceptance criterion #7267 was filed on. `cpSync` is why it is asserted
  // rather than reasoned: it creates the destination's parent chain before it
  // fails, so a probe aimed at a NON-EXISTENT path under ~/.chroxy left a real
  // directory there — through an armed sandbox — while every other probe in
  // this file is safe by construction. This assertion runs last on purpose.
  test('no probe root exists under ~/.chroxy or ~/.claude', () => {
    const roots = [PROBE_ROOT, join(homedir(), '.claude', `__chroxy-sandbox-coverage-${process.pid}`)]
    const leaked = roots.some((r) => namedExistsSync(r))
    if (leaked) removeProbeRoot()
    assert.strictEqual(
      leaked, false,
      `A probe created real state at ${PROBE_ROOT}. It has been removed, but the ` +
      `sandbox let a write through — that is the #4633 bug, live.`,
    )
  })
})
