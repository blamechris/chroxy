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
//
// It had said 179 since #7548 while the suite grew to 341, so the floor sat 162
// cases loose and the instruction above described a guard nobody was running.
// Measured on #7692: deleting ALL TEN rows that PR added — including three that
// pin a regression it had just fixed — left the run green at 320/320, exit 0.
// A floor that trails the count is the shape this whole file exists to catch:
// it passes, and what it is checking is not what it says.
const MIN_CASES = 443

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
const DASH_DECL_REL = 'packages/dashboard/src/store/message-handler.ts'

// The SHIPPED allowlist names these two bindings, and an allowlist entry whose
// subject is not in the roster is a cannot-check — so every fixture tree must
// declare them or the CLI exits 2 for a reason the case is not about.
const DASH_TEST_EXPORTS =
  'export const _testQueueInternals = { getQueue: () => [] };\n' +
  'export const _testMessageHandler = { handle: () => {} };\n'
const DASH_CLEAN_DECL =
  `${DASH_TEST_EXPORTS}let flag = false;\nexport function a(): boolean { flag = true; return flag; }\n`

const tmpDirs = []

function fixtureRoot(declText, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-woctx-'))
  tmpDirs.push(dir)
  mkdirSync(join(dir, dirname(DECL_REL)), { recursive: true })
  writeFileSync(join(dir, DECL_REL), declText)
  // Every target in TARGETS runs on every CLI invocation, so a fixture that
  // seeds only the app tree makes the dashboard target exit 2 and turns each
  // app case into a test of the wrong thing.
  mkdirSync(join(dir, dirname(DASH_DECL_REL)), { recursive: true })
  writeFileSync(join(dir, DASH_DECL_REL), DASH_CLEAN_DECL)
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
    /IMPORT-RETURNED:[1-9]\d*/.test(r.stdout),
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
  TARGETS,
  analyzeTarget,
  assignsThroughAccessor,
  atStatementStart,
  blankModuleClauses,
  classifyBindingReferences,
  classifyReferences,
  extractInterfaceFields,
  extractModuleBindings,
  declaratorNames,
  genericEnd,
  incrementsThroughAccessor,
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
  // The flag-OFF behaviour of the FUNCTION, which is still its default. The
  // SHIPPED interface target no longer runs this way — see the companion below.
  const stripped = stripComments('_ctx.set.clear(); if (_ctx.set) {} const a = _ctx.set;')
  const { reads, writes } = classifyReferences(stripped, 'set', RECEIVERS)
  assert(reads.length === 3, `expected 3 reads, got ${reads.length}`)
  assert(writes.length === 0, `expected 0 writes, got ${writes.length}`)
})

test('with the flag ON, `_ctx.set.clear()` is a WRITE — the shipped app setting (#7532)', () => {
  // The companion, and the reason the row above is not simply wrong now: the
  // FUNCTION still defaults OFF, and the TARGET turns it on. Asserting only the
  // default would leave the shipped configuration unexercised, which is how a
  // flag becomes a no-op nobody notices — this one already was one, because the
  // interface path never threaded it at all.
  const stripped = stripComments('_ctx.set.clear(); if (_ctx.set) {} const a = _ctx.set;')
  const { reads, writes } = classifyReferences(stripped, 'set', RECEIVERS, { inPlaceMutationIsWrite: true })
  assert(writes.length === 1, `expected 1 write, got ${writes.length}`)
  assert(reads.length === 2, `expected 2 reads, got ${reads.length}`)
})

test('a context field populated and cleared with NOTHING reading it now FAILS (#7532)', () => {
  // The red proof the decision is for. Before #7532 this field was rescued by
  // its own reset assignment and never judged on whether anything reads the
  // container's CONTENTS — the #7421 class, one level in.
  const decl = 'export interface Ctx {\n  replaying: Set<string>;\n}\n'
  const src = [
    'export function begin(id: string): void { _ctx.replaying.add(id); }',
    'export function reset(): void { _ctx.replaying.clear(); }',
    'export function wipe(): void { _ctx.replaying = new Set(); }',
  ].join('\n')
  const r = analyzeTarget({
    declText: decl,
    interfaceName: 'Ctx',
    receivers: RECEIVERS,
    sources: [{ path: 'a.ts', text: src }],
    inPlaceMutationIsWrite: true,
  })
  assert(r.failures.length === 1, `expected 1 failure, got ${JSON.stringify(r.failures)}`)
  assert(/replaying/.test(r.failures[0]), `the field was not named: ${r.failures[0]}`)
})

