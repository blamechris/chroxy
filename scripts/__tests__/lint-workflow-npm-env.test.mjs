#!/usr/bin/env node
/**
 * lint-workflow-npm-env.test.mjs — pins scripts/lint-workflow-npm-env.mjs (#7616).
 *
 * The lint's subject is INVISIBLE by construction: a workflow that installs
 * without `NPM_CONFIG_AUDIT`/`NPM_CONFIG_FUND` is green on every ordinary day
 * and only fails when registry.npmjs.org is slow — which is to say, it fails
 * for someone else's reason, months later, on the job with the tightest
 * timeout. So this suite is built around five kinds of case:
 *
 *   1. RED — a workflow with an install site and no (or a partial, or a
 *      job-level, or an unquoted) env block must FAIL, and the message must
 *      name the file. Section 5 anchors that on the SHIPPED tree rather than on
 *      origin/main: `actions/checkout` is shallow by default, so a case that
 *      read `origin/main` would pass locally and fail in CI for a reason that
 *      has nothing to do with the lint.
 *   2. GREEN — a workflow with no install sites needs no env block, and a
 *      correct one passes. "Everything fails" is its own false-safety shape
 *      (docs/false-safety-guards.md, #7273): a check that denies everything
 *      passes its negative tests for the wrong reason.
 *   3. CANNOT-CHECK — a missing directory, an enumeration that finds too few
 *      workflows, and a site detector that finds too few installs must each
 *      exit 2. Never 0.
 *   4. The npm CONTRACT — a live positive-and-negative control that
 *      `NPM_CONFIG_AUDIT=false` actually flips npm's `audit` from its `true`
 *      default, run against the real npm on the real CI node. The lint checks
 *      that the workflows carry the variables; nothing in it checks that the
 *      variables DO anything, and a guard resting on an unverified claim about
 *      a third party is how a green run means nothing. Both npm config files
 *      are pointed at empty temp files so the control cannot be perturbed by a
 *      host `.npmrc` — and so the baseline is npm's built-in default rather
 *      than whatever the runner container happens to set.
 *   5. The SHIPPED tree, in both directions — the real .github/workflows must
 *      pass, and a mutated copy of it must fail. A suite that only ever ran on
 *      synthetic fixtures would keep passing if the real tree drifted out from
 *      under it.
 *   0. The isEntryPoint CALL SITE — see section 0, which runs BEFORE this file
 *      imports the module and explains why it must.
 *
 * No external test framework. Run from repo root:
 *   node scripts/__tests__/lint-workflow-npm-env.test.mjs
 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, '..', 'lint-workflow-npm-env.mjs')
const REPO = resolve(HERE, '..', '..')
const REAL_WORKFLOWS = join(REPO, '.github', 'workflows')

// Every case in this file. Bump it when you add one — a case that vanishes
// should break the run rather than quietly shrink it (#7447).
const MIN_CASES = 76

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

// ---------------------------------------------------------------------------
// Fixture trees + CLI driver (needed by section 0, so defined before it)
// ---------------------------------------------------------------------------

const tmpDirs = []

const ENV_BLOCK = 'env:\n  NPM_CONFIG_AUDIT: "false"\n  NPM_CONFIG_FUND: "false"\n'

/** A workflow with `sites` install lines, optionally prefixed by an env block. */
const workflow = (sites, { env = ENV_BLOCK, extra = '' } = {}) =>
  `name: Fixture\non:\n  push:\n${env}${extra}jobs:\n  j:\n    runs-on: ubuntu-24.04\n    steps:\n` +
  Array.from({ length: sites }, () => '      - run: npm ci\n').join('')

/**
 * A tree that clears BOTH floors on its own, so a case's own file is the only
 * thing under test. Without this every fixture would exit 2 for a reason the
 * case is not about.
 */
const BASE_FILES = {
  'base.yml': workflow(16),
  'quiet-a.yml': 'name: A\non:\n  push:\njobs:\n  j:\n    runs-on: ubuntu-24.04\n',
  'quiet-b.yml': 'name: B\non:\n  push:\njobs:\n  j:\n    runs-on: ubuntu-24.04\n',
  'quiet-c.yml': 'name: C\non:\n  push:\njobs:\n  j:\n    runs-on: ubuntu-24.04\n',
  'quiet-d.yml': 'name: D\non:\n  push:\njobs:\n  j:\n    runs-on: ubuntu-24.04\n',
}

