import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSafeRegexSource, MAX_PATTERN_LENGTH } from '../src/utils/safe-regex.js'
import { shouldSkipEvaluator, _resetSkipPatternCache } from '../src/prompt-evaluator.js'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { readContainedTextFile } from '../src/utils/regular-file.js'
import { searchContent } from '../src/ide/search.js'
import { collectWorkspaceSymbols as collectSymbols } from '../src/ide/symbols.js'
import { evaluatorHandlers } from '../src/handlers/evaluator-handlers.js'
import { resolveSession } from '../src/handler-utils.js'
import { nsCtx, createSpy } from './test-helpers.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

const POSIX = process.platform !== 'win32'
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('screen for patterns the daemon will run', () => {
  it('refuses repeated groups that contain repeats or alternation, backreferences, lookaround and long patterns', () => {
    for (const bad of ['(a+)+$', '(a*)*b', '(a|aa)+c', '(x+x+)+y', '((a+))*', '(a|b)*c', '(a)\\1', '(?=a)b', '(?<!a)b', 'a'.repeat(MAX_PATTERN_LENGTH + 1)]) {
      assert.equal(isSafeRegexSource(bad), false, bad)
    }
  })

  it('accepts ordinary patterns', () => {
    for (const ok of ['^(foo|bar)$', '\\bfix\\b', '^/(help|clear)', 'a+b+c', '(ab)+', '[a-z]{2,5}\\d', '(?:todo|fixme)', 'x?y*']) {
      assert.equal(isSafeRegexSource(ok), true, ok)
    }
    assert.equal(isSafeRegexSource(42), false)
  })

  it('the evaluator never compiles or runs a refused pattern', () => {
    _resetSkipPatternCache()
    const started = Date.now()
    const verdict = shouldSkipEvaluator('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', { promptEvaluatorSkipPattern: '^(a+)+$' })
    assert.ok(Date.now() - started < 500, 'returned without running the pattern')
    assert.equal(verdict, false)
  })

  it('the setter refuses an unsafe pattern with an error and changes nothing', () => {
    const sent = []
    const session = { setPromptEvaluatorSkipPattern: createSpy(() => true) }
    const ctx = nsCtx({
      send: createSpy((_w, m) => sent.push(m)),
      sessionManager: { getSession: () => ({ session }) },
    })
    settingsHandlers.set_prompt_evaluator_skip_pattern({}, { id: 'c', activeSessionId: 's' }, { type: 'set_prompt_evaluator_skip_pattern', sessionId: 's', value: '(a+)+$' }, ctx)
    assert.equal(sent[0].type, 'session_error')
    assert.match(sent[0].message, /Invalid pattern/)
    assert.equal(session.setPromptEvaluatorSkipPattern.callCount, 0)
  })
})

describe('file references read through a checked, non-blocking descriptor', { skip: !POSIX && 'needs mkfifo' }, () => {
  let dir
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-fileref-')))
    execFileSync('mkfifo', [join(dir, 'pipe.txt')])
    writeFileSync(join(dir, 'ok.txt'), 'plain text\n')
  })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  // Run in a child so a blocking read cannot hold this process; the child prints
  // the decoded replies and the parent bounds it with a timeout.
  function run(paths) {
    const code = `
      import('${join(SERVER, 'src/handler-utils.js').replace(/\\/g, '/')}').then(({ resolveFileRefAttachments }) => {
        const out = resolveFileRefAttachments(${JSON.stringify(paths.map((p) => ({ type: 'file_ref', path: p })))}, ${JSON.stringify(dir)})
        console.log(JSON.stringify((out || []).map((a) => Buffer.from(a.data, 'base64').toString())))
      })`
    return spawnSync(process.execPath, ['--input-type=commonjs', '-e', code], { timeout: 5000, encoding: 'utf8' })
  }

  it('answers a FIFO with an error instead of waiting for a writer', () => {
    const r = run(['pipe.txt', 'ok.txt'])
    assert.equal(r.error, undefined, `the child did not finish: ${r.error?.message}`)
    assert.equal(r.status, 0, r.stderr)
    const texts = JSON.parse(r.stdout.trim().split('\n').pop())
    assert.match(texts[0], /not a regular file/)
    assert.equal(texts[1], 'plain text\n')
  })
})

