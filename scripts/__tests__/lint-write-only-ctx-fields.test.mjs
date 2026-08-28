#!/usr/bin/env node
/**
 * lint-write-only-ctx-fields.test.mjs — pins scripts/lint-write-only-ctx-fields.mjs (#7452).
 *
 * The lint exists because a write-only context field is INVISIBLE: it compiles,
 * type-checks and passes every test. Its own failure mode is the same shape —
 * a classifier that quietly stops matching, or an extractor that quietly finds
 * zero fields, reports "clean", and is indistinguishable from a healthy run. So
 * this suite is built around four kinds of case:
 *
 *   1. RED — a write-only field must fail, and the failure must NAME the field
 *      and its write sites. Anchored on the two real regressions (#7421's
 *      `isSessionSwitchReplay`, PR #7446's `pendingSwitchSessionId`).
 *   2. GREEN — a field with any reader must pass. Every read SHAPE the app
 *      actually uses gets its own case, because "no reads found" is how this
 *      lint produces a false positive, and one missed shape would fail a
 *      legitimate field.
 *   3. CANNOT-CHECK — a missing interface, an empty interface, an unterminated
 *      body, an empty scan set and a malformed allowlist must each exit 2.
 *      Never 0. "Cannot check" silently read as "nothing to check" is the
 *      catalogued false-safety shape (docs/false-safety-guards.md) and is the
 *      only way this lint could be green while checking nothing.
 *   4. The isEntryPoint CALL SITE, in both directions — see section 0, which
 *      runs BEFORE this file imports the module and explains why it must.
 *
 * No external test framework. Run from repo root:
 *   node scripts/__tests__/lint-write-only-ctx-fields.test.mjs
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, '..', 'lint-write-only-ctx-fields.mjs')

// Every case in this file. Bump it when you add one — a case that vanishes
// should break the run rather than quietly shrink it (#7447).
const MIN_CASES = 50

let pass = 0
let fail = 0
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

const throws = (fn, Type, match) => {
  let caught = null
  try {
    fn()
  } catch (err) {
    caught = err
  }
  assert(caught !== null, 'expected a throw, got none')
  assert(caught instanceof Type, `expected ${Type.name}, got ${caught.constructor.name}: ${caught.message}`)
  if (match) assert(match.test(caught.message), `message did not match ${match}: ${caught.message}`)
}

// ---------------------------------------------------------------------------
// Fixture trees + CLI driver (needed by section 0, so defined before it)
// ---------------------------------------------------------------------------

const DECL_REL = 'packages/app/src/store/message-handler.ts'
const tmpDirs = []

function fixtureRoot(declText, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-woctx-'))
  tmpDirs.push(dir)
  mkdirSync(join(dir, dirname(DECL_REL)), { recursive: true })
  writeFileSync(join(dir, DECL_REL), declText)
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

const runCliOn = (dir, ...args) =>
  spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], { encoding: 'utf8' })

const CLEAN_DECL = `
interface MessageHandlerContext {
  flag: boolean;
}
let _ctx: MessageHandlerContext = { flag: false };
export function run(): void { _ctx.flag = true; if (_ctx.flag) console.log('x'); }
`
const WRITE_ONLY_DECL = `
interface MessageHandlerContext {
  flag: boolean;
}
let _ctx: MessageHandlerContext = { flag: false };
export function run(): void { _ctx.flag = true; }
`

// ---------------------------------------------------------------------------
// 0. The isEntryPoint CALL SITE — and why it is FIRST, before the import below.
//
// The module ends in `process.exit(runCli())` under `isEntryPoint()`. If that
// guard ever read TRUE on a plain import, the static import this file would
// otherwise open with would run the lint against the real repo and exit —
// before a single case ran, printing nothing, exiting 0 on a clean tree. A
// green run and a DELETED suite would be the same observable outcome, which is
// exactly the trap recorded as "an entry-point call site needs its own test
// file" (#7236): a file that imports the module cannot witness it auto-running.
//
// The resolution here is ordering rather than a second file. These two cases
// run out of process, the failure gate below is hard (exit 1 immediately), and
// only then does this file import the module. Mutating the guard to a literal
// `true` therefore fails HERE, by name, instead of erasing the run.
// ---------------------------------------------------------------------------

test('importing the module does NOT run the lint (a guard stuck TRUE would erase this suite)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-woctx-probe-'))
  tmpDirs.push(dir)
  const probe = join(dir, 'probe.mjs')
  writeFileSync(
    probe,
    `import { TARGETS } from ${JSON.stringify(pathToFileURL(SCRIPT).href)}\n` +
    "process.stdout.write('IMPORT-RETURNED:' + TARGETS.length + '\\n')\n",
  )
  const r = spawnSync(process.execPath, [probe], { encoding: 'utf8' })
  assert(r.status === 0, `probe exited ${r.status}\n${r.stdout}${r.stderr}`)
  assert(
    /IMPORT-RETURNED:1/.test(r.stdout),
    `the import never returned — the module ran and exited on import\n${r.stdout}${r.stderr}`,
  )
  assert(
    !/\[write-only-ctx\]/.test(r.stdout + r.stderr),
    `importing the module produced lint output\n${r.stdout}${r.stderr}`,
  )
})

test('running the module directly DOES run it — positive control for the case above', () => {
  // Without this, "no lint output on import" would pass just as happily against
  // a module that produces no output at all, ever.
  const r = runCliOn(fixtureRoot(CLEAN_DECL))
  assert(/\[write-only-ctx\]/.test(r.stdout), `direct run produced no lint output\n${r.stdout}${r.stderr}`)
})

if (fail > 0) {
  for (const f of failures) process.stdout.write(`\n--- ${f.name}\n${f.err.stack}\n`)
  process.stdout.write(
    '\nFAIL: the entry-point call site is broken. Stopping BEFORE importing the module, ' +
    'because a guard stuck TRUE would exit this process during that import.\n',
  )
  process.exit(1)
}

const {
  CannotCheckError,
  analyzeTarget,
  classifyReferences,
  extractInterfaceFields,
  stripComments,
} = await import(pathToFileURL(SCRIPT).href)

// ---------------------------------------------------------------------------
// Fixture builder — a minimal stand-in for message-handler.ts
// ---------------------------------------------------------------------------

const RECEIVERS = ['_ctx', 'ctx']

/** Analyse a single in-memory module as both the declaration and the source. */
const analyzeOne = (text, opts = {}) =>
  analyzeTarget({
    declText: text,
    interfaceName: 'Ctx',
    receivers: RECEIVERS,
    sources: [{ path: 'fixture.ts', text }],
    ...opts,
  })