function fixtureDir(files = {}, { base = BASE_FILES } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-wfnpm-'))
  tmpDirs.push(dir)
  for (const [name, text] of Object.entries({ ...base, ...files })) {
    if (text === null) continue
    writeFileSync(join(dir, name), text)
  }
  return dir
}

const runCliOn = (dir, ...args) =>
  spawnSync(process.execPath, [SCRIPT, '--dir', dir, ...args], { encoding: 'utf8', timeout: 60_000 })

// ---------------------------------------------------------------------------
// 0. The isEntryPoint CALL SITE — and why it is FIRST, before the import below.
//
// The module ends in `process.exit(runCli())` under `isEntryPoint()`. If that
// guard ever read TRUE on a plain import, the dynamic import further down would
// run the lint against the real repo and exit — before a single case ran,
// printing nothing, exiting 0 on a clean tree. A green run and a DELETED suite
// would be the same observable outcome (#7236). These two cases run out of
// process and the gate below is hard, so a guard stuck TRUE fails HERE, by
// name, instead of erasing the run.
// ---------------------------------------------------------------------------

test('importing the module does NOT run the lint (a guard stuck TRUE would erase this suite)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-wfnpm-probe-'))
  tmpDirs.push(dir)
  const probe = join(dir, 'probe.mjs')
  writeFileSync(
    probe,
    `import { MIN_WORKFLOWS } from ${JSON.stringify(pathToFileURL(SCRIPT).href)}\n` +
    "process.stdout.write('IMPORT-RETURNED:' + MIN_WORKFLOWS + '\\n')\n",
  )
  const r = spawnSync(process.execPath, [probe], { encoding: 'utf8', cwd: REPO, timeout: 60_000 })
  assert(r.status === 0, `probe exited ${r.status}\n${r.stdout}${r.stderr}`)
  assert(
    /IMPORT-RETURNED:[1-9]\d*/.test(r.stdout),
    `the import never returned — the module ran and exited on import\n${r.stdout}${r.stderr}`,
  )
  assert(
    !/\[workflow-npm-env\]/.test(r.stdout + r.stderr),
    `importing the module produced lint output\n${r.stdout}${r.stderr}`,
  )
})

test('running the module directly DOES run it — positive control for the case above', () => {
  const r = runCliOn(fixtureDir())
  assert(
    /\[workflow-npm-env\]/.test(r.stdout),
    `direct run produced no lint output\n${r.stdout}${r.stderr}`,
  )
})

if (fail > 0) {
  for (const f of failures) process.stdout.write(`\n--- ${f.name}\n${f.err.stack}\n`)
  process.stdout.write(
    '\nFAIL: the entry-point call site is broken. Stopping BEFORE importing the module, ' +
    'because a guard stuck TRUE would exit this process during that import.\n',
  )
  // This exit bypasses the cleanup loop at the bottom of the file, so do it here
  // too. Only reachable when section 0 fails, but that is precisely the run
  // nobody is going to tidy up after by hand.
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  process.exit(1)
}

const {
  CannotCheckError,
  MIN_INSTALL_SITES,
  MIN_WORKFLOWS,
  REQUIRED_ENV,
  analyze,
  findInstallSites,
  overridesOf,
  parseArgs,
  workflowEnv,
} = await import(pathToFileURL(SCRIPT).href)

// ---------------------------------------------------------------------------
// 1. findInstallSites — the detector, in both directions
// ---------------------------------------------------------------------------

const sitesIn = (text) => findInstallSites(text).length

test('detects `run: npm ci`', () => assert(sitesIn('      - run: npm ci\n') === 1))
test('detects `npm ci --omit=dev`', () => assert(sitesIn('        run: npm ci --omit=dev\n') === 1))
test('detects `npm install --package-lock-only`', () =>
  assert(sitesIn('          npm install --package-lock-only\n') === 1))
