// is-entry-point.test.js — pins the one entry-point guard (#7213, #7217).
//
// The guard's failure mode is SILENCE: it returns false, main() never runs,
// and the process exits 0. Nothing observable distinguishes that from a clean
// no-op, which is how the bug survived in four files. So every case here
// asserts the boolean directly rather than any downstream side effect.
//
// `process.argv[1]` is read at call time, which is what makes these tests
// possible in-process: each one points argv[1] at a path it controls and
// restores it afterwards.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isEntryPoint } from '../src/utils/is-entry-point.js'

let dir
let realDir
let linkDir
let realScript
let siblingScript
let linkedScript

before(() => {
  // The base is deliberately NOT realpath'd. On macOS os.tmpdir() is under
  // /var, itself a symlink to /private/var — so these paths carry a real
  // unresolved symlink, the same shape as the /tmp case that started this.
  dir = mkdtempSync(join(tmpdir(), 'chroxy-entry-'))
  realDir = join(dir, 'real')
  linkDir = join(dir, 'link')
  mkdirSync(realDir)
  realScript = join(realDir, 'probe.js')
  writeFileSync(realScript, 'export const x = 1\n')
  // A real, EXISTING sibling. argv[1] pointing at a path that was never created
  // looks like "some other script" but behaves nothing like one: realpath fails
  // and the case short-circuits before the guard's main comparison. That gap let
  // `return realSelf === realInvoked` be hardwired to `return true` — every
  // ordinary import running main() — with the whole suite still green.
  siblingScript = join(realDir, 'sibling.js')
  writeFileSync(siblingScript, 'export const y = 2\n')
  symlinkSync(realDir, linkDir, 'dir')
  linkedScript = join(linkDir, 'probe.js')
})

after(() => {
  rmSync(dir, { recursive: true, force: true })
})

const withArgv1 = (value, fn) => {
  const saved = process.argv[1]
  process.argv[1] = value
  try {
    return fn()
  } finally {
    process.argv[1] = saved
  }
}

// The #7226 warning is captured rather than left to scroll past: a test that
// only checked the boolean would pass identically whether the diagnostic was
// printed or not, which is the same "assert the observable, not the intent"
// reasoning as the rest of this file.
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