const withField = (decl, body) => `
interface Ctx {
  ${decl}
  keep: number;
}
function build(): Ctx {
  return { ${decl.split(':')[0].trim()}: null as never, keep: 0 };
}
let _ctx: Ctx = build();
export function run(): void {
${body}
  void _ctx.keep;
}
`

// ---------------------------------------------------------------------------
// 1. RED — write-only fields fail
// ---------------------------------------------------------------------------

test('a field with writes and no reads FAILS and names the field', () => {
  const r = analyzeOne(withField('flag: boolean;', '  _ctx.flag = true;\n  _ctx.flag = false;'))
  assert(r.failures.length === 1, `expected 1 failure, got ${r.failures.length}`)
  assert(/Ctx\.flag is WRITE-ONLY/.test(r.failures[0]), r.failures[0])
})

test('the failure lists EVERY write site with a line number', () => {
  const r = analyzeOne(withField('flag: boolean;', '  _ctx.flag = true;\n  _ctx.flag = false;'))
  const sites = r.failures[0].match(/write: fixture\.ts:\d+/g) || []
  assert(sites.length === 2, `expected 2 write sites, got ${sites.length}: ${r.failures[0]}`)
})

test('#7421 shape: isSessionSwitchReplay written in four handlers, read nowhere', () => {
  const src = `
interface Ctx {
  isSessionSwitchReplay: boolean;
  replayingSessions: Set<string>;
}
let _ctx: Ctx = { isSessionSwitchReplay: false, replayingSessions: new Set() };
export function reset(): void { _ctx.isSessionSwitchReplay = false; _ctx.replayingSessions.clear(); }
export function a(): void { _ctx.isSessionSwitchReplay = true; }
export function b(): void { _ctx.isSessionSwitchReplay = true; }
export function c(): void { _ctx.isSessionSwitchReplay = false; }
`
  const r = analyzeOne(src)
  assert(r.failures.length === 1, `expected 1, got ${r.failures.length}`)
  assert(/isSessionSwitchReplay is WRITE-ONLY: 4 write site\(s\)/.test(r.failures[0]), r.failures[0])
})