test('detects `npm i`', () => assert(sitesIn('          npm i\n') === 1))
test('detects an install after a shell operator', () =>
  assert(sitesIn('          cd packages/server && npm ci\n') === 1))
test('detects an install inside a command substitution', () =>
  assert(sitesIn('          out=$(npm ci)\n') === 1))
test('detects an install inside a BACKTICK command substitution', () =>
  // Missed until review: the leading class had `(` but not the backtick, so a
  // real executable install site read as no site at all — the one direction
  // this detector must never fail in.
  assert(sitesIn('          OUT=`npm ci`\n') === 1))
test('counts every line, not just the first', () =>
  assert(sitesIn('  run: npm ci\n  run: npm ci\n  run: npm ci\n') === 3))

test('a YAML comment line is not a site', () =>
  assert(sitesIn('        # thing standing between it and a cold `npm ci` of the monorepo.\n') === 0))
test('an indented shell comment inside a run block is not a site', () =>
  assert(sitesIn('          # and deliberately no npm ci, which is the same reason\n') === 0))
test('`npm run build` is not an install site', () =>
  assert(sitesIn('        run: npm run build\n') === 0))
test('`npm audit` is not an install site', () => assert(sitesIn('        run: npm audit\n') === 0))
test('a word ending in npm is not an install site', () =>
  assert(sitesIn('        run: pnpm ci\n') === 0))
test('`npm cite` is not an install site — the trailing boundary is not a prefix match', () =>
  assert(sitesIn('        run: npm cite\n') === 0))
test('a file with no npm at all has no sites', () =>
  assert(sitesIn(BASE_FILES['quiet-a.yml']) === 0))

test('the detector is deliberately over-inclusive — an echo mentioning npm ci counts', () => {
  // Documented in the script header, and asserted here so the behaviour is a
  // decision rather than an accident. Over-inclusive only ever REQUIRES the env
  // block on a file that does not need it; under-inclusive would let a real
  // install site through, which is the failure the lint exists to prevent.
  assert(sitesIn('            echo "::error::$dir has no lock — npm ci cannot run."\n') === 1)
})

// ---------------------------------------------------------------------------
// 2. workflowEnv — the workflow-level block, and only that level
// ---------------------------------------------------------------------------

test('reads a workflow-level env block', () => {
  const env = workflowEnv(`name: x\n${ENV_BLOCK}jobs:\n  j:\n`)
  assert(env.NPM_CONFIG_AUDIT === '"false"', JSON.stringify(env))
  assert(env.NPM_CONFIG_FUND === '"false"', JSON.stringify(env))
})

test('reads a block that also carries unrelated keys (release.yml shape)', () => {
  const env = workflowEnv('env:\n  REGISTRY: ghcr.io\n  NPM_CONFIG_AUDIT: "false"\njobs:\n')
  assert(env.REGISTRY === 'ghcr.io' && env.NPM_CONFIG_AUDIT === '"false"', JSON.stringify(env))
})

test('tolerates blank lines and indented comments inside the block', () => {
  const env = workflowEnv('env:\n  # why\n\n  NPM_CONFIG_AUDIT: "false"\njobs:\n')
  assert(env.NPM_CONFIG_AUDIT === '"false"', JSON.stringify(env))
})

test('strips a trailing inline comment from a value', () => {
  const env = workflowEnv('env:\n  NPM_CONFIG_AUDIT: "false"  # see #7616\njobs:\n')
  assert(env.NPM_CONFIG_AUDIT === '"false"', JSON.stringify(env))
})

test('a column-0 comment does NOT end the block — YAML resumes the mapping after it', () => {
  // Cross-checked against a real YAML parser: this is ONE two-key mapping.
  // The scanner used to break at the unindented comment and report
  // NPM_CONFIG_FUND missing on a correct file.
  const env = workflowEnv('env:\n  NPM_CONFIG_AUDIT: "false"\n# why fund too\n  NPM_CONFIG_FUND: "false"\njobs:\n')
  assert(env.NPM_CONFIG_AUDIT === '"false"' && env.NPM_CONFIG_FUND === '"false"', JSON.stringify(env))
})

test('a column-0 comment immediately after `env:` does not wipe the block', () => {
  const env = workflowEnv('env:\n# a note\n  NPM_CONFIG_AUDIT: "false"\njobs:\n')
  assert(env.NPM_CONFIG_AUDIT === '"false"', JSON.stringify(env))
})