describe('isEntryPoint', () => {
  it('is true when the module IS the invoked script', () => {
    withArgv1(realScript, () => {
      assert.equal(isEntryPoint(pathToFileURL(realScript).href), true)
    })
  })

  it('is false when the module is merely imported', () => {
    withArgv1(siblingScript, () => {
      assert.equal(isEntryPoint(pathToFileURL(realScript).href), false)
    })
  })

  // The negative control for the guard's MAIN comparison: both paths exist and
  // realpath cleanly, so the answer comes from `realSelf === realInvoked`
  // rather than from a short-circuit. Without it, hardwiring that line to
  // `return true` passed every test in this file.
  it('is false when argv[1] is a DIFFERENT file that EXISTS', () => {
    const { value, lines } = capturingWarnings(() =>
      withArgv1(siblingScript, () => isEntryPoint(pathToFileURL(realScript).href)))
    assert.equal(value, false, 'an ordinary import must not be treated as the entry point')
    assert.deepEqual(lines, [], 'ordinary imports must stay silent')
  })

  // The original bug (#7198). Node's ESM loader resolves symlinks in
  // import.meta.url; argv[1] is whatever the caller typed. Every hand-rolled
  // guard compared one against the other and read false.
  it('is true when invoked through a symlinked directory', () => {
    withArgv1(linkedScript, () => {
      assert.equal(isEntryPoint(pathToFileURL(realScript).href), true)
    })
  })

  it('is true when import.meta.url is the symlinked side', () => {
    withArgv1(realScript, () => {
      assert.equal(isEntryPoint(pathToFileURL(linkedScript).href), true)
    })
  })

  // The #7217 review finding, and the reason the plain comparison runs first.
  //
  // A path that cannot be realpath'd stands in for the EACCES / unlinked-script
  // cases that are not portable to construct: ENOENT takes the identical branch
  // in the guard. With realpath consulted FIRST, this returns false — a direct
  // `node foo.js` that silently does nothing, which is precisely the class the
  // module was written to eliminate.
  //
  // Mutation check: put the realpath comparison back in front of the plain one
  // and this is the assertion that goes red.
  it('is true for identical paths even when they cannot be realpath\'d', () => {
    const ghost = join(dir, 'does-not-exist', 'probe.js')
    withArgv1(ghost, () => {
      assert.equal(isEntryPoint(pathToFileURL(ghost).href), true)
    })
  })

  // Negative control for the case above: the un-realpath-able path must not
  // become a blanket "true", or the assertion above would pass for the wrong
  // reason.
  it('is false for DIFFERING paths that cannot be realpath\'d', () => {
    const { value } = capturingWarnings(() =>
      withArgv1(join(dir, 'nowhere', 'a.js'), () =>
        isEntryPoint(pathToFileURL(join(dir, 'nowhere', 'b.js')).href)))
    assert.equal(value, false)
  })

  it('is false when there is no invoked script (node -e, REPL)', () => {
    withArgv1(undefined, () => {
      assert.equal(isEntryPoint(pathToFileURL(realScript).href), false)
    })
  })

  it('resolves a relative argv[1] before comparing', () => {
    const saved = process.cwd()
    process.chdir(realDir)
    try {
      withArgv1('./probe.js', () => {
        assert.equal(isEntryPoint(pathToFileURL(realScript).href), true)
      })
    } finally {
      process.chdir(saved)
    }
  })

  // --- #7226: undecidable must not also mean silent -------------------------
  //
  // `false` stays the right answer when the paths differ and cannot be
  // resolved — but returning it without a word is the property that made #7198
  // and #7214 expensive to find. These cases mirror
  // scripts/__tests__/is-entry-point.test.mjs, which pins the scripts/ copy of
  // this same guard; keep the two tables in step (#7222).
  describe('the undecidable case warns (#7226)', () => {
    it('warns when it returns false because realpath failed', () => {
      const { value, lines } = capturingWarnings(() =>
        withArgv1(join(dir, 'nowhere', 'a.js'), () =>
          isEntryPoint(pathToFileURL(join(dir, 'nowhere', 'b.js')).href)))
      assert.equal(value, false, 'undecidable must still answer false')
      assert.equal(lines.length, 1, `expected exactly one warning, got ${JSON.stringify(lines)}`)
      // Anchored to the PREFIX: the path list in the reason also contains
      // 'b.js', so a bare /b\.js/ passed even with basename(self) emptied.
      assert.match(lines[0], /^\[is-entry-point] b\.js:/)
      // The reason, not just the fact: a bare "could not determine" sends the
      // reader back to reproducing it; the errno says which path broke and how.
      assert.match(lines[0], /ENOENT|EACCES/)
    })

    // The other half of the acceptance criteria, and the one that keeps this
    // from becoming noise. `self` and `invoked` are not symmetric: argv[1]
    // pointing at a file that does not exist is a DECIDED false (it cannot be
    // the module we were loaded from), and it is also what every ordinary
    // import looks like. Warning there would fire on every guarded import in
    // the suite and the real signal would stop being read.
    it('stays silent for the ordinary imported-not-run false', () => {
      const { value, lines } = capturingWarnings(() =>
        withArgv1(siblingScript, () => isEntryPoint(pathToFileURL(realScript).href)))
      assert.equal(value, false)
      assert.deepEqual(lines, [], 'an imported module must not warn')
    })

    it('stays silent when there is no invoked script (node -e, REPL)', () => {
      const { value, lines } = capturingWarnings(() =>
        withArgv1(undefined, () => isEntryPoint(pathToFileURL(realScript).href)))
      assert.equal(value, false)
      assert.deepEqual(lines, [])
    })

    it('stays silent on the happy path', () => {
      const { value, lines } = capturingWarnings(() =>
        withArgv1(realScript, () => isEntryPoint(pathToFileURL(realScript).href)))
      assert.equal(value, true)
      assert.deepEqual(lines, [])
    })

    // The boundary between the two cases above, and the only one that tells
    // "argv[1] is absent" apart from "the filesystem refused to say". Both
    // answer false; only this one is unknowable, because an unreadable path
    // could still be a symlink to this very module. Without it, collapsing the
    // rule back to "warn on any realpath failure" would pass every other test.
    //
    // chmod 0000 does not deny root, so this would exercise nothing as root.
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
    it('warns when argv[1] is UNREADABLE rather than absent', { skip: asRoot && 'running as root' }, () => {
      const locked = join(dir, 'locked')
      mkdirSync(locked, { recursive: true })
      writeFileSync(join(locked, 'entry.js'), '\n')
      chmodSync(locked, 0o000)
      try {
        const { value, lines } = capturingWarnings(() =>
          withArgv1(join(locked, 'entry.js'), () =>
            isEntryPoint(pathToFileURL(realScript).href)))
        assert.equal(value, false)
        assert.equal(lines.length, 1, `EACCES is unknowable, not decided: ${JSON.stringify(lines)}`)
        assert.match(lines[0], /EACCES/)
      } finally {
        chmodSync(locked, 0o755)
      }
    })
  })
})
