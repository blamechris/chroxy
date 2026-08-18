#!/usr/bin/env node
/**
 * compile-skill-targets.test.mjs — node test harness for
 * scripts/compile-skill-targets.mjs.
 *
 * Two layers, and both are needed. The unit tests import the module and call
 * its exported pieces (deriveDescription, detectUncompiledAgents, emitPi). The
 * subprocess tests at the bottom run the script for real and assert on what it
 * WROTE, because importing a module proves nothing about whether its CLI still
 * runs — #7236, where hardwiring the entry-point guard to false left this file
 * fully green while the script compiled nothing.
 *
 * No external test framework. Each `test()` block runs in series and pushes
 * pass/fail into a counter. Exit status is 0 if all pass, 1 otherwise.
 *
 * Run from repo root:
 *   node scripts/__tests__/compile-skill-targets.test.mjs
 *
 * Importing the module must NOT run its CLI main() — the module guards the
 * invocation behind an "invoked directly" check so it is safe to import here.
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const helperPath = resolve(__dirname, '..', 'compile-skill-targets.mjs')

const { deriveDescription, detectUncompiledAgents, emitPi, ALL_TARGETS, REPO_LOCAL_TARGETS, checkDrift } =
  await import(helperPath)

let pass = 0
let fail = 0
const failures = []

const test = async (name, fn) => {
  try {
    await fn()
    pass++
    process.stdout.write(`  ok ${name}\n`)
  } catch (err) {
    fail++
    failures.push({ name, err })
    process.stdout.write(`  FAIL ${name}: ${err.message}\n`)
  }
}

// Counted, so withFixture below can prove its callback actually checked
// something rather than trusting that it was called.
let assertions = 0
const assert = (cond, msg) => {
  assertions++
  if (!cond) throw new Error(msg || 'assertion failed')
}

// Count visible glyphs (grapheme clusters), not UTF-16 code units — the unit the
// cap is measured in since #6261.
const countGraphemes = (s) =>
  [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length

// A long single sentence with no early period and clearly numbered words, so a
// mid-word cut is detectable: "word001 word002 … word040" (8-char stride).
const numberedWords = (n) =>
  Array.from({ length: n }, (_, i) => `word${String(i + 1).padStart(3, '0')}`).join(' ')

// --- Test 1: long description truncates on a WORD boundary (the #6259 bug) ---
await test('truncates a long single sentence on a word boundary, not mid-word', async () => {
  const body = numberedWords(40) // 319 chars, no period
  const desc = deriveDescription(body, 'demo')

  assert(desc.endsWith('...'), `should end with ellipsis, got: ${JSON.stringify(desc)}`)
  assert(desc.length <= 160, `should respect the 160-char cap, got length ${desc.length}`)

  // The text before the ellipsis must end on a COMPLETE numbered word — a
  // mid-word cut (e.g. "word0...") is the bug we are fixing.
  const visible = desc.slice(0, -3).trimEnd()
  const lastToken = visible.split(' ').pop()
  assert(
    /^word\d{3}$/.test(lastToken),
    `last token before ellipsis must be a whole word, got: ${JSON.stringify(lastToken)}`,
  )
})

// --- Test 2: pathological single over-long word still hard-cuts (no space) ---
await test('hard-cuts a single over-long word with no space to break on', async () => {
  const body = 'x'.repeat(200) // one 200-char "word", no boundary to back off to
  const desc = deriveDescription(body, 'demo')

  assert(desc.endsWith('...'), `should end with ellipsis, got length ${desc.length}`)
  assert(desc.length === 160, `should hard-cut to the cap (157 + '...'), got length ${desc.length}`)
})

// --- Test 3: first sentence is extracted when a period is within the cap ----
await test('extracts the first sentence when it ends within the cap', async () => {
  const body = 'First sentence here. Second sentence that should be dropped.'
  const desc = deriveDescription(body, 'demo')
  assert(desc === 'First sentence here.', `got: ${JSON.stringify(desc)}`)
})

// --- Test 4: a short paragraph passes through unchanged (no ellipsis) -------
await test('passes a short paragraph through without an ellipsis', async () => {
  const body = 'A short skill description'
  const desc = deriveDescription(body, 'demo')
  assert(desc === 'A short skill description', `got: ${JSON.stringify(desc)}`)
  assert(!desc.endsWith('...'), 'short descriptions must not be truncated')
})

// --- Test 5: heading-only / empty body falls back to the project label ------
await test('falls back to a project label when there is no prose', async () => {
  const body = '# Heading only\n\n---\n'
  const desc = deriveDescription(body, 'my-skill')
  assert(desc === 'Project skill: /my-skill', `got: ${JSON.stringify(desc)}`)
})

// --- Test 6: the 160-char cap boundary (passthrough at 160, cut at 161) ----
// Pins the off-by-one most likely to regress on a future refactor of the cap:
// a no-period string of exactly 160 chars is returned untouched (no ellipsis),
// while 161 truncates on the word boundary and stays within the cap.
await test('passes a 160-char string through but truncates at 161 on a word boundary', async () => {
  const at160 = 'a'.repeat(80) + ' ' + 'b'.repeat(79) // length 160, no period
  const passthrough = deriveDescription(at160, 'demo')
  assert(passthrough === at160, `160-char string should pass through untouched, got length ${passthrough.length}`)
  assert(!passthrough.endsWith('...'), '160-char string must not get an ellipsis')

  const at161 = 'a'.repeat(80) + ' ' + 'b'.repeat(80) // length 161, no period
  const truncated = deriveDescription(at161, 'demo')
  assert(truncated.endsWith('...'), 'a 161-char string should be truncated')
  assert(truncated.length <= 160, `truncated string should respect the cap, got length ${truncated.length}`)
  assert(truncated === 'a'.repeat(80) + '...', `should cut at the word boundary, got: ${JSON.stringify(truncated)}`)
})

// --- Test 7: grapheme-aware cap — a ZWJ sequence counts as ONE glyph (#6261) -
// A "family" emoji is a single grapheme cluster but 7 code points / 11 UTF-16
// code units. 30 of them is 30 graphemes (well under the 160 cap) yet 330 code
// units (well over it). A code-unit cap would wrongly truncate — and slice a
// family mid-ZWJ-sequence; a grapheme cap leaves the string untouched.
await test('counts a ZWJ emoji sequence as one glyph and does not truncate under the cap', async () => {
  const family = '👨‍👩‍👧‍👦' // 1 grapheme, 7 code points, 11 UTF-16 code units
  const body = family.repeat(30) // 30 graphemes / 330 code units
  assert(countGraphemes(body) === 30 && body.length === 330, 'fixture sanity: 30 graphemes, 330 code units')
  const desc = deriveDescription(body, 'demo')
  assert(desc === body, `a 30-grapheme string must pass through untouched (a UTF-16 cap would truncate it), got length ${desc.length}`)
  assert(!desc.endsWith('...'), 'must not truncate a 30-grapheme description')
})

// --- Test 8: grapheme-aware cut — a space-less emoji run never splits a pair --
// 200 emoji with no spaces to break on must hard-cut on a cluster boundary. A
// UTF-16 slice at 157 units would bisect emoji #79's surrogate pair and leak a
// lone high surrogate; a grapheme cut keeps every emoji whole.
await test('hard-cuts a space-less emoji run on a cluster boundary, never a lone surrogate', async () => {
  const emoji = '😀' // 1 grapheme, 2 UTF-16 code units
  const body = emoji.repeat(200)
  const desc = deriveDescription(body, 'demo')
  assert(desc.endsWith('...'), `should truncate a 200-emoji run, got: ${JSON.stringify(desc.slice(0, 12))}…`)
  const visible = desc.slice(0, -3) // strip the ASCII ellipsis
  // Strip valid surrogate PAIRS; any surviving surrogate code unit is a lone
  // (split) surrogate — the signature of a mid-cluster cut.
  const stripped = visible.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
  assert(!/[\uD800-\uDFFF]/.test(stripped), 'a lone surrogate leaked — the cut sliced mid-cluster')
  assert([...visible].every((ch) => ch === emoji), 'every visible glyph must be a whole emoji')
  assert(countGraphemes(visible) <= 160, `visible text must respect the 160-grapheme cap, got ${countGraphemes(visible)}`)
})

// --- detectUncompiledAgents (#6571) ---------------------------------------
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pjoin } from 'node:path'

await test('detectUncompiledAgents flags ONLY codex (gemini is repo-local, never flagged even with ~/.gemini present)', () => {
  const home = mkdtempSync(pjoin(tmpdir(), 'skill-home-'))
  try {
    mkdirSync(pjoin(home, '.codex'))
    mkdirSync(pjoin(home, '.gemini')) // present but IRRELEVANT — gemini compiles into the repo, not ~/.gemini
    const out = detectUncompiledAgents(['claude'], home)
    assert(out.includes('codex'), `expected codex flagged, got ${JSON.stringify(out)}`)
    assert(!out.includes('gemini'), 'gemini is repo-local + in the default target list — a ~/.gemini dir must NOT be a hint')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('detectUncompiledAgents does NOT flag a target that IS selected', () => {
  const home = mkdtempSync(pjoin(tmpdir(), 'skill-home-'))
  try {
    mkdirSync(pjoin(home, '.codex'))
    const out = detectUncompiledAgents(['claude', 'gemini', 'codex'], home)
    assert(out.length === 0, `codex is selected, expected [], got ${JSON.stringify(out)}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('detectUncompiledAgents returns nothing when no agent home dirs exist', () => {
  const home = mkdtempSync(pjoin(tmpdir(), 'skill-home-'))
  try {
    const out = detectUncompiledAgents(['claude'], home)
    assert(out.length === 0, `no agent dirs present, expected [], got ${JSON.stringify(out)}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// --- Pi target (#6573) ----------------------------------------------------

await test('pi is a known compile target', () => {
  assert(ALL_TARGETS.includes('pi'), `expected 'pi' in ALL_TARGETS, got ${JSON.stringify(ALL_TARGETS)}`)
})

await test('emitPi writes ~/.pi/agent/skills/<name>/SKILL.md with name + description frontmatter', () => {
  const out = emitPi('demo-skill', '# Body\nDo the thing.\n', 'Does the thing.')
  assert(/[/\\]\.pi[/\\]agent[/\\]skills[/\\]demo-skill[/\\]SKILL\.md$/.test(out.path), `unexpected path: ${out.path}`)
  // Pi REQUIRES a `name` field matching the parent dir (unlike the claude emitter);
  // it's quoted so a YAML-significant char in a filename can't break the frontmatter.
  assert(out.content.startsWith('---\nname: "demo-skill"\ndescription: '), `missing name/description frontmatter:\n${out.content}`)
  assert(out.content.includes('# Body\nDo the thing.'), 'body must pass through verbatim')
  assert(/\/skill:demo-skill/.test(out.note), `note should document /skill: invocation, got: ${out.note}`)
})

await test('emitPi warns when the body uses arg tokens Pi will not substitute', () => {
  const withArgs = emitPi('a', 'Summarize $ARGUMENTS please\n', 'x')
  assert(withArgs.warn && /not substituted/i.test(withArgs.warn), `expected an arg-token warning, got: ${withArgs.warn}`)
  const noArgs = emitPi('b', 'No args here\n', 'x')
  assert(!noArgs.warn, `expected no warning for an arg-free body, got: ${noArgs.warn}`)
})

await test('emitPi does not warn for an arg token inside a fenced code block (but does in prose)', () => {
  // Use `$1` — a token that DOES match the warn regex — so the test actually
  // exercises the code-fence stripping rather than passing trivially.
  const fenced = emitPi('c', 'Run it:\n```bash\necho $1\n```\n', 'x')
  assert(!fenced.warn, `a bare $1 inside a code fence must not warn, got: ${fenced.warn}`)
  const prose = emitPi('c', 'Pass echo $1 to the tool\n', 'x')
  assert(prose.warn && /not substituted/i.test(prose.warn), `a bare $1 in prose must warn, got: ${prose.warn}`)
})

await test('emitPi quotes the name so a YAML-significant char in a filename stays valid YAML', () => {
  // A Linux filename could carry `:` — unquoted `name: weird:name` would misparse.
  const out = emitPi('weird:name', 'body\n', 'x')
  assert(out.content.startsWith('---\nname: "weird:name"\n'), `name must be quoted, got:\n${out.content}`)
})

await test('emitPi warns on a non-Pi-valid skill name (Pi rejects it at load)', () => {
  for (const bad of ['My_Skill', 'has space', '-leading', 'trailing-', 'double--hyphen', 'UPPER']) {
    const out = emitPi(bad, 'body\n', 'x')
    assert(out.warn && /not Pi-valid/.test(out.warn), `expected a name-format warning for "${bad}", got: ${out.warn}`)
  }
  const ok = emitPi('good-name-123', 'body\n', 'x')
  assert(!ok.warn || !/not Pi-valid/.test(ok.warn), `a valid kebab name must not warn, got: ${ok.warn}`)
})

await test('detectUncompiledAgents flags an installed-but-unselected pi (~/.pi)', () => {
  const home = mkdtempSync(pjoin(tmpdir(), 'skill-home-'))
  try {
    mkdirSync(pjoin(home, '.pi'))
    const out = detectUncompiledAgents(['claude', 'gemini'], home)
    assert(out.includes('pi'), `expected pi flagged, got ${JSON.stringify(out)}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// --- entry-point call site (#7236) -----------------------------------------
//
// Every test above IMPORTS this module and calls an exported function, which
// says nothing about whether `node scripts/compile-skill-targets.mjs` still
// compiles anything. Hardwiring the module's `if (isEntryPoint(import.meta.url))`
// to `false` left this file at 18/18 green: the script would exit 0 having
// emitted nothing — the same silent no-op class as #7198/#7214, and the reason
// that bug survived in four files at once. The failure is SILENCE, not a crash.
//
// So the tests below run the script for real, out of a temp fixture, and assert
// on the ARTIFACT it wrote. Exit status alone cannot tell "compiled everything"
// from "never ran": both are 0. The sibling coverage for the other consumer of
// the shared guard is in gen-agents-md.test.mjs.

import { existsSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { stageScript } from './helpers/stage-script.mjs'

// Carries a registry stamp and an arg token on purpose. A bare heading plus one
// sentence exercises none of the emitter transformations, and `stripStamp`,
// `emitClaude` and `emitGemini` are NOT exported — these subprocess tests are
// their only coverage anywhere in the repo, so the fixture has to be rich enough
// to catch a mutation in them. 28 of the 31 real sources in .claude/commands/
// carry a stamp, so a stripStamp regression would ship install metadata as skill
// content in almost every artifact.
const SKILL_STAMP = '<!-- skill-templates: demo@1.2.3 -->'
const SKILL_BODY = `${SKILL_STAMP}\n# Demo skill\n\nCompiles a demo skill for the entry-point fixture. Takes $ARGUMENTS.\n`

/**
 * A fixture repo holding the staged compiler plus one source skill.
 *
 * The tmpdir is realpath'd first. On macOS `os.tmpdir()` is /var/folders/…, a
 * symlink to /private/var/…, so a fixture built on the raw path would put every
 * run through a symlinked prefix — the direct-invocation test would silently
 * become a second copy of the symlink test, and only on macOS. Canonicalising
 * here means the only symlink in play is the one a test creates on purpose.
 */