test('a double-quoted key is read', () => {
  const env = workflowEnv('env:\n  "NPM_CONFIG_AUDIT": "false"\njobs:\n')
  assert(env.NPM_CONFIG_AUDIT === '"false"', JSON.stringify(env))
})

test('a single-quoted key is read', () => {
  const env = workflowEnv("env:\n  'NPM_CONFIG_AUDIT': \"false\"\njobs:\n")
  assert(env.NPM_CONFIG_AUDIT === '"false"', JSON.stringify(env))
})

test('a FLOW mapping raises cannot-check rather than reading as no env block', () => {
  let caught = null
  try {
    workflowEnv('env: { NPM_CONFIG_AUDIT: "false" }\njobs:\n')
  } catch (err) {
    caught = err
  }
  assert(caught instanceof CannotCheckError, `got ${caught && caught.constructor.name}`)
  assert(/inline value/.test(caught.message), caught.message)
})

test('`env:` with only a trailing comment is still a block start', () => {
  const env = workflowEnv('env:  # see #7616\n  NPM_CONFIG_AUDIT: "false"\njobs:\n')
  assert(env.NPM_CONFIG_AUDIT === '"false"', JSON.stringify(env))
})

test('CRLF line endings parse identically', () => {
  const env = workflowEnv('env:\r\n  NPM_CONFIG_AUDIT: "false"\r\njobs:\r\n')
  assert(env.NPM_CONFIG_AUDIT === '"false"', JSON.stringify(env))
})

test('a file with no env: at all reads as null, not as an empty block', () =>
  assert(workflowEnv('name: x\njobs:\n  j:\n') === null))

test('does not read a JOB-level env as the workflow level', () => {
  const env = workflowEnv('name: x\njobs:\n  j:\n    env:\n      NPM_CONFIG_AUDIT: "false"\n')
  assert(env === null, JSON.stringify(env))
})

test('the block ends at the next column-0 key', () => {
  const env = workflowEnv('env:\n  A: "1"\njobs:\n  j:\n    env:\n      B: "2"\n')
  assert(env.A === '"1"' && env.B === undefined, JSON.stringify(env))
})

// ---------------------------------------------------------------------------
// 3. RED — a violation must fail, and the message must name the file
// ---------------------------------------------------------------------------

const expectFail = (files, match) => {
  const r = runCliOn(fixtureDir(files))
  assert(r.status === 1, `expected exit 1, got ${r.status}\n${r.stdout}${r.stderr}`)
  assert(match.test(r.stderr), `stderr did not match ${match}\n${r.stderr}`)
  return r
}

test('RED: an install site with no env block at all', () =>
  expectFail({ 'bad.yml': workflow(1, { env: '' }) }, /bad\.yml.*no workflow-level `env:` block/s))

test('RED: the failure names the line of the first install site', () =>
  expectFail({ 'bad.yml': workflow(1, { env: '' }) }, /bad\.yml: 1 npm install site\(s\), first at line \d+/))

test('RED: NPM_CONFIG_AUDIT present, NPM_CONFIG_FUND missing', () =>
  expectFail(
    { 'bad.yml': workflow(1, { env: 'env:\n  NPM_CONFIG_AUDIT: "false"\n' }) },
    /bad\.yml.*does not set NPM_CONFIG_FUND/,
  ))

test('RED: NPM_CONFIG_FUND present, NPM_CONFIG_AUDIT missing', () =>
  expectFail(
    { 'bad.yml': workflow(1, { env: 'env:\n  NPM_CONFIG_FUND: "false"\n' }) },
    /bad\.yml.*does not set NPM_CONFIG_AUDIT/,
  ))

test('RED: an unquoted YAML boolean is rejected, with the reason', () =>
  expectFail(
    { 'bad.yml': workflow(1, { env: 'env:\n  NPM_CONFIG_AUDIT: false\n  NPM_CONFIG_FUND: false\n' }) },
    /is `false`, not the quoted string "false"/,
  ))

