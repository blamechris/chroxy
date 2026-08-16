#!/usr/bin/env node
/**
 * is-entry-point.test.mjs — pins scripts/lib/is-entry-point.mjs (#7222, #7226).
 *
 * The guard's failure mode is SILENCE: it returns false, the CLI branch never
 * runs, and the process exits 0. Nothing observable distinguishes that from a
 * clean no-op, which is how the bug survived in four files (#7198, #7213,
 * #7214). So every case here asserts the boolean directly rather than any
 * downstream side effect.
 *
 * The case table below is deliberately the same one as
 * packages/server/tests/is-entry-point.test.js. That file cannot be shared —
 * `scripts/` is outside every workspace package and imports nothing from
 * `packages/*​/src` — so the two copies of the guard are held equal by testing
 * both against equivalent tables rather than by a single import. If you add a
 * case to one, add it to the other.
 *
 * `process.argv[1]` is read at call time, which is what makes these tests
 * possible in-process: each one points argv[1] at a path it controls and
 * restores it afterwards.
 *
 * No external test framework. Run from repo root:
 *   node scripts/__tests__/is-entry-point.test.mjs
 */

import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { isEntryPoint } from '../lib/is-entry-point.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Every case in this file, including the ones that skip themselves. Bump it
// when you add one — that is the point: a case that vanishes should break the
// run rather than quietly shrink it.
const MIN_CASES = 18

let pass = 0
let fail = 0
let skipped = 0
const failures = []