const withFixture = (fn) => {
  const dir = mkdtempSync(pjoin(realpathSync(tmpdir()), 'compile-skill-'))
  const before = assertions
  try {
    const root = pjoin(dir, 'root')
    const home = pjoin(dir, 'home')
    mkdirSync(home, { recursive: true })
    const script = stageScript(helperPath, pjoin(root, 'scripts'))
    mkdirSync(pjoin(root, '.claude', 'commands'), { recursive: true })
    writeFileSync(pjoin(root, '.claude', 'commands', 'demo.md'), SKILL_BODY)
    const returned = fn({ dir, root, home, script })
    // Sync-only, and said out loud. An async callback returns a pending promise
    // that nothing awaits: the `finally` below removes the fixture out from
    // under it, everything after the first `await` runs against a deleted tree,
    // and the assertion counter is already satisfied by the synchronous prefix —
    // so the test reports `ok` having skipped the rest of its body. Verified:
    // making the --dry-run callback async and awaiting once before its positive
    // control left the suite 23/23 green with the control never executed. The
    // 18 unit tests above all use async callbacks that the harness awaits, so
    // async is this file's ambient habit and only these callbacks are not.
    if (returned && typeof returned.then === 'function') {
      throw new Error('withFixture: the callback must be synchronous — the fixture is removed before an async body finishes')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // Proof of WORK, not proof of call. Every assertion in this section lives
  // inside `fn`, and the harness counts a test as `ok` whenever it does not
  // throw — so a `withFixture` that quietly failed to call `fn` would report
  // every test here as passing having checked nothing. That is the same
  // false-safety shape this whole section exists to catch, one level up in the
  // scaffolding.
  //
  // A `ran = true` after the call does NOT close it: the obvious mutation makes
  // the CALL conditional and still falls through to the flag, which is exactly
  // how the first version of this line passed a mutant that skipped `fn`
  // entirely. Counting assertions cannot be dodged that way, and it also
  // catches the weaker case of a callback that runs but checks nothing.
  // Unreachable when `fn` throws, since the exception propagates past it.
  if (assertions === before) {
    throw new Error('withFixture: the callback made no assertions — this test checked NOTHING')
  }
}

/**
 * Run the staged compiler with a throwaway HOME.
 *
 * Safety first: the `codex` and `pi` emitters write into ~/.codex and ~/.pi, so
 * a fixture that ever reached them would write to the developer's real home.
 * That is also why every run below passes --targets explicitly instead of
 * trusting the profile fallback — the fallback is `['claude']` today, and a
 * test should not be the thing that notices if that changes.
 *
 * Determinism second: main()'s "installed but not selected" hint fires off
 * `homedir()`, so on a machine with ~/.codex present the child's stdout would
 * differ from CI's.
 *
 * `cwd` is pinned to the fixture for the same reason. Every call passes --repo
 * explicitly, so it should never matter — but `repo` DEFAULTS to
 * `process.cwd()`, and the suite is normally invoked from the repo root. If
 * --repo handling ever regressed, an unpinned child would compile the real
 * checkout and rewrite its committed artifacts instead of failing. Pointing it
 * at a directory with no .claude/commands turns that regression red.
 */
const runCompiler = (scriptPath, args, home, cwd) =>
  spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  })