test('RED: "true" is rejected', () =>
  expectFail(
    { 'bad.yml': workflow(1, { env: 'env:\n  NPM_CONFIG_AUDIT: "true"\n  NPM_CONFIG_FUND: "false"\n' }) },
    /NPM_CONFIG_AUDIT is `"true"`/,
  ))

test('RED: a JOB-level env block does not satisfy the lint', () => {
  // The whole point of the workflow level is that it covers jobs added later.
  const jobLevel =
    'name: Fixture\non:\n  push:\njobs:\n  j:\n    runs-on: ubuntu-24.04\n' +
    '    env:\n      NPM_CONFIG_AUDIT: "false"\n      NPM_CONFIG_FUND: "false"\n' +
    '    steps:\n      - run: npm ci\n'
  expectFail({ 'bad.yml': jobLevel }, /bad\.yml.*no workflow-level `env:` block/s)
})

test('RED: a JOB-level override neutralises a correct workflow-level block', () => {
  // GitHub resolves step env over job env over workflow env, so this job's
  // `npm ci` audits anyway. The lint reported OK on exactly this shape until
  // review caught it: the workflow-level block is a DEFAULT, not a guarantee.
  const overridden =
    'name: Fixture\non:\n  push:\n' + ENV_BLOCK +
    'jobs:\n  j:\n    runs-on: ubuntu-24.04\n' +
    '    env:\n      NPM_CONFIG_AUDIT: "true"\n' +
    '    steps:\n      - run: npm ci\n'
  expectFail({ 'bad.yml': overridden }, /NPM_CONFIG_AUDIT is set to `"true"` somewhere below the workflow level/)
})

test('RED: a STEP-level override is caught the same way', () => {
  const overridden =
    'name: Fixture\non:\n  push:\n' + ENV_BLOCK +
    'jobs:\n  j:\n    runs-on: ubuntu-24.04\n    steps:\n' +
    '      - run: npm ci\n        env:\n          NPM_CONFIG_FUND: "true"\n'
  expectFail({ 'bad.yml': overridden }, /NPM_CONFIG_FUND is set to `"true"`/)
})

test('GREEN-ish: a job-level env repeating "false" is not an override', () => {
  // Redundant, but it does not neutralise anything — flagging it would be the
  // deny-everything shape (#7273).
  const repeated =
    'name: Fixture\non:\n  push:\n' + ENV_BLOCK +
    'jobs:\n  j:\n    runs-on: ubuntu-24.04\n' +
    '    env:\n      NPM_CONFIG_AUDIT: "false"\n' +
    '    steps:\n      - run: npm ci\n'
  const r = runCliOn(fixtureDir({ 'ok.yml': repeated }))
  assert(r.status === 0, `expected exit 0, got ${r.status}\n${r.stdout}${r.stderr}`)
})

test('RED: both violation kinds in one file are reported together', () => {
  const both = workflow(1, { env: 'env:\n  NPM_CONFIG_AUDIT: "true"\n' })
  const r = expectFail({ 'bad.yml': both }, /does not set NPM_CONFIG_FUND/)
  assert(/NPM_CONFIG_AUDIT is `"true"`/.test(r.stderr), `only one kind reported\n${r.stderr}`)
})

test('RED: a NEW workflow added beside compliant ones is caught', () => {
  // The reason this is a lint and not 22 per-step flags.
  const r = expectFail({ 'brand-new.yml': workflow(1, { env: '' }) }, /brand-new\.yml/)
  assert(!/base\.yml/.test(r.stderr), `the compliant file was also reported\n${r.stderr}`)
})

test('RED: every offending file is reported, not just the first', () => {
  const r = expectFail(
    { 'bad1.yml': workflow(1, { env: '' }), 'bad2.yml': workflow(1, { env: '' }) },
    /bad1\.yml/,
  )
  assert(/bad2\.yml/.test(r.stderr), `only the first offender was reported\n${r.stderr}`)
})

// ---------------------------------------------------------------------------
// 4. GREEN — the lint must not deny everything (#7273)
// ---------------------------------------------------------------------------

const expectPass = (files) => {
  const r = runCliOn(fixtureDir(files))
  assert(r.status === 0, `expected exit 0, got ${r.status}\n${r.stdout}${r.stderr}`)
  return r
}