test('...and the SAME field is rescued with the flag OFF — the control (#7532)', () => {
  // Without this the case above could pass because the fixture is malformed
  // rather than because the flag changed the verdict.
  const decl = 'export interface Ctx {\n  replaying: Set<string>;\n}\n'
  const src = [
    'export function begin(id: string): void { _ctx.replaying.add(id); }',
    'export function reset(): void { _ctx.replaying.clear(); }',
    'export function wipe(): void { _ctx.replaying = new Set(); }',
  ].join('\n')
  const r = analyzeTarget({
    declText: decl,
    interfaceName: 'Ctx',
    receivers: RECEIVERS,
    sources: [{ path: 'a.ts', text: src }],
  })
  assert(r.failures.length === 0, `expected no failure with the flag OFF, got ${JSON.stringify(r.failures)}`)
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

// --- #7464 review C1/S3: the classification windows and the quote lexer ----

test('a comment-padded write still classifies as a WRITE (C1: the 8-byte window)', () => {
  // Stripping a comment leaves blanks between the reference and `=`; the old
  // 8-byte lookahead filed this as a READ, and one rescued write silences a
  // whole write-only field (demonstrated on the real #7421 regression).
  const stmt = '_ctx.n /* review on #7464, a padded write */ = 1;'
  const { reads, writes } = classifyReferences(stripComments(stmt), 'n', RECEIVERS)
  assert(writes.length === 1 && reads.length === 0, `padded write misclassified: ${reads.length}r ${writes.length}w`)
})

test('a comment-padded delete still classifies as a WRITE (C1: the lookbehind window)', () => {
  const stmt = 'delete /* the mirror case */ _ctx.n;'
  const { reads, writes } = classifyReferences(stripComments(stmt), 'n', RECEIVERS)
  assert(writes.length === 1 && reads.length === 0, `padded delete misclassified: ${reads.length}r ${writes.length}w`)
})

test("a lone apostrophe in JSX prose cannot open a blind span (S3: quote spans stop at newline)", () => {
  // Live shape from CreateSessionModal.tsx: `server's` has no closing quote on
  // its line. The old lexer swallowed everything to the next apostrophe —
  // including a following `// _ctx.n = 1` line the stripper should have blanked.
  const src = "const label = <p>the server's daemon</p>;\n// _ctx.n = 1\n_ctx.n = 2;\n"
  const { reads, writes } = classifyReferences(stripComments(src), 'n', RECEIVERS)
  assert(writes.length === 1 && reads.length === 0, `blind span altered classification: ${reads.length}r ${writes.length}w`)
})


// ---------------------------------------------------------------------------
// 10. MODULE-LEVEL BINDINGS (#7467) — the dashboard store's shape.
//
// Same core, two differences: the roster comes from module-level `let`/`const`
// declarations rather than an interface, and a reference is a BARE identifier
// rather than `<receiver>.<field>`. Everything below exists because one of
// those two differences can fail silently: an extractor that quietly stops
// finding bindings, or a classifier that quietly files every reference as a
// read, both report "clean".
// ---------------------------------------------------------------------------

// A roster key is `<path>::<name>`, so `fields.includes('x')` can NEVER be true
// — an absence assertion written that way passes with the guard deleted, which
// is the shape this suite exists to catch. Match the SUFFIX.
const has = (r, name) => r.fields.some((k) => k === name || k.endsWith(`::${name}`))

const analyzeBindings = (text, opts = {}) =>
  analyzeTarget({
    kind: 'module-bindings',
    declSources: [{ path: 'store/mod.ts', text }],
    sources: [{ path: 'store/mod.ts', text }],
    inPlaceMutationIsWrite: true,
    ...opts,
  })

const K = (name) => `store/mod.ts::${name}`

// --- 10a. RED --------------------------------------------------------------

test('a module-level LET written and never read FAILS, named by file::binding', () => {
  const r = analyzeBindings("let flag = false;\nexport function a(): void { flag = true; }\n")
  assert(r.failures.length === 1, `expected 1 failure, got ${JSON.stringify(r.failures)}`)
  assert(/store\/mod\.ts::flag is WRITE-ONLY: 1 write site\(s\)/.test(r.failures[0]), r.failures[0])
})

test('the binding failure lists EVERY write site with a line number', () => {
  const r = analyzeBindings("let n = 0;\nfunction a() { n = 1; }\nfunction b() { n = 2; }\n")
  const sites = r.failures[0].match(/write: store\/mod\.ts:\d+/g) || []
  assert(sites.length === 2, `expected 2 write sites, got ${sites.length}: ${r.failures[0]}`)
})

test('#7421 shape on a binding: written in four places, read nowhere', () => {
  const src = `
let isSessionSwitchReplay = false;
export function reset(): void { isSessionSwitchReplay = false; }
export function a(): void { isSessionSwitchReplay = true; }
export function b(): void { isSessionSwitchReplay = true; }
export function c(): void { isSessionSwitchReplay = false; }
`
  const r = analyzeBindings(src)
  assert(r.failures.length === 1, `expected 1, got ${JSON.stringify(r.failures)}`)
  assert(/isSessionSwitchReplay is WRITE-ONLY: 4 write site\(s\)/.test(r.failures[0]), r.failures[0])
})

test('a CONST Map populated and cleared but never consulted FAILS', () => {
  // The exact shape #7467 names. A `const` cannot be reassigned, so without the
  // mutator rule this binding would have zero writes by construction and could
  // never fail — a guard reporting clean on state it structurally cannot judge.
  const src = `
const pending = new Map<string, number>();
export function add(k: string): void { pending.set(k, 1); }
export function drop(k: string): void { pending.delete(k); }
export function reset(): void { pending.clear(); }
`
  const r = analyzeBindings(src)
  assert(r.failures.length === 1, `expected 1, got ${JSON.stringify(r.failures)}`)
  assert(/pending is WRITE-ONLY: 3 write site\(s\)/.test(r.failures[0]), r.failures[0])
})

test('the mutator rule is what makes that case reachable (control)', () => {
  // With inPlaceMutationIsWrite off, the SAME source has zero writes and can never
  // reach the failure bucket. Pinned so the flag cannot be dropped silently.
  const src = 'const pending = new Map();\nexport function add(k) { pending.set(k, 1); }\n'
  const off = analyzeBindings(src, { inPlaceMutationIsWrite: false })
  assert(off.failures.length === 0 && off.warnings.length === 0, 'expected a plain read')
  assert(off.perName.get(K('pending')).writes.length === 0, 'a mutator was still a write')
  const on = analyzeBindings(src)
  assert(on.perName.get(K('pending')).writes.length === 1, 'the mutator was not a write')
})

test('a CONST Record populated only by INDEX ASSIGNMENT FAILS (#7537)', () => {
  // The #7467 shape for a plain object. `const` cannot be reassigned and a
  // Record has no mutator METHOD, so index assignment is its ONLY write shape:
  // without the rule this binding had 2 reads / 0 writes and could never reach
  // the failure bucket, however dead it became. The live instance was
  // `gitOneshotTimers` — see the CLI case below.
  const src = `
const counts: Record<string, number> = {};
export function record(k: string, n: number): void { counts[k] = n; }
export function forget(k: string): void { counts[k] = 0; }
`
  const r = analyzeBindings(src)
  assert(r.failures.length === 1, `expected 1, got ${JSON.stringify(r.failures)}`)
  assert(/counts is WRITE-ONLY: 2 write site\(s\)/.test(r.failures[0]), r.failures[0])
})

test('a CONST object mutated only by PROPERTY assignment FAILS (#7537)', () => {
  const src = `
const state = { count: 0, at: 0 };
export function bump(n: number): void { state.count = n; }
export function stamp(t: number): void { state.at = t; }
`
  const r = analyzeBindings(src)
  assert(r.failures.length === 1, `expected 1, got ${JSON.stringify(r.failures)}`)
  assert(/state is WRITE-ONLY: 2 write site\(s\)/.test(r.failures[0]), r.failures[0])
})

test('the index-assignment rule is what makes those reachable (control)', () => {
  // Two-sided: with the flag off the SAME source is silently clean — 2 reads,
  // 0 writes, no failure AND no warning, which is the exact observable #7537
  // reproduced on `_prevMessageCounts` in the live tree.
  const src = 'const counts = {};\nexport function record(k, n) { counts[k] = n; }\n'
  const off = analyzeBindings(src, { inPlaceMutationIsWrite: false })
  assert(off.failures.length === 0 && off.warnings.length === 0, 'expected a plain read')
  assert(off.perName.get(K('counts')).writes.length === 0, 'an index assignment was still a write')
  const on = analyzeBindings(src)
  assert(on.perName.get(K('counts')).writes.length === 1, 'the index assignment was not a write')
  assert(on.failures.length === 1, `expected the failure to become reachable: ${JSON.stringify(on.failures)}`)
})

test('a genuine reader still rescues an index-assigned binding (no false positive)', () => {
  // The shape `gitOneshotTimers` actually has: index-assigned in four places
  // AND read in two. It must stay clean — the rule reclassifies references, it
  // does not manufacture failures.
  const src = `
const timers: Record<string, number | undefined> = {};
export function arm(k: string): void {
  const prev = timers[k];
  if (prev !== undefined) { timers[k] = undefined; }
  timers[k] = 1;
}
export function read(k: string): number | undefined { return timers[k]; }
`
  const r = analyzeBindings(src)
  assert(r.failures.length === 0, `false positive: ${JSON.stringify(r.failures)}`)
  const { reads, writes } = r.perName.get(K('timers'))
  assert(reads.length === 2 && writes.length === 2, `got ${reads.length}r ${writes.length}w`)
})

test('a COMMENTED-OUT reader does not rescue a write-only binding', () => {
  const r = analyzeBindings("let flag = false;\nfunction a() { flag = true; }\n// if (flag) doThing();\n")
  assert(r.failures.length === 1, `a commented reader was counted: ${JSON.stringify(r.failures)}`)
})

// --- 10b. GREEN — read shapes ----------------------------------------------

const bindingReadShapes = [
  ['an if condition', 'flag = true;\n  if (flag) { doThing(); }'],
  ['a right-hand side', 'flag = true;\n  const x = flag;\n  void x;'],
  ['an argument', 'flag = true;\n  doThing(flag);'],
  ['a template interpolation', 'flag = true;\n  const s = `v=${flag}`;\n  void s;'],
  ['a property access through it', 'flag = true;\n  void flag.valueOf();'],
  ['a return', 'flag = true;\n  return flag;'],
]
for (const [label, body] of bindingReadShapes) {
  test(`a binding read via ${label} PASSES`, () => {
    const r = analyzeBindings(`let flag: unknown = null;\nfunction run(): unknown {\n  ${body}\n}\n`)
    assert(r.failures.length === 0, `false positive: ${JSON.stringify(r.failures)}`)
  })
}

test('a PROPERTY that shares a binding name is not a reference to the binding', () => {
  const r = analyzeBindings('let flag = false;\nfunction a() { flag = true; }\nfunction b() { return o.flag; }\n')
  assert(r.failures.length === 1, `obj.flag rescued the binding: ${JSON.stringify(r.failures)}`)
})

// --- 10c. The statement-position rule for ++/-- and mutators ---------------

const incdecCases = [
  ['n++ alone is a WRITE and not a read', 'n++;', 0, 1],
  ['--n alone is a WRITE and not a read', '--n;', 0, 1],
  ['a for-update n++ is a WRITE (nothing consumes it)', 'for (let i = 0; i < 3; n++) {}', 0, 1],
  ['return n++ is a READ — its value is handed on', 'function f() { return n++; }', 1, 0],
  ['String(++n) is a READ — its value is consumed', 'const s = String(++n);', 1, 0],
  ['f(n++) is a READ', 'f(n++);', 1, 0],
  ['a plain assignment is still a WRITE', 'n = 1;', 0, 1],
  // #7530 F2 — the header used to claim the rule was "the value is DISCARDED".
  // It is not: the code tests STATEMENT POSITION, a strict subset. These two
  // discard the value and still classify as reads. Rescue-only, so it cannot
  // produce a false accusation — pinned so the gap stays a decision on record
  // instead of an assumption about what the regex does.
  ['void n++ is a READ — discarded, but not at statement position', 'void n++;', 1, 0],
  ['c && n++ is a READ — discarded, but not at statement position', 'c && n++;', 1, 0],
]
for (const [label, stmt, wantReads, wantWrites] of incdecCases) {
  test(`binding: ${label}`, () => {
    const { reads, writes } = classifyBindingReferences(stripComments(stmt), 'n')
    assert(
      reads.length === wantReads && writes.length === wantWrites,
      `got ${reads.length}r ${writes.length}w, wanted ${wantReads}r ${wantWrites}w`,
    )
  })
}

test('the SAME rule applies to a context field — return _ctx.n++ is a read', () => {
  // One classifier, one rule. If these two ever disagree, the "one core" claim
  // in the header is false.
  const { reads, writes } = classifyReferences(stripComments('function f() { return _ctx.n++; }'), 'n', RECEIVERS)
  assert(reads.length === 1 && writes.length === 0, `got ${reads.length}r ${writes.length}w`)
})

const mutatorCases = [
  ['m.set(k, v); is a WRITE', 'm.set(k, v);', 'm', 0, 1],
  ['m.clear(); is a WRITE', 'm.clear();', 'm', 0, 1],
  ['arr.push(x); is a WRITE', 'arr.push(x);', 'arr', 0, 1],
  ['if (m.delete(k)) is a READ — the result is consumed', 'if (m.delete(k)) doThing();', 'm', 1, 0],
  ['const last = m.pop() is a READ', 'const last = m.pop();', 'm', 1, 0],
  ['m.get(k) is a READ', 'm.get(k);', 'm', 1, 0],
  ['m.size is a READ', 'const n = m.size;', 'm', 1, 0],
  // #7530 F3 — MUTATOR_AHEAD carries a `\??` for optional chaining. Dropping
  // it survived every other case in this file, so the optional form gets its
  // own pin: `m?.set(...)` at statement position must classify exactly as
  // `m.set(...)` does.
  ['m?.set(k, v); is a WRITE — optional chaining is the same mutation', 'm?.set(k, v);', 'm', 0, 1],
  // #7530 F1 pinned these two as deliberate READS and said, in as many words,
  // that if #7537 landed the pin would go red and the header must be updated
  // with it. #7537 landed; both were flipped in the same commit as the header,
  // exactly as that comment instructed. `gitOneshotTimers` in connection.ts
  // was the live instance — 6r/0w, four of its six references being
  // `gitOneshotTimers[key] = …` — and reports 2r/4w now.
  ['o[k] = v; is a WRITE of o — the only mutation shape a const Record has (#7537)', 'o[k] = v;', 'o', 0, 1],
  ['o.k = v; is a WRITE of o (#7537)', 'o.k = v;', 'o', 0, 1],
]
for (const [label, stmt, name, wantReads, wantWrites] of mutatorCases) {
  test(`binding: ${label}`, () => {
    const { reads, writes } = classifyBindingReferences(stripComments(stmt), name, { inPlaceMutationIsWrite: true })
    assert(
      reads.length === wantReads && writes.length === wantWrites,
      `got ${reads.length}r ${writes.length}w, wanted ${wantReads}r ${wantWrites}w`,
    )
  })
}

// --- 10c-2. Index and property assignment (#7537) --------------------------
//
// The second in-place mutation shape, and the ONLY one a `const` bound to a
// plain object or `Record` has. Before it landed, such a binding had zero
// writes BY CONSTRUCTION: the failure bucket was unreachable however dead the
// state became, which is the "guard that cannot fail" class in
// docs/false-safety-guards.md. Every case below is either the new WRITE or one
// of the deliberate limits around it — the limits are all the rescue direction
// (a missed write), so none of them can produce a false accusation, and each
// is pinned so it stays a decision rather than an assumption.

const accessorAssignCases = [
  // The write itself, in every operator form.
  ['o[k] = v; is a WRITE', 'o[k] = v;', 'o', true, 0, 1],
  ['o.field = v; is a WRITE', 'o.field = v;', 'o', true, 0, 1],
  ['o[k] += v; is a WRITE — every compound operator counts', 'o[k] += v;', 'o', true, 0, 1],
  ['o.field ??= v; is a WRITE', 'o.field ??= v;', 'o', true, 0, 1],
  ['o [ k ] = v; is a WRITE — whitespace between the steps is not a shape', 'o [ k ] = v;', 'o', true, 0, 1],
  ['o.length = 0; is a WRITE — truncating an array is a mutation', 'o.length = 0;', 'o', true, 0, 1],
  // #7548 F1 / #7553 — the SAME accessor blindness #7537 fixed, one operator
  // over: INCDEC_AHEAD was tested against the text that starts with `[` or `.`,
  // so it never saw the `++`. One mutation had THREE spellings and TWO
  // classifications on the same binding, and a `const counts: Record<string,
  // number> = {}` mutated only by `counts[k]++` was still unfailable by
  // construction — the exact property #7537 exists to remove, for one
  // remaining spelling.
  //
  // These four were pinned at their then-current classification by #7548, with
  // the instruction that #7553 landing must turn the two `read` rows red and
  // take the WHAT IT CANNOT SEE bullet with them. #7553 landed; both were
  // flipped in the same commit as the header, exactly as that comment said —
  // the same arrangement #7530 made for #7537, for the second time.
  // `_encryptionState` (message-handler.ts:680, `_encryptionState.sendNonce++`)
  // was the live instance: 7r/5w before, 6r/6w now, masked either way by five
  // plain reassignments rather than by anything the lint understood.
  // These two are ALSO #7558's flag-ON pins. #7692's review found the PR had
  // added a byte-identical pair further down and called them new controls; they
  // are removed and cross-referenced here instead, because two rows asserting
  // the same tuple kill the same mutants and overstate coverage.
  ['++o[k]; is a WRITE — the prefix form is seen (INCDEC_BEHIND)', '++o[k];', 'o', true, 0, 1],
  ['++o.field; is a WRITE — same, property form', '++o.field;', 'o', true, 0, 1],
  ['o[k]++; is a WRITE — the postfix form, through the accessor (#7553)', 'o[k]++;', 'o', true, 0, 1],
  ['o.field++; is a WRITE — same, property form (#7553)', 'o.field++;', 'o', true, 0, 1],
  // The decrement spelling is the same operator class and must not need its own
  // rule: INCDEC_AHEAD carries `--` alongside `++`, and dropping half of it
  // would survive every `++` case above.
  ['o[k]--; is a WRITE — `--` is the same mutation (#7553)', 'o[k]--;', 'o', true, 0, 1],
  ['o.field--; is a WRITE — same, property form (#7553)', 'o.field--;', 'o', true, 0, 1],
  // …under the SAME statement-position gate as every other in-place shape.
  // These three consume the value, so they are reads exactly as `return n++`
  // and `String(++n)` are on a bare binding.
  ['return o[k]++ is a READ — its value is handed on (#7553)', 'function f() { return o[k]++; }', 'o', true, 1, 0],
  ['const x = o[k]++ is a READ — its value is consumed (#7553)', 'const x = o[k]++;', 'o', true, 1, 0],
  ['f(o.field++) is a READ (#7553)', 'f(o.field++);', 'o', true, 1, 0],
  ['for (;; o[k]++) is a WRITE — nothing consumes it (#7553)', 'for (let i = 0; i < 3; o[k]++) {}', 'o', true, 0, 1],
  ['if (c) o[k]++; is a WRITE — `)` is a statement boundary (#7553)', 'if (c) o[k]++;', 'o', true, 0, 1],
  // ONE STEP DEEP applies to the postfix form too: what `o.a.b++` mutates is
  // the object held in `o.a`, not `o` — the same adjudication as `o.a.b = v`.
  ['o.a.b++; is a READ of o — the mutation lands in o.a (#7553)', 'o.a.b++;', 'o', true, 1, 0],
  ['o[i][j]++; is a READ of o — the mutation lands in o[i] (#7553)', 'o[i][j]++;', 'o', true, 1, 0],
  // `o?.f++` is a SyntaxError (an optional chain is not an assignment target),
  // so the `?.` exclusion the assign predicate already makes is right here too.
  ['o?.field++; is a READ — an optional chain is not a mutation target', 'o?.field++;', 'o', true, 1, 0],
  // NOT an increment. `o[k] - -1` is subtraction of a negative literal; a
  // predicate that matched `-` loosely would file it as a write.
  ['o[k] - -1 is a READ — a minus is not a decrement', 'const x = o[k] - -1;', 'o', true, 1, 0],
  ['o[k]++; is a READ with the flag OFF (control) (#7553)', 'o[k]++;', 'o', false, 1, 0],
  ['o.field++; is a READ with the flag OFF (control) (#7553)', 'o.field++;', 'o', false, 1, 0],
  // …and since #7558 the PREFIX form IS symmetric with it. These two rows were
  // inverted by that fix: they pinned the asymmetry deliberately so the fix
  // would be visible instead of silent, and flipping them is what makes it so.
  //
  // `++o[k]` reached isWriteAt through INCDEC_BEHIND, which is tested before
  // either in-place rule and consults neither the flag nor the accessor scan.
  // With the flag OFF it was a write while `o[k] = v`, `o[k] += 1` and `o[k]++`
  // were reads — the one shape on the list running in the ACCUSE direction, so
  // a context field whose only other reference was `++_ctx.f[k]` would be
  // called write-only and FAIL.
  //
  // The old comment here claimed "swept: zero `++X[` / `++X.` in
  // packages/{dashboard,app}/src". That is false as written — `++requestIdRef.current`
  // appears five times in packages/app/src. It is true only of the RECEIVERS
  // this lint scans (`_ctx`/`ctx`) and of module-level bindings, which is the
  // claim it meant to make and not the claim it made.
  ['++o[k]; is a READ with the flag OFF — symmetric with o[k]++ since #7558', '++o[k];', 'o', false, 1, 0],
  ['++o.field; is a READ with the flag OFF (#7558)', '++o.field;', 'o', false, 1, 0],
  // The controls that keep the fix from over-reaching. A prefix increment of
  // the BINDING is not an in-place mutation of what it holds — it rebinds —
  // so it stays a write on both targets, flag or no flag.
  ['++o; is a WRITE with the flag OFF — no accessor follows (#7558)', '++o;', 'o', false, 0, 1],
  // Postfix does NOT reach #7558's branch — it arrives through INCDEC_AHEAD,
  // which tests the text after the reference. Kept as a regression fence for a
  // future refactor that merges the two paths, and labelled as one: #7692's
  // review showed no mutation confined to #7558's diff can red it, so calling
  // it a control FOR that fix was wrong.
  ['o++; is a WRITE with the flag OFF — reaches isWriteAt via INCDEC_AHEAD, not #7558s branch', 'o++;', 'o', false, 0, 1],
  // DECREMENT. `INCDEC_AHEAD`/`INCDEC_BEHIND` union `++` and `--`, so this is
  // free — and untested by name, while the docstring table spells out only
  // `++`. Free behaviour that nothing pins is behaviour a refactor can take.
  ['--o[k]; is a READ with the flag OFF — same union as ++ (#7692)', '--o[k];', 'o', false, 1, 0],
  ['--o.field; is a READ with the flag OFF (#7692)', '--o.field;', 'o', false, 1, 0],
  ['--o[k]; is a WRITE with the flag ON (#7692)', '--o[k];', 'o', true, 0, 1],
  ['--o; is a WRITE with the flag OFF — no accessor follows (#7692)', '--o;', 'o', false, 0, 1],
  // ACCESSOR_AHEAD's docstring claims newline tolerance, on the grounds that
  // member access is not a restricted production. Nothing pinned it. This file
  // pins every other predicate's claimed newline behaviour (the F1/F5 review
  // rows), and an unpinned claim in a docstring is the overclaim class.
  ['++o\n[k]; is a READ with the flag OFF — member access spans the newline (#7692)', '++o\n[k];', 'o', false, 1, 0],
  ['++o\n.field; is a READ with the flag OFF — same (#7692)', '++o\n.field;', 'o', false, 1, 0],
  ['++o\n[k]; is a WRITE with the flag ON (#7692)', '++o\n[k];', 'o', true, 0, 1],
  // And statement position still gates it: a prefix increment whose value is
  // USED is a read, exactly as `o[k]++` in the same position is.
  ['const id = ++o.field; is a READ — value used, not statement position (#7558)', 'const id = ++o.field;', 'o', true, 1, 0],
  // An optional chain is not a mutation target in ANY spelling — `++o?.f`,
  // `o?.f++` and `o?.f = 1` are all SyntaxErrors. The postfix row above pinned
  // that for `o?.field++`; these pin the prefix form, which #7692's review
  // found `ACCESSOR_AHEAD` describing as reachable when it is not.
  ['++o?.field; is a READ — an optional chain is not a mutation target (#7692)', '++o?.field;', 'o', true, 1, 0],
  ['++o?.[k]; is a READ — same, computed form (#7692)', '++o?.[k];', 'o', true, 1, 0],
  ['++o?.[k]; is a READ with the flag OFF too (#7692)', '++o?.[k];', 'o', false, 1, 0],
  // THE ONE-ACCESSOR-STEP INVARIANT, for the prefix form. `++o.a.b` mutates
  // `o.a`; `o` is only read to reach it — which is already how `o.a.b = v` and
  // `o.a.b++` are classified two rows apart in this same table. #7558's first
  // implementation tested only the FIRST character after the reference, so with
  // the flag ON it called `++o.a.b` a WRITE of `o` while both siblings read it:
  // the same accuse direction #7558 exists to close, one level deeper.
  ['++o.a.b; is a READ — it mutates o.a, and o is only read to reach it (#7692)', '++o.a.b;', 'o', true, 1, 0],
  ['++o[i][j]; is a READ — same, computed form (#7692)', '++o[i][j];', 'o', true, 1, 0],
  ['++o.a.b; is a READ with the flag OFF too (#7692)', '++o.a.b;', 'o', false, 1, 0],
  // A call result is not a reference: `++o.f()` throws at runtime and TS
  // rejects it, so `o` is read — as it already is in `o.f()++`.
  ['++o.f(); is a READ — a call result is not a reference (#7692)', '++o.f();', 'o', true, 1, 0],
  // The control that keeps the invariant from over-reaching: exactly ONE step
  // still reaches the flag gate.
  ['++o.a; is a WRITE with the flag ON — one step, unchained (#7692)', '++o.a;', 'o', true, 0, 1],
  ['++o?.field; is a READ with the flag OFF too (#7692)', '++o?.field;', 'o', false, 1, 0],
  // The index expression is arbitrary source, so the scan must actually parse
  // it. A naive `\[[^\]]*\]` stops at the FIRST `]` and files both of these
  // as reads — one rescued write silences a whole binding.
  ['o[arr[i]] = v; is a WRITE — the index nests', 'o[arr[i]] = v;', 'o', true, 0, 1],
  ["o['a]b'] = v; is a WRITE — a `]` inside a string is not the bracket", "o['a]b'] = v;", 'o', true, 0, 1],
  // NOT an assignment at all.
  ['o[k] === v is a READ — `=` must not be an equality', 'if (o[k] === v) f();', 'o', true, 1, 0],
  ['o[k] is a READ — a bare index access', 'const x = o[k];', 'o', true, 1, 0],
  ['o.field is a READ — a bare property access', 'const x = o.field;', 'o', true, 1, 0],
  // ONE STEP DEEP, the same adjudication that keeps `m.get(k).push(x)` a read
  // of `m`: what these store into is the object held in `o.a` / `o[i]`.
  ['o.a.b = v; is a READ of o — the write lands in o.a', 'o.a.b = v;', 'o', true, 1, 0],
  ['o[i][j] = v; is a READ of o — the write lands in o[i]', 'o[i][j] = v;', 'o', true, 1, 0],
  // STATEMENT POSITION, the same gate the mutator rule uses. Both of these
  // genuinely mutate and are still reads — the documented rescue-only gap.
  ['const x = (o[k] = v) is a READ — the value is consumed', 'const x = (o[k] = v);', 'o', true, 1, 0],
  ['if ((o[k] = v)) is a READ — not at statement position', 'if ((o[k] = v)) f();', 'o', true, 1, 0],
  ['a concise arrow body `() => o.k = v` is a READ', 'const f = () => o.k = v;', 'o', true, 1, 0],
  // The BASE is what matters. In all three of these `o` is the key, the
  // aliased source or a destructuring target, never the assignment's base.
  ['obj[o] = v; is a READ of o — o is the computed KEY, not the base', 'obj[o] = v;', 'o', true, 1, 0],
  ['const c = { [o]: 1 } is a READ of o — a computed property key', 'const c = { [o]: 1 };', 'o', true, 1, 0],
  ['const alias = o; is a READ — assignment through an ALIAS is out of model', 'const alias = o;\nalias[k] = v;', 'o', true, 1, 0],
  ['({ x: o.k } = obj); is a READ — destructuring writes are the #7464 S2 gap', '({ x: o.k } = obj);', 'o', true, 1, 0],
  ['[o[k]] = arr; is a READ — same S2 gap, array form', '[o[k]] = arr;', 'o', true, 1, 0],
  // DELETE THROUGH AN ACCESSOR, RE-DECIDED by #7691. It was a write regardless
  // of the flag and of statement position, because `DELETE_BEHIND` was checked
  // before both — the last rule here that classified an in-place mutation
  // unconditionally. #7537 adjudicated it as a genuine mutation, which is true
  // and was not the question: `o[k] = v` is a genuine mutation too, and the
  // flag exists to say whether a TARGET counts mutations of the held object as
  // writes of the binding.
  //
  // It now takes the same flag, the same one-accessor-step invariant and the
  // same statement-position gate as its four siblings. BOTH columns are pinned
  // here, as #7553 and #7558 did for theirs, because a one-column pin is how
  // the asymmetry survived three issues.
  ['delete o[k]; is a WRITE with the flag ON', 'delete o[k];', 'o', true, 0, 1],
  ['delete o.f; is a WRITE with the flag ON — the property spelling', 'delete o.f;', 'o', true, 0, 1],
  ['delete o[k]; is a READ with the flag OFF (#7691)', 'delete o[k];', 'o', false, 1, 0],
  ['delete o.f; is a READ with the flag OFF (#7691)', 'delete o.f;', 'o', false, 1, 0],
  // The one-accessor-step invariant, the shape #7692 had to add for `++`.
  // `delete o.a.b` removes a property of what `o.a` holds, so it only READS
  // `o` — on both columns, exactly as `o.a.b = v` and `++o.a.b` do.
  ['delete o.a.b; is a READ — it deletes from o.a, not from o', 'delete o.a.b;', 'o', true, 1, 0],
  ['delete o[i][j]; is a READ — the index spelling of the same', 'delete o[i][j];', 'o', true, 1, 0],
  // Statement position. `if (delete o[k])` CONSUMES the boolean the operator
  // returns, so it is a read for the same reason `if ((o[k] = v))` and
  // `const x = m.delete(k)` are. This needed `atStatementStart` to learn that
  // `delete` is a prefix operator: without that it answers FALSE for a plain
  // `delete o[k];` too, and the write bucket would be unreachable rather than
  // narrower.
  ['if (delete o[k]) is a READ — the result is consumed (#7691)', 'if (delete o[k]) f();', 'o', true, 1, 0],
  ['const x = delete o[k]; is a READ — same gate', 'const x = delete o[k];', 'o', true, 1, 0],
  // `delete o?.[k]` is legal, unlike `++o?.f`. The accessor scan cannot read an
  // optional step, so it is a READ — the rescue direction, and the same answer
  // `o?.field++` gives.
  ['delete o?.[k]; is a READ — an optional step is not scanned', 'delete o?.[k];', 'o', true, 1, 0],
  // `?.` CONTINUES the accessor chain (#7699 review). `delete o.a?.b` removes a
  // property of `o.a`, so `o` is only READ — the same answer as the
  // `delete o.a.b` it is spelled beside, and it said WRITE until the optional
  // step was added to the refused set.
  //
  // The hole predates the shared predicate's second caller and was UNREACHABLE
  // through the first: `++o.a?.b` is a SyntaxError, so no increment could land
  // there. Giving it a `delete` caller is what made it live.
  ['delete o.a?.b; is a READ — `?.` continues the chain', 'delete o.a?.b;', 'o', true, 1, 0],
  ['delete o[i]?.[j]; is a READ — the index spelling', 'delete o[i]?.[j];', 'o', true, 1, 0],
  // The control that keeps `?.` from being read as a bare `?`. A TERNARY is not
  // a chain: `delete o.a ? x : y` parses as `(delete o.a) ? x : y`, which IS a
  // one-step mutation of `o`. Match `?.` and this stays a write; match `?` and
  // it silently becomes a read.
  ['delete o.a ? x : y; is a WRITE — a ternary is not an optional chain', 'delete o.a ? x : y;', 'o', true, 0, 1],
  ['const r = delete o.a ? x : y; is a READ — the result is consumed', 'const r = delete o.a ? x : y;', 'o', true, 1, 0],
  // A PARENTHESISED OR ASSERTED BASE IS A READ — the rule the header already
  // states for `(o)[k] = v`, `o![k] = v` and `(o as T)[k] = v` (#7548 F3),
  // applied to `delete` for the first time. The scan starts after the
  // IDENTIFIER and finds `)`, `!` or ` as`, so it cannot see the base.
  //
  // These are the rows that caught the first version of this branch. It
  // returned an unconditional write whenever `ACCESSOR_AHEAD` failed, reasoning
  // that only the SyntaxError shape `delete o` could get there — but `!` fails
  // that test too, so a TS non-null assertion took a write past the flag, past
  // the one-accessor-step invariant AND past the statement gate, in the accuse
  // direction, under today's flag-ON config.
  ['delete o!.f; is a READ — a non-null assertion hides the base', 'delete o!.f;', 'o', true, 1, 0],
  ['delete o!.a.b; is a READ — assertion, and more than one step', 'delete o!.a.b;', 'o', true, 1, 0],
  ['if (delete o!.f) is a READ — and must not skip the statement gate', 'if (delete o!.f) g();', 'o', true, 1, 0],
  ['delete (o)[k]; is a READ — a parenthesised base', 'delete (o)[k];', 'o', true, 1, 0],

  // A DIRECT delete — nothing continues the expression, so what is removed is
  // the reference itself. For a bare binding that is a strict-mode SyntaxError
  // and unreachable, but the shape is NOT unreachable in general: the interface
  // kind's reference is `receiver.field`, and `delete _ctx.field` removes the
  // field. It is pinned as a write six hundred lines above, and it is a write
  // for the same reason `_ctx.field = v` is — which is why this arm, like
  // `ASSIGN_AHEAD`, takes neither the flag nor the statement gate.
  //
  // The first version of this branch reached that answer by a route that also
  // swallowed `delete o!.f`. The rows above are the ones that caught it.
  ['delete o; is a WRITE — a direct delete of the reference itself', 'delete o;', 'o', true, 0, 1],
  ['delete o; is a WRITE with the flag OFF too — direct, not in-place', 'delete o;', 'o', false, 0, 1],
  // The two-sided control. With the flag off the SAME source has zero writes,
  // which is what made the bucket unreachable in the first place.
  ['o[k] = v; is a READ with the flag OFF (control)', 'o[k] = v;', 'o', false, 1, 0],
  ['o.field = v; is a READ with the flag OFF (control)', 'o.field = v;', 'o', false, 1, 0],
]
for (const [label, stmt, name, flag, wantReads, wantWrites] of accessorAssignCases) {
  test(`binding: ${label}`, () => {
    const { reads, writes } = classifyBindingReferences(stripComments(stmt), name, {
      inPlaceMutationIsWrite: flag,
    })
    assert(
      reads.length === wantReads && writes.length === wantWrites,
      `got ${reads.length}r ${writes.length}w, wanted ${wantReads}r ${wantWrites}w`,
    )
  })
}

test('an index expression inside the 256-byte accessor window is a WRITE', () => {
  // The operator windows are 64 bytes because a stripped COMMENT is all that
  // can widen them (#7464 C1). An index expression is arbitrary source, so it
  // gets its own, wider window — pinned on both sides so neither number can
  // drift silently.
  const key = 'k'.repeat(200)
  const { reads, writes } = classifyBindingReferences(stripComments(`o[${key}] = v;`), 'o', {
    inPlaceMutationIsWrite: true,
  })
  assert(writes.length === 1 && reads.length === 0, `got ${reads.length}r ${writes.length}w`)
})

test('an index expression LONGER than the window is a READ — unproven is not a write', () => {
  const key = 'k'.repeat(300)
  const { reads, writes } = classifyBindingReferences(stripComments(`o[${key}] = v;`), 'o', {
    inPlaceMutationIsWrite: true,
  })
  assert(reads.length === 1 && writes.length === 0, `got ${reads.length}r ${writes.length}w`)
})

test('the POSTFIX predicate shares that one window — both sides of 256 (#7553)', () => {
  // One window, both accessor predicates. A second number here would be a
  // second thing to drift, so `o[<200>]++` and `o[<300>]++` must answer exactly
  // as `o[<200>] = v` and `o[<300>] = v` do.
  const inside = classifyBindingReferences(stripComments(`o[${'k'.repeat(200)}]++;`), 'o', {
    inPlaceMutationIsWrite: true,
  })
  assert(inside.writes.length === 1 && inside.reads.length === 0, `inside: ${inside.reads.length}r ${inside.writes.length}w`)
  const outside = classifyBindingReferences(stripComments(`o[${'k'.repeat(300)}]++;`), 'o', {
    inPlaceMutationIsWrite: true,
  })
  assert(outside.reads.length === 1 && outside.writes.length === 0, `outside: ${outside.reads.length}r ${outside.writes.length}w`)
})

const accessorPredicateCases = [
  ['[k] =', true],
  ['.field =', true],
  ['[k] +=', true],
  ['.field ??=', true],
  ['[k] ==', false],
  ['[k] ===', false],
  ['[k] =>', false],
  ['.a.b =', false],
  ['[i][j] =', false],
  ['?.[k] =', false],
  ['?.field =', false],
  ['[k', false],
  ['.0 =', false],
  ['', false],
  ['(k) =', false],
]
for (const [after, want] of accessorPredicateCases) {
  test(`assignsThroughAccessor(${JSON.stringify(after)}) === ${want}`, () => {
    assert(assignsThroughAccessor(after) === want, `got ${assignsThroughAccessor(after)}`)
  })
}

// #7553 — the second predicate over the SAME accessor scan. The step-parsing
// half of these answers must be identical to the table above; only the operator
// past the step differs, which is the whole point of sharing `accessorStepEnd`.
const incrementPredicateCases = [
  ['[k]++', true],
  ['.field++', true],
  ['[k]--', true],
  ['.field --', true],
  ['[arr[i]]++', true],
  ["['a]b']++", true],
  ['[k] =', false],
  ['.field =', false],
  ['[k] +=', false],
  ['[k] + +x', false],
  ['[k] - -x', false],
  ['.a.b++', false],
  ['[i][j]++', false],
  ['?.[k]++', false],
  ['?.field++', false],
  ['[k++', false],
  ['.0++', false],
  ['', false],
  ['(k)++', false],
  ['++', false],
]
for (const [after, want] of incrementPredicateCases) {
  test(`incrementsThroughAccessor(${JSON.stringify(after)}) === ${want}`, () => {
    assert(incrementsThroughAccessor(after) === want, `got ${incrementsThroughAccessor(after)}`)
  })
}

test('the two accessor predicates are DISJOINT on every case in both tables', () => {
  // They share one scan and split on the operator past it. If a case ever
  // satisfied both, one of the two operator regexes has grown into the other's
  // territory — `=` is not `++` and `+=` is neither.
  for (const [after] of [...accessorPredicateCases, ...incrementPredicateCases]) {
    assert(
      !(assignsThroughAccessor(after) && incrementsThroughAccessor(after)),
      `both predicates accepted ${JSON.stringify(after)}`,
    )
  }
})

test('the INTERFACE kind still classifies _ctx.map[k] = v as a READ (#7532 owns that)', () => {
  // Both in-place rules ride one per-target flag, and classifyReferences never
  // passes it. That is a decision: a context field is a REASSIGNABLE property,
  // so `_ctx.map = new Map()` already reaches the failure bucket for it — the
  // argument that forced the rule onto `const` bindings does not apply here.
  const stripped = stripComments('_ctx.map[k] = v; _ctx.set.clear(); _ctx.map.field = v;')
  const { reads, writes } = classifyReferences(stripped, 'map', RECEIVERS)
  assert(reads.length === 2 && writes.length === 0, `map: ${reads.length}r ${writes.length}w`)
  const set = classifyReferences(stripped, 'set', RECEIVERS)
  assert(set.reads.length === 1 && set.writes.length === 0, `set: ${set.reads.length}r`)
})

test('delete _ctx.map[k] follows the target flag on the interface kind (#7691)', () => {
  // The asymmetry this used to pin is gone. The interface kind's model is that
  // a context field is a REASSIGNABLE property — `_ctx.field = v` already
  // reaches the failure bucket — so mutating the container is a read of the
  // field. Under that model `delete _ctx.map[k]` making a field write-only was
  // a false RED: the accuse direction, on a mutation the model deliberately
  // treats as a read.
  //
  // Both columns, because the default is what the interface kind ran with
  // before #7532 and the flag is a target setting, not a constant.
  const off = classifyReferences(stripComments('delete _ctx.map[k];'), 'map', RECEIVERS)
  assert(off.reads.length === 1 && off.writes.length === 0, `flag OFF: got ${off.reads.length}r ${off.writes.length}w`)
  const on = classifyReferences(stripComments('delete _ctx.map[k];'), 'map', RECEIVERS, { inPlaceMutationIsWrite: true })
  assert(on.writes.length === 1 && on.reads.length === 0, `flag ON: got ${on.reads.length}r ${on.writes.length}w`)
})

test('the ASI arm reaches `delete`, which pins the `start` half of its prefix skip (#7699 review)', () => {
  // `start` has exactly ONE consumer — `beginsLine(text, start)` in the third
  // arm of `atStatementStart`, the ASI rule #7554 added because the character
  // set alone "lost every in-place write in a semicolon-free file". The
  // dashboard store IS semicolon-free, and no delete case reached that arm, so
  // three separate mutations of `start` (`- 'delete'.length`, `= index`, `= i`)
  // each left the suite at 409/409 while flipping this classification.
  //
  // The siblings are pinned here already; this is the fourth form joining them.
  const src = 'const e = [1]\ndelete o[k]\n'
  const r = classifyBindingReferences(stripComments(src), 'o', { inPlaceMutationIsWrite: true })
  assert(r.writes.length === 1 && r.reads.length === 0, `got ${r.reads.length}r ${r.writes.length}w`)
  // The control: NOT at the start of its line, so ASI does not apply and the
  // delete is part of the preceding expression.
  const inline = classifyBindingReferences(stripComments('const e = [1] + delete o[k]\n'), 'o', { inPlaceMutationIsWrite: true })
  assert(inline.reads.length === 1 && inline.writes.length === 0, `got ${inline.reads.length}r ${inline.writes.length}w`)
})

test('delete reads the WIDE accessor window, like its siblings (#7699 review)', () => {
  // `delete` was handed the 64-byte operator slice that #7558's prefix path
  // uses, so `accessorStepEnd` hit an unbalanced `[` on any key longer than ~62
  // characters and returned -1 — making `delete o[<long key>]` a READ while
  // `o[<long key>] = v` and `o[<long key>]++` were WRITEs. Both sides of 256 are
  // pinned for each predicate, so this pins them for the third.
  const key = 'k'.repeat(200)
  const wide = classifyBindingReferences(stripComments(`delete o[${key}];`), 'o', { inPlaceMutationIsWrite: true })
  assert(wide.writes.length === 1, `inside the window: got ${wide.reads.length}r ${wide.writes.length}w`)
  // The far side. Past 256 the step cannot be read and the reference is a READ,
  // which is the same answer the assignment predicate gives at the same length.
  const past = 'k'.repeat(400)
  const far = classifyBindingReferences(stripComments(`delete o[${past}];`), 'o', { inPlaceMutationIsWrite: true })
  const farAssign = classifyBindingReferences(stripComments(`o[${past}] = v;`), 'o', { inPlaceMutationIsWrite: true })
  assert(
    far.writes.length === farAssign.writes.length,
    `delete and assignment disagree past the window: delete ${far.writes.length}w vs assign ${farAssign.writes.length}w`,
  )
})

test('a DIRECT delete of a context field stays a WRITE on both columns (#7691)', () => {
  // The case the bare arm exists for, and the one the first version of this
  // branch denied while claiming "there is no direct-delete case". A bare
  // binding cannot be deleted — `delete o` is a strict-mode SyntaxError — but
  // the interface kind's reference is `receiver.field`, and `delete _ctx.field`
  // removes the field. That is a direct write exactly as `_ctx.field = v` is,
  // so it takes neither the flag nor the statement gate, for the same reason
  // `ASSIGN_AHEAD` does not.
  for (const flag of [true, false]) {
    const r = classifyReferences(stripComments('delete _ctx.n;'), 'n', RECEIVERS, { inPlaceMutationIsWrite: flag })
    assert(r.writes.length === 1 && r.reads.length === 0, `flag ${flag}: got ${r.reads.length}r ${r.writes.length}w`)
  }
})

test('a bare `)` after a field delete is not a hidden base (#7699 review)', () => {
  // The control that keeps the `)` arm from swallowing an ENCLOSING paren. In
  // `delete (o)[k]` the `)` is followed by an accessor and really does hide the
  // base; in `if (delete _ctx.n)` it merely closes the `if`, and the field is
  // genuinely removed. Match a bare `)` and this silently becomes a read while
  // `if ((_ctx.n = v))` stays a write.
  const consumed = classifyReferences(stripComments('if (delete _ctx.n) f();'), 'n', RECEIVERS, { inPlaceMutationIsWrite: true })
  assert(consumed.writes.length === 1, `got ${consumed.reads.length}r ${consumed.writes.length}w`)
  // ...and the shape it must NOT swallow, one accessor deeper, where the `)`
  // really does follow a hidden base.
  const hidden = classifyBindingReferences(stripComments('delete (o)[k];'), 'o', { inPlaceMutationIsWrite: true })
  assert(hidden.reads.length === 1 && hidden.writes.length === 0, `got ${hidden.reads.length}r ${hidden.writes.length}w`)
})

test('an IN-PLACE delete through a context field obeys the flag (#7691)', () => {
  // The mirror of the row above: `delete _ctx.n[k]` removes a property of what
  // the field HOLDS, so it is the in-place shape and takes the flag.
  const on = classifyReferences(stripComments('delete _ctx.n[k];'), 'n', RECEIVERS, { inPlaceMutationIsWrite: true })
  assert(on.writes.length === 1 && on.reads.length === 0, `flag ON: got ${on.reads.length}r ${on.writes.length}w`)
  const off = classifyReferences(stripComments('delete _ctx.n[k];'), 'n', RECEIVERS, { inPlaceMutationIsWrite: false })
  assert(off.reads.length === 1 && off.writes.length === 0, `flag OFF: got ${off.reads.length}r ${off.writes.length}w`)
})

test('atStatementStart locates the whole `delete` expression, not the binding (#7691)', () => {
  // The enabling change, stated directly. Without it the walk lands on the `e`
  // of the keyword — neither a statement boundary nor a primary-expression end
  // — so a plain `delete o[k];` answers FALSE and gating on it would make the
  // delete write bucket unreachable instead of narrower.
  assert(atStatementStart('delete o[k];', 7) === true, 'plain delete statement')
  assert(atStatementStart('{ delete o[k]; }', 9) === true, 'after a brace')
  assert(atStatementStart('if (delete o[k]) f();', 11) === false, 'the result is consumed')
  assert(atStatementStart('const x = delete o[k];', 17) === false, 'assigned')
})

test('a comment-padded increment still classifies as a WRITE (C1 window, binding side)', () => {
  // atStatementStart scans back over the BLANKS a stripped comment leaves, so
  // the comment's length cannot flip the verdict — the mirror of #7464 C1.
  const long = `/* ${'x'.repeat(200)} */`
  const { reads, writes } = classifyBindingReferences(stripComments(`${long} n++;`), 'n')
  assert(writes.length === 1 && reads.length === 0, `padded increment misclassified: ${reads.length}r ${writes.length}w`)
})

test('atStatementStart answers alike for a prefix and a postfix increment', () => {
  assert(atStatementStart('n++;', 0) === true, 'postfix at file start')
  assert(atStatementStart('++n;', 2) === true, 'prefix at file start')
  assert(atStatementStart('return n++;', 7) === false, 'after `return`')
  assert(atStatementStart('f(++n);', 4) === false, 'inside a call')
  assert(atStatementStart('{ n++; }', 2) === true, 'after a brace')
  assert(atStatementStart('if (c) n++;', 7) === true, 'after a paren')
})

// --- 10c-3. The two statement-boundary arms #7554 added --------------------
//
// STATEMENT_BOUNDARY is five characters, and #7537 had just routed a SECOND
// predicate through the gate it decides — a hardcoded set beside a growing set
// of callers, the shape docs/false-safety-guards.md catalogues. Two shapes fell
// through it, both verified live and both measured before the rule changed:
//
//   message-handler.ts:1084  `else _pendingTranscriptFetches.set(…)`  7r/4w -> 6r/5w
//   scheduledTaskRequests.ts:95  `[…]` then `pending.clear()`, no `;`  5r/4w -> 4r/5w
//
// A sweep of EVERY in-place-shaped reference on both rosters found exactly
// those two and nothing else, so these arms are the whole of the miss rather
// than a sample of it. The MISS direction is rescue-only, as every gap here is;
// widening the gate is the direction that can accuse, which is why the negative
// controls below matter more than the positives and why the identifier residual
// at the end of the table is refused rather than admitted.

const statementBoundaryCases = [
  // Arm 1: the keyword boundary. What follows `else` and `do` is a Statement,
  // so its value is discarded by definition.
  ['else m.clear(); is a WRITE (#7554)', 'if (c) f();\nelse m.clear();', 'm', 0, 1],
  ['else o[k] = v; is a WRITE — the same gate both in-place rules use', 'if (c) f();\nelse o[k] = v;', 'o', 0, 1],
  ['else o[k]++; is a WRITE — #7553 rides the same gate', 'if (c) f();\nelse o[k]++;', 'o', 0, 1],
  ['else delete o[k]; is a WRITE — #7691 rides it too', 'if (c) f();\nelse delete o[k];', 'o', 0, 1],
  ['do m.clear(); while (c) is a WRITE (#7554)', 'do m.clear(); while (c);', 'm', 0, 1],
  // …and the keyword must be a whole KEYWORD, not the tail of an identifier
  // and not a member named `else`.
  ['a property named `else` is not the keyword', 'const x = a.else m.clear();', 'm', 1, 0],
  ['an identifier ENDING in `do` is not the keyword', 'const x = judo m.clear();', 'm', 1, 0],
  // Arm 2: ASI. The previous character closed a complete primary expression and
  // the reference starts a new line, so the parser must insert the `;`.
  // The live shape, copied from scheduledTaskRequests.ts:94-95. Note the 0
  // READS: `[...m.values()]` yields NO reference at all, because the
  // `(?<![\w$.])` lookbehind rejects the `.` of the spread (#7548 F5). That gap
  // is live on this exact binding: `scheduledTaskRequests.ts` mentions `pending`
  // 11 times outside comments and the classifier sees 10 of them, the missing
  // one being line 94's `[...pending.values()]`. That is why line 95's
  // `.clear()` was this binding's only unseen WRITE rather than one of two.
  ['`]` then a new line is a WRITE — the live semicolon-free shape (#7554)', 'const e = [...m.values()]\nm.clear()', 'm', 0, 1],
  ['…and the same shape with a countable read', 'const e = [m.size]\nm.clear()', 'm', 1, 1],
  ['a string close then a new line is a WRITE', "const s = 'x'\nm.clear()", 'm', 0, 1],
  ['a template close then a new line is a WRITE', 'const s = `x`\nm.clear()', 'm', 0, 1],
  ['a numeric literal then a new line is a WRITE', 'const n2 = 1\nm.clear()', 'm', 0, 1],
  ['`]` then a new line, index-assignment form', 'const e = [1]\no[k] = v', 'o', 0, 1],
  ['`]` then a new line, postfix form (#7553 + #7554)', 'const e = [1]\no[k]++', 'o', 0, 1],
  // The line break is load-bearing: without it there is no ASI, and the same
  // characters are not two statements at all.
  ['`]` on the SAME line is still a READ — ASI needs the newline', 'const y = e[0] m.clear();', 'm', 1, 0],
  // The negative controls — continuations ending in a character NOT in the
  // primary-expression set. Each consumes the value, so each must stay a read;
  // accepting any of them would be a false ACCUSATION, the one direction this
  // lint's gaps do not otherwise run in.
  ['a ternary continuation stays a READ', 'const a = c\n  ? m.get(1)\n  : m.get(2);', 'm', 2, 0],
  ['an argument on its own line stays a READ', 'f(\n  m.set(k, v)\n);', 'm', 1, 0],
  ['an array element on its own line stays a READ', 'const a = [\n  m.get(1),\n  m.get(2)\n];', 'm', 2, 0],
  ['an object value on its own line stays a READ', 'const o2 = {\n  a: m.get(1)\n};', 'm', 1, 0],
  ['an `&&` continuation stays a READ', 'const a = c &&\n  m.delete(k);', 'm', 1, 0],
  ['an `=` continuation stays a READ', 'const a =\n  m.delete(k);', 'm', 1, 0],
  // THE RESIDUAL, pinned as a decision rather than left as prose. This IS the
  // same ASI, and it stays a read because accepting an identifier character
  // means knowing the trailing word is not `new` / `as` / `await` / `of` / … —
  // a hand-maintained keyword list beside a language that keeps adding
  // contextual keywords. Measured before it was refused: the identifier arm
  // moves ZERO of the ~950 classified references on either roster.
  ['an identifier-terminated line is a READ — the #7554 residual', 'const a = b\nm.clear()', 'm', 1, 0],
  // …and a braceless `case` arm is a read for the mirror reason: `:` is also a
  // ternary and an object value, so the character cannot be admitted, and the
  // keyword form needs a parse of the case expression. Zero live instances.
  ['a braceless `case` arm is a READ — `:` is ambiguous, so it is out of model', 'switch (x) {\n  case 1:\n    m.clear();\n}', 'm', 1, 0],
]
for (const [label, stmt, name, wantReads, wantWrites] of statementBoundaryCases) {
  test(`statement position: ${label}`, () => {
    const { reads, writes } = classifyBindingReferences(stripComments(stmt), name, { inPlaceMutationIsWrite: true })
    assert(
      reads.length === wantReads && writes.length === wantWrites,
      `got ${reads.length}r ${writes.length}w, wanted ${wantReads}r ${wantWrites}w`,
    )
  })
}

test('atStatementStart: the #7554 arms, at the predicate', () => {
  assert(atStatementStart('else m.clear();', 5) === true, 'after `else`')
  assert(atStatementStart('do m.clear(); while (c);', 3) === true, 'after `do`')
  assert(atStatementStart('judo m.clear();', 5) === false, 'after an identifier ENDING in `do`')
  assert(atStatementStart('a.else m.clear();', 7) === false, 'after a property named `else`')
  assert(atStatementStart('const e = [1]\nm.clear()', 14) === true, 'ASI after `]` at line start')
  assert(atStatementStart('const e = [1] m.clear()', 14) === false, 'the same characters, SAME line')
  assert(atStatementStart('const a = b\nm.clear()', 12) === false, 'the identifier residual')
  // The reference's LEFTMOST character is what has to begin the line, prefix
  // operator included: `++n` at column 0 begins its line even though `n` is at
  // column 2.
  assert(atStatementStart('const e = [1]\n++n', 16) === true, 'a prefix ++ at line start after ASI')
  // A stripped comment is blanked to spaces, so it can sit on either side of
  // the newline without changing the answer — the same property the C1 window
  // has, and the reason this scan is over the full text and not a window.
  assert(atStatementStart(stripComments('const e = [1] // why\nm.clear()'), 21) === true, 'comment before the newline')
  assert(atStatementStart(stripComments('const e = [1]\n/* why */ m.clear()'), 24) === true, 'comment after the newline')
})

// --- 10c-4. The three review findings on #7560 -----------------------------
//
// All three run in the ACCUSE direction — a read filed as a write — which is
// the one direction this lint's gaps are not allowed to take, so all three are
// fixed rather than documented as limits. Two of them (F1, F5) were introduced
// or widened by this PR; F2 was a hole in what the PR's own new rule was
// allowed to grow into.

const reviewFindingCases = [
  // F1. `UpdateExpression : LeftHandSideExpression [no LineTerminator] ++` is a
  // RESTRICTED PRODUCTION, so `o[k]` ⏎ `++x` is `o[k];` then `++x` — a READ of
  // o. INCDEC_AHEAD's `\s*` crossed the newline and filed it as a write.
  ['o[k] ⏎ ++x is a READ — postfix cannot cross a line terminator (F1)', 'o[k]\n++x;', 'o', true, 1, 0],
  ['o.field ⏎ ++x is a READ — same, property form (F1)', 'o.field\n++x;', 'o', true, 1, 0],
  ['o[k]++ on ONE line is still a WRITE — the control for F1', 'o[k]++;', 'o', true, 0, 1],
  ['o[k]  ++ with spaces is a WRITE — only a LINE TERMINATOR is restricted', 'o[k]  ++;', 'o', true, 0, 1],
  // ALL FOUR line terminators, not just `\n`. A mutant narrowing the class to
  // `[^\S\n]` SURVIVED the rest of this file — `\r`, `\u2028` and `\u2029` are
  // matched by `\s` and are not `\n`, so it read them as ordinary space and
  // filed the write. `\r` is reachable on a CRLF checkout (this lint runs on
  // Windows runners too) and `\u2028`/`\u2029` are line terminators the spec
  // lists, so the refinement has behaviour and gets pins rather than removal.
  ['o[k] CR ++x is a READ — a bare CR is a line terminator (F1)', 'o[k]\r++x;', 'o', true, 1, 0],
  ['o[k] CRLF ++x is a READ (F1)', 'o[k]\r\n++x;', 'o', true, 1, 0],
  ['o[k] U+2028 ++x is a READ — LINE SEPARATOR (F1)', 'o[k]\u2028++x;', 'o', true, 1, 0],
  ['o[k] U+2029 ++x is a READ — PARAGRAPH SEPARATOR (F1)', 'o[k]\u2029++x;', 'o', true, 1, 0],
  ['o[k] VT ++ is a WRITE — U+000B is whitespace, NOT a line terminator', 'o[k]\v++;', 'o', true, 0, 1],
  ['o[k] FF ++ is a WRITE — U+000C is whitespace, NOT a line terminator', 'o[k]\f++;', 'o', true, 0, 1],
  // The BARE form had the same defect, predating this PR — which is why the
  // restriction lives in the shared regex and not in the accessor predicate.
  ['n ⏎ ++x is a READ on a bare binding too (F1)', 'n\n++x;', 'n', true, 1, 0],
  ['n++ on one line is still a WRITE — the bare control', 'n++;', 'n', true, 0, 1],
  // …and the two operators that RIGHTLY cross a newline. Restricting either of
  // them would lose a real write; the asymmetry is the grammar's.
  ['o[k] ⏎ = v is a WRITE — an assignment operator is NOT restricted', 'o[k]\n= v;', 'o', true, 0, 1],
  ['++ ⏎ n is a WRITE — a PREFIX ++ is NOT restricted', '++\nn;', 'n', true, 0, 1],
  ['o ⏎ [k]++ is a WRITE — a member access is not restricted either', 'o\n[k]++;', 'o', true, 0, 1],
  // F5. A member access is not restricted, so `o.` ⏎ `else` and `o. else` are
  // both the member `o.else` and neither introduces a statement. The `.` guard
  // only saw a dot sitting hard against the word.
  ['a. ⏎ else m.clear() is a READ — the member access spans the line (F5)', 'a.\nelse m.clear();', 'm', true, 1, 0],
  ['a. else m.clear() is a READ — a space is enough to miss the dot (F5)', 'a. else m.clear();', 'm', true, 1, 0],
  ['a?. ⏎ else m.clear() is a READ — optional member, same shape (F5)', 'a?.\nelse m.clear();', 'm', true, 1, 0],
  ['a.else m.clear() is a READ — the control that already passed', 'a.else m.clear();', 'm', true, 1, 0],
  ['a genuine else arm across a newline is STILL a WRITE — the F5 control', 'if (c) f();\nelse m.clear();', 'm', true, 0, 1],
  // F2. `/` closes a regex literal (a primary expression) AND is the division
  // operator, and this predicate has no lexer state to tell them apart. The
  // division reading is the one that accuses, so `/` stays out.
  ['a division continuation is a READ — `/` is not a primary-expression end (F2)', 'const a = b /\nm.delete(k);', 'm', true, 1, 0],
  ['a `>` continuation is a READ — comparison, JSX close, arrow tail', 'const a = b >\nm.delete(k);', 'm', true, 1, 0],
]
for (const [label, stmt, name, flag, wantReads, wantWrites] of reviewFindingCases) {
  test(`review finding: ${label}`, () => {
    const { reads, writes } = classifyBindingReferences(stripComments(stmt), name, { inPlaceMutationIsWrite: flag })
    assert(
      reads.length === wantReads && writes.length === wantWrites,
      `got ${reads.length}r ${writes.length}w, wanted ${wantReads}r ${wantWrites}w`,
    )
  })
}

// F2, at the predicate: the whole SET, in both directions. Adding `/` to
// PRIMARY_EXPRESSION_END moved zero references in the tree and passed the
// entire harness, so the exclusions need a pin of their own — an admitted
// character converts reads into writes, and that is the accuse direction.
const primaryExpressionEndChars = [
  // Admitted: these can ONLY end a complete primary expression, so an
  // identifier on the next line cannot continue them and ASI is guaranteed.
  [']', true], ["'", true], ['"', true], ['`', true], ['0', true], ['9', true],
  // Refused: every one of these can end a CONTINUED line.
  ['/', false], ['>', false], ['<', false], ['+', false], ['-', false],
  ['*', false], ['%', false], ['&', false], ['|', false], ['^', false],
  ['~', false], ['!', false], ['?', false], [':', false], [',', false],
  ['.', false], ['=', false], ['(', false], ['[', false], ['@', false],
]
for (const [ch, admitted] of primaryExpressionEndChars) {
  test(`atStatementStart: a line ending in ${JSON.stringify(ch)} ${admitted ? 'IS' : 'is NOT'} a statement boundary`, () => {
    const text = `x ${ch}\nn`
    assert(
      atStatementStart(text, text.length - 1) === admitted,
      `got ${atStatementStart(text, text.length - 1)}`,
    )
  })
}

// --- 10d. Roster discovery -------------------------------------------------

test('every module-level LET is state; a nested one is not', () => {
  const names = extractModuleBindings('let a = 1;\nfunction f() { let b = 2; return b; }\n').map((b) => b.name)
  assert(JSON.stringify(names) === JSON.stringify(['a']), `got ${JSON.stringify(names)}`)
})

const constRoster = [
  ['a number literal', 'const CAP = 32;', false],
  ['a string literal', "const MSG = 'x';", false],
  ['a regex literal', 'const RE = /^a$/i;', false],
  ['a boolean literal', 'const ON = true;', false],
  ['an alias of another binding', 'const A = SC_A;', false],
  ['a dotted alias', 'const A = mod.thing;', false],
  ['an arrow function', 'const f = (s: S): boolean => s.x;', false],
  ['a function expression', 'const f = function () { return 1; };', false],
  ['a `new` expression', 'const m = new Map<string, number>();', true],
  ['an array literal', 'const q: string[] = [];', true],
  ['an object literal', 'const o: T = { a: 1 };', true],
  ['a factory call', 'const h = createHeartbeat({ a: 1 });', true],
  ['a generic factory call', 'const t = createTable<S>();', true],
]
for (const [label, decl, inRoster] of constRoster) {
  test(`a const initialised from ${label} is ${inRoster ? '' : 'NOT '}state`, () => {
    const found = extractModuleBindings(stripComments(decl)).length
    assert(found === (inRoster ? 1 : 0), `got ${found} binding(s) from: ${decl}`)
  })
}

test('the DECLARATION itself is neither a read nor a write', () => {
  // Counting it as a write would push "declared and never mentioned again"
  // into the failure bucket, where the interface kind warns — and
  // `noUnusedLocals` already covers a genuinely unused private binding.
  const r = analyzeBindings('let held = 0;\nlet used = 0;\nexport function run(): void { void used; }\n')
  assert(r.failures.length === 0, `expected no failure, got ${JSON.stringify(r.failures)}`)
  assert(r.warnings.length === 1 && /held is UNREFERENCED/.test(r.warnings[0]), JSON.stringify(r.warnings))
})

test('the roster records the declaration OFFSET, not just the name', () => {
  const src = 'let alpha = 1;\n'
  const [b] = extractModuleBindings(src)
  assert(b.index === src.indexOf('alpha'), `index ${b.index} !== ${src.indexOf('alpha')}`)
  assert(b.exported === false && b.keyword === 'let', JSON.stringify(b))
})

// Each name below occurs EXACTLY ONCE in its declaration — asserted, so
// `indexOf` is an unambiguous independent answer for where the entry should
// point rather than merely the first of several candidates. #7533's acceptance
// criterion is per-declarator offsets, and until this table the only thing
// pinning them was the CLI verdict, which a name pointing at the wrong column
// still satisfies: the classifier skips `index..index+name.length` to avoid
// counting the declaration as a read, so a drifted offset leaves the real
// declaration IN the scanned text and reads as a first reference.
const offsetRoster = [
  ['a multi-declarator `let`', 'let alpha = 1, beta = 2;\n', ['alpha', 'beta']],
  ['a destructuring `const`', 'const { alpha, beta } = make();\n', ['alpha', 'beta']],
  ['a RENAMED destructuring', 'const { a: alpha, b: beta } = make();\n', ['alpha', 'beta']],
  ['a DEFAULTED destructuring', 'const { alpha = 1, beta = 2 } = make();\n', ['alpha', 'beta']],
  ['an array pattern with a REST element', 'const [alpha, ...beta] = make();\n', ['alpha', 'beta']],
]
for (const [label, decl, names] of offsetRoster) {
  test(`the roster records a per-declarator offset for ${label} (#7533)`, () => {
    const found = extractModuleBindings(stripComments(decl))
    assert(found.length === names.length, `got ${found.length} binding(s), want ${names.length}: ${decl}`)
    assert(
      found.map((b) => b.name).join(',') === names.join(','),
      `names ${found.map((b) => b.name).join(',')} !== ${names.join(',')}`,
    )
    for (const [i, name] of names.entries()) {
      assert(decl.split(name).length === 2, `${name} is not unique in ${JSON.stringify(decl)}`)
      assert(
        found[i].index === decl.indexOf(name),
        `${name}: index ${found[i].index} !== ${decl.indexOf(name)} in ${JSON.stringify(decl)}`,
      )
    }
  })
}

test('the second declarator of `let a = 1, b = 2` lands on its own column (#7533)', () => {
  // The criterion's own example, with the arithmetic spelled out rather than
  // derived, so the table above cannot agree with a wrong `indexOf` unnoticed.
  const [a, b] = extractModuleBindings('let a = 1, b = 2;\n')
  assert(a.name === 'a' && a.index === 4, JSON.stringify(a))
  assert(b.name === 'b' && b.index === 11, JSON.stringify(b))
})

test('a renamed binding whose name is a SUBSTRING of the key it renames (#7533)', () => {
  // Why `identifierOffset` is a whole-identifier match and not `indexOf`: in
  // `{ alpha: pha }` the string `pha` first occurs INSIDE `alpha`, three
  // columns early. `indexOf` survives every case in the table above — none of
  // their names is a substring of anything to its left — so without this case
  // the offset math would be pinned only where it cannot be wrong.
  const decl = 'const { alpha: pha } = make();\n'
  assert(decl.indexOf('pha') === 10, 'fixture no longer has the ambiguity it is for')
  const [b] = extractModuleBindings(stripComments(decl))
  assert(b.name === 'pha', JSON.stringify(b))
  assert(b.index === 15, `index ${b.index} !== 15 — pointed inside \`alpha\`?`)
})

// A default value carries colons of its own, and the rename split used to read
// the first of them as `key: bound`. `{ a = cond ? 1 : 2 }` became "rename
// `a = cond ? 1` to `2`", which fails the identifier test and drops `a` into
// `unparsed`. Reported rather than silent — but still coverage the docblock
// claims. The offsetRoster's defaulted case uses `= 1`, which has no colon, so
// none of it exercised this.
const ternaryDefaults = [
  ['an object pattern', 'let { a = cond ? 1 : 2, b } = make();\n', ['a', 'b']],
  ['an array pattern', 'const [a = flag ? 1 : 2, b] = make();\n', ['a', 'b']],
  ['a RENAMED binding with a ternary default', 'const { k: a = cond ? 1 : 2 } = make();\n', ['a']],
  ['a nested ternary', 'let { a = p ? q ? 1 : 2 : 3 } = make();\n', ['a']],
]
for (const [label, decl, names] of ternaryDefaults) {
  test(`a ternary default does not read as a rename in ${label} (#7687)`, () => {
    const found = extractModuleBindings(stripComments(decl))
    const got = found.map((b) => (b.name === null ? `UNPARSED(${b.unparsed})` : b.name))
    assert(got.join(',') === names.join(','), `got ${got.join(',')}, want ${names.join(',')}: ${decl}`)
  })
}

test('a declarator that cannot be read is REPORTED, not dropped (#7533)', () => {
  // The `unparsed` channel had no test at all until #7687's review — the one
  // path whose documented behaviour had already been wrong once. A nested
  // pattern is the shape that still reaches it.
  const found = extractModuleBindings(stripComments('let { a: { deep } } = make();\n'))
  assert(found.length === 1, `got ${found.length} entries: ${JSON.stringify(found)}`)
  assert(found[0].name === null, `expected a null name, got ${JSON.stringify(found[0])}`)
  assert(/deep/.test(found[0].unparsed), `unparsed text lost the declarator: ${JSON.stringify(found[0])}`)
})

test('an unreadable declarator is FATAL — exit 2, and it NAMES the declarator (#7689)', () => {
  // RE-DECIDED. It was a `::warning::` on #7533's reasoning that the previous
  // extractor did not read these declarations either, so failing would red the
  // build over a shape that change did not introduce. That argument expired
  // once the count reached zero: both shipped targets contain NO unreadable
  // declarators today, so there is nothing to grandfather.
  //
  // Exit 2 and not 1, because this is "I could not check it" rather than "the
  // state is write-only" — the distinction the CLI already draws everywhere
  // else.
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]:
      `${DASH_TEST_EXPORTS}let { a: { deep } } = make();\n` +
      'export function f(): number { return 1; }\n',
  }))
  assert(r.status === 2, `exit ${r.status} — an unread declarator is a cannot-check\n${r.stderr}`)
  assert(/CANNOT CHECK/.test(r.stderr), `not reported as a cannot-check: ${r.stderr}`)
  assert(/unread declarator: .*deep/.test(r.stderr), `the declarator text was not named: ${r.stderr}`)
})

