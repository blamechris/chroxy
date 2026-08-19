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
 * 45 modules under `src/` import a write-side `fs` function by name, so for all
 * of them the guard was not armed while still reporting success for everything
 * else — the `docs/false-safety-guards.md` shape exactly.
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
  appendFileSync as namedAppendFileSync,
  renameSync as namedRenameSync,
  mkdirSync as namedMkdirSync,
  createWriteStream as namedCreateWriteStream,
  openSync as namedOpenSync,
  readFileSync as namedReadFileSync,
  rmSync as namedRmSync,
} from 'node:fs'

import * as fspNamespace from 'node:fs/promises'
import fspDefault from 'node:fs/promises'
import {
  writeFile as namedWriteFile,
  appendFile as namedAppendFile,
  rename as namedRename,
  mkdir as namedMkdir,
  open as namedOpen,
} from 'node:fs/promises'

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

// `createWriteStream` is the one probe whose BYPASS path is asynchronous: the
// guard throws synchronously, but a bypassed call returns a live stream and
// reports ENOENT later on an 'error' event. `probeSync` would classify that as
// "the call SUCCEEDED" — wrong — and the unhandled 'error' would then surface
// as an uncaughtException after the test had already ended, turning a clean
// assertion failure into noise that hides which assertion failed.
function probeStream(fn, target) {
  return new Promise((resolve) => {
    let stream
    try {
      stream = fn(target)
    } catch (err) {
      resolve(classify(err))
      return
    }
    // No synchronous throw means the guard was bypassed and we are now holding
    // a real stream aimed at a real path. Attach the handler before yielding.
    stream.once('error', (err) => resolve(classify(err)))
    stream.once('open', () => {
      // It actually opened, so a real file exists under the protected root.
      stream.destroy()
      try { namedRmSync(target, { force: true }) } catch { /* best effort */ }
      resolve(classify(null))
    })
  })
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

describe('write sandbox: every patched method is armed for named imports', () => {
  // The other axis: each method is a separate monkey-patch in `_setup.mjs` and
  // could individually be missed. Driven through the NAMED form because that is
  // the form #7262 left unguarded and the one 45 modules under `src/` use.
  //
  // KNOWN GAP (#7267): this list is hand-maintained alongside the patch list in
  // `_setup.mjs`, under a suite titled "every patched method" — a hardcoded list
  // beside a set that can grow, which is `docs/false-safety-guards.md` cause #1.
  // It cannot currently claim "every": the sandbox patches no delete or copy
  // API, so `unlinkSync`, `rmSync`, `cpSync` and friends are absent here because
  // they are absent there. #7267 closes both halves by deriving the two lists
  // from one exported array; until then, read this suite as "every method
  // `_setup.mjs` claims to patch", and check that claim against #7267's table.
  const syncMethods = [
    ['writeFileSync',     () => probeSync(namedWriteFileSync, protectedTarget, 'probe')],
    // NOTE: this one is guarded even when its own binding is stale, so unlike
    // its neighbours it survives the #7262 mutant. That is a real property of
    // Node, not a dead assertion: `appendFileSync` reaches `writeFileSync`
    // through the module's exports OBJECT, which is the thing `_setup.mjs`
    // patches — so an unpatched named `appendFileSync` still lands in the
    // patched `writeFileSync`. Verified by patching only `writeFileSync` on the
    // CJS object and watching a named `appendFileSync` call trip it. Kept
    // because it pins the OUTCOME (`appendFileSync` cannot reach the real home)
    // regardless of which mechanism delivers it; do not read its mutant
    // survival as this file being insensitive.
    ['appendFileSync',    () => probeSync(namedAppendFileSync, protectedTarget, 'probe')],
    ['renameSync (from)', () => probeSync(namedRenameSync, protectedTarget, join(tmpdir(), 'probe-dest.tmp'))],
    ['renameSync (to)',   () => probeSync(namedRenameSync, join(tmpdir(), MISSING_DIR, 'src.tmp'), protectedTarget)],
    // Deliberately NOT `{ recursive: true }`: recursive would create real
    // directories under ~/.chroxy if the guard were bypassed.
    ['mkdirSync',         () => probeSync(namedMkdirSync, protectedTarget)],
    ['openSync',          () => probeSync(namedOpenSync, protectedTarget, 'w')],
  ]

  for (const [label, run] of syncMethods) {
    test(`${label} is guarded via named import`, () => {
      assert.strictEqual(run(), GUARDED, `${label} bypassed the sandbox.`)
    })
  }

  test('createWriteStream is guarded via named import', async () => {
    assert.strictEqual(
      await probeStream(namedCreateWriteStream, protectedTarget),
      GUARDED,
      'createWriteStream bypassed the sandbox.',
    )
  })

  const asyncMethods = [
    ['promises.writeFile',   () => probeAsync(namedWriteFile, protectedTarget, 'probe')],
    ['promises.appendFile',  () => probeAsync(namedAppendFile, protectedTarget, 'probe')],
    ['promises.rename (from)', () => probeAsync(namedRename, protectedTarget, join(tmpdir(), 'probe-dest.tmp'))],
    ['promises.rename (to)',   () => probeAsync(namedRename, join(tmpdir(), MISSING_DIR, 'src.tmp'), protectedTarget)],
    ['promises.mkdir',       () => probeAsync(namedMkdir, protectedTarget)],
    ['promises.open',        () => probeAsync(namedOpen, protectedTarget, 'w')],
  ]

  for (const [label, run] of asyncMethods) {
    test(`${label} is guarded via named import`, async () => {
      assert.strictEqual(await run(), GUARDED, `${label} bypassed the sandbox.`)
    })
  }
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
  test('tests/_setup.mjs contains no ESM import from node:fs', () => {
    const setupPath = fileURLToPath(new URL('./_setup.mjs', import.meta.url))
    const source = namedReadFileSync(setupPath, 'utf8')

    // Comments must be blanked first, and with the repo's ONE stripper
    // (`scripts/lib/strip-comments.mjs`, #7248) rather than a second local
    // regex. `_setup.mjs` deliberately quotes `import { mkdtempSync } from
    // 'node:fs'` in its own header to explain the bug, so a check that reads
    // raw source flags the very comment warning against the thing. Measured:
    // 1 match raw, 0 stripped. The stripper preserves offsets, so line numbers
    // computed here are valid against the original file.
    const blanked = stripComments(source, '_setup.mjs')

    // Deliberately NOT line-anchored on `... from ...`. Three forms disarm the
    // sandbox and the narrow version caught only the first, which meant the
    // check that exists to NAME the cause stayed green for two of the three
    // ways the cause comes back. All three are measured, not assumed:
    //
    //   import { mkdtempSync } from 'node:fs'   single line   -> 9 tests fail
    //   import 'node:fs'                        bare          -> 8 tests fail
    //   import {\n  mkdtempSync,\n} from 'node:fs'  multi-line
    //
    // `node:fs/promises` is included because it is a separate synthetic module
    // with the same lazy-link behaviour: importing it here snapshots ITS named
    // exports early and disarms the promises half of the guard (measured: 9
    // tests fail).
    const IMPORT_OF_FS = /(^|\n)[ \t]*import\s+(?:[\s\S]*?\sfrom\s+)?['"](node:)?fs(\/promises)?['"]/g
    const offending = [...blanked.matchAll(IMPORT_OF_FS)].map((m) => {
      const at = m.index + (m[0].startsWith('\n') ? 1 : 0)
      return {
        line: source.slice(0, at).split('\n').length,
        statement: source.slice(at, at + m[0].length).trim(),
      }
    })

    assert.deepStrictEqual(
      offending, [],
      'tests/_setup.mjs must reach node:fs ONLY through createRequire. Any ESM ' +
      'import of it here — named, namespace, or bare side-effect — is evaluated ' +
      'before the file body and snapshots the synthetic module\'s named exports ' +
      'from the UNPATCHED object, silently disarming the sandbox for every ' +
      'named/namespace consumer (#7262). Destructure what you need off the ' +
      '`fs` object instead.',
    )
  })
})
