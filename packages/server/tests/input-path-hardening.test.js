import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, renameSync, unlinkSync, linkSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSafeRegexSource, MAX_PATTERN_LENGTH, MAX_QUANTIFIED_ATOMS } from '../src/utils/safe-regex.js'
import { shouldSkipEvaluator, _resetSkipPatternCache } from '../src/prompt-evaluator.js'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { readContainedTextFile, readContainedBytes, readContainedBytesSync, readPinnedHandle } from '../src/utils/regular-file.js'
import { readResolvedMemoryFile } from '../src/ws-file-ops/memory.js'
import { open } from 'node:fs/promises'
import { searchContent } from '../src/ide/search.js'
import { collectWorkspaceSymbols as collectSymbols } from '../src/ide/symbols.js'
import { evaluatorHandlers } from '../src/handlers/evaluator-handlers.js'
import { resolveSession } from '../src/handler-utils.js'
import { nsCtx, createSpy } from './test-helpers.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

const POSIX = process.platform !== 'win32'
const SKIP_WIN_RENAME_UNDER_HANDLE = process.platform === 'win32' && 'Windows refuses to rename a directory while a handle beneath it is open (EPERM), so a swap staged between the open and the checks cannot be set up on win32; the same schedule is exercised on POSIX'
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('screen for patterns the daemon will run', () => {
  it('refuses repeated groups that contain repeats or alternation, backreferences, lookaround and long patterns', () => {
    for (const bad of ['(a+)+$', '(a*)*b', '(a|aa)+c', '(x+x+)+y', '((a+))*', '(a|b)*c', '(a)\\1', '(?=a)b', '(?<!a)b', '^(a?a)+$', '\\s*\\s*\\s*x', 'a*a*', 'a+b*c+', '(a{1,2})+b', 'a'.repeat(MAX_PATTERN_LENGTH + 1)]) {
      assert.equal(isSafeRegexSource(bad), false, bad)
    }
  })

  it('refuses bounded or optional repeats of groups that hold repeats, and many quantified atoms', () => {
    for (const bad of ['(aa|a){1,40}$', '(a|a){0,25}$', '(a{0,9}){0,9}$', '(a|a)?'.repeat(20), 'a?'.repeat(36) + 'a'.repeat(36), '(foo.*)?']) {
      assert.equal(isSafeRegexSource(bad), false, bad.slice(0, 40))
    }
    assert.equal(isSafeRegexSource('a?'.repeat(MAX_QUANTIFIED_ATOMS) + 'b'), true, 'at the cap it is still accepted')
    assert.equal(isSafeRegexSource('a?'.repeat(MAX_QUANTIFIED_ATOMS + 1) + 'b'), false, 'one past the cap is refused')
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

  it('a parent redirected for the open and restored before the checks is refused', { skip: SKIP_NO_SYMLINK || SKIP_WIN_RENAME_UNDER_HANDLE }, async () => {
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

describe('pinning: second pass, descriptor path, lexical roots', () => {
  let base
  before(() => { base = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-pin2-'))) })
  after(() => { rmSync(base, { recursive: true, force: true }) })

  // proj/sub/f.txt (INSIDE) and outside/sub/f.txt that is a HARD LINK to the same
  // inode, so a read through the outside tree has the inside file's identity.
  function tree(name) {
    const root = join(base, name, 'proj')
    const outside = join(base, name, 'outside')
    mkdirSync(join(root, 'sub'), { recursive: true })
    mkdirSync(join(outside, 'sub'), { recursive: true })
    writeFileSync(join(root, 'sub', 'f.txt'), 'SAME-OBJECT\n')
    linkSync(join(root, 'sub', 'f.txt'), join(outside, 'sub', 'f.txt'))
    return { root, outside, file: join(root, 'sub', 'f.txt'), parent: join(root, 'sub') }
  }
  const toLinkAndBack = (t, name) => ({
    park: () => { renameSync(t.parent, `${t.parent}.real`); symlinkSync(join(t.outside, 'sub'), t.parent) },
    restore: () => { unlinkSync(t.parent); renameSync(`${t.parent}.real`, t.parent) },
    name,
  })

  it('a directory turned into a link only between the first and second check is refused (async, sync, pinned handle)', { skip: SKIP_NO_SYMLINK || SKIP_WIN_RENAME_UNDER_HANDLE }, async () => {
    // The first pass sees real directories and the file\'s identity (the outside
    // tree holds a hard link to it, so identity matches either way); the swap lands
    // between the passes, and only a second pass can see it.
    for (const kind of ['async', 'sync', 'handle']) {
      const t = tree(`second-${kind}`)
      const sw = toLinkAndBack(t)
      const deps = { betweenChecks: () => sw.park() }
      let out
      if (kind === 'async') out = await readContainedBytes(t.file, t.root, 1024, { deps })
      else if (kind === 'sync') out = readContainedBytesSync(t.file, t.root, 1024, { deps })
      else {
        const fh = await open(t.file, 'r')
        try { out = await readPinnedHandle(fh, t.file, t.root, 1024, deps).catch((e) => (e.code === 'EACCES' ? null : Promise.reject(e))) } finally { await fh.close() }
      }
      assert.equal(out, null, kind)
    }
  })

  it('undisturbed, the same reads succeed (control for the second pass)', async () => {
    const t = tree('control')
    assert.equal((await readContainedBytes(t.file, t.root, 1024)).toString(), 'SAME-OBJECT\n')
    assert.equal(readContainedBytesSync(t.file, t.root, 1024).toString(), 'SAME-OBJECT\n')
  })

  it('with a descriptor-path check the file opened must be the file at the expected path (simulated /proc)', async () => {
    const t = tree('procsim')
    const expectedTarget = join(t.root, 'sub', 'f.txt')
    const agree = { procFd: { available: true, readlink: () => expectedTarget } }
    const disagree = { procFd: { available: true, readlink: () => join(t.outside, 'sub', 'f.txt') } }
    const throws = { procFd: { available: true, readlink: () => { throw new Error('no proc') } } }
    const absent = { procFd: { available: false, readlink: () => { throw new Error('must not be asked') } } }
    assert.equal((await readContainedBytes(t.file, t.root, 1024, { deps: agree })).toString(), 'SAME-OBJECT\n')
    assert.equal(await readContainedBytes(t.file, t.root, 1024, { deps: disagree }), null)
    assert.equal(await readContainedBytes(t.file, t.root, 1024, { deps: throws }), null, 'fails closed when the platform offers the check and it errors')
    assert.equal((await readContainedBytes(t.file, t.root, 1024, { deps: absent })).toString(), 'SAME-OBJECT\n', 'not consulted where the platform has no such primitive')
    assert.equal(readContainedBytesSync(t.file, t.root, 1024, { deps: disagree }), null)
    assert.equal(readContainedBytesSync(t.file, t.root, 1024, { deps: agree }).toString(), 'SAME-OBJECT\n')
  })

  it('on Linux the real /proc check refuses a parent link that was restored before the checks even when identities agree', { skip: process.platform !== 'linux' && `needs /proc/self/fd (Linux); this platform is ${process.platform}` }, async () => {
    const t = tree('proc-real')
    const sw = toLinkAndBack(t)
    const deps = { beforeOpen: () => sw.park(), afterOpen: () => sw.restore() }
    // The descriptor was opened through the link (so it resolved to the outside
    // path), and the hard link makes its identity equal to the inside file's.
    assert.equal(await readContainedBytes(t.file, t.root, 1024, { deps }), null)
    assert.equal(readContainedBytesSync(t.file, t.root, 1024, { deps }), null)
  })

  it('a lexical root (a link spelling, or the unresolved temp directory) reads correctly', { skip: SKIP_NO_SYMLINK }, async () => {
    const t = tree('lexical')
    const spelled = join(base, 'lexical-link')
    symlinkSync(join(base, 'lexical'), spelled)
    const viaLink = join(spelled, 'proj')
    assert.equal((await readContainedBytes(join(viaLink, 'sub', 'f.txt'), viaLink, 1024)).toString(), 'SAME-OBJECT\n')
    assert.equal(readContainedBytesSync(join(viaLink, 'sub', 'f.txt'), viaLink, 1024).toString(), 'SAME-OBJECT\n')
    const raw = mkdtempSync(join(tmpdir(), 'chroxy-lexical-')) // NOT realpath'd: /var vs /private/var on macOS
    try {
      mkdirSync(join(raw, 'd'))
      writeFileSync(join(raw, 'd', 'x.txt'), 'RAW\n')
      assert.equal((await readContainedBytes(join(raw, 'd', 'x.txt'), raw, 1024)).toString(), 'RAW\n')
    } finally { rmSync(raw, { recursive: true, force: true }) }
    void t
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