test('a tree with NO unreadable declarator still exits 0 — the other direction (#7689)', () => {
  // The control. Without it the case above passes for a guard that refuses
  // everything, which is its own catalogued false-safety shape: a check that
  // denies universally has negative tests that pass for the wrong reason and
  // keeps passing if the check is deleted outright.
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]:
      `${DASH_TEST_EXPORTS}let { readMe, alsoRead } = make();\n` +
      'export function f(): number { return readMe + alsoRead; }\n',
  }))
  assert(r.status === 0, `exit ${r.status} — a readable destructuring must not fail\n${r.stderr}`)
  assert(!/CANNOT CHECK/.test(r.stderr), `spurious cannot-check: ${r.stderr}`)
})

test('the unreadable ACCUMULATION carries every declarator, across files (#7689)', () => {
  // §1 of #7689: the channel was tested only at the CLI, one declarator at a
  // time, so nothing pinned that `analyzeModuleBindings` accumulates ACROSS
  // declarators and files. A collector that reported only the first would look
  // identical at the CLI, and would understate the very number the fatality
  // decision rests on.
  //
  // Each file also declares a READABLE binding, so the roster is non-empty and
  // this exercises the unreadable channel rather than the zero-roster guard.
  const a = 'let keepA = 0;\nlet { x: { deepOne } } = make();\nlet { y: { deepTwo } } = make();\n' +
    'export function ga(): number { keepA = 1; return keepA; }\n'
  const b = 'let keepB = 0;\nlet { z: { deepThree } } = make();\n' +
    'export function gb(): number { keepB = 1; return keepB; }\n'
  const r = analyzeTarget({
    kind: 'module-bindings',
    declSources: [{ path: 'store/a.ts', text: a }, { path: 'store/b.ts', text: b }],
    sources: [{ path: 'store/a.ts', text: a }, { path: 'store/b.ts', text: b }],
    inPlaceMutationIsWrite: true,
  })
  assert(r.unreadable.length === 3, `expected 3, got ${r.unreadable.length}: ${JSON.stringify(r.unreadable)}`)
  const joined = r.unreadable.join(' | ')
  for (const name of ['deepOne', 'deepTwo', 'deepThree']) {
    assert(joined.includes(name), `${name} missing: ${joined}`)
  }
  // BOTH files, so the accumulation is not per-file.
  assert(/store\/a\.ts/.test(joined) && /store\/b\.ts/.test(joined), joined)
  // The readable bindings were still judged — the unreadable ones did not
  // abort the analysis.
  assert(has(r, 'keepA') && has(r, 'keepB'), `readable bindings were lost: ${JSON.stringify(r.fields)}`)
})

