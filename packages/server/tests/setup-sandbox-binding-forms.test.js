/**
 * BINDING-FORM coverage for the write sandbox in `tests/_setup.mjs` (#7262).
 *
 * The sandbox patches the write-side of `node:fs` so a test that forgets a temp
 * path fails loudly instead of clobbering the developer's real `~/.chroxy` /
 * `~/.claude` (#4633). It patches the live CJS `module.exports` object. Whether
 * that patch is VISIBLE depends on how the consumer imported `fs`, and for
 * months it was visible to only two of the four forms:
 *
 *   CJS require          patched      import * as fs from 'fs'     UNPATCHED
 *   import fs from 'fs'  patched      import { writeFileSync }     UNPATCHED
 *
 * 45 modules under `src/` import, BY NAME, one of the six write-side `fs`
 * functions the guard named at the time — so for all of them it was not armed
 * while still reporting success for everything else, the
 * `docs/false-safety-guards.md` shape exactly. (That figure is specific to the
 * old, narrow list, which is what makes it the right measure of what #7262
 * exposed. Against the surface #7267 now guards it is 53.)
 *
 * This file owns ONE axis: is the patch VISIBLE, whichever way `fs` was
 * imported. Whether it is WIDE ENOUGH — which methods are patched at all — is
 * `setup-sandbox-coverage.test.js` (#7267). It used to be both, via a
 * hand-written per-method list sitting beside the patch list in `_setup.mjs`;
 * that list is deleted, because a second hardcoded list beside a set that grows
 * is the same defect one level up. Both now expand from the one array in
 * `scripts/lib/test-fs-sandbox.mjs`.
 *
 * ── Why the fix is one deleted line, and why it needs a test at all ─────────
 *
 * Node builds the `node:fs` synthetic ESM module LAZILY, snapshotting its named
 * exports off `module.exports` at the first ESM import of it. `_setup.mjs` did
 * `import { mkdtempSync } from 'node:fs'` at the top; ESM imports evaluate
 * before the module body, so that one line took the snapshot from the UNPATCHED
 * object before the body could patch anything. Taking `mkdtempSync` off the CJS
 * object instead lets the snapshot happen later, already patched.
 *
 * That makes the fix invisible and trivially reversible: re-adding any innocuous
 * `import { … } from 'node:fs'` to `_setup.mjs` silently disarms the sandbox for
 * 45 modules again, and every other test in this suite still passes. This file
 * is the only thing standing between that edit and a repeat of #4633.
 *
 * ── How these assertions avoid writing to the real home ────────────────────
 *
 * Every probe targets a path under the protected root whose PARENT DIRECTORY
 * DOES NOT EXIST. That makes the two outcomes cleanly distinguishable without
 * risking real state:
 *
 *   guard fired      -> throws/rejects `CHROXY_TEST_SANDBOX`  (patched fn ran)
 *   guard bypassed   -> throws/rejects `ENOENT`               (real fs ran)
 *
 * The bypass case reaches the real syscall and is refused by the kernel for the
 * missing parent, so a FAILING run of this file still creates nothing. Asserting
 * on a real call's observable outcome — rather than reading `fn.name` — is
 * deliberate: a name check is a reading, and the sandbox's own first probe in
 * #7254 read as "working" because it happened to use a default import.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert'

// The four binding forms under test. This file MUST import `node:fs` all four
// ways — that is the point — and it is safe to do so here because `--import
// ./tests/_setup.mjs` has already run the patch by the time this file links.
import * as fsNamespace from 'node:fs'
import fsDefault from 'node:fs'
import { createRequire } from 'node:module'
import {
  writeFileSync as namedWriteFileSync,
  mkdirSync as namedMkdirSync,
  readFileSync as namedReadFileSync,
  rmSync as namedRmSync,
} from 'node:fs'

import * as fspNamespace from 'node:fs/promises'
import fspDefault from 'node:fs/promises'
import { writeFile as namedWriteFile } from 'node:fs/promises'

import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The repo's single comment stripper (#7248). Importing it from `scripts/lib`
// rather than re-implementing one here is deliberate: #7250 consolidated four
// hand-rolled strippers into this one after two of them were measured wrong in
// opposite directions on real files in this repo.
import { stripComments } from '../scripts/lib/strip-comments.mjs'

const require = createRequire(import.meta.url)
const fsCjs = require('node:fs')
const fspCjs = require('node:fs/promises')

// A path under the REAL protected root whose parent does not exist. Never
// created by any assertion below — see the header.
const MISSING_DIR = `__chroxy-sandbox-binding-probe-${process.pid}`
const protectedTarget = join(homedir(), '.chroxy', MISSING_DIR, 'probe.tmp')
// The control: identically shaped (missing parent) but NOT protected.
const unprotectedTarget = join(tmpdir(), MISSING_DIR, 'probe.tmp')

const GUARDED = 'guarded'
const REACHED_REAL_FS = 'reached-real-fs'

function classify(err) {
  if (!err) return 'no-error: the call SUCCEEDED, which means it wrote to a real path'
  if (err.code === 'CHROXY_TEST_SANDBOX') return GUARDED
  if (err.code === 'ENOENT') return REACHED_REAL_FS
  return `unexpected: ${err.code || err.message}`
}

function probeSync(fn, ...args) {
  try {
    fn(...args)
    return classify(null)
  } catch (err) {
    return classify(err)
  }
}

async function probeAsync(fn, ...args) {
  try {
    const handle = await fn(...args)
    if (handle && typeof handle.close === 'function') await handle.close()
    return classify(null)
  } catch (err) {
    return classify(err)
  }
}

describe('write sandbox: all four fs binding forms are guarded (#7262)', () => {
  // ── The axis that was broken: HOW `fs` was imported ──────────────────────
  //
  // `writeFileSync` stands in for the whole write-side here on purpose. The
  // binding-form defect is not per-method: if the named-export snapshot was
  // taken before the patch, EVERY method on it is stale together. The
  // per-method axis is covered separately below.
  const fsForms = [
    ['CJS require',          () => fsCjs.writeFileSync],
    ['ESM default import',   () => fsDefault.writeFileSync],
    ['ESM namespace import', () => fsNamespace.writeFileSync],
    ['ESM named import',     () => namedWriteFileSync],
  ]

  for (const [label, get] of fsForms) {
    test(`node:fs writeFileSync via ${label} is guarded`, () => {
      assert.strictEqual(
        probeSync(get(), protectedTarget, 'probe'),
        GUARDED,
        `${label} bypassed the sandbox. If this is the namespace/named form, ` +
        `something in tests/_setup.mjs is importing 'node:fs' via ESM again — ` +
        `that snapshots the unpatched exports before the body runs (#7262).`,
      )
    })
  }

  // `node:fs/promises` is the natural CONTROL for the root cause: it is a
  // separate synthetic module, `_setup.mjs` never ESM-imported it, and all four
  // of its forms were already guarded while `node:fs` named/namespace were not.
  // The two differ in exactly one thing — whether `_setup.mjs` links them
  // early — which is what identifies that import as the cause rather than a
  // correlate. Pinned here so the control cannot silently rot either.
  const fspForms = [
    ['CJS require',          () => fspCjs.writeFile],
    ['ESM default import',   () => fspDefault.writeFile],
    ['ESM namespace import', () => fspNamespace.writeFile],
    ['ESM named import',     () => namedWriteFile],
  ]

  for (const [label, get] of fspForms) {
    test(`node:fs/promises writeFile via ${label} is guarded`, async () => {
      assert.strictEqual(
        await probeAsync(get(), protectedTarget, 'probe'),
        GUARDED,
        `${label} of node:fs/promises bypassed the sandbox.`,
      )
    })
  }

  // This must be a test(), not a bare assert in the describe() body. A throw
  // during collection CANCELS the sibling tests rather than failing one, and
  // node:test reports cancelled subtests with `# fail 0` — a green-looking
  // summary for a suite that never ran. That is the false-safety shape this
  // whole file exists to prevent, so it must not appear in the file itself.
  test('node:fs/promises IS fs.promises, which is why patching the latter covers it', () => {
    assert.strictEqual(
      fsCjs.promises, fspCjs,
      'node:fs/promises is expected to BE fs.promises — the sandbox patches the ' +
      'latter and relies on that identity to cover the former.',
    )
  })
})

describe('write sandbox: controls', () => {
  // POSITIVE CONTROL. Every assertion above passes when the guard throws
  // CHROXY_TEST_SANDBOX and fails when the call reaches the real fs and gets
  // ENOENT. That distinction is worthless unless ENOENT is genuinely what the
  // unguarded path looks like here — otherwise the suite would be green because
  // nothing ever reaches the syscall, not because the guard is armed.
  //
  // Same shape, same missing parent, only the root differs.
  test('an UNPROTECTED missing-parent path reaches the real fs (ENOENT)', () => {
    assert.strictEqual(
      probeSync(namedWriteFileSync, unprotectedTarget, 'probe'),
      REACHED_REAL_FS,
      'The control did not reach the real fs, so ENOENT is not a valid ' +
      'signature for "bypassed" and the guarded assertions above prove nothing.',
    )
  })

  test('the guard discriminates by path, not by throwing at everything', () => {
    // If the patched functions rejected every call, the tests above would pass
    // for the wrong reason. A legitimate temp write must still succeed —
    // through the NAMED import specifically, since that binding is the one the
    // fix changed.
    const dir = join(tmpdir(), `chroxy-sandbox-binding-ok-${process.pid}`)
    try {
      namedMkdirSync(dir, { recursive: true })
      const file = join(dir, 'legit.txt')
      namedWriteFileSync(file, 'ok')
      assert.strictEqual(namedReadFileSync(file, 'utf8'), 'ok')
    } finally {
      namedRmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('write sandbox: the cause is pinned structurally too (#7262)', () => {
  // The behavioural tests above are the real guard — they fail on the OUTCOME
  // however it is reintroduced. This one adds nothing to coverage; it exists so
  // the failure NAMES the cause, because the outcome-level failure ("named
  // import bypassed the sandbox") does not obviously point at an import
  // statement three files away.
  //
  // It walks the whole GRAPH, not just `_setup.mjs`. The file-local version was
  // correct only while `_setup.mjs` imported nothing local, and that stopped
  // being true when #7267 moved the guard into
  // `scripts/lib/test-fs-sandbox.mjs`: an ESM `node:fs` import THERE is linked
  // as part of `_setup.mjs`'s graph and disarms the sandbox identically. The
  // header of `_setup.mjs` always stated the wider condition; this now checks
  // it instead of asking the next reader to remember it.

  // Static `import`/`export … from`, including the no-space form (`}from'x'`),
  // which the first version of this pattern let through.
  const ESM_IMPORT = /(^|\n)[ \t]*(?:import|export)\s+(?:[\s\S]*?\bfrom\s*)?['"]([^'"]+)['"]/g
  // `import('x')` is an edge too. A top-level `await import('node:fs')` disarms
  // the guard exactly as a static import does — it links the synthetic module —
  // and the static pattern above produces NO match for it, so the check that
  // exists to name the cause reported the cause absent.
  const DYNAMIC_IMPORT_LITERAL = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  // A dynamic import whose specifier is NOT a literal cannot be followed at
  // all, and must be reported rather than skipped.
  const DYNAMIC_IMPORT_ANY = /\bimport\s*\(/g
  const IS_FS = /^(node:)?fs(\/promises)?$/

  function scan (fileUrl) {
    const path = fileURLToPath(fileUrl)
    const source = namedReadFileSync(path, 'utf8')
    // Comments must be blanked first, and with the repo's ONE stripper
    // (`scripts/lib/strip-comments.mjs`, #7248) rather than a second local
    // regex. Both `_setup.mjs` and the shared module deliberately QUOTE
    // `import { mkdtempSync } from 'node:fs'` in their headers to explain the
    // bug, so a check that reads raw source flags the very comment warning
    // against the thing. The stripper preserves offsets, so line numbers
    // computed here stay valid against the original file.
    const blanked = stripComments(source, path)
    const found = []
    const record = (index, length, specifier) => {
      const at = index + (source.slice(index, index + 1) === '\n' ? 1 : 0)
      found.push({
        specifier,
        line: source.slice(0, at).split('\n').length,
        statement: source.slice(at, at + length).trim(),
      })
    }
    for (const m of blanked.matchAll(ESM_IMPORT)) record(m.index, m[0].length, m[2])
    for (const m of blanked.matchAll(DYNAMIC_IMPORT_LITERAL)) record(m.index, m[0].length, m[1])

    const literalDynamic = [...blanked.matchAll(DYNAMIC_IMPORT_LITERAL)].length
    const allDynamic = [...blanked.matchAll(DYNAMIC_IMPORT_ANY)].length
    for (let i = 0; i < allDynamic - literalDynamic; i++) {
      found.push({ specifier: '<computed dynamic import>', line: 0, statement: 'import(<expression>)' })
    }
    return found
  }

  test('nothing in tests/_setup.mjs\'s import graph ESM-imports node:fs', () => {
    const entry = new URL('./_setup.mjs', import.meta.url).href
    const seen = new Set()
    const queue = [entry]
    const offending = []
    const unwalkable = []

    while (queue.length > 0) {
      const url = queue.shift()
      if (seen.has(url)) continue
      seen.add(url)
      for (const imp of scan(url)) {
        if (IS_FS.test(imp.specifier)) {
          offending.push({ file: fileURLToPath(url).split('/chroxy/').pop(), line: imp.line, statement: imp.statement })
        } else if (imp.specifier.startsWith('.')) {
          queue.push(new URL(imp.specifier, url).href)
        } else if (!imp.specifier.startsWith('node:')) {
          // "Cannot check this" must never be recorded as "nothing to check" —
          // that is `docs/false-safety-guards.md` the "Silently skipped an input" mode, and it is how a
          // guard reports success over a file it never opened. A bare package
          // specifier is unresolvable here, so it FAILS rather than being
          // skipped: whatever it pulls in is exactly the transitive `node:fs`
          // import this test exists to find.
          unwalkable.push({ file: fileURLToPath(url).split('/chroxy/').pop(), specifier: imp.specifier })
        }
      }
    }

    assert.deepStrictEqual(
      unwalkable, [],
      'A module in the sandbox bootstrap\'s graph imports a package this check ' +
      'cannot follow. Remove it, or make it resolvable — an unwalked edge is an ' +
      'unchecked one.',
    )
    assert.deepStrictEqual(
      offending, [],
      'The sandbox bootstrap and everything it imports must reach node:fs ONLY ' +
      'through createRequire. Any ESM import of it — named, namespace, bare ' +
      'side-effect, or a re-export — is evaluated before the file bodies run and ' +
      'snapshots the synthetic module\'s named exports from the UNPATCHED object, ' +
      'silently disarming the sandbox for every named/namespace consumer (#7262). ' +
      'Destructure what you need off the `fs` object instead.',
    )

    // The walk is only worth anything if it actually reached the shared module;
    // a resolution change that quietly emptied the queue would pass otherwise.
    assert.ok(
      [...seen].some((u) => u.endsWith('/scripts/lib/test-fs-sandbox.mjs')),
      `The walk never reached scripts/lib/test-fs-sandbox.mjs (visited ${seen.size} ` +
      `file(s)), so it proved nothing about the module that installs the guard.`,
    )
  })
})