test('PR #7446 shape: the setter plus three clears, reader deleted', () => {
  const src = `
interface Ctx {
  pendingSwitchSessionId: string | null;
  replayingSessions: Set<string>;
}
let _ctx: Ctx = { pendingSwitchSessionId: null, replayingSessions: new Set() };
export function setPendingSwitchSessionId(id: string | null): void { _ctx.pendingSwitchSessionId = id; }
export function resetReplayFlags(): void { _ctx.replayingSessions.clear(); _ctx.pendingSwitchSessionId = null; }
export function onAuthOk(): void { _ctx.pendingSwitchSessionId = null; }
export function onSwitched(): void { _ctx.pendingSwitchSessionId = null; }
`
  const r = analyzeOne(src)
  assert(r.failures.length === 1, `expected 1, got ${r.failures.length}`)
  assert(/pendingSwitchSessionId is WRITE-ONLY: 4 write site\(s\)/.test(r.failures[0]), r.failures[0])
})

test('a COMMENTED-OUT reader does not rescue a write-only field', () => {
  // The realistic regression: the reader is commented out rather than deleted.
  const r = analyzeOne(withField('flag: boolean;', '  _ctx.flag = true;\n  // if (_ctx.flag) doThing();'))
  assert(r.failures.length === 1, `a commented reader was counted as a read: ${JSON.stringify(r.failures)}`)
})

test('a reader that lives only in a TEST file does not rescue the field', () => {
  const prod = withField('flag: boolean;', '  _ctx.flag = true;')
  const r = analyzeTarget({
    declText: prod,
    interfaceName: 'Ctx',
    receivers: RECEIVERS,
    // The CLI filters test paths out of `sources` before this point; passing
    // only production files here is that contract. The CLI-level case in
    // section 9 proves the filter itself.
    sources: [{ path: 'fixture.ts', text: prod }],
  })
  assert(r.failures.length === 1, 'expected the write-only failure to stand')
})

// ---------------------------------------------------------------------------
// 2. GREEN — every read shape the app actually uses
// ---------------------------------------------------------------------------

const readShapes = [
  ['an if condition', '  _ctx.flag = true;\n  if (_ctx.flag) { doThing(); }'],
  ['a right-hand side', '  _ctx.flag = true;\n  const x = _ctx.flag;\n  void x;'],
  ['a method call through the field', '  _ctx.flag = true;\n  _ctx.flag.valueOf();'],
  ['an argument', '  _ctx.flag = true;\n  doThing(_ctx.flag);'],
  ['a template interpolation', '  _ctx.flag = true;\n  const s = `v=${_ctx.flag}`;\n  void s;'],
  ['optional chaining', '  _ctx.flag = true;\n  void _ctx?.flag;'],
  ['a multi-line reference', '  _ctx.flag = true;\n  void _ctx\n    .flag;'],
  ['an equality comparison (=== is not an assignment)', '  _ctx.flag = true;\n  if (_ctx.flag === true) doThing();'],
  ['a loose equality (== is not an assignment)', '  _ctx.flag = true;\n  if (_ctx.flag == true) doThing();'],
  ['an arrow body (=> is not an assignment)', '  _ctx.flag = true;\n  const f = () => _ctx.flag;\n  void f;'],
  ['the local `ctx` receiver used while building the context', '  ctx.flag = true;\n  void ctx.flag;'],
]
for (const [label, body] of readShapes) {
  test(`a field read via ${label} PASSES`, () => {
    const r = analyzeOne(withField('flag: boolean;', body))
    assert(r.failures.length === 0, `false positive: ${JSON.stringify(r.failures)}`)
  })
}

test('the real-world read shapes are COUNTED, not merely tolerated', () => {
  const stripped = stripComments('_ctx.set.clear(); if (_ctx.set) {} const a = _ctx.set;')
  const { reads, writes } = classifyReferences(stripped, 'set', RECEIVERS)
  assert(reads.length === 3, `expected 3 reads, got ${reads.length}`)
  assert(writes.length === 0, `expected 0 writes, got ${writes.length}`)
})

// ---------------------------------------------------------------------------
// 3. Write shapes
// ---------------------------------------------------------------------------

const writeShapes = [
  ['plain assignment', '_ctx.n = 1;'],
  ['compound assignment', '_ctx.n += 1;'],
  ['logical assignment', '_ctx.n ??= 1;'],
  ['unsigned right shift assignment', '_ctx.n >>>= 1;'],
  ['postfix increment', '_ctx.n++;'],
  ['prefix decrement', '--_ctx.n;'],
  ['delete', 'delete _ctx.n;'],
]
for (const [label, stmt] of writeShapes) {
  test(`${label} classifies as a WRITE`, () => {
    const { reads, writes } = classifyReferences(stripComments(stmt), 'n', RECEIVERS)
    assert(writes.length === 1 && reads.length === 0, `reads=${reads.length} writes=${writes.length}`)
  })
}

