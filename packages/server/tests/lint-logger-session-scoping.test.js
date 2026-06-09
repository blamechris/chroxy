/**
 * Tests for scripts/lint-logger-session-scoping.mjs
 *
 * The lint exists so session-aware modules cannot regress to unscoped log
 * lines — those would leak across sessions on the WsServer log fan-out
 * (#4787). Two layers of enforcement:
 *
 *   1. REQUIRES_FACTORY_IMPORT — file must `import { loggerForSession }`
 *      from logger.js.
 *   2. FORBIDS_BARE_CREATELOGGER — every `createLogger(...)` call in the
 *      file must be followed by `.withSession(...)`. Stronger guard
 *      reserved for files that no longer need a pre-session-id fallback.
 *
 * Issue: #4828 follow-up to #4823. The FORBIDS_BARE_CREATELOGGER set was
 * empty in #4823 (no files migrated far enough yet), so without these
 * tests a regression in the parser's parenthesis-depth / string-state
 * tracking could land silently — no real file exercises that code path.
 *
 * Strategy: build a tiny temp `src/` tree, point the lint at it via the
 * resolution path it already uses (relative `../src/`), and assert the
 * exit code + offender list match the fixture's shape.
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REAL_LINT_SCRIPT = resolve(__dirname, '..', 'scripts', 'lint-logger-session-scoping.mjs')
const REAL_LINT_SOURCE = readFileSync(REAL_LINT_SCRIPT, 'utf8')

/**
 * Build an isolated scratch tree of the form:
 *   tmpDir/
 *     scripts/lint-logger-session-scoping.mjs   (rewritten with the test sets)
 *     src/                                      (fixture .js files supplied by caller)
 *
 * The real lint resolves `SRC_DIR = resolve(__dirname, '..', 'src')`, so
 * dropping the script under `scripts/` makes that resolve to our fixture
 * `src/`. We splice in the caller's `REQUIRES_FACTORY_IMPORT` and
 * `FORBIDS_BARE_CREATELOGGER` set bodies via a literal regex replace —
 * the real source defines each Set in the same shape, so swapping the
 * Set bodies is unambiguous.
 */
function buildFixtureTree({ requiresFactoryImport, forbidsBareCreateLogger, srcFiles }) {
  const root = mkdtempSync(join(tmpdir(), 'chroxy-lint-logger-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })

  let patched = REAL_LINT_SOURCE
  // Swap the REQUIRES_FACTORY_IMPORT Set body for the test-supplied list.
  // #4828 (Copilot review): if the production Set's surface shape changes
  // (multi-line keys, trailing comma stylistics, rename) the regex would
  // silently no-op and every test would become vacuous — the fixture
  // filenames would not appear in the real sets, lint would skip them, and
  // assertions on offender lists would still pass. Assert the patch ran.
  const reqRe = /const REQUIRES_FACTORY_IMPORT = new Set\(\[[\s\S]*?\]\)/
  const forbidRe = /const FORBIDS_BARE_CREATELOGGER = new Set\(\[[\s\S]*?\]\)/
  if (!reqRe.test(patched)) {
    throw new Error('lint script no longer matches REQUIRES_FACTORY_IMPORT regex — fixture builder needs updating')
  }
  if (!forbidRe.test(patched)) {
    throw new Error('lint script no longer matches FORBIDS_BARE_CREATELOGGER regex — fixture builder needs updating')
  }
  patched = patched.replace(
    reqRe,
    `const REQUIRES_FACTORY_IMPORT = new Set([${requiresFactoryImport.map((f) => JSON.stringify(f)).join(', ')}])`,
  )
  // Same for FORBIDS_BARE_CREATELOGGER.
  patched = patched.replace(
    forbidRe,
    `const FORBIDS_BARE_CREATELOGGER = new Set([${forbidsBareCreateLogger.map((f) => JSON.stringify(f)).join(', ')}])`,
  )

  writeFileSync(join(root, 'scripts', 'lint-logger-session-scoping.mjs'), patched)

  for (const [relPath, contents] of Object.entries(srcFiles)) {
    const fullPath = join(root, 'src', relPath)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, contents)
  }

  return root
}

function runLint(root) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'lint-logger-session-scoping.mjs')], {
    encoding: 'utf8',
  })
}