test('GREEN: a compliant tree passes', () => expectPass({}))

test('GREEN: single-quoted "false" is accepted too', () =>
  expectPass({
    'ok.yml': workflow(1, { env: "env:\n  NPM_CONFIG_AUDIT: 'false'\n  NPM_CONFIG_FUND: 'false'\n" }),
  }))

test('GREEN: a workflow with no install sites needs no env block', () =>
  expectPass({ 'quiet-e.yml': 'name: E\non:\n  push:\njobs:\n  j:\n    runs-on: ubuntu-24.04\n' }))

test('GREEN: the env block may carry unrelated keys alongside', () =>
  expectPass({
    'ok.yml': workflow(1, {
      env: 'env:\n  REGISTRY: ghcr.io\n  NPM_CONFIG_AUDIT: "false"\n  NPM_CONFIG_FUND: "false"\n',
    }),
  }))

test('GREEN: a .yaml extension is enumerated too', () =>
  expectPass({ 'ok.yaml': workflow(1) }))

test('GREEN: a non-workflow file in the directory is ignored', () =>
  expectPass({ 'README.md': 'npm ci\nnpm ci\n' }))

// ---------------------------------------------------------------------------
// 5. CANNOT-CHECK — never 0
// ---------------------------------------------------------------------------

test('CANNOT CHECK: a missing directory exits 2', () => {
  const r = runCliOn(join(tmpdir(), 'chroxy-wfnpm-does-not-exist-12345'))
  assert(r.status === 2, `expected exit 2, got ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/CANNOT CHECK/.test(r.stderr), r.stderr)
})

test('CANNOT CHECK: a file where a directory was expected exits 2', () => {
  const dir = fixtureDir()
  const r = runCliOn(join(dir, 'base.yml'))
  assert(r.status === 2, `expected exit 2, got ${r.status}\n${r.stdout}${r.stderr}`)
})

test('CANNOT CHECK: too few workflows exits 2, and does NOT report clean', () => {
  const r = runCliOn(fixtureDir({}, { base: { 'only.yml': workflow(16) } }))
  assert(r.status === 2, `expected exit 2, got ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/enumeration is broken/.test(r.stderr), r.stderr)
  assert(!/OK —/.test(r.stdout), `reported OK while unable to check\n${r.stdout}`)
})

test('CANNOT CHECK: too few install sites exits 2 — a dead detector is not a clean tree', () => {
  const quiet = 'name: Q\non:\n  push:\njobs:\n  j:\n    runs-on: ubuntu-24.04\n'
  const base = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [`${n}.yml`, quiet]))
  const r = runCliOn(fixtureDir({ 'one.yml': workflow(1) }, { base }))
  assert(r.status === 2, `expected exit 2, got ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/site detector has stopped matching/.test(r.stderr), r.stderr)
})

test('CANNOT CHECK: an unreadable workflow file exits 2, not 1', () => {
  // A DIRECTORY named *.yml, not `chmod 000`: readFileSync throws EISDIR for
  // every uid, whereas a mode-000 file is readable by root and CI containers
  // here run as root — the test would silently stop exercising this path
  // (#6075's root-bypassed fs perms, one layer over).
  //
  // Exit 1 would also be "red", so this case is about the DIAGNOSIS: 1 means a
  // workflow is missing the env block and sends the reader to the wrong place.
  const dir = fixtureDir()
  mkdirSync(join(dir, 'oops.yml'))
  const r = runCliOn(dir)
  assert(r.status === 2, `expected exit 2, got ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/CANNOT CHECK/.test(r.stderr), r.stderr)
  assert(/oops\.yml/.test(r.stderr), `the unreadable file was not named\n${r.stderr}`)
})

test('parseArgs: --dir=<path> is honoured, not silently ignored', () => {
  // The equals form used to fall through indexOf('--dir') and take the DEFAULT,
  // so `--dir=/some/fixture` reported on the real .github/workflows instead.
  assert(parseArgs(['--dir=/tmp/x']).dir === '/tmp/x', JSON.stringify(parseArgs(['--dir=/tmp/x'])))
})