await test('invoked directly, it compiles a real skill and writes every target artifact (#7236)', () => {
  withFixture(({ dir, root, home, script }) => {
    const run = runCompiler(script, ['--repo', root, '--targets', 'claude,gemini'], home, dir)
    assert(run.status === 0, `expected exit 0, got ${run.status}: ${run.stderr}`)

    const skillMd = pjoin(root, '.claude', 'skills', 'demo', 'SKILL.md')
    assert(
      existsSync(skillMd),
      'the compiler exited 0 having emitted NOTHING — the entry-point guard read false ' +
      `and main() never ran (#7198/#7236). stdout: ${JSON.stringify(run.stdout)}`,
    )
    const emitted = readFileSync(skillMd, 'utf8')
    // Pin the WHOLE frontmatter block, not just its opening. A `startsWith`
    // check still passes on output whose closing `---` was dropped, which
    // Claude cannot parse; this also pins that the description is non-empty and
    // really derived rather than defaulted.
    assert(
      /^---\ndescription: "[^\n]+"\n---\n\n/.test(emitted),
      `frontmatter is not a complete, non-empty block:\n${emitted}`,
    )
    assert(emitted.includes('# Demo skill'), `the source body must pass through:\n${emitted}`)
    assert(
      !emitted.includes('skill-templates:'),
      `the registry stamp is install metadata, not skill content — stripStamp did not run:\n${emitted}`,
    )

    // A second target, so the assertion covers the emitter LOOP rather than one
    // lucky write: a main() that emitted only its first target would pass above.
    const geminiToml = pjoin(root, '.gemini', 'commands', 'demo.toml')
    assert(existsSync(geminiToml), 'the second target was not emitted — the emitter loop stopped after one')
    const gemini = readFileSync(geminiToml, 'utf8')
    assert(gemini.includes('# Demo skill'), `the gemini artifact must carry the skill body:\n${gemini}`)
    // $ARGUMENTS is the neutral arg token; Gemini's is {{args}}. Without this,
    // deleting the substitution silently strips argument passing from every
    // compiled Gemini command and nothing notices.
    assert(
      gemini.includes('{{args}}') && !gemini.includes('$ARGUMENTS'),
      `gemini must rewrite $ARGUMENTS to {{args}}:\n${gemini}`,
    )
  })
})