const cleanups = []
after(() => {
  for (const root of cleanups) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('lint-logger-session-scoping', () => {
  test('REQUIRES_FACTORY_IMPORT: passes when loggerForSession is imported', () => {
    const root = buildFixtureTree({
      requiresFactoryImport: ['session-good.js'],
      forbidsBareCreateLogger: [],
      srcFiles: {
        'session-good.js': `
import { createLogger, loggerForSession } from './logger.js'

const log = createLogger('test')
export function withLogger(sid) {
  return loggerForSession('test', sid)
}
`,
      },
    })
    cleanups.push(root)

    const res = runLint(root)
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr:\n${res.stderr}`)
    assert.match(res.stdout, /OK: 1 module\(s\) import loggerForSession/)
  })

  test('REQUIRES_FACTORY_IMPORT: passes when sessionLogger is imported (#5378)', () => {
    // sessionLogger wraps loggerForSession (and falls back to the unscoped
    // logger only when sessionId is absent), so importing it keeps log entries
    // session-scoped and satisfies the factory-import requirement.
    const root = buildFixtureTree({
      requiresFactoryImport: ['session-good-helper.js'],
      forbidsBareCreateLogger: [],
      srcFiles: {
        'session-good-helper.js': `
import { createLogger, sessionLogger } from './logger.js'

const log = createLogger('test')
export function withLogger(sid) {
  return sessionLogger(sid, 'test')
}
`,
      },
    })
    cleanups.push(root)

    const res = runLint(root)
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr:\n${res.stderr}`)
  })

  test('REQUIRES_FACTORY_IMPORT: fails when only createLogger is imported', () => {
    const root = buildFixtureTree({
      requiresFactoryImport: ['session-missing-import.js'],
      forbidsBareCreateLogger: [],
      srcFiles: {
        'session-missing-import.js': `
import { createLogger } from './logger.js'

const log = createLogger('test')
`,
      },
    })
    cleanups.push(root)

    const res = runLint(root)
    assert.equal(res.status, 1, `expected exit 1, got ${res.status}; stdout:\n${res.stdout}`)
    assert.match(res.stderr, /session-aware module must `import \{ loggerForSession \}` \(or `sessionLogger`\) from/)
  })

  test('FORBIDS_BARE_CREATELOGGER: passes when every createLogger is chained with .withSession', () => {
    const root = buildFixtureTree({
      requiresFactoryImport: ['session-forbid-good.js'],
      forbidsBareCreateLogger: ['session-forbid-good.js'],
      srcFiles: {
        'session-forbid-good.js': `
import { createLogger, loggerForSession } from './logger.js'

export function build(sid) {
  const a = createLogger('test').withSession(sid)
  const b = loggerForSession('test', sid)
  return [a, b]
}
`,
      },
    })
    cleanups.push(root)

    const res = runLint(root)
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr:\n${res.stderr}`)
    assert.match(res.stdout, /1 module\(s\) forbid bare createLogger/)
  })

  test('FORBIDS_BARE_CREATELOGGER: fails on a bare module-level createLogger', () => {
    const root = buildFixtureTree({
      requiresFactoryImport: ['session-forbid-bad.js'],
      forbidsBareCreateLogger: ['session-forbid-bad.js'],
      srcFiles: {
        'session-forbid-bad.js': `
import { createLogger, loggerForSession } from './logger.js'

// Bare createLogger() with no trailing .withSession — the forbid rule
// must flag this as the regression the lint exists to catch.
const log = createLogger('test')
export function go(sid) { return loggerForSession('test', sid) }
`,
      },
    })
    cleanups.push(root)

    const res = runLint(root)
    assert.equal(res.status, 1, `expected exit 1, got ${res.status}; stdout:\n${res.stdout}`)
    assert.match(res.stderr, /bare createLogger\(\.\.\.\) is forbidden/)
  })

  test('FORBIDS_BARE_CREATELOGGER: parser tolerates string args containing parens', () => {
    // Regression guard for the parenthesis-depth tracker in
    // findUnscopedCreateLoggerCalls: the close-paren scanner must not
    // count `(` / `)` that appear INSIDE a string literal as call-depth
    // changes. Without correct string-state tracking, a `createLogger`
    // with a complex string argument would either close too early
    // (false positive — sees a `.withSession` that's actually after a
    // different call) or never close (silent skip — never flags real
    // bare calls). Both regressions would land silently because the
    // production source does not exercise the corner case.
    const root = buildFixtureTree({
      requiresFactoryImport: ['session-parens.js'],
      forbidsBareCreateLogger: ['session-parens.js'],
      srcFiles: {
        'session-parens.js': `
import { createLogger } from './logger.js'

// Bare call with a paren-bearing string. After the string-aware scanner
// finds the matching close-paren, the next non-whitespace token is the
// statement terminator — there is NO .withSession to satisfy the rule.
const log = createLogger('component (with parens)')
export const logRef = log
`,
      },
    })
    cleanups.push(root)

    const res = runLint(root)
    assert.equal(res.status, 1, `expected exit 1, got ${res.status}; stderr:\n${res.stderr}`)
    assert.match(res.stderr, /bare createLogger\(\.\.\.\) is forbidden/)
  })
})