test('an unreadable declarator does NOT mask a real finding elsewhere (#7689)', () => {
  // The reason this is data on the result rather than a throw. An earlier draft
  // threw CannotCheckError from the analysis, which pre-empted `judge()`:
  // measured, an unreadable declarator in one file SUPPRESSED a genuine
  // `store/b.ts::deadState is WRITE-ONLY` in another. One problem hiding
  // another is not an improvement on one problem being silent.
  const a = 'let keepA = 0;\nlet { x: { deep } } = make();\n' +
    'export function ga(): number { keepA = 1; return keepA; }\n'
  const b = 'let deadState = new Map();\nexport function f(): void { deadState.set(1, 2); }\n'
  const r = analyzeTarget({
    kind: 'module-bindings',
    declSources: [{ path: 'store/a.ts', text: a }, { path: 'store/b.ts', text: b }],
    sources: [{ path: 'store/a.ts', text: a }, { path: 'store/b.ts', text: b }],
    inPlaceMutationIsWrite: true,
  })
  assert(r.unreadable.length === 1, `expected the unread declarator: ${JSON.stringify(r.unreadable)}`)
  assert(
    r.failures.some((f) => f.includes('deadState')),
    `the write-only finding was masked: ${JSON.stringify(r.failures)}`,
  )
})