await test('invoked through a symlinked path, it still compiles (#7198 at this call site)', () => {
  withFixture(({ dir, root, home }) => {
    const link = pjoin(dir, 'link')
    symlinkSync(root, link)
    // Through the symlink, node realpaths `import.meta.url` to …/root/… while
    // `process.argv[1]` stays …/link/… as typed. Comparing those two directly —
    // which is what this script did before #7213 — reads false, so main() never
    // runs and the process exits 0 having compiled nothing.
    const run = runCompiler(
      pjoin(link, 'scripts', 'compile-skill-targets.mjs'),
      ['--repo', root, '--targets', 'claude'],
      home,
      dir,
    )
    assert(run.status === 0, `expected exit 0, got ${run.status}: ${run.stderr}`)
    assert(
      existsSync(pjoin(root, '.claude', 'skills', 'demo', 'SKILL.md')),
      'compiled nothing through a symlinked invocation path — the #7198 silent no-op',
    )
  })
})

await test('--dry-run emits nothing, and the identical run without it does (#7236)', () => {
  withFixture(({ dir, root, home, script }) => {
    const skillMd = pjoin(root, '.claude', 'skills', 'demo', 'SKILL.md')

    const dry = runCompiler(script, ['--repo', root, '--targets', 'claude', '--dry-run'], home, dir)
    assert(dry.status === 0, `--dry-run should exit 0, got ${dry.status}: ${dry.stderr}`)
    assert(!existsSync(skillMd), '--dry-run wrote an artifact')

    // The positive control, and the reason this is one test and not two: "no
    // file" is equally what a guard that never fired produces, so the assertion
    // above proves nothing on its own. Same fixture, same flags minus
    // --dry-run, must now write.
    const wet = runCompiler(script, ['--repo', root, '--targets', 'claude'], home, dir)
    assert(wet.status === 0, `expected exit 0, got ${wet.status}: ${wet.stderr}`)
    assert(existsSync(skillMd), 'the control run emitted nothing either — the no-op above was vacuous')
  })
})