// ---------------------------------------------------------------------------
// 4. Comment stripping — must not eat live code
// ---------------------------------------------------------------------------

test('a `//` inside a string literal does not start a comment', () => {
  const src = "const u = 'http://x'; if (_ctx.flag) doThing();"
  const { reads } = classifyReferences(stripComments(src), 'flag', RECEIVERS)
  assert(reads.length === 1, `the read after a URL string was eaten (reads=${reads.length})`)
})

test('a regex literal containing an escaped `//` does not start a comment', () => {
  const src = 'const re = /a\\/\\/b/; if (_ctx.flag) doThing();'
  const { reads } = classifyReferences(stripComments(src), 'flag', RECEIVERS)
  assert(reads.length === 1, `the read after a regex was eaten (reads=${reads.length})`)
})

test('division is not mistaken for a regex', () => {
  const src = 'const q = a / b; const r = c / d; if (_ctx.flag) doThing();'
  const { reads } = classifyReferences(stripComments(src), 'flag', RECEIVERS)
  assert(reads.length === 1, `division confused the lexer (reads=${reads.length})`)
})

test('stripping preserves byte offsets and line numbers', () => {
  const src = 'a\n// comment here\nif (_ctx.flag) doThing();\n'
  const out = stripComments(src)
  assert(out.length === src.length, `length changed: ${out.length} vs ${src.length}`)
  assert(out.split('\n').length === src.split('\n').length, 'line count changed')
  const { reads } = classifyReferences(out, 'flag', RECEIVERS)
  assert(reads[0] === 3, `expected the read on line 3, got ${reads[0]}`)
})

// ---------------------------------------------------------------------------
// 5. Interface extraction
// ---------------------------------------------------------------------------

test('fields are extracted, and nested object-type members are NOT', () => {
  const src = `
interface Ctx {
  a: Map<string, { serverTs: number; recvAt: number }>;
  b?: string | null;
  readonly c: number;
  method(): void;
  [key: string]: unknown;
}
`
  const fields = extractInterfaceFields(src, 'Ctx')
  assert(JSON.stringify(fields) === JSON.stringify(['a', 'b', 'c']), `got ${JSON.stringify(fields)}`)
})

test('base-interface fields are included when followExtends is on', () => {
  const src = `
interface Base { encryptionState: unknown; }
interface Ctx extends Base { own: number; }
`
  const fields = extractInterfaceFields(src, 'Ctx', { followExtends: true })
  assert(fields.includes('own') && fields.includes('encryptionState'), `got ${JSON.stringify(fields)}`)
})

test('a base interface declared in ANOTHER module is skipped, not fatal', () => {
  const src = 'interface Ctx extends Imported { own: number; }'
  const fields = extractInterfaceFields(src, 'Ctx', { followExtends: true })
  assert(JSON.stringify(fields) === JSON.stringify(['own']), `got ${JSON.stringify(fields)}`)
})

// ---------------------------------------------------------------------------
// 6. CANNOT-CHECK — every one of these must be loud, never exit 0
// ---------------------------------------------------------------------------

test('an EMPTY interface is a cannot-check, not a clean run', () => {
  throws(() => extractInterfaceFields('interface Ctx {}', 'Ctx'), CannotCheckError, /ZERO fields/)
})

test('a MISSING interface is a cannot-check', () => {
  throws(() => extractInterfaceFields('type Ctx = { a: number };', 'Ctx'), CannotCheckError, /not found/)
})

test('an UNTERMINATED interface body is a cannot-check', () => {
  throws(() => extractInterfaceFields('interface Ctx { a: number;', 'Ctx'), CannotCheckError, /unterminated/)
})

test('an EMPTY scan set is a cannot-check', () => {
  throws(
    () => analyzeTarget({ declText: 'interface Ctx { a: number; }', interfaceName: 'Ctx', receivers: RECEIVERS, sources: [] }),
    CannotCheckError,
    /no source files/,
  )
})

// ---------------------------------------------------------------------------
// 7. Allowlist
// ---------------------------------------------------------------------------

test('an allowlist entry WITH a justification admits a write-only field', () => {
  const src = withField('flag: boolean;', '  _ctx.flag = true;')
  const r = analyzeOne(src, { allow: { flag: 'kept as a debugger-visible marker; see #1234' } })
  assert(r.failures.length === 0, `allowlist did not admit: ${JSON.stringify(r.failures)}`)
  assert(r.stats.allowlisted === 1, `stats.allowlisted=${r.stats.allowlisted}`)
})