test('the CLI reports BOTH, and exits 2 because cannot-check outranks a finding (#7689)', () => {
  // End to end through the shipped config. Exit 2 and not 1, because "I could
  // not check part of this" is the stronger verdict — and both messages must be
  // on stderr, which is what separates this from the throw it replaced.
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]:
      `${DASH_TEST_EXPORTS}let { a: { deep } } = make();\n` +
      'let deadState = new Map();\n' +
      'export function f(): void { deadState.set(1, 2); }\n',
  }))
  assert(r.status === 2, `exit ${r.status} — cannot-check must outrank the finding\n${r.stderr}`)
  assert(/CANNOT CHECK — unread declarator: .*deep/.test(r.stderr), `the declarator was not named: ${r.stderr}`)
  assert(/deadState is WRITE-ONLY/.test(r.stderr), `the finding was masked: ${r.stderr}`)
})

// `stripComments` leaves literal CONTENT byte-identical by design, so a comma,
// semicolon or brace inside a string, template or regex reaches the declarator
// scanners raw. Uncounted, those characters either TRUNCATE the declaration
// list (losing a sibling) or split it in the wrong place — and a fragment that
// happens to start with an identifier character is then accepted as a binding.
// An invented name is the ACCUSE direction: it gets classified, and can fail
// the build over state that does not exist. Each row's `want` was checked
// against main, which produces none of the phantoms.
const literalAndWrapRoster = [
  ['a regex literal holding a comma', 'let re = /a,b/, c = compute();\n', 're,c'],
  ['a template holding interpolated commas', 'let a = `${x},${y}`, b = compute();\n', 'a,b'],
  ['a string holding an unbalanced brace', "let a = '{', b = compute();\n", 'a,b'],
  ['a string holding a semicolon', "let a = ';', b = compute();\n", 'a,b'],
  ['a generic ARROW parameter list', 'const id = <T, U = T>(x: T): U => x, z = compute();\n', 'id,z'],
  ['a declaration WRAPPED across lines', 'let a = 1,\n    b = compute();\n', 'a,b'],
  // Controls. Each one is a shape a plausible fix for the rows above breaks,
  // and three of them broke while this was being written.
  ['a spaced comparison, not a generic', 'let a = b < c, d = compute();\n', 'a,d'],
  ['a generic type ANNOTATION', 'let counts: Record<string, number> = {}, z = compute();\n', 'counts,z'],
  ['a division, not a regex', 'let a = x / y, b = compute();\n', 'a,b'],
  ['a statement that really does end at the newline', 'let a = compute()\nlet b = compute()\n', 'a,b'],
  ['a comparison with no `<` at all', 'let isBig = count > 10, z = compute();\n', 'isBig,z'],
  // An initializer beginning on the NEXT line. In-tree as
  // `export const SCHEDULER_TIMEOUT_ERROR =\n  '...'`
  // (packages/dashboard/src/store/scheduledTaskRequests.ts). Breaking the list
  // at that newline left `init` empty, so `isConstantInitializer` never saw the
  // string and four literal constants entered the real roster as state — where
  // they get CLASSIFIED and can be reported as unreferenced state. They are all
  // read today, so the lint stayed green: inert by luck, not by design.
  ['a `const` whose string initializer starts on the next line', "export const X =\n  'literal';\n", ''],
  ['a wrapped initializer with a real sibling', 'let a =\n  compute(), b = compute();\n', 'a,b'],
  // Why the continuation set is `,` and `=` and stops there. Widening it to `+`
  // continues across `let a = b++` into the NEXT statement — and the damage is
  // not the swallow, which `i = listStart` undoes by re-walking: it is that the
  // over-long list ALSO gets split, so `d` is emitted once from the bogus list
  // and again from the real one. Measured with `+` added: `a,d,c,d`. A
  // duplicate roster entry is classified twice, and the copy carries a
  // skipIndex that does not match its own declaration — so that declaration
  // stays in the scanned text and reads as a reference, which is the false-GREEN
  // direction. The single-statement form below is inert; this one is not.
  ['a POSTFIX increment ending the line', 'let a = b++\nlet c = compute(), d = compute();\n', 'a,c,d'],
  // `of` is only contextually a keyword (`for (x of y)`); `let of = 1` is legal
  // in a module, and listing it as reserved refused a real binding (#7687
  // review). The pair below pins BOTH directions of that list: a word that is
  // not reserved must bind, and one that is must still be refused.
  ['a binding named `of`, which is NOT reserved', 'let of = compute(), b = compute();\n', 'of,b'],
  ['a declarator named `await`, which IS reserved in a module', 'let a = 1, await = 2;\n', 'a,UNPARSED(await = 2)'],
  // #7689 §3. None of these was broken — they were UNPROTECTED, which is the
  // point: this parser has been rewritten twice (#7533, #7688) and will be
  // again, and a shape with no row is a shape a rewrite can drop silently.
  // Each expectation was derived from what the rule SHOULD say and then checked
  // against the tree, not copied off the implementation.
  ['a `var` object pattern', 'var { a, b } = f();\n', 'a,b', '#7689'],
  ['a `var` array pattern', 'var [a, b] = f();\n', 'a,b', '#7689'],
  ['an EXPORTED destructuring, which also feeds the exported-dedup path', 'export const { a, b } = f();\n', 'a,b', '#7689'],
  ['a plain array pattern with no rest', 'const [a, b] = f();\n', 'a,b', '#7689'],
  // One level deep, deliberately: the inner pattern is REPORTED rather than
  // guessed at, because a wrong name in the roster gets classified.
  ['a NESTED array pattern, refused one level in', 'const [[a, b], c] = f();\n', 'UNPARSED([a, b]),c', '#7689'],
  // The default-value shapes. Each carries a character the declarator splitter
  // also uses as a separator — a comma, then a brace — so each is a place a
  // naive split lands inside the default.
  ['a default holding a comma-bearing CALL', 'const { a = f(1, 2), b } = f();\n', 'a,b', '#7689'],
  ['a default holding a BRACE', 'const { a = { x: 1 }, b } = f();\n', 'a,b', '#7689'],
  ['a default holding a GENERIC — the two newest parsers intersecting', 'const { a = new Map<string, number>() } = f();\n', 'a', '#7689'],
  ['a pattern with a trailing generic ANNOTATION', 'const { a, b }: Foo<X, Y> = f();\n', 'a,b', '#7689'],
  ['TWO destructured declarators in one statement', 'const { a } = f(), { b } = f();\n', 'a,b', '#7689'],
  // `as const` is a TYPE ASSERTION, and its `const` matched the declaration
  // regex because the character before it is a space. The scan then read the
  // NEXT statement as a declarator list. Main emits
  // `A, UNPARSED('export const B = mk()'), B` here — `B` survives, because
  // `i = listStart` re-walks, so this was NOISE rather than lost coverage and
  // was invisible while the unreadable channel was only a warning.
  //
  // It stops being invisible in this same change, and it is not rare: it
  // accounted for ALL THIRTY unreadable declarators in packages/ before this
  // fix and zero after, and connection.ts already writes `as const` five times
  // at brace depth > 0 — one dedent from the roster's own directory.
  ['`as const`, which is an assertion and not a declaration', 'export const A = [1] as const\nexport const B = mk();\n', 'A,B', '#7689'],
  ['`as const` wrapped across lines', 'export const A = [\n  1,\n] as const\n\nexport const B = mk();\n', 'A,B', '#7689'],
  ['`as const` followed by real STATE, which must still be seen', 'export const A = [1] as const\nlet pendingThing = new Map();\n', 'A,pendingThing', '#7689'],
  // Controls for the lookbehind. It must not swallow a REAL declaration whose
  // initializer merely ends in an `as` cast, and `o.as` is not the keyword —
  // the same distinction `wordEndingAt` grew in #7560 F5.
  ['a real declaration after an `as` CAST', 'const x = y as T;\nconst z = mk();\n', 'x,z', '#7689'],
  ['a property named `as` does not suppress the next declaration', 'const o = { as: 1 };\nexport const B = mk();\n', 'o,B', '#7689'],
  // #7688. A destructuring declarator has NO initializer of its own — what
  // follows its `=` is the SOURCE — so the alias rule was reading that source
  // as the declarator's value and suppressing EVERY name in the pattern. On
  // main these three rows yield the empty string.
  //
  // Every destructuring fixture above sources from `make()`, and a CALL escapes
  // the alias rule, which is exactly why this shipped uncaught: the cases that
  // existed could not tell the two behaviours apart.
  ['a `const` pattern sourced from a BARE identifier', 'const { readMe, writeOnly } = ctx;\n', 'readMe,writeOnly', '#7688'],
  ['a `const` pattern sourced from a DOTTED path', 'const { sessionId, phase } = store.state;\n', 'sessionId,phase', '#7688'],
  ['a `const` ARRAY pattern sourced from a bare identifier', 'const [first, second] = tuple;\n', 'first,second', '#7688'],
  // The renamed / defaulted / rest forms, repeated with a NON-call source. The
  // `extractModuleBindings` docblock advertises exactly these as SEEN, and
  // every fixture that pinned them sourced from `make()` — so the claim was
  // testable only in the one spelling that escaped the alias rule. Each of the
  // three returns `[]` on main.
  ['a RENAMED `const` pattern from a bare source', 'const { a: alpha, b: beta } = ctx;\n', 'alpha,beta', '#7688'],
  ['a DEFAULTED `const` pattern from a bare source', 'const { alpha = 1, beta = 2 } = ctx;\n', 'alpha,beta', '#7688'],
  ['a REST `const` pattern from a bare source', 'const [alpha, ...beta] = ctx;\n', 'alpha,beta', '#7688'],
  // Controls for the two rows above: the alias rule itself must be UNCHANGED
  // for the single-name shape it was written for. Delete the `isPattern` guard
  // and the three rows above go red; weaken `isConstantInitializer` instead and
  // these two do.
  ['a single-name alias, which is still NOT state', 'const ALIAS = OTHER;\n', '', '#7688'],
  ['a single-name DOTTED alias, still NOT state', 'const ALIAS = other.path;\n', '', '#7688'],
  // #7688's second half. `Map<string, { a: number; b: number }>` did not match
  // the generic lookahead — it rejected any `<...>` containing a `;`, and a TS
  // inline object type carries its own — so the comma INSIDE the generic split
  // the declarator list and the fragment `{ x: number; y: number }>()` was read
  // as a binding pattern. Main yields `_a,number,_b` here: a PHANTOM, which is
  // the ACCUSE direction and the reason RESERVED_WORDS exists.
  ['a generic holding an inline object type', 'let _a = new Map<string, { x: number; y: number }>(), _b = compute();\n', '_a,_b', '#7688'],
  // The `const` spelling of the same line — in-tree at message-handler.ts:1240.
  // It was CORRECT on main, but only by accident: the phantom fragment has no
  // top-level `=`, so `init` was null and the alias rule dropped it. #7688's
  // first half removes exactly that cushion, so without the widened lookahead
  // this row would start failing.
  ['the `const` spelling of that generic', 'const _a = new Map<string, { x: number; y: number }>();\n', '_a', '#7688'],
  // Controls for the WIDENED lookahead: it must not start matching a `<` that
  // is a comparison. The first has a brace after the comma (the new alternative
  // in the regex) and must still split; the second puts the `;` at the
  // generic's own depth, where it still disqualifies the match.
  ['a comparison whose sibling is an object literal', 'let a = b < c, d = { x: 1 };\n', 'a,d', '#7688'],
  ['a comparison across a statement boundary', 'let a = b < c; let d = e > f, g = compute();\n', 'a,d,g', '#7688'],
  // The LOSS direction of the same generic bug, which the `new Map<...>` rows
  // above cannot reach: in ANNOTATION position the mis-split does not add a
  // phantom BESIDE the real binding, it REPLACES it. Main returns `number,z` —
  // `m` is gone, so a write-only `m` would never be judged at all. This is the
  // false-GREEN direction and the more serious of the two.
  ['a generic ANNOTATION holding an inline object type', 'const m: Record<string, { a: number; b: number }> = {}, z = compute();\n', 'm,z', '#7688'],
  // The generic ARROW spelling, which is the SECOND call site of the scan
  // (`prev === '='`). The `<T, U = T>` row above has no braces, so it is
  // satisfied by the old regex and cannot witness a revert of this half.
  // Main returns `f,U,z`: the type parameter `U` as a phantom binding.
  ['a generic ARROW parameter list holding an inline object type', 'const f = <T, U = { a: number; b: string }>(x: T) => x, z = compute();\n', 'f,z', '#7688'],
  // CONTROLS for the scan, and the ones that caught the first attempt at this
  // fix. Expressing "is this a generic" as a regex with a braced alternative
  // (`\{[^{}]*\}`) admits exactly ONE brace level, so these three — which MAIN
  // HANDLES CORRECTLY — started losing their binding to an `unparsed` warning.
  // Trading a phantom for a missing name one level down is the defect class
  // this whole file exists to catch, so both directions are pinned.
  ['a generic whose object type NESTS braces', 'const _r: Record<string, { a: { b: 1 } }> = {}, z = compute();\n', '_r,z', '#7688'],
  ['a generic nesting braces in initializer position', 'const _m = new Map<string, { run: { id: string } }>(), z = compute();\n', '_m,z', '#7688'],
  ['a generic whose object type nests THREE deep', 'const _d: Record<string, { a: { b: { c: 1 } } }> = {}, z = compute();\n', '_d,z', '#7688'],
  // A `{` inside a STRING LITERAL type must not be counted as nesting — the
  // same class `literalEnd`'s docblock records for `/a,b/` and `` `${x},${y}` ``.
  ['a generic holding a brace inside a string literal type', "const _s = new Map<'{', number>(), z = compute();\n", '_s,z', '#7688'],
  // A generic WRAPPED across lines is still not recognised — `genericEnd` bails
  // on a newline exactly as `[^;\n]` did. Pinned because the safe outcome is
  // not obvious: the declaration-end scan stops at that same newline (the last
  // significant character is `<`, not `,` or `=`), so the list TRUNCATES to one
  // declarator instead of mis-splitting, and no fragment is produced at all.
  ['a generic WRAPPED across lines, which truncates rather than mis-splits', 'let _w = new Map<\n  string, { a: number }\n>();\n', '_w', '#7688'],
]
// The issue tag is per-ROW, not baked into the template: rows added later
// belong to a different issue, and a case name that misattributes itself is the
// same defect as a comment describing a stronger check than its code performs.
for (const [label, decl, want, issue = '#7687'] of literalAndWrapRoster) {
  test(`the declarator scan reads ${label} (${issue})`, () => {
    const got = extractModuleBindings(stripComments(decl))
      .map((b) => (b.name === null ? `UNPARSED(${b.unparsed})` : b.name))
      .join(',')
    assert(got === want, `got [${got}], want [${want}] from ${JSON.stringify(decl)}`)
  })
}