await test('exits 1 with a diagnostic when the repo has no .claude/commands (#7236)', () => {
  withFixture(({ dir, home, script }) => {
    const empty = pjoin(dir, 'empty')
    mkdirSync(empty, { recursive: true })
    const run = runCompiler(script, ['--repo', empty, '--targets', 'claude'], home, dir)
    // A detector for the same mutation that does not depend on a file: with the
    // entry-point guard hardwired false, main() never runs, so the process exits
    // 0 with an empty stderr where it owes a 1 and a reason.
    assert(run.status === 1, `expected exit 1, got ${run.status} (0 = main() never ran)`)
    assert(
      /No \.claude\/commands/.test(run.stderr),
      `exit 1 came from something other than the missing-commands check:\n${JSON.stringify(run.stderr)}`,
    )
  })
})

await test('importing the module does NOT run its CLI (the other direction, #7236)', () => {
  withFixture(({ root, home, script }) => {
    // Everything above faces one way: a guard stuck FALSE compiles nothing.
    // Stuck TRUE is the other failure, and it is invisible from that side —
    // hardwiring the guard to `true` leaves all of the above green, because
    // main() then runs during THIS FILE's own `await import(...)` at the top,
    // compiling whatever repo the suite was invoked from and rewriting its
    // committed artifacts. Testing only the direction the bug arrived from is
    // how #7250 shipped a worse hole than the one it fixed, so this faces the
    // other way.
    //
    // The importer is a STAGED FILE, not `node -e`. Under `-e` there is no
    // argv[1], so isEntryPoint returns at its first line and never reaches the
    // path comparison — the test would pass without exercising the branch that
    // actually decides this. Verified: inverting `self === invoked` to `!==` in
    // the guard left an `-e` version of this test at 23/23 green while the
    // suite's own import wrote 12 files into the invoking checkout. A real
    // argv[1] that is a DIFFERENT existing file is the configuration this suite
    // genuinely imports under when CI runs it.
    const importer = pjoin(root, 'importer.mjs')
    writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(script).href)})\n`)
    const run = spawnSync(process.execPath, [importer], {
      encoding: 'utf8',
      cwd: root,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    })
    assert(run.status === 0, `importing the module should exit 0, got ${run.status}: ${run.stderr}`)
    assert(
      !/Compiling/.test(run.stdout),
      `main() ran on import — the guard reads true when it is not the entry point:\n${run.stdout}`,
    )
    assert(
      !existsSync(pjoin(root, '.claude', 'skills', 'demo', 'SKILL.md')),
      'importing the module compiled a skill — any test that imports it would rewrite the real repo',
    )
  })
})

// --- #7253: the drift gate -------------------------------------------------
//
// `.claude/commands/<name>.md` is the neutral SOURCE; `.claude/skills/<name>/SKILL.md`
// is what Claude actually LOADS (the legacy `.claude/commands/` discovery is
// broken — anthropics/claude-code#31846) and `.gemini/commands/<name>.toml` is
// Gemini's. A stale artifact therefore means the skill you edited is not the
// skill that runs. Nothing gated that: on pristine main 11 artifacts differed
// from what the compiler produces, and `catchup` had a source with no compiled
// artifact at all, so that skill was not loadable.
//
// AGENTS.md — a generated mirror of the same class, and strictly less
// load-bearing since it changes no agent's behaviour — has had this gate since
// #7198. These are its counterpart.
//
// Four of the tests below cover a way an artifact can be wrong that a naive
// "do the bytes match?" check passes silently: an artifact that does not exist
// (`catchup`), one that should not exist, one whose source is gone, and a whole
// target that is not being checked at all.

// A source Gemini CANNOT take: `{{` is an active sequence in its prompt engine,
// so emitGemini refuses and the compiler emits no .toml. It is the only way to
// reach the "an artifact exists that SHOULD NOT" branch, and it is not a
// hypothetical shape — 5 of the repo's 31 real sources sit in exactly this
// position.
const GEMINI_UNSAFE_BODY = '# Unsafe skill\n\nCarries a literal {{TEMPLATE}} token that Gemini would interpret.\n'
const KEEPER_BODY = '# Keeper skill\n\nA second source so a test can delete the first one.\n'

// The fixture ships ONE source, which is not enough here: deleting it to make an
// orphan also empties .claude/commands, and the "checked nothing" refusal then
// fires before the orphan report. A second source keeps each test to ONE
// condition.
const addSource = (root, name, body) =>
  writeFileSync(pjoin(root, '.claude', 'commands', `${name}.md`), body)

const runCheck = (script, args, home, cwd) => runCompiler(script, ['--check', ...args], home, cwd)

// A content-addressed snapshot of a tree: every path, plus every file's bytes.
// Deliberately NOT mtime-based — its granularity is coarse enough that a
// same-second rewrite reads as unchanged, which is the one thing a "wrote
// nothing" assertion must never miss.
const snapshot = (dir) => {
  const out = []
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        out.push(`d ${r}`)
        walk(pjoin(d, e.name), r)
      } else if (e.isFile()) {
        out.push(`f ${r}\n${readFileSync(pjoin(d, e.name), 'utf8')}`)
      } else {
        out.push(`? ${r}`)
      }
    }
  }
  walk(dir, '')
  return out.join('\n ')
}

// Compile the fixture and assert the gate is GREEN on the result. Every drift
// test below mutates from this state, so a fixture that was already red would
// make all of them pass for the wrong reason.
const compileThenCheck = (ctx, targets = 'claude,gemini') => {
  const built = runCompiler(ctx.script, ['--repo', ctx.root, '--targets', targets], ctx.home, ctx.dir)
  assert(built.status === 0, `fixture compile failed (${built.status}): ${built.stderr}`)
  const clean = runCheck(ctx.script, ['--repo', ctx.root, '--targets', targets], ctx.home, ctx.dir)
  assert(
    clean.status === 0,
    `--check must be green on a freshly compiled tree, got ${clean.status}:\n${clean.stdout}${clean.stderr}`,
  )
  return clean
}

// Every drift test asserts the MESSAGE, never the exit code alone. `node` exits
// 1 for an uncaught module-load error too, and a guard reading false exits 0
// having done nothing — so a bare status check cannot tell "the gate detected
// drift" from "the gate never ran". Same reasoning as gen-agents-md.test.mjs's
// assertDetectedDrift, arrived at the same way (#7214).
const assertDetected = (run, kind, file) => {
  assert(
    run.status === 1,
    `--check must exit 1 on drift, got ${run.status} (0 = the gate never ran)\n${run.stdout}${run.stderr}`,
  )
  assert(
    run.stderr.includes('::error::Compiled skill artifacts are out of sync'),
    `exit 1 came from something other than drift detection:\n${run.stderr}`,
  )
  const line = run.stderr.split('\n').find((l) => l.includes(file))
  assert(line, `nothing in the report mentions ${file}:\n${run.stderr}`)
  assert(line.includes(kind), `${file} was reported, but not as ${kind}:\n${line}`)
}

// --- the real repo ---------------------------------------------------------
await test('committed skill artifacts are in sync with .claude/commands (drift gate, #7253)', () => {
  const repoRoot = resolve(__dirname, '..', '..')
  const { names, compared, problems } = checkDrift(repoRoot, REPO_LOCAL_TARGETS)
  // Both counters are the same refusal the CLI applies, asserted here so this
  // test cannot go vacuous if the source directory is ever moved out from under
  // it: with no sources there is nothing to compare and `problems` is empty,
  // which would otherwise read as a pass.
  assert(names.length > 0, `no skill sources under ${repoRoot}/.claude/commands — this test checked NOTHING`)
  assert(
    compared === names.length * REPO_LOCAL_TARGETS.length,
    `compared ${compared} artifact(s) for ${names.length} source(s) x ${REPO_LOCAL_TARGETS.length} target(s) — the target loop did not run to completion`,
  )
  assert(
    problems.length === 0,
    'compiled skill artifacts are stale — run `node scripts/compile-skill-targets.mjs --targets ' +
      `${REPO_LOCAL_TARGETS.join(',')}\` and commit the result:\n` +
      problems.map((p) => `  ${p.kind.toUpperCase()} [${p.target}] ${p.file}`).join('\n'),
  )
})

