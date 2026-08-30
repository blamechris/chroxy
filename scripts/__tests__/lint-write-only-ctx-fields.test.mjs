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
const MIN_CASES = 120

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
  atStatementStart,
  blankModuleClauses,
  classifyBindingReferences,
  classifyReferences,
  extractInterfaceFields,
  extractModuleBindings,
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

const analyzeBindings = (text, opts = {}) =>
  analyzeTarget({
    kind: 'module-bindings',
    declSources: [{ path: 'store/mod.ts', text }],
    sources: [{ path: 'store/mod.ts', text }],
    mutatorsAreWrites: true,
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
  // With mutatorsAreWrites off, the SAME source has zero writes and can never
  // reach the failure bucket. Pinned so the flag cannot be dropped silently.
  const src = 'const pending = new Map();\nexport function add(k) { pending.set(k, 1); }\n'
  const off = analyzeBindings(src, { mutatorsAreWrites: false })
  assert(off.failures.length === 0 && off.warnings.length === 0, 'expected a plain read')
  assert(off.perName.get(K('pending')).writes.length === 0, 'a mutator was still a write')
  const on = analyzeBindings(src)
  assert(on.perName.get(K('pending')).writes.length === 1, 'the mutator was not a write')
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
  ['m.set(k, v); is a WRITE', 'm.set(k, v);', 0, 1],
  ['m.clear(); is a WRITE', 'm.clear();', 0, 1],
  ['arr.push(x); is a WRITE', 'arr.push(x);', 0, 1],
  ['if (m.delete(k)) is a READ — the result is consumed', 'if (m.delete(k)) doThing();', 1, 0],
  ['const last = m.pop() is a READ', 'const last = m.pop();', 1, 0],
  ['m.get(k) is a READ', 'm.get(k);', 1, 0],
  ['m.size is a READ', 'const n = m.size;', 1, 0],
]
for (const [label, stmt, wantReads, wantWrites] of mutatorCases) {
  test(`binding: ${label}`, () => {
    const name = /^arr/.test(stmt) || /= arr/.test(stmt) ? 'arr' : 'm'
    const { reads, writes } = classifyBindingReferences(stripComments(stmt), name, { mutatorsAreWrites: true })
    assert(
      reads.length === wantReads && writes.length === wantWrites,
      `got ${reads.length}r ${writes.length}w, wanted ${wantReads}r ${wantWrites}w`,
    )
  })
}

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
    mutatorsAreWrites: true,
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
    mutatorsAreWrites: true,
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
    mutatorsAreWrites: true,
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
  assert(dash.mutatorsAreWrites === true, 'the dashboard target must treat mutators as writes')
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
    `FAIL: only ${total} cases ran, expected at least ${MIN_CASES}. A case stopped being ` +
    'discovered — that is a shrinking suite, not a passing one.\n',
  )
  process.exit(1)
}
if (fail > 0) {
  for (const f of failures) process.stdout.write(`\n--- ${f.name}\n${f.err.stack}\n`)
  process.exit(1)
}