const test = (name, fn) => {
  try {
    fn()
    pass++
    process.stdout.write(`  ok ${name}\n`)
  } catch (err) {
    fail++
    failures.push({ name, err })
    process.stdout.write(`  FAIL ${name}: ${err.message}\n`)
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed')
}

// The base is deliberately NOT realpath'd. On macOS os.tmpdir() is under /var,
// itself a symlink to /private/var — so these paths carry a real unresolved
// symlink, the same shape as the /tmp case that started this.
const dir = mkdtempSync(join(tmpdir(), 'chroxy-entry-'))
const realDir = join(dir, 'real')
const linkDir = join(dir, 'link')
mkdirSync(realDir)
const realScript = join(realDir, 'probe.js')
writeFileSync(realScript, 'export const x = 1\n')
// A real, EXISTING sibling. Pointing argv[1] at a path that was never created
// looks like "some other script" but behaves nothing like one: realpath fails,
// so every such case short-circuits before the guard's main comparison is ever
// reached. That fixture gap let `return realSelf === realInvoked` be hardwired
// to `return true` — every ordinary import running main() — with all three
// suites still green.
const siblingScript = join(realDir, 'sibling.js')
writeFileSync(siblingScript, 'export const y = 2\n')
symlinkSync(realDir, linkDir, 'dir')
const linkedScript = join(linkDir, 'probe.js')

const withArgv1 = (value, fn) => {
  const saved = process.argv[1]
  process.argv[1] = value
  try {
    return fn()
  } finally {
    process.argv[1] = saved
  }
}

// The warning is the whole point of #7226, so it is captured rather than left
// to scroll past: a test that only checked the boolean would pass identically
// whether the diagnostic was printed or not.
const capturingWarnings = (fn) => {
  const saved = console.warn
  const lines = []
  console.warn = (...args) => lines.push(args.join(' '))
  try {
    return { value: fn(), lines }
  } finally {
    console.warn = saved
  }
}

try {
  test('is true when the module IS the invoked script', () => {
    withArgv1(realScript, () => {
      assert(isEntryPoint(pathToFileURL(realScript).href) === true)
    })
  })

  test('is false when the module is merely imported', () => {
    withArgv1(siblingScript, () => {
      assert(isEntryPoint(pathToFileURL(realScript).href) === false)
    })
  })

  // The negative control for the guard's MAIN comparison, and the one the
  // suite was missing: both paths exist and realpath cleanly, so the answer
  // comes from `realSelf === realInvoked` rather than from a short-circuit.
  // Without it, hardwiring that line to `return true` passed every test here.
  test('is false when argv[1] is a DIFFERENT file that EXISTS', () => {
    const { value, lines } = capturingWarnings(() =>
      withArgv1(siblingScript, () => isEntryPoint(pathToFileURL(realScript).href)))
    assert(value === false, 'an ordinary import must not be treated as the entry point')
    assert(lines.length === 0, `ordinary imports must stay silent, got: ${JSON.stringify(lines)}`)
  })

  // The original bug (#7198). Node's ESM loader resolves symlinks in
  // import.meta.url; argv[1] is whatever the caller typed. Every hand-rolled
  // guard compared one against the other and read false.
  test('is true when invoked through a symlinked directory', () => {
    withArgv1(linkedScript, () => {
      assert(isEntryPoint(pathToFileURL(realScript).href) === true)
    })
  })

  test('is true when import.meta.url is the symlinked side', () => {
    withArgv1(realScript, () => {
      assert(isEntryPoint(pathToFileURL(linkedScript).href) === true)
    })
  })

  // The #7217 review finding, and the reason the plain comparison runs first.
  // A path that cannot be realpath'd stands in for the EACCES / unlinked-script
  // cases that are not portable to construct: ENOENT takes the identical branch.
  //
  // Mutation check: DELETING the plain comparison reddens this. Note that
  // merely REORDERING it after the realpath decision does not — the answer
  // stays true via realpath — which is why the silence assertion is here too.
  // A reordered guard warns on a successful direct run whose path cannot be
  // realpath'd: the cry-wolf failure #7226's own rationale argues against.
  test("is true for identical paths even when they cannot be realpath'd", () => {
    const ghost = join(dir, 'does-not-exist', 'probe.js')
    const { value, lines } = capturingWarnings(() =>
      withArgv1(ghost, () => isEntryPoint(pathToFileURL(ghost).href)))
    assert(value === true)
    assert(lines.length === 0, `a decided TRUE must not warn, got: ${JSON.stringify(lines)}`)
  })

  // Negative control for the case above: the un-realpath-able path must not
  // become a blanket "true", or the assertion above would pass for the wrong
  // reason.
  test("is false for DIFFERING paths that cannot be realpath'd", () => {
    const { value } = capturingWarnings(() =>
      withArgv1(join(dir, 'nowhere', 'a.js'), () =>
        isEntryPoint(pathToFileURL(join(dir, 'nowhere', 'b.js')).href)))
    assert(value === false)
  })

  test('is false when there is no invoked script (node -e, REPL)', () => {
    withArgv1(undefined, () => {
      assert(isEntryPoint(pathToFileURL(realScript).href) === false)
    })
  })

  test('resolves a relative argv[1] before comparing', () => {
    const saved = process.cwd()
    process.chdir(realDir)
    try {
      withArgv1('./probe.js', () => {
        assert(isEntryPoint(pathToFileURL(realScript).href) === true)
      })
    } finally {
      process.chdir(saved)
    }
  })

  // The case above passes even without resolve(), because realpathSync ALSO
  // resolves a relative path against cwd — so it drops through to the realpath
  // fallback and still answers true. What actually needs resolve() is the
  // FILESYSTEM-FREE fast path the sidecar's comment cites (`node ./agent.js`):
  // with a path that cannot be realpath'd, only resolve() can still decide.
  test('resolves a relative argv[1] WITHOUT touching the filesystem', () => {
    const saved = process.cwd()
    // Canonical, unlike the other fixtures here. process.cwd() reports a
    // realpath'd path, so chdir'ing into the symlinked /var form would make
    // resolve() and `self` disagree for a reason that has nothing to do with
    // this test — it would fall through to realpath and prove nothing.
    const canonicalDir = realpathSync(realDir)
    process.chdir(canonicalDir)
    try {
      const ghost = join(canonicalDir, 'ghost.js')
      const { value, lines } = capturingWarnings(() =>
        withArgv1('./ghost.js', () => isEntryPoint(pathToFileURL(ghost).href)))
      assert(value === true, 'a relative direct invocation must decide without realpath')
      assert(lines.length === 0, `the fast path must not warn, got: ${JSON.stringify(lines)}`)
    } finally {
      process.chdir(saved)
    }
  })

  // --- #7226: undecidable must not also mean silent ------------------------
  //
  // "Undecidable" is the honest answer for differing paths that cannot be
  // realpath'd, and `false` stays the right return. What was wrong was that
  // nothing was printed: a human running the script directly saw an exit-0
  // no-op with no output, which is the property that made #7198 and #7214
  // expensive to find.
  test('warns when it returns false because realpath FAILED (#7226)', () => {
    const { value, lines } = capturingWarnings(() =>
      withArgv1(join(dir, 'nowhere', 'a.js'), () =>
        isEntryPoint(pathToFileURL(join(dir, 'nowhere', 'b.js')).href)))
    assert(value === false, 'undecidable must still answer false')
    assert(lines.length === 1, `expected exactly one warning, got ${lines.length}: ${JSON.stringify(lines)}`)
    assert(lines[0].includes('[is-entry-point]'), 'warning must be attributable to this guard')
    // Anchored to the PREFIX, not just "contains b.js": the path list in the
    // reason also contains 'b.js', so a `contains` check passed even with
    // `${basename(self)}` replaced by the empty string.
    assert(/^\[is-entry-point] b\.js:/.test(lines[0]),
      `warning must lead with the module that could not decide: ${lines[0]}`)
    // The reason, not just the fact. A bare "could not determine" sends the
    // reader back to reproducing it; the errno says which path broke and how.
    assert(/ENOENT|EACCES/.test(lines[0]), `warning must carry the realpath errno: ${lines[0]}`)
  })

  // The other half of the acceptance criteria, and the one that keeps this
  // from becoming noise: the ORDINARY false — "this module was imported" —
  // must stay quiet, or every test run that imports a guarded module prints a
  // spurious warning and the real one stops being noticed.
  test('stays SILENT for the ordinary imported-not-run false (#7226)', () => {
    const { value, lines } = capturingWarnings(() =>
      withArgv1(siblingScript, () => isEntryPoint(pathToFileURL(realScript).href)))
    assert(value === false)
    assert(lines.length === 0, `imported-module case must not warn, got: ${JSON.stringify(lines)}`)
  })

  // The boundary of the rule above, and the only case that distinguishes
  // "argv[1] does not exist" from "the filesystem refused to say". Both make
  // realpath return null and both answer false; only this one is UNKNOWABLE,
  // because an unreadable path could still be a symlink to this very module.
  // Without this case the ENOENT/EACCES split is asserted in only one
  // direction, and collapsing it back to "warn on any failure" would go
  // undetected by every other test here.
  //
  // chmod 0000 does not deny root, so as root this would exercise nothing.
  // Skipped rather than silently weakened.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    skipped++
    process.stdout.write('  skip warns when argv[1] is unreadable rather than absent (#7226): running as root\n')
  } else {
    test('warns when argv[1] is UNREADABLE rather than absent (#7226)', () => {
      const locked = join(dir, 'locked')
      mkdirSync(locked)
      writeFileSync(join(locked, 'entry.js'), '\n')
      chmodSync(locked, 0o000)
      try {
        const { value, lines } = capturingWarnings(() =>
          withArgv1(join(locked, 'entry.js'), () =>
            isEntryPoint(pathToFileURL(realScript).href)))
        assert(value === false)
        assert(lines.length === 1, `EACCES on argv[1] is unknowable, not decided: ${JSON.stringify(lines)}`)
        assert(/EACCES/.test(lines[0]), `warning must carry the errno: ${lines[0]}`)
      } finally {
        chmodSync(locked, 0o755)
      }
    })
  }

  test('stays SILENT when there is no invoked script at all (#7226)', () => {
    const { value, lines } = capturingWarnings(() =>
      withArgv1(undefined, () => isEntryPoint(pathToFileURL(realScript).href)))
    assert(value === false)
    assert(lines.length === 0, `node -e / REPL must not warn, got: ${JSON.stringify(lines)}`)
  })

  test('stays SILENT on the happy path (#7226)', () => {
    const { value, lines } = capturingWarnings(() =>
      withArgv1(realScript, () => isEntryPoint(pathToFileURL(realScript).href)))
    assert(value === true)
    assert(lines.length === 0, `direct invocation must not warn, got: ${JSON.stringify(lines)}`)
  })

  // --- #7222: the drift gate ------------------------------------------------
  //
  // This guard exists in three places and cannot be reduced to one. `scripts/`
  // imports nothing from `packages/*​/src`, and sidecar/agent.js ships as a
  // standalone in-pod bundle whose Dockerfile COPYs only agent.js and its
  // package.json — so neither can import the other.
  //
  // "Keep them in sync by hand" is exactly the arrangement that produced #7198:
  // one guard was fixed, three were not, and nothing said so because the
  // failure mode is silence. Comments asking the next person to remember do not
  // fail a build. This does.
  //
  // Comments are stripped before comparing because they legitimately differ —
  // the sidecar's talk about pods — and `import.meta.url` is normalised to the
  // parameter name because the sidecar is an inline IIFE rather than a function
  // taking the URL as an argument. Everything else must match exactly.
  const GUARD_COPIES = [
    'scripts/lib/is-entry-point.mjs',
    'packages/server/src/utils/is-entry-point.js',
    'packages/server/sidecar/agent.js',
  ]

  const extractGuard = (relPath) => {
    const lines = readFileSync(join(REPO, relPath), 'utf8').split('\n')
    const start = lines.findIndex((l) => l.includes('if (!process.argv[1]) return false'))
    if (start === -1) throw new Error(`${relPath}: could not find the start of the guard`)
    const end = lines.indexOf('  return false', start)
    if (end === -1) throw new Error(`${relPath}: could not find the end of the guard`)
    return lines
      .slice(start, end + 1)
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('//'))
      .join('\n')
      .replace(/import\.meta\.url/g, 'importMetaUrl')
  }

  // Positive control. Every assertion below compares extracted text, so an
  // extraction that silently returned '' — a renamed variable, a reformatted
  // line, a moved guard — would make all three compare equal and the gate would
  // report success having compared nothing. That is the same vacuous-pass shape
  // the rest of this file is written against, so prove the extraction found
  // real code before trusting any comparison of it.
  test('the guard extraction finds real code in every copy (positive control)', () => {
    for (const relPath of GUARD_COPIES) {
      const body = extractGuard(relPath)
      const count = body.split('\n').length
      assert(count >= 20, `${relPath}: extracted only ${count} line(s) — the gate below would be vacuous`)
      assert(body.includes('realpathSync'), `${relPath}: extract is missing the realpath call`)
      assert(body.includes('console.warn'), `${relPath}: extract is missing the #7226 diagnostic`)
      assert(body.includes('realSelf'), `${relPath}: extract is missing the realpath comparison`)
    }
  })

  // The extraction starts at the argv[1] line, so the import statements sit
  // OUTSIDE the compared region — and `basename` is used only inside the warn
  // branch. Dropping it from any one copy left the gate green while making that
  // copy throw ReferenceError the moment the branch fired. In the sidecar that
  // means the pod dies at startup, in the one branch whose entire job is to
  // explain a problem: strictly worse than the silent no-op it replaced.
  test('every copy imports the bindings its guard body uses (#7222)', () => {
    const NEEDED = ['realpathSync', 'basename', 'resolve', 'fileURLToPath']
    for (const relPath of GUARD_COPIES) {
      const src = readFileSync(join(REPO, relPath), 'utf8')
      const imports = src.split('\n').filter((l) => l.trimStart().startsWith('import '))
      assert(imports.length, `${relPath}: no import statements found — extraction is wrong`)
      const bound = imports.join('\n')
      for (const name of NEEDED) {
        assert(
          new RegExp(`\\b${name}\\b`).test(bound),
          `${relPath} uses ${name} in the guard but never imports it — ` +
          'the drift gate cannot see this because imports are outside the compared region',
        )
      }
    }
  })

  test('all three copies of the guard are identical (#7222 drift gate)', () => {
    const [reference, ...rest] = GUARD_COPIES.map((p) => [p, extractGuard(p)])
    for (const [relPath, body] of rest) {
      assert(
        body === reference[1],
        `${relPath} has drifted from ${reference[0]}.\n` +
        'These three copies must stay in step — see the header of scripts/lib/is-entry-point.mjs.\n' +
        `--- ${reference[0]}\n${reference[1]}\n--- ${relPath}\n${body}`,
      )
    }
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// A count floor. Several cases skip themselves as root (chmod 0000 does not
// deny root), and the self-hosted Linux pool has root container members — so
// without this, a run there prints "14 passed, 0 failed", exits 0, and looks
// identical to a healthy run. Scripts Tests has no coverage threshold to catch
// it either. Assert the shape of the run, not just that nothing failed.
const EXPECTED = pass + fail + skipped
if (EXPECTED < MIN_CASES) {
  process.stderr.write(
    `\nERROR: only ${EXPECTED} case(s) accounted for, expected at least ${MIN_CASES}. ` +
    'Cases went missing rather than failing — check the root/platform skips.\n',
  )
  process.exit(1)
}
process.stdout.write(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n`)
if (fail > 0) {
  for (const f of failures) {
    process.stderr.write(`\n[FAIL] ${f.name}\n${f.err.stack || f.err.message}\n`)
  }
  process.exit(1)
}
process.exit(0)