// `genericEnd` — CLAUSE BY CLAUSE, driven directly (#7688 review).
//
// It is exported for this. The first version of it was pinned only through the
// extractor, and a reachability probe showed THREE of its clauses — the `;`
// rule, the newline bail and the unbalanced-`}` bail — were never executed by
// any of the suite's cases, while 6 of 9 mutations to it survived green. The
// `;` rule is the one behaviour this change deliberately alters, and the row
// added as its control provably could not reach it: the declaration-end scan
// breaks on a top-level `;` before the splitter ever sees one.
//
// A guard nobody can make fire is a guard nobody can prove.
const GE = (src) => genericEnd(src, src.indexOf('<'))
const GE_CALL = (src) => genericEnd(src, src.indexOf('<'), { requireCall: true })

const genericEndCases = [
  // [label, input, closes?]
  ['a plain type-argument list', '<string, number>', true],
  ['a `;` at the generic’s OWN depth, which is a comparison', 'a < b; c > d', false],
  ['a `;` INSIDE braces, which is a type-member separator', '<string, { a: 1; b: 2 }>', true],
  ['braces nested two deep', '<string, { a: { b: 1 } }>', true],
  ['braces nested three deep', '<string, { a: { b: { c: 1 } } }>', true],
  ['a NEWLINE, disqualifying at any depth', '<string,\n  number>', false],
  ['a newline INSIDE braces, also disqualifying', '<string, {\n  a: 1\n}>', false],
  // The unbalanced-`}` bail, in the ONLY spelling that discriminates. The
  // obvious fixture `<string } number>` passes with the bail DELETED — the
  // counter just goes to -1 and no later `>` sits at 0 — so it proves nothing.
  // Here a following `{` brings the mutated counter back to 0, the `>` closes,
  // and a stray brace has manufactured a generic. That is what the bail is for:
  // a depth-0 `}` means the scan has left the expression, and letting the
  // counter go negative lets it wander back in.
  ['an unbalanced `}` that a later `{` would compensate', '<a } { b > c', false],
  ['an unbalanced `}` at depth 0', '<string } number>', false],
  ['a brace inside a STRING literal, not counted', "<'{', number>", true],
  ['a `;` inside a string literal, still disqualifying', "<';', number>", false],
  ['a newline inside a TEMPLATE literal, still disqualifying', '<`a\nb`, number>', false],
  ['no closing `>` at all', '<string, number', false],
]
for (const [label, src, closes] of genericEndCases) {
  test(`genericEnd handles ${label} (#7688)`, () => {
    const got = GE(src)
    assert((got !== -1) === closes, `got ${got} from ${JSON.stringify(src)}, expected ${closes ? 'a close' : '-1'}`)
  })
}

