import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * CALL-SITE coverage for the isEntryPoint()-guarded CLI block in
 * scripts/lib/contributing-roster.mjs (#7937, filed from #7934).
 *
 * `parseRoster`/`parseExemptions` are thoroughly covered —
 * contributing-roster-parse.test.js pins the refusal branches,
 * contributing-required-checks.test.js pins the real CONTRIBUTING.md roster —
 * but every one of those tests reaches the parse functions by IMPORTING them
 * directly. Nothing runs the module as a program, which is the only way its
 * `isEntryPoint(import.meta.url)` guard ever executes. The guard's own logic
 * is separately proven correct (scripts/__tests__/is-entry-point.test.mjs,
 * the drift gate across all three copies), but that proves the GUARD decides
 * right; it says nothing about whether this CALL SITE ever asks it.
 *
 * Production reads this call site through exactly one path:
 * scripts/check-required-contexts.sh runs `node scripts/lib/contributing-
 * roster.mjs` and trusts its stdout line-for-line as the doc-side half of a
 * diff against live branch protection. A guard stuck FALSE here means that
 * `doc=$(...)` command prints nothing, the script's own `[ -n "$doc" ] ||
 * REFUSE` catches an empty string and exits 2 — so the direct-run cases below
 * assert the stronger, more useful thing (the roster is byte-identical to
 * `parseRoster()`'s real output) rather than merely "something happened".
 *
 * ── Why nothing here imports the module at file scope ───────────────────────
 *
 * Unlike the two server call sites in entry-point-call-sites.test.js, a guard
 * stuck TRUE in THIS module is not catastrophic on import — the guarded block
 * neither calls process.exit() on success nor binds a port that outlives the
 * test, so importing it at module scope would not hang or crash this suite
 * (contributing-roster-parse.test.js already does exactly that, safely).
 * Importing is still deferred to inside a test body, after the subprocess
 * evidence below, to keep this file self-contained and to keep the "did
 * importing print anything" question answered by an out-of-process
 * observation rather than by whatever this process's stdout happens to
 * collect during module loading.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'lib', 'contributing-roster.mjs')
const CONTRIBUTING = resolve(REPO_ROOT, 'CONTRIBUTING.md')

const tempDirs = []
after(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }) })

const stageDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const moduleUrl = (target) => pathToFileURL(target).href

const runNode = (entry, opts = {}) =>
  spawnSync(process.execPath, [entry], { encoding: 'utf8', cwd: REPO_ROOT, timeout: 30_000, ...opts })

describe('entry-point call site: scripts/lib/contributing-roster.mjs (#7937)', () => {
  it('running the module directly parses CONTRIBUTING.md and prints the roster to stdout', () => {
    const r = runNode(SCRIPT)
    assert.equal(
      r.status,
      0,
      'expected exit 0 — either the guard read false (main() never ran, so check-required-contexts.sh ' +
      `would see an empty $doc) or parseRoster refused against the real doc.\n` +
      `stdout: ${JSON.stringify(r.stdout)}\nstderr: ${JSON.stringify(r.stderr)}`,
    )
    assert.equal(
      r.stderr,
      '',
      `unexpected stderr — a REFUSE line here means the parse failed, not that the guard misfired: ${r.stderr}`,
    )
    const lines = r.stdout.split('\n').filter(Boolean)
    assert.ok(
      lines.length >= 10,
      'expected >=10 roster lines on stdout (parseRoster\'s own "parsed only N entries" floor) — ' +
      `main() never ran or printed far fewer than the real roster. stdout: ${JSON.stringify(r.stdout)}`,
    )
  })

  it('the direct-run stdout is EXACTLY parseRoster()\'s output — the value check-required-contexts.sh diffs', async () => {
    // Imported here, after the subprocess case above has already exercised the
    // call site out of process — see the file header for why this particular
    // module is safe to import at all under a stuck-TRUE guard.
    const { parseRoster } = await import(moduleUrl(SCRIPT))
    const contributingText = await readFile(CONTRIBUTING, 'utf8')
    const expected = parseRoster(contributingText).join('\n') + '\n'

    const r = runNode(SCRIPT)
    assert.equal(r.status, 0, `direct run failed: ${r.stderr}`)
    assert.equal(
      r.stdout,
      expected,
      'the CLI wrapper\'s stdout must match parseRoster() exactly — a mismatch here means the guarded ' +
      'block and the parse function have drifted apart even though both individually "work"',
    )
  })

  it('importing the module does NOT run the CLI block (the stuck-TRUE direction)', () => {
    const dir = stageDir('contributing-roster-import-')
    const importer = join(dir, 'importer.mjs')
    writeFileSync(
      importer,
      `await import(${JSON.stringify(moduleUrl(SCRIPT))})\nprocess.stdout.write('IMPORTED-OK\\n')\n`,
    )
    const r = runNode(importer)
    assert.equal(
      r.status,
      0,
      `the importer should exit cleanly regardless of the guard; a non-zero exit means importing threw ` +
      `or the guarded block's error path ran: ${r.stderr}`,
    )
    assert.equal(
      r.stdout,
      'IMPORTED-OK\n',
      'importing the module must produce no other output — anything else on stdout means the guarded ' +
      `block ran on import (a stuck-TRUE guard). Full stdout: ${JSON.stringify(r.stdout)}`,
    )
  })

  it('positive control: the same importer harness DOES observe output when the guard reads true', () => {
    // Without this, the assertion above ("stdout is exactly IMPORTED-OK") could
    // be vacuously true for a reason that has nothing to do with the guard —
    // e.g. the staged importer silently failing to import anything at all.
    // This proves the harness CAN see a difference: swap only the guard's own
    // dependency for a stub that always answers true, leave
    // contributing-roster.mjs itself byte-for-byte as committed, and confirm
    // the importer's observable behaviour changes.
    //
    // No copy of CONTRIBUTING.md is staged alongside it. That is deliberate,
    // not an oversight: contributing-roster.mjs resolves it relative to its
    // OWN import.meta.url (`new URL('../../CONTRIBUTING.md', ...)`), which
    // from a bare temp directory resolves to a path that does not exist. Under
    // a forced-true guard that makes the guarded block take its OWN REFUSE
    // path (readFile throws ENOENT, caught, `process.exit(1)` before
    // 'IMPORTED-OK' is ever written) — a different, equally decisive
    // observable: exit 1 and empty stdout, instead of exit 0 and
    // 'IMPORTED-OK\n'. Either failure shape is fine evidence; asserting both
    // channels (stdout AND status) makes the control robust to either.
    const dir = stageDir('contributing-roster-control-')
    writeFileSync(join(dir, 'is-entry-point.mjs'), 'export function isEntryPoint () { return true }\n')
    const real = readFileSync(SCRIPT, 'utf8')
    const stagedScript = join(dir, 'contributing-roster.mjs')
    writeFileSync(stagedScript, real)

    const importer = join(dir, 'importer.mjs')
    writeFileSync(
      importer,
      `await import(${JSON.stringify(moduleUrl(stagedScript))})\nprocess.stdout.write('IMPORTED-OK\\n')\n`,
    )
    const r = runNode(importer)
    assert.notEqual(
      r.status,
      0,
      'forcing the guard true should make the guarded block hit its own REFUSE path (no staged ' +
      `CONTRIBUTING.md), so the control importer should NOT exit 0. Got status ${r.status}, ` +
      `stdout: ${JSON.stringify(r.stdout)}, stderr: ${JSON.stringify(r.stderr)}`,
    )
    assert.notEqual(
      r.stdout,
      'IMPORTED-OK\n',
      'forcing the guard true produced the same stdout as the ordinary import case — the stuck-TRUE ' +
      'assertion above would be unable to tell the two apart',
    )
  })
})