// --- the gate, end to end --------------------------------------------------
await test('--check is green on a freshly compiled tree, and says what it checked (#7253)', () => {
  withFixture((ctx) => {
    addSource(ctx.root, 'keeper', KEEPER_BODY)
    const clean = compileThenCheck(ctx)
    // "in sync" with a zero count is the vacuous pass this gate must never
    // report, so pin the count rather than the word.
    assert(
      /in sync: 2 skill\(s\) x 2 target\(s\)/.test(clean.stdout),
      `the gate must report how much it actually compared:\n${clean.stdout}`,
    )
  })
})

await test('--check goes red when a source is edited without recompiling (#7253)', () => {
  withFixture((ctx) => {
    compileThenCheck(ctx)
    // The exact mistake the gate exists to catch, and the one that drifted 11
    // artifacts on main: edit the neutral source, ship without recompiling.
    writeFileSync(
      pjoin(ctx.root, '.claude', 'commands', 'demo.md'),
      `${SKILL_BODY}\nA line the committed artifacts do not carry.\n`,
    )
    const run = runCheck(ctx.script, ['--repo', ctx.root, '--targets', 'claude,gemini'], ctx.home, ctx.dir)
    assertDetected(run, 'STALE', '.claude/skills/demo/SKILL.md')
    // Both targets, so a gate that stopped after the first one is red too.
    assertDetected(run, 'STALE', '.gemini/commands/demo.toml')
  })
})