test('genericEnd returns the index PAST the closing `>` (#7688)', () => {
  // The call site slices from this index to test for a following `(`. Off by
  // one and it reads the `>` itself, so every generic arrow stops being one.
  // `return j` instead of `j + 1` is a mutation the suite DID kill; this states
  // the contract directly rather than relying on that.
  const src = '<string, number>(x)'
  const end = GE(src)
  assert(src[end - 1] === '>', `index ${end} does not sit just past a '>': ${JSON.stringify(src.slice(0, end))}`)
  assert(src[end] === '(', `expected '(' at ${end}, got ${JSON.stringify(src[end])}`)
})

const genericEndCallCases = [
  ['a type-parameter list followed by `(`', '<T, U>(x: T) => x', true],
  ['a type-parameter list NOT followed by `(`', '<T, U> x', false],
  // The BACKTRACKING clause. The regex this replaced was lazy, so the engine
  // retried later `>` until one was followed by `(`. Returning the FIRST `>`
  // closed at `Array<string>` and put the type parameter `U` in the roster as a
  // binding — the exact phantom class this PR removes, one layer down, and
  // `exported` on an `export const`, which aborts the target as a duplicate.
  ['a nested generic before the `(`', '<T extends Array<string>, U>(x: T) => x', true],
  ['a defaulted nested generic before the `(`', '<T = Map<string, number>, U>(x: T) => x', true],
  ['a function type before the `(`', '<T extends (a: number) => void, U>(x: T) => x', true],
  ['whitespace between the `>` and the `(`', '<T, U>  (x: T) => x', true],
]
for (const [label, src, closes] of genericEndCallCases) {
  test(`genericEnd in requireCall mode handles ${label} (#7688)`, () => {
    const got = GE_CALL(src)
    assert((got !== -1) === closes, `got ${got} from ${JSON.stringify(src)}, expected ${closes ? 'a close' : '-1'}`)
  })
}

// The four REGRESSIONS the review panel found in the first version of this
// change, each measured against main. Every row here was CORRECT on main and
// wrong on that version, so each is a control in the direction that matters:
// they must stay green if this scan is ever touched again.
const reviewRegressions = [
  ['a generic ARROW whose type parameter nests a generic', 'const f = <T extends Array<string>, U>(x: T) => x, z = compute();\n', 'f,z'],
  ['the EXPORTED spelling of that arrow', 'export const f = <T extends Array<string>, U>(x: T) => x;\n', 'f'],
  ['a destructuring declarator with a TYPE ANNOTATION', 'let { readMe, writeOnly }: Ctx = ctx;\n', 'readMe,writeOnly'],
  ['an ARRAY pattern with a type annotation', 'const [first, second]: T[] = tuple;\n', 'first,second'],
  ['a comparison whose operand is a string holding a `;`', "let a = b < ';', c = d > e;\n", 'a,c'],
  ['a pattern whose DEFAULT value holds a brace', "let { readMe = '}', writeOnly } = ctx;\n", 'readMe,writeOnly'],
]
for (const [label, decl, want] of reviewRegressions) {
  test(`the declarator scan reads ${label} (#7688 review)`, () => {
    const got = extractModuleBindings(stripComments(decl))
      .map((b) => (b.name === null ? `UNPARSED(${b.unparsed})` : b.name))
      .join(',')
    assert(got === want, `got [${got}], want [${want}] from ${JSON.stringify(decl)}`)
  })
}

// The pattern-needs-an-initializer guard (#7688), tested where it is
// REACHABLE. A lexical destructuring declarator with no `=` is a SyntaxError,
// so a `{`- or `[`-leading fragment without one was FABRICATED by the splitter
// and is not a declarator at all. It must be refused BY NAME, never read for
// bindings.
//
// Driven through `declaratorNames` directly because that is where every shape
// is constructible. It IS reachable through the extractor — `const { a } ;` is
// a pattern with no initializer and arrives here — and the row below pins that,
// but most of the fragments this must refuse are ones only a mis-split can
// produce. An earlier version of this comment claimed the extractor could not
// reach it at all; that was wrong, and it is why the annotated-declarator
// regression below went unmeasured until review. This is defence in depth
// behind the scan — the layer that keeps a
// residual mis-split from becoming a phantom now that the alias rule no longer
// drops these fragments by accident (it used to, as a side effect of their
// having no `=`: the same test written in the wrong place, by luck).
const fabricatedFragments = [
  ['the tail of a mis-split generic', '{ serverTs: number; recvAt: number }>()'],
  ['an array-looking tail', '[a: number, b: string]>()'],
  ['a bare pattern with no initializer at all', '{ a, b }'],
  ['a pattern followed by `=>`, which is not an initializer', '{ a, b } => c'],
  ['a pattern followed by `==`, which is not an initializer', '{ a, b } == c'],
]
for (const [label, fragment] of fabricatedFragments) {
  test(`declaratorNames REFUSES ${label} instead of binding its names (#7688)`, () => {
    const { names, unparsed } = declaratorNames(fragment)
    assert(names.length === 0, `invented ${JSON.stringify(names)} from ${JSON.stringify(fragment)}`)
    assert(unparsed.length === 1, `the refusal was not reported: ${JSON.stringify(unparsed)}`)
  })
}

test('the EXTRACTOR reaches the refusal too, and reports rather than invents (#7688 review)', () => {
  // `const { a } ;` is a pattern with no initializer — a SyntaxError, so it
  // cannot be a real declaration — and it arrives at the guard through the
  // normal extractor path. Pinned because the comment above used to claim the
  // extractor could not reach this code at all, which is how the annotated
  // declarator `let { a }: T = x` was refused for three review rounds without
  // anyone measuring it.
  const found = extractModuleBindings(stripComments('const { a } ;\n'))
  assert(found.length === 1, `got ${JSON.stringify(found)}`)
  assert(found[0].name === null, `a name was invented: ${JSON.stringify(found[0])}`)
})

test('declaratorNames still reads a REAL pattern, so the refusal did not widen (#7688)', () => {
  // The control. Delete the guard and every row above passes anyway unless this
  // one proves the guard is discriminating rather than blanket — a check that
  // denies EVERYTHING is its own catalogued false-safety shape.
  const { names, unparsed } = declaratorNames('{ readMe, writeOnly } = ctx')
  assert(names.join(',') === 'readMe,writeOnly', `got ${JSON.stringify(names)}`)
  assert(unparsed.length === 0, `a real declarator was refused: ${JSON.stringify(unparsed)}`)
})

test('an EXPORTED binding is marked as such', () => {
  const [b] = extractModuleBindings('export let n = 0;\n')
  assert(b.exported === true, JSON.stringify(b))
})

// --- 10e. Clause blanking --------------------------------------------------

test('an `import { x } from` clause is not a read of x', () => {
  const src = "import { n } from './other';\nlet n2 = 0;\n"
  const out = blankModuleClauses(stripComments(src))
  assert(out.length === src.length, `length changed: ${out.length} vs ${src.length}`)
  assert(out.split('\n').length === src.split('\n').length, 'line count changed')
  assert(classifyBindingReferences(out, 'n').reads.length === 0, 'the import clause counted as a read')
})

test('an `export { x }` clause is not a read of x — the re-export rescue', () => {
  const src = 'let n = 0;\nfunction a() { n = 1; }\nexport { n };\n'
  const r = analyzeBindings(src)
  assert(r.failures.length === 1, `a re-export line rescued a write-only binding: ${JSON.stringify(r.failures)}`)
})

test('an `export const` DECLARATION is NOT blanked', () => {
  const out = blankModuleClauses('export const n = 1;\nfunction a() { return n; }\n')
  assert(/export const n = 1;/.test(out), `the declaration was blanked: ${JSON.stringify(out)}`)
  assert(extractModuleBindings(out).length === 0, 'a literal const should not be state')
})

// --- 10f. Scan-set scoping -------------------------------------------------

test('a PRIVATE binding is scanned in its own module only', () => {
  // A same-named local in an unrelated file must not rescue it. `_store` is the
  // real name this protects: generic enough to appear anywhere.
  const decl = 'let _store = null;\nfunction a() { _store = mk(); }\n'
  const r = analyzeTarget({
    kind: 'module-bindings',
    declSources: [{ path: 'store/mod.ts', text: decl }],
    sources: [
      { path: 'store/mod.ts', text: decl },
      { path: 'other/thing.ts', text: 'function b() { const _store = mk(); return _store; }\n' },
    ],
    inPlaceMutationIsWrite: true,
  })
  assert(r.failures.length === 1, `an unrelated local rescued a private binding: ${JSON.stringify(r.failures)}`)
})

test('an EXPORTED binding IS scanned across the target', () => {
  const decl = 'export let n = 0;\nfunction a() { n = 1; }\n'
  const r = analyzeTarget({
    kind: 'module-bindings',
    declSources: [{ path: 'store/mod.ts', text: decl }],
    sources: [
      { path: 'store/mod.ts', text: decl },
      { path: 'ui/panel.ts', text: "import { n } from '../store/mod';\nexport const show = () => String(n);\n" },
    ],
    inPlaceMutationIsWrite: true,
  })
  assert(r.failures.length === 0, `a cross-file reader was not seen: ${JSON.stringify(r.failures)}`)
})

// --- 10g. CANNOT-CHECK -----------------------------------------------------

test('ZERO discovered bindings is a cannot-check, not a clean run', () => {
  throws(
    () => analyzeBindings('export function f(): number { return 1; }\n'),
    CannotCheckError,
    /ZERO module-level bindings/,
  )
})

test('an empty declaring-file set is a cannot-check', () => {
  throws(
    () => analyzeTarget({ kind: 'module-bindings', declSources: [], sources: [{ path: 'a.ts', text: 'let n = 0;' }] }),
    CannotCheckError,
    /no declaring file/,
  )
})

test('an EMPTY scan set is a cannot-check for the binding kind too', () => {
  throws(
    () => analyzeTarget({ kind: 'module-bindings', declSources: [{ path: 'a.ts', text: 'let n = 0;' }], sources: [] }),
    CannotCheckError,
    /no source files/,
  )
})