describe('workspace walks read the object they checked', () => {
  let root, ws, outside
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-ide-')))
    ws = join(root, 'ws')
    outside = join(root, 'outside')
    mkdirSync(ws, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(ws, 'inside.js'), 'export function insideMarker() {}\n')
    writeFileSync(join(outside, 'stolen.js'), 'export function outsideMarker() {}\n')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  it('reads an ordinary in-workspace file', async () => {
    assert.match(await readContainedTextFile(join(ws, 'inside.js'), ws, 1024), /insideMarker/)
  })

  it('refuses a file larger than the cap', async () => {
    assert.equal(await readContainedTextFile(join(ws, 'inside.js'), ws, 4), null)
  })

  it('refuses a path outside the workspace root', async () => {
    assert.equal(await readContainedTextFile(join(outside, 'stolen.js'), ws, 1024), null)
  })

  it('refuses a final-component link and a link in a parent directory', { skip: SKIP_NO_SYMLINK }, async () => {
    symlinkSync(join(outside, 'stolen.js'), join(ws, 'link.js'))
    symlinkSync(outside, join(ws, 'linkdir'))
    assert.equal(await readContainedTextFile(join(ws, 'link.js'), ws, 1024), null)
    assert.equal(await readContainedTextFile(join(ws, 'linkdir', 'stolen.js'), ws, 1024), null)
  })

  it('refuses a special file without waiting on it', { skip: !POSIX && 'needs mkfifo' }, async () => {
    execFileSync('mkfifo', [join(ws, 'pipe.js')])
    const out = await Promise.race([
      readContainedTextFile(join(ws, 'pipe.js'), ws, 1024),
      new Promise((_, rej) => setTimeout(() => rej(new Error('read of a FIFO did not settle')), 3000)),
    ])
    assert.equal(out, null)
  })

  it('search and symbol collection never yield content from outside the workspace', { skip: SKIP_NO_SYMLINK }, async () => {
    const search = await searchContent(ws, 'outsideMarker')
    assert.equal(JSON.stringify(search).includes('outsideMarker'), false)
    const symbols = await collectSymbols(ws)
    assert.equal(JSON.stringify(symbols).includes('outsideMarker'), false)
    assert.ok(JSON.stringify(symbols).includes('insideMarker'), 'control: the in-workspace symbol is found')
  })
})

describe('malformed bindings and the standalone evaluator', () => {
  it('resolveSession treats an empty or falsy non-null binding as bound (matches no session)', () => {
    const ctx = nsCtx({ sessionManager: { getSession: (id) => ({ id }) } })
    for (const boundSessionId of ['', 0, false]) {
      assert.equal(resolveSession(ctx, { sessionId: 'B' }, { boundSessionId }), null, JSON.stringify(boundSessionId))
    }
    assert.deepEqual(resolveSession(ctx, { sessionId: 'B' }, { boundSessionId: null }), { id: 'B' })
    assert.deepEqual(resolveSession(ctx, { sessionId: 'A' }, { boundSessionId: 'A' }), { id: 'A' })
  })

  it('evaluate_draft for a session-scoped connection whose session does not resolve runs no evaluation', async () => {
    const sent = []
    let ran = 0
    const ctx = nsCtx({
      send: createSpy((_w, m) => sent.push(m)),
      sessionManager: { getSession: (id) => (id === 'A' ? { session: { cwd: '/a' }, name: 'A' } : undefined) },
    })
    ctx.evaluateDraft = async () => { ran++; return { verdict: 'forward' } }
    await evaluatorHandlers.evaluate_draft({}, { id: 'c', boundSessionId: 'A' }, { type: 'evaluate_draft', draft: 'please do the thing now', sessionId: 'B' }, ctx)
    assert.equal(ran, 0)
    assert.equal(sent[0].code, 'SESSION_TOKEN_MISMATCH')
    await evaluatorHandlers.evaluate_draft({}, { id: 'c', boundSessionId: 'A' }, { type: 'evaluate_draft', draft: 'please do the thing now', sessionId: 'A' }, ctx)
    assert.equal(ran, 1, 'control: its own session is evaluated')
  })
})