await test('--check goes red when a source was never compiled at all (#7253)', () => {
  withFixture((ctx) => {
    addSource(ctx.root, 'keeper', KEEPER_BODY)
    compileThenCheck(ctx)
    // `catchup` on main: a source with no artifact whatsoever. A gate that only
    // diffed the files it FOUND would pass this, which is why it is its own case.
    rmSync(pjoin(ctx.root, '.claude', 'skills', 'demo', 'SKILL.md'))
    const run = runCheck(ctx.script, ['--repo', ctx.root, '--targets', 'claude,gemini'], ctx.home, ctx.dir)
    assertDetected(run, 'MISSING', '.claude/skills/demo/SKILL.md')
  })
})

await test('--check goes red when a source is deleted but its artifacts remain (#7253)', () => {
  withFixture((ctx) => {
    addSource(ctx.root, 'keeper', KEEPER_BODY)
    compileThenCheck(ctx)
    // A half-run `/skill remove`. The artifact keeps LOADING as a skill, with no
    // source left to review it against — the most invisible of the four.
    rmSync(pjoin(ctx.root, '.claude', 'commands', 'demo.md'))
    const run = runCheck(ctx.script, ['--repo', ctx.root, '--targets', 'claude,gemini'], ctx.home, ctx.dir)
    assertDetected(run, 'ORPHAN', '.claude/skills/demo/SKILL.md')
    assertDetected(run, 'ORPHAN', '.gemini/commands/demo.toml')
  })
})

await test('--check goes red on a leftover artifact for a target that skips the skill (#7253)', () => {
  withFixture((ctx) => {
    addSource(ctx.root, 'unsafe', GEMINI_UNSAFE_BODY)
    compileThenCheck(ctx)
    const leftover = pjoin(ctx.root, '.gemini', 'commands', 'unsafe.toml')
    // Positive control for the fixture itself: if the compiler DID emit a Gemini
    // artifact here, the file written below would be legitimate output and the
    // test would be asserting on a condition it manufactured.
    assert(!existsSync(leftover), 'the compiler emitted a Gemini artifact for a body Gemini cannot take')
    // The compile path DELETES this on its next run (compileOne's removeStale);
    // --check writes nothing, so it has to REPORT it or the leftover keeps
    // loading forever.
    writeFileSync(leftover, "description = 'stale'\nprompt = '''\nleft over from before the skill became unsafe\n'''\n")
    const run = runCheck(ctx.script, ['--repo', ctx.root, '--targets', 'claude,gemini'], ctx.home, ctx.dir)
    assertDetected(run, 'UNEXPECTED', '.gemini/commands/unsafe.toml')
  })
})

await test('--check goes red when a repo-local target has committed artifacts but is not checked (#7253)', () => {
  withFixture((ctx) => {
    compileThenCheck(ctx)
    // targetsFromProfile() returns null for ANY `targets:` line it fails to
    // match, and main() then falls back to ['claude'] — so one mangled character
    // in .claude/skill-profile.md would leave every committed
    // .gemini/commands/*.toml unchecked while the gate still exited 0. "Cannot
    // check this" must not read as "there was nothing to check".
    const run = runCheck(ctx.script, ['--repo', ctx.root, '--targets', 'claude'], ctx.home, ctx.dir)
    assertDetected(run, 'UNGATED', '.gemini/commands')
  })
})

await test('--check detects drift through a symlinked invocation path (#7198 at this call site)', () => {
  withFixture((ctx) => {
    addSource(ctx.root, 'keeper', KEEPER_BODY)
    compileThenCheck(ctx)
    writeFileSync(pjoin(ctx.root, '.claude', 'commands', 'demo.md'), `${SKILL_BODY}\ndrifted\n`)
    // node realpaths import.meta.url but leaves argv[1] as typed, so through a
    // symlink the two differ. Before #7213 that read false and the process
    // exited 0 — here that means a CI gate reporting "in sync" having compared
    // nothing, which is strictly worse than the compile path's no-op.
    const link = pjoin(ctx.dir, 'link')
    symlinkSync(ctx.root, link)
    const run = runCheck(
      pjoin(link, 'scripts', 'compile-skill-targets.mjs'),
      ['--repo', ctx.root, '--targets', 'claude,gemini'],
      ctx.home,
      ctx.dir,
    )
    assertDetected(run, 'STALE', '.claude/skills/demo/SKILL.md')
  })
})

// --- the gate's own refusals -----------------------------------------------
await test('--check refuses an empty .claude/commands rather than reporting success (#7253)', () => {
  withFixture((ctx) => {
    rmSync(pjoin(ctx.root, '.claude', 'commands', 'demo.md'))
    const run = runCheck(ctx.script, ['--repo', ctx.root, '--targets', 'claude,gemini'], ctx.home, ctx.dir)
    assert(run.status === 1, `a gate with nothing to check must not exit 0, got ${run.status}:\n${run.stdout}`)
    assert(
      /found no skill sources/.test(run.stderr),
      `exit 1 must name the reason, not just happen:\n${run.stderr}`,
    )
  })
})

await test('--check refuses --name, which would report every other artifact as an orphan (#7253)', () => {
  withFixture((ctx) => {
    const run = runCheck(
      ctx.script,
      ['--repo', ctx.root, '--targets', 'claude', '--name', 'demo'],
      ctx.home,
      ctx.dir,
    )
    assert(run.status === 1, `--check --name must be refused, got ${run.status}:\n${run.stdout}`)
    assert(/repo-wide gate/.test(run.stderr), `the refusal must say why:\n${run.stderr}`)
  })
})