test('an allowlist entry WITHOUT a justification is refused', () => {
  const src = withField('flag: boolean;', '  _ctx.flag = true;')
  throws(() => analyzeOne(src, { allow: { flag: '   ' } }), CannotCheckError, /no justification/)
})

test('an allowlist entry naming a field that no longer exists is refused', () => {
  const src = withField('flag: boolean;', '  _ctx.flag = true;\n  void _ctx.flag;')
  throws(() => analyzeOne(src, { allow: { gone: 'why' } }), CannotCheckError, /not declared/)
})

test('an allowlist entry for a field that regained a reader is refused as STALE', () => {
  const src = withField('flag: boolean;', '  _ctx.flag = true;\n  if (_ctx.flag) doThing();')
  throws(() => analyzeOne(src, { allow: { flag: 'was write-only' } }), CannotCheckError, /stale/)
})

// ---------------------------------------------------------------------------
// 8. Unreferenced fields warn (and do not fail) — pinned so it stays deliberate
// ---------------------------------------------------------------------------

test('a field with no reference at all WARNS rather than failing', () => {
  const src = `
interface Ctx { held: number; used: number; }
let _ctx: Ctx = { held: 0, used: 0 };
export function run(): void { void _ctx.used; }
`
  const r = analyzeOne(src)
  assert(r.failures.length === 0, `expected no failure, got ${JSON.stringify(r.failures)}`)
  assert(r.warnings.length === 1 && /held is UNREFERENCED/.test(r.warnings[0]), JSON.stringify(r.warnings))
})

// ---------------------------------------------------------------------------
// 9. CLI end-to-end — exit codes are the contract CI reads
// ---------------------------------------------------------------------------

test('CLI exits 0 on a clean fixture tree', () => {
  const r = runCliOn(fixtureRoot(CLEAN_DECL))
  assert(r.status === 0, `exit ${r.status}\n${r.stdout}${r.stderr}`)
})

test('CLI exits 1 on a write-only field and names it on stderr', () => {
  const r = runCliOn(fixtureRoot(WRITE_ONLY_DECL))
  assert(r.status === 1, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/MessageHandlerContext\.flag is WRITE-ONLY/.test(r.stderr), r.stderr)
  assert(/write: packages\/app\/src\/store\/message-handler\.ts:\d+/.test(r.stderr), r.stderr)
})

test('CLI exits 2 when the declaring file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-woctx-'))
  tmpDirs.push(dir)
  const r = runCliOn(dir)
  assert(r.status === 2, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/cannot read/.test(r.stderr), r.stderr)
})

test('CLI exits 2 on an EMPTY interface — never 0', () => {
  const dir = fixtureRoot('interface MessageHandlerContext {}\nlet _ctx: MessageHandlerContext = {} as never;\n')
  const r = runCliOn(dir)
  assert(r.status === 2, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/CANNOT CHECK/.test(r.stderr) && /ZERO fields/.test(r.stderr), r.stderr)
})

test('CLI exits 2 on an unparseable (unterminated) interface — never 0', () => {
  const dir = fixtureRoot('interface MessageHandlerContext {\n  flag: boolean;\n')
  const r = runCliOn(dir)
  assert(r.status === 2, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/CANNOT CHECK/.test(r.stderr), r.stderr)
})

test('CLI ignores a reader that lives in a test file', () => {
  // The ONLY read is in a __tests__ path; the field must still fail.
  const dir = fixtureRoot(WRITE_ONLY_DECL, {
    'packages/app/src/__tests__/store/message-handler.test.ts':
      "export const seen = (_ctx: any) => _ctx.flag;\n",
  })
  const r = runCliOn(dir)
  assert(r.status === 1, `a test-file read masked the write-only field (exit ${r.status})\n${r.stderr}`)
})

test('CLI reports the classification stats it acted on', () => {
  const r = runCliOn(fixtureRoot(CLEAN_DECL))
  assert(/1 field\(s\), 1 source file\(s\), 2 reference\(s\) classified/.test(r.stdout), r.stdout)
})

// ---------------------------------------------------------------------------

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })

const total = pass + fail
process.stdout.write(`\n${pass}/${total} passed\n`)
if (total < MIN_CASES) {
  process.stdout.write(
    `FAIL: only ${total} cases ran, expected at least ${MIN_CASES}. A case stopped being ` +
    'discovered — that is a shrinking suite, not a passing one.\n',
  )
  process.exit(1)
}
if (fail > 0) {
  for (const f of failures) process.stdout.write(`\n--- ${f.name}\n${f.err.stack}\n`)
  process.exit(1)
}