test('parseArgs: --dir <path> two-token form is honoured', () =>
  assert(parseArgs(['--dir', '/tmp/x']).dir === '/tmp/x'))

test('parseArgs: no arguments means .github/workflows', () =>
  assert(parseArgs([]).dir === join('.github', 'workflows')))

test('parseArgs: an unknown argument is an error, not a silent default', () =>
  assert(/unknown argument/.test(parseArgs(['--bogus']).error || '')))

test('CANNOT CHECK: --dir=<empty> exits 2 rather than scanning the real tree', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--dir='], { encoding: 'utf8', cwd: REPO, timeout: 60_000 })
  assert(r.status === 2, `expected exit 2, got ${r.status}\n${r.stdout}${r.stderr}`)
})

test('CANNOT CHECK: an unknown argument exits 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8', cwd: REPO, timeout: 60_000 })
  assert(r.status === 2, `expected exit 2, got ${r.status}\n${r.stdout}${r.stderr}`)
})

test('CANNOT CHECK: a flow-style env: in a real file exits 2 and names the file', () => {
  const flow = 'name: F\non:\n  push:\nenv: { NPM_CONFIG_AUDIT: "false" }\njobs:\n  j:\n    steps:\n      - run: npm ci\n'
  const r = runCliOn(fixtureDir({ 'flow.yml': flow }))
  assert(r.status === 2, `expected exit 2, got ${r.status}\n${r.stdout}${r.stderr}`)
  assert(/flow\.yml/.test(r.stderr), `the file was not named\n${r.stderr}`)
})

test('overridesOf: a comment mentioning the key is not an override', () =>
  assert(overridesOf('        # NPM_CONFIG_AUDIT: "true" was tried here\n').length === 0))

test('CANNOT CHECK: --dir with no value exits 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--dir'], { encoding: 'utf8', cwd: REPO, timeout: 60_000 })
  assert(r.status === 2, `expected exit 2, got ${r.status}\n${r.stdout}${r.stderr}`)
})

test('analyze() throws CannotCheckError rather than returning an empty result', () => {
  let caught = null
  try {
    analyze(join(tmpdir(), 'chroxy-wfnpm-does-not-exist-12345'))
  } catch (err) {
    caught = err
  }
  assert(caught instanceof CannotCheckError, `got ${caught && caught.constructor.name}`)
})

// ---------------------------------------------------------------------------
// 6. The npm CONTRACT — a live control that the variables do what we claim
// ---------------------------------------------------------------------------

const npmConfig = (key, env) => {
  const iso = mkdtempSync(join(tmpdir(), 'chroxy-wfnpm-npmrc-'))
  tmpDirs.push(iso)
  writeFileSync(join(iso, 'user'), '')
  writeFileSync(join(iso, 'global'), '')
  const clean = { ...process.env }
  // The self-hosted runner CONTAINERS set npm_config_audit out-of-band (#7616).
  // Leaving it in would make the baseline `false` and destroy this control's
  // discriminating power — the very shape a control exists to rule out.
  for (const k of Object.keys(clean)) if (/^npm_config_/i.test(k)) delete clean[k]
  const r = spawnSync(
    'npm',
    ['config', 'get', key, '--userconfig', join(iso, 'user'), '--globalconfig', join(iso, 'global')],
    { encoding: 'utf8', env: { ...clean, ...env }, shell: process.platform === 'win32', timeout: 60_000 },
  )
  assert(r.status === 0, `npm config get ${key} failed (${r.status})\n${r.stdout}${r.stderr}`)
  return r.stdout.trim()
}

for (const [key, envName] of [['audit', 'NPM_CONFIG_AUDIT'], ['fund', 'NPM_CONFIG_FUND']]) {
  test(`npm CONTRACT: \`${key}\` defaults to true with no config — the negative control`, () => {
    const got = npmConfig(key)
    assert(
      got === 'true',
      `baseline npm \`${key}\` is ${got}, not true — something other than ${envName} is setting it, ` +
      'so the positive control below cannot discriminate',
    )
  })

  test(`npm CONTRACT: ${envName}="false" flips \`${key}\` to false`, () => {
    const got = npmConfig(key, { [envName]: 'false' })
    assert(
      got === 'false',
      `npm \`${key}\` is ${got} with ${envName}=false — npm no longer honours the variable, and ` +
      'every env block this lint enforces is inert',
    )
  })
}