test('two EXPORTED bindings sharing a name is a cannot-check', () => {
  throws(
    () => analyzeTarget({
      kind: 'module-bindings',
      declSources: [
        { path: 'store/a.ts', text: 'export let dup = 0;\nfunction f() { return dup; }\n' },
        { path: 'store/b.ts', text: 'export let dup = 0;\nfunction g() { return dup; }\n' },
      ],
      sources: [
        { path: 'store/a.ts', text: 'export let dup = 0;\nfunction f() { return dup; }\n' },
        { path: 'store/b.ts', text: 'export let dup = 0;\nfunction g() { return dup; }\n' },
      ],
    }),
    CannotCheckError,
    /two files export a module-level binding named 'dup'/,
  )
})

test('two PRIVATE bindings sharing a name are FINE — the live tree has a pair', () => {
  const a = 'const pending = new Map();\nfunction f() { return pending.get(1); }\n'
  const b = 'const pending = new Map();\nfunction g() { return pending.get(2); }\n'
  const r = analyzeTarget({
    kind: 'module-bindings',
    declSources: [{ path: 'store/a.ts', text: a }, { path: 'store/b.ts', text: b }],
    sources: [{ path: 'store/a.ts', text: a }, { path: 'store/b.ts', text: b }],
    inPlaceMutationIsWrite: true,
  })
  assert(r.failures.length === 0 && r.fields.length === 2, JSON.stringify({ f: r.failures, k: r.fields }))
})

// --- 10h. Allowlist, binding kind ------------------------------------------

test('a binding allowlist entry is keyed by file::binding', () => {
  const src = 'let flag = false;\nfunction a() { flag = true; }\n'
  const r = analyzeBindings(src, { allow: { [K('flag')]: 'kept as a debugger marker' } })
  assert(r.failures.length === 0, `not admitted: ${JSON.stringify(r.failures)}`)
  assert(r.stats.allowlisted === 1, `stats.allowlisted=${r.stats.allowlisted}`)
})

test('a BARE binding name (no file prefix) is refused as not in the roster', () => {
  const src = 'let flag = false;\nfunction a() { flag = true; }\n'
  throws(() => analyzeBindings(src, { allow: { flag: 'why' } }), CannotCheckError, /not declared/)
})

test('a binding allowlist entry without a justification is refused', () => {
  const src = 'let flag = false;\nfunction a() { flag = true; }\n'
  throws(() => analyzeBindings(src, { allow: { [K('flag')]: '  ' } }), CannotCheckError, /no justification/)
})

test('a binding allowlist entry whose subject regained a reader is refused as STALE', () => {
  const src = 'let flag = false;\nfunction a() { flag = true; }\nfunction b() { return flag; }\n'
  throws(() => analyzeBindings(src, { allow: { [K('flag')]: 'was write-only' } }), CannotCheckError, /stale/)
})

// --- 10i. CLI end to end ---------------------------------------------------

test('CLI exits 1 on a write-only dashboard binding and names it on stderr', () => {
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]: `${DASH_TEST_EXPORTS}let flag = false;\nexport function a(): void { flag = true; }\n`,
  }))
  assert(r.status === 1, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/store\/message-handler\.ts::flag is WRITE-ONLY/.test(r.stderr), r.stderr)
  assert(/write: packages\/dashboard\/src\/store\/message-handler\.ts:\d+/.test(r.stderr), r.stderr)
})

test('CLI ignores a dashboard reader that lives in a test file', () => {
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]: `${DASH_TEST_EXPORTS}let flag = false;\nexport function a(): void { flag = true; }\n`,
    'packages/dashboard/src/store/mod.test.ts': "import { flag } from './message-handler';\nexport const seen = flag;\n",
  }))
  assert(r.status === 1, `a test-file read masked the write-only binding (exit ${r.status})\n${r.stderr}`)
})

test('CLI exits 2 when the dashboard declaring directory is missing — never 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-woctx-'))
  tmpDirs.push(dir)
  mkdirSync(join(dir, dirname(DECL_REL)), { recursive: true })
  writeFileSync(join(dir, DECL_REL), CLEAN_DECL)
  const r = runCliOn(dir)
  assert(r.status === 2, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/CANNOT CHECK/.test(r.stderr) && /unreadable/.test(r.stderr), r.stderr)
})

test('CLI exits 2 when the dashboard store declares no state at all — never 0', () => {
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]: 'export function noop(): void {}\n',
  }))
  assert(r.status === 2, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/ZERO module-level bindings/.test(r.stderr), r.stderr)
})

test('CLI exits 1 on a dashboard Record mutated only by index assignment (#7537)', () => {
  // End to end through the SHIPPED target config, not just the classifier: the
  // dashboard target's flag has to actually reach isWriteAt for this to fail.
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]:
      `${DASH_TEST_EXPORTS}const counts: Record<string, number> = {};\n` +
      'export function record(k: string, n: number): void { counts[k] = n; }\n',
  }))
  assert(r.status === 1, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/store\/message-handler\.ts::counts is WRITE-ONLY/.test(r.stderr), r.stderr)
})

test('CLI exits 1 on a dashboard counter mutated only by counts[k]++ (#7553)', () => {
  // The shape the header's WHAT IT CANNOT SEE bullet named as STILL unfailable
  // after #7537: `o[k] = v` was a write, `o[k]++` was not, so a Record counter
  // written only the second way could never reach the failure bucket however
  // dead it became. End to end through the SHIPPED target config, because the
  // classifier answering correctly is not the same as the flag reaching it.
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]:
      `${DASH_TEST_EXPORTS}const counts: Record<string, number> = {};\n` +
      'export function record(k: string): void { counts[k]++; }\n',
  }))
  assert(r.status === 1, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/store\/message-handler\.ts::counts is WRITE-ONLY/.test(r.stderr), r.stderr)
})

test('CLI exits 1 on the SECOND declarator of a multi-declarator, written and never read (#7533)', () => {
  // `let a = 1, b = 2` used to yield only `a`, so `b` was never judged. Not a
  // false green on anything in the roster — missing COVERAGE, which is the same
  // defect as a hardcoded roster beside a growing set, one level down: a
  // refactor writing `let pendingA = null, pendingB = null` would quietly halve
  // what this lint sees and nothing would go red.
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]:
      `${DASH_TEST_EXPORTS}let readMe = 1, writeOnly = 2;\n` +
      'export function f(): number { writeOnly = 3; return readMe; }\n',
  }))
  assert(r.status === 1, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/store\/message-handler\.ts::writeOnly is WRITE-ONLY/.test(r.stderr), r.stderr)
})

test('CLI exits 1 on a DESTRUCTURED binding written and never read (#7533)', () => {
  // `const { a, b } = f()` yielded nothing at all — the old regex required an
  // identifier immediately after the keyword, so it did not match the
  // declaration in the first place.
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]:
      `${DASH_TEST_EXPORTS}let { readMe, writeOnly } = make();\n` +
      'export function f(): number { writeOnly = 3; return readMe; }\n',
  }))
  assert(r.status === 1, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/store\/message-handler\.ts::writeOnly is WRITE-ONLY/.test(r.stderr), r.stderr)
})

test('CLI exits 1 on a binding DESTRUCTURED FROM A BARE IDENTIFIER, written and never read (#7688)', () => {
  // The case above is the same fixture sourced from `make()`. A CALL escapes
  // the alias rule; a bare identifier does not, so on main this exits 0 and
  // says OK — with no `::warning::` either, so it is invisible even to the
  // honesty channel #7533 added. Changing ONLY `make()` to `ctx` is what turns
  // the case above green-when-it-should-be-red, which is why both spellings
  // have to be here.
  //
  // `const`, not `let`: `let` never reaches the alias rule at all, so the `let`
  // spelling cannot witness this.
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]:
      `${DASH_TEST_EXPORTS}const { readMe, writeOnly } = ctx;\n` +
      "export function f(): number { writeOnly.set('k', 1); return readMe.size; }\n",
  }))
  assert(r.status === 1, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/store\/message-handler\.ts::writeOnly is WRITE-ONLY/.test(r.stderr), r.stderr)
})

test('CLI exits 1 on a Record whose generic holds an inline object type, written and never read (#7688)', () => {
  // The false-GREEN half of #7688, end to end. `Record<string, T> = {}` is the
  // shape this lint's own header calls out as live in the dashboard store, and
  // `const counts: Record<string, number> = {}` is already a shipped case a few
  // tests up — the ONLY difference here is that the type argument carries an
  // inline object type, so the `;` inside it used to disqualify the generic.
  // The comma then split the declarator list and the roster got `number`
  // INSTEAD of `counts`: not a phantom beside the real binding, a phantom
  // REPLACING it. On main this exits 0 and reports OK.
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]:
      `${DASH_TEST_EXPORTS}const counts: Record<string, { hits: number; last: number }> = {};\n` +
      'export function record(k: string): void { counts[k] = { hits: 1, last: 2 }; }\n',
  }))
  assert(r.status === 1, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/store\/message-handler\.ts::counts is WRITE-ONLY/.test(r.stderr), r.stderr)
})

test('CLI exits 1 on a binding destructured from a DOTTED path (#7688)', () => {
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]:
      `${DASH_TEST_EXPORTS}const { readMe, writeOnly } = store.state;\n` +
      "export function f(): number { writeOnly.set('k', 1); return readMe.size; }\n",
  }))
  assert(r.status === 1, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/store\/message-handler\.ts::writeOnly is WRITE-ONLY/.test(r.stderr), r.stderr)
})

test('a single-name alias is STILL rescued from the roster, so the carve-out did not widen (#7688)', () => {
  // The other direction of the same change, and the one a careless fix breaks:
  // dropping `isConstantInitializer` entirely would also pass every case above.
  // `OTHER` is undeclared here, so if `ALIAS` entered the roster it would have
  // zero references and reach the WARNING bucket — a standing warning on a
  // green run is the failure mode `isConstantInitializer` exists to prevent.
  const r = analyzeBindings("const ALIAS = OTHER;\nconst DOTTED = other.path;\nlet seen = 0;\nexport function f(): number { seen = 1; return seen; }\n")
  assert(!has(r, 'ALIAS'), `the alias entered the roster: ${JSON.stringify(r.fields)}`)
  assert(!has(r, 'DOTTED'), `the dotted alias entered the roster: ${JSON.stringify(r.fields)}`)
  assert(has(r, 'seen'), `real state fell OUT of the roster: ${JSON.stringify(r.fields)}`)
})

test('a phantom from a generic holding an inline object type never reaches the roster (#7688)', () => {
  // The harm the widened lookahead prevents, one level up from the declarator
  // scan: on main `number` is a roster KEY here, and a roster key is
  // CLASSIFIED — it can be reported as unreferenced state, or accused of being
  // write-only, over a binding that does not exist.
  const r = analyzeBindings('let _a = new Map<string, { x: number; y: number }>();\nexport function f(): number { _a.set(\'k\', 1); return _a.size; }\n')
  assert(!has(r, 'number'), `a phantom binding entered the roster: ${JSON.stringify(r.fields)}`)
  assert(has(r, '_a'), `the real binding was lost: ${JSON.stringify(r.fields)}`)
})

test('CLI exits 1 on a counter mutated only by counts.hits++ (#7553, property form)', () => {
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]:
      `${DASH_TEST_EXPORTS}const counts = { hits: 0 };\n` +
      'export function record(): void { counts.hits++; }\n',
  }))
  assert(r.status === 1, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/store\/message-handler\.ts::counts is WRITE-ONLY/.test(r.stderr), r.stderr)
})

test('CLI exits 1 on a Map whose only mutation is a braceless `else` arm (#7554)', () => {
  // Before the keyword boundary, `else m.clear();` was a READ, so this Map had
  // zero writes and could not reach the failure bucket however dead it became —
  // the same unfailable-by-construction shape #7467 and #7537 each closed for a
  // different spelling. The live instance was message-handler.ts:1084.
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]:
      `${DASH_TEST_EXPORTS}const cache = new Map<string, number>();\n` +
      'export function drop(k: string, c: boolean): void {\n' +
      '  if (c) other(k);\n' +
      '  else cache.delete(k);\n' +
      '}\n',
  }))
  assert(r.status === 1, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/store\/message-handler\.ts::cache is WRITE-ONLY/.test(r.stderr), r.stderr)
})

test('CLI exits 1 on a SEMICOLON-FREE module whose only mutation follows a `]` (#7554)', () => {
  // scheduledTaskRequests.ts is written without semicolons, so the character
  // before a statement is whatever ended the previous expression. Before the
  // ASI arm every in-place write in such a file after a line ending in `]` was
  // a read — a property of the file's STYLE, not of the statement.
  const r = runCliOn(fixtureRoot(CLEAN_DECL, {
    [DASH_DECL_REL]:
      `${DASH_TEST_EXPORTS}const cache = new Map<string, number>()\n` +
      'export function sweep(ks: string[]): void {\n' +
      '  const first = [ks[0]]\n' +
      '  cache.clear()\n' +
      '  other(first)\n' +
      '}\n',
  }))
  assert(r.status === 1, `exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/store\/message-handler\.ts::cache is WRITE-ONLY/.test(r.stderr), r.stderr)
})

test('CLI reports the binding target with its own noun', () => {
  const r = runCliOn(fixtureRoot(CLEAN_DECL))
  assert(/dashboard\/store-module-state: \d+ binding\(s\)/.test(r.stdout), r.stdout)
})

test('the SHIPPED TARGETS table still covers both kinds', () => {
  // A target silently dropped from the table is a lint that checks half of what
  // its own header claims, and every run stays green.
  const kinds = TARGETS.map((t) => t.kind)
  assert(kinds.includes('interface'), `no interface target: ${JSON.stringify(kinds)}`)
  assert(kinds.includes('module-bindings'), `no module-bindings target: ${JSON.stringify(kinds)}`)
  const dash = TARGETS.find((t) => t.kind === 'module-bindings')
  assert(
    dash.inPlaceMutationIsWrite === true,
    'the dashboard target must treat in-place mutation — mutator calls AND index/property ' +
    'assignment — as writes; without it every const binding is unfailable by construction',
  )
  const app = TARGETS.find((t) => t.kind === 'interface')
  // INVERTED by #7532. This row pinned the asymmetry so the decision would be
  // visible instead of inherited, and flipping it is what makes it so. Both
  // kinds now treat in-place mutation as a write; the interface path did not
  // merely default the flag OFF before, it never THREADED it, so setting it
  // here was a silent no-op.
  assert(
    app.inPlaceMutationIsWrite === true,
    'the app target must treat in-place mutation as a write too (#7532) — a container field ' +
    'populated and cleared with nothing reading its contents is the #7421 class',
  )
  assert(
    dash.declDirs.includes('packages/dashboard/src/store'),
    `declDirs drifted: ${JSON.stringify(dash.declDirs)}`,
  )
})

// ---------------------------------------------------------------------------

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })

const total = pass + fail
process.stdout.write(`\n${pass}/${total} passed\n`)
if (total < MIN_CASES) {
  process.stdout.write(
    `HARNESS BROKEN: ran ${total} cases, expected at least ${MIN_CASES}. A case stopped being ` +
    'discovered — that is a shrinking suite, not a passing one.\n',
  )
  process.exit(1)
}
if (fail > 0) {
  for (const f of failures) process.stdout.write(`\n--- ${f.name}\n${f.err.stack}\n`)
  process.exit(1)
}
