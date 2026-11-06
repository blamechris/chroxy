import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, renameSync, unlinkSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSafeRegexSource, MAX_PATTERN_LENGTH } from '../src/utils/safe-regex.js'
import { shouldSkipEvaluator, _resetSkipPatternCache } from '../src/prompt-evaluator.js'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { readContainedTextFile, readContainedBytesSync, readPinnedHandle } from '../src/utils/regular-file.js'
import { readResolvedMemoryFile } from '../src/ws-file-ops/memory.js'
import { open } from 'node:fs/promises'
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
    for (const bad of ['(a+)+$', '(a*)*b', '(a|aa)+c', '(x+x+)+y', '((a+))*', '(a|b)*c', '(a)\\1', '(?=a)b', '(?<!a)b', '^(a?a)+$', '\\s*\\s*\\s*x', 'a*a*', 'a+b*c+', '(a{1,2})+b', 'a'.repeat(MAX_PATTERN_LENGTH + 1)]) {
      assert.equal(isSafeRegexSource(bad), false, bad)
    }
  })

  it('accepts ordinary patterns', () => {
    for (const ok of ['^(foo|bar)$', '\\bfix\\b', '^/(help|clear)', 'a+bc', '(ab)+', 'x?y*', 'a*b?c', '^\\s*fix', '[a-z]{2,5}\\d', '(?:todo|fixme)', 'x?y*']) {
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
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-fileref-')))
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
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-ide-')))
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

describe('containment does not depend on resolving the name twice', () => {
  let root, ws, outside
  before(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-parent-race-')))
    ws = join(root, 'ws')
    outside = join(root, 'outside')
    mkdirSync(join(ws, 'sub'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(ws, 'sub', 'f.js'), 'INSIDE-CONTENT\n')
    writeFileSync(join(outside, 'f.js'), 'OUTSIDE-CONTENT\n')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  it('a parent redirected for the open and restored before the checks is refused', { skip: SKIP_NO_SYMLINK }, async () => {
    // Scheduled through the helper's seam: the parent is a link to the outside
    // directory when the file is opened, and a real directory again by the time
    // the helper checks the path. The descriptor is the outside file; the name now
    // shows the inside file; the identities differ, so nothing is returned.
    const parked = join(ws, 'sub-parked')
    const out = await readContainedTextFile(join(ws, 'sub', 'f.js'), ws, 1024, {
      deps: {
        beforeOpen: () => { renameSync(join(ws, 'sub'), parked); symlinkSync(outside, join(ws, 'sub')) },
        afterOpen: () => { unlinkSync(join(ws, 'sub')); renameSync(parked, join(ws, 'sub')) },
      },
    })
    assert.equal(out, null)
    assert.equal(await readContainedTextFile(join(ws, 'sub', 'f.js'), ws, 1024), 'INSIDE-CONTENT\n', 'control: undisturbed, the same call reads the inside file')
  })

  it('a parent still redirected at check time is refused', { skip: SKIP_NO_SYMLINK }, async () => {
    const parked = join(ws, 'sub-parked2')
    const out = await readContainedTextFile(join(ws, 'sub', 'f.js'), ws, 1024, {
      deps: { beforeOpen: () => { renameSync(join(ws, 'sub'), parked); symlinkSync(outside, join(ws, 'sub')) } },
    })
    unlinkSync(join(ws, 'sub'))
    renameSync(parked, join(ws, 'sub'))
    assert.equal(out, null)
  })

  it('a file replaced by a different one after the open is not returned as the checked file', async () => {
    const out = await readContainedTextFile(join(ws, 'sub', 'f.js'), ws, 1024, {
      deps: { afterOpen: () => { unlinkSync(join(ws, 'sub', 'f.js')); writeFileSync(join(ws, 'sub', 'f.js'), 'REPLACEMENT\n') } },
    })
    assert.equal(out, null)
    writeFileSync(join(ws, 'sub', 'f.js'), 'INSIDE-CONTENT\n')
  })

  it('the synchronous reader applies the same identity checks', { skip: SKIP_NO_SYMLINK }, () => {
    assert.equal(readContainedBytesSync(join(ws, 'sub', 'f.js'), ws, 1024).toString(), 'INSIDE-CONTENT\n')
    symlinkSync(join(outside, 'f.js'), join(ws, 'sub', 'link.js'))
    assert.equal(readContainedBytesSync(join(ws, 'sub', 'link.js'), ws, 1024), null)
    const report = {}
    assert.equal(readContainedBytesSync(join(ws, 'sub', 'f.js'), ws, 4, { report }), null)
    assert.equal(report.reason, 'too-large')
  })
})

describe('handles opened by the file viewers and the memory reader are pinned', () => {
  let root, ws, outside
  before(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-pinned-')))
    ws = join(root, 'ws')
    outside = join(root, 'outside')
    mkdirSync(join(ws, 'd'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(ws, 'd', 'f.md'), 'INSIDE\n')
    writeFileSync(join(outside, 'f.md'), 'OUTSIDE\n')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  it('refuses a file larger than the ceiling and a special file, from the descriptor', async () => {
    const fh = await open(join(ws, 'd', 'f.md'), 'r')
    try {
      await assert.rejects(readPinnedHandle(fh, join(ws, 'd', 'f.md'), ws, 3), (e) => e.code === 'EFBIG')
      assert.equal((await readPinnedHandle(fh, join(ws, 'd', 'f.md'), ws, 1024)).toString(), 'INSIDE\n')
    } finally { await fh.close() }
    const dirFh = await open(join(ws, 'd'), 'r').catch(() => null)
    if (dirFh) {
      try { await assert.rejects(readPinnedHandle(dirFh, join(ws, 'd'), ws, 1024), (e) => e.code === 'ENOTREG') } finally { await dirFh.close() }
    }
  })

  it('refuses a handle that is not the file the name denotes inside the root', { skip: SKIP_NO_SYMLINK }, async () => {
    const fh = await open(join(outside, 'f.md'), 'r')
    try {
      await assert.rejects(readPinnedHandle(fh, join(ws, 'd', 'f.md'), ws, 1024), (e) => e.code === 'EACCES')
    } finally { await fh.close() }
  })

  it('the memory reader refuses a parent redirected between its stat and its open', { skip: SKIP_NO_SYMLINK }, async () => {
    const parked = join(ws, 'd-parked')
    const entry = await readResolvedMemoryFile(join(ws, 'd', 'f.md'), async () => {
      renameSync(join(ws, 'd'), parked)
      symlinkSync(outside, join(ws, 'd'))
    }, ws)
    unlinkSync(join(ws, 'd'))
    renameSync(parked, join(ws, 'd'))
    assert.equal(JSON.stringify(entry).includes('OUTSIDE'), false)
    assert.ok(entry.error || entry.skipped, 'the read is refused')
    const ok = await readResolvedMemoryFile(join(ws, 'd', 'f.md'), undefined, ws)
    assert.equal(ok.content, 'INSIDE\n')
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