await test('--check refuses every non-repo-local target and creates no agent home dir (#7253)', () => {
  withFixture((ctx) => {
    const userGlobal = ALL_TARGETS.filter((t) => !REPO_LOCAL_TARGETS.includes(t))
    // Derived, not listed: a target added to the table is covered here the day
    // it lands, which a hardcoded ['codex', 'pi'] would not be.
    assert(userGlobal.length > 0, 'precondition: there is at least one user-global target to refuse')
    for (const target of userGlobal) {
      const run = runCheck(ctx.script, ['--repo', ctx.root, '--targets', target], ctx.home, ctx.dir)
      assert(run.status === 1, `--check --targets ${target} must be refused, got ${run.status}:\n${run.stdout}`)
      assert(
        /applies only to the repo-local targets/.test(run.stderr),
        `the refusal must say why:\n${run.stderr}`,
      )
    }
    assert(
      readdirSync(ctx.home).length === 0,
      `--check wrote into a user-global agent home dir: ${readdirSync(ctx.home).join(', ')}`,
    )
  })
})

await test('--check never writes — not to the repo, not to a home dir (#7253)', () => {
  withFixture((ctx) => {
    addSource(ctx.root, 'keeper', KEEPER_BODY)
    compileThenCheck(ctx)
    writeFileSync(pjoin(ctx.root, '.claude', 'commands', 'demo.md'), `${SKILL_BODY}\ndrifted\n`)
    const before = snapshot(ctx.root)
    const run = runCheck(ctx.script, ['--repo', ctx.root, '--targets', 'claude,gemini'], ctx.home, ctx.dir)
    // The drifted state matters: it is the reporting path, where the compile
    // path would rewrite artifacts and delete leftovers. A green run proves
    // nothing about whether the gate writes.
    assert(run.status === 1, `precondition: the tree must be drifted so the gate takes its reporting path (${run.status})`)
    assert(
      snapshot(ctx.root) === before,
      '--check modified the repo — it is a gate, and a gate that fixes the thing it measures can never fail',
    )
    assert(
      readdirSync(ctx.home).length === 0,
      `--check wrote into the home dir: ${readdirSync(ctx.home).join(', ')} — codex/pi artifacts are per-machine and CI must never touch them`,
    )
  })
})

await test('every target is classified, and the classification matches where the compiler writes (#7253)', () => {
  withFixture((ctx) => {
    // --check gates the repo-local targets and refuses the rest, so this
    // classification decides both what is protected and what CI may touch. A
    // table that said "repo-local" about a target writing into $HOME would point
    // the gate at a path it must never read; one that said "user-global" about a
    // committed target would leave those artifacts silently ungated. Assert it
    // against where the compiler ACTUALLY writes rather than trusting the flag.
    assert(ALL_TARGETS.length > 0 && REPO_LOCAL_TARGETS.length > 0, 'precondition: both target lists are non-empty')
    for (const target of ALL_TARGETS) {
      const home = pjoin(ctx.dir, `home-${target}`)
      mkdirSync(home, { recursive: true })
      const repoBefore = snapshot(ctx.root)
      const run = runCompiler(ctx.script, ['--repo', ctx.root, '--targets', target], home, ctx.dir)
      assert(run.status === 0, `compiling --targets ${target} failed (${run.status}): ${run.stderr}`)
      const repoChanged = snapshot(ctx.root) !== repoBefore
      const wroteHome = readdirSync(home).length > 0
      if (REPO_LOCAL_TARGETS.includes(target)) {
        assert(repoChanged, `${target} is classified repo-local but wrote nothing into the repo`)
        assert(!wroteHome, `${target} is classified repo-local but wrote into $HOME — --check would reach a path CI must never touch`)
      } else {
        assert(wroteHome, `${target} is classified user-global but wrote nothing into $HOME`)
        assert(!repoChanged, `${target} is classified user-global but wrote into the repo — those artifacts are committed and --check skips them`)
      }
    }
  })
})

await test('checkDrift throws on a non-repo-local target rather than reaching into $HOME (#7253)', () => {
  // main() refuses these, but checkDrift is EXPORTED: a caller passing ['codex']
  // would have emitCodex resolve real ~/.codex paths inside a function whose
  // contract says it never touches a home dir. Derived from the table, so a new
  // user-global target is covered the day it lands.
  const repoRoot = resolve(__dirname, '..', '..')
  const userGlobal = ALL_TARGETS.filter((t) => !REPO_LOCAL_TARGETS.includes(t))
  assert(userGlobal.length > 0, 'precondition: there is at least one user-global target')
  for (const target of [...userGlobal, 'not-a-target']) {
    let threw = null
    try {
      checkDrift(repoRoot, [target])
    } catch (err) {
      threw = err
    }
    assert(threw, `checkDrift accepted ${target} — it would resolve paths outside the repo`)
    assert(
      /not a repo-local target/.test(threw.message),
      `checkDrift(${target}) threw for the wrong reason: ${threw.message}`,
    )
  }
})

// --- summary --------------------------------------------------------------
process.stdout.write(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) {
  for (const f of failures) {
    process.stderr.write(`\n[FAIL] ${f.name}\n${f.err.stack || f.err.message}\n`)
  }
  process.exit(1)
}
process.exit(0)