// ---------------------------------------------------------------------------
// 7. The SHIPPED tree, in both directions
// ---------------------------------------------------------------------------

test('SHIPPED: the PRODUCTION invocation — no arguments at all — passes', () => {
  // ci.yml runs `node scripts/lint-workflow-npm-env.mjs` with NO arguments, and
  // every other case in this file passes --dir. That left the default-path line
  // guarded by nothing: a one-character typo there ('.github/workflow') breaks
  // every CI run of the lint while this suite reports 54/54. A guard wired to
  // only some of its callers is the catalogued shape from #7262.
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: REPO, timeout: 60_000 })
  assert(r.status === 0, `production invocation exited ${r.status}\n${r.stdout}${r.stderr}`)
  assert(
    /\d+ workflow\(s\), \d+ npm install site\(s\) checked/.test(r.stdout),
    `no scan summary — did it read the right directory?\n${r.stdout}${r.stderr}`,
  )
})

test('SHIPPED: the real .github/workflows passes', () => {
  const r = runCliOn(REAL_WORKFLOWS)
  assert(r.status === 0, `the real tree failed the lint\n${r.stdout}${r.stderr}`)
})

test('SHIPPED: the real tree with ci.yml\'s env block removed FAILS', () => {
  // The positive control for the case above: without it, "the real tree passes"
  // would read identically against a lint that passes everything.
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-wfnpm-mutant-'))
  tmpDirs.push(dir)
  cpSync(REAL_WORKFLOWS, dir, { recursive: true })
  const ci = join(dir, 'ci.yml')
  const src = readFileSync(ci, 'utf8')
  const stripped = src.replace(/^env:\n(?:[ \t]+.*\n)+/m, '')
  assert(stripped !== src, 'the mutation did not land — ci.yml has no workflow-level env: block')
  writeFileSync(ci, stripped)
  const r = runCliOn(dir)
  assert(r.status === 1, `mutated tree exited ${r.status}, expected 1\n${r.stdout}${r.stderr}`)
  assert(/ci\.yml/.test(r.stderr), `ci.yml was not named\n${r.stderr}`)
})

test('SHIPPED: the workflows that install are exactly the five known files', () => {
  // This case used to assert `installSites >= MIN_INSTALL_SITES` under this
  // name — a duplicate of the floor case below, which stayed green when a
  // review added a SIXTH installing workflow to the real tree. A comment
  // promising a stronger check than the code performs is the shape catalogued
  // at #7290/#7291, produced here in a test written for that catalogue.
  //
  // The roster is safe in a way a roster inside the LINT would not be: it is
  // asserted EQUAL to the enumerated reality on every run, so it cannot drift
  // silently — drift is the thing it reports. The lint itself still enumerates
  // the directory and consults no list.
  const { installing } = analyze(REAL_WORKFLOWS)
  const known = [
    'ci.yml',
    'maestro-nightly.yml',
    'nightly-k8s-integration.yml',
    'release.yml',
    'repo-relay.yml',
  ]
  assert(
    JSON.stringify(installing) === JSON.stringify(known),
    `the set of installing workflows changed.\n  now:   ${JSON.stringify(installing)}\n` +
    `  known: ${JSON.stringify(known)}\nIf that is deliberate, update this roster in the same commit.`,
  )
})

test('the two floors are floors, not counts — the real tree exceeds both', () => {
  const { workflows, installSites } = analyze(REAL_WORKFLOWS)
  assert(workflows > MIN_WORKFLOWS, `workflows ${workflows} is not above the floor ${MIN_WORKFLOWS}`)
  assert(
    installSites > MIN_INSTALL_SITES,
    `sites ${installSites} is not above the floor ${MIN_INSTALL_SITES}`,
  )
})

test('REQUIRED_ENV names exactly the two variables the workflows set', () => {
  assert(
    JSON.stringify(Object.keys(REQUIRED_ENV)) === JSON.stringify(['NPM_CONFIG_AUDIT', 'NPM_CONFIG_FUND']),
    JSON.stringify(REQUIRED_ENV),
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
