import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as realFs from 'node:fs'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBoundedFile, readBoundedJson, SMALL_FILE_CAP } from '../src/utils/small-file.js'
import { isIso, parseRequest, parsePostpone, isRequestFresh, REQUEST_TTL_MS } from '../src/utils/deploy-control-files.js'

// #8331 — the shared reader and the shared parsing rules.

const dirs = []
const mkDir = () => { const d = mkdtempSync(join(tmpdir(), 'chroxy-smallfile-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('readBoundedFile accumulates reads until EOF (a short read is legal)', () => {
  it('a file returned 8 bytes at a time is read completely', () => {
    const dir = mkDir()
    const f = join(dir, 'x.json')
    const body = JSON.stringify({ rollbackTo: A, failedTarget: B })
    writeFileSync(f, body)
    const fs = { ...realFs, readSync: (fd, buf, off, len, pos) => realFs.readSync(fd, buf, off, Math.min(len, 8), pos) }
    assert.deepEqual(readBoundedFile(f, { fs }), { state: 'ok', raw: body })
    assert.deepEqual(readBoundedJson(f, { fs }).value, { rollbackTo: A, failedTarget: B })
  })

  it('an oversized file split across reads is still refused, and never read past cap + 1 bytes', () => {
    const dir = mkDir()
    const f = join(dir, 'big.json')
    writeFileSync(f, '{}' + ' '.repeat(SMALL_FILE_CAP * 3))
    let total = 0
    const fs = { ...realFs, readSync: (fd, buf, off, len, pos) => { const n = realFs.readSync(fd, buf, off, Math.min(len, 1000), pos); total += n; return n } }
    assert.equal(readBoundedFile(f, { fs }).state, 'bad')
    assert.ok(total <= SMALL_FILE_CAP + 1, `read ${total} bytes`)
  })

  it('exactly the cap is accepted', () => {
    const dir = mkDir()
    const f = join(dir, 'cap.json')
    writeFileSync(f, '{}' + ' '.repeat(SMALL_FILE_CAP - 2))
    assert.equal(readBoundedFile(f).state, 'ok')
  })

  it('an I/O error on the read is an ERROR state, not corrupt content', () => {
    const dir = mkDir()
    const f = join(dir, 'x.json')
    writeFileSync(f, '{"a":1}')
    const fs = { ...realFs, readSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) } }
    const r = readBoundedJson(f, { fs })
    assert.equal(r.state, 'error')
    assert.equal(r.reason, 'EIO')
    // ... and so is an open that fails for a reason other than absence or a symlink.
    const fs2 = { ...realFs, openSync: () => { throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' }) } }
    assert.equal(readBoundedFile(f, { fs: fs2 }).state, 'error')
  })

  it('absent is none; unparseable content is bad (a different thing from an error)', () => {
    const dir = mkDir()
    assert.equal(readBoundedFile(join(dir, 'nope.json')).state, 'none')
    writeFileSync(join(dir, 'junk.json'), 'not json')
    assert.equal(readBoundedJson(join(dir, 'junk.json')).state, 'bad')
  })
})

describe('the win32 path (no O_NOFOLLOW) proves the opened fd is the file at the path', () => {
  const win = (fs, file) => readBoundedFile(file, { fs, platform: 'win32', hasONoFollow: false })
  const fake = (real, over) => Object.assign(Object.create(real), over)

  it('an ordinary file reads fine through the win32 path', () => {
    const dir = mkDir()
    const f = join(dir, 'x.json')
    writeFileSync(f, '{"a":1}')
    assert.equal(win(realFs, f).state, 'ok')
  })

  it('a symlink already planted is refused before the open', { skip: process.platform === 'win32' }, () => {
    const dir = mkDir()
    writeFileSync(join(dir, 'real.json'), '{"a":1}')
    symlinkSync(join(dir, 'real.json'), join(dir, 'link.json'))
    assert.equal(win(realFs, join(dir, 'link.json')).state, 'bad')
  })

  it('a symlink swapped in BETWEEN the pre-check and the open is refused (fresh lstat after the open)', () => {
    const dir = mkDir()
    const f = join(dir, 'x.json')
    writeFileSync(f, '{"a":1}')
    let calls = 0
    const fs = fake(realFs, {
      lstatSync: (p, o) => {
        const st = realFs.lstatSync(p, o)
        // 1st call: the pre-open check sees a regular file. 2nd: the post-open check sees a symlink.
        return ++calls === 1 ? st : Object.create(st, { isSymbolicLink: { value: () => true } })
      },
    })
    assert.equal(win(fs, f).state, 'bad')
    assert.equal(calls, 2)
  })

  it('a different file at the path than the one opened is refused (device/inode mismatch)', () => {
    const dir = mkDir()
    const f = join(dir, 'x.json')
    writeFileSync(f, '{"a":1}')
    const fs = fake(realFs, {
      lstatSync: (p, o) => {
        const st = realFs.lstatSync(p, o)
        return Object.create(st, { ino: { value: st.ino + 1n } })
      },
    })
    assert.equal(win(fs, f).state, 'bad')
  })

  it('identity that cannot be established (file index 0) is refused, not waved through', () => {
    const dir = mkDir()
    const f = join(dir, 'x.json')
    writeFileSync(f, '{"a":1}')
    const zero = (st) => Object.create(st, { ino: { value: 0n } })
    const fs = fake(realFs, { lstatSync: (p, o) => zero(realFs.lstatSync(p, o)), fstatSync: (fd, o) => zero(realFs.fstatSync(fd, o)) })
    assert.equal(win(fs, f).state, 'bad')
  })

  it('a path that vanishes after the open is refused', () => {
    const dir = mkDir()
    const f = join(dir, 'x.json')
    writeFileSync(f, '{"a":1}')
    let calls = 0
    const fs = fake(realFs, { lstatSync: (p, o) => { if (++calls === 2) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return realFs.lstatSync(p, o) } })
    assert.equal(win(fs, f).state, 'bad')
  })

  it('a missing file is still just absent', () => {
    assert.equal(win(realFs, join(mkDir(), 'nope.json')).state, 'none')
  })
})

describe('the one copy of the parsing rules', () => {
  const req = (o = {}) => ({ action: 'restart-now', target: B, force: true, requestedAt: '2026-10-07T12:00:00.000Z', nonce: 'n1', ...o })

  it('isIso accepts 1970-9999 and refuses everything else, including the extended-year form', () => {
    for (const ok of ['2026-10-07T12:00:00.000Z', '1970-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z']) assert.equal(isIso(ok), true, ok)
    for (const bad of ['+275760-09-13T00:00:00.000Z', '0001-01-01T00:00:00.000Z', '1969-12-31T23:59:59.999Z', '-000001-01-01T00:00:00.000Z', 'yesterday', 12, null, 'x'.repeat(50)]) assert.equal(isIso(bad), false, String(bad))
  })

  it('parseRequest needs the whole shape and normalises the target', () => {
    assert.equal(parseRequest(req({ target: B.toUpperCase() })).target, B)
    for (const bad of [req({ action: 'x' }), req({ target: 'nope' }), req({ force: 'yes' }), req({ requestedAt: 'x' }), req({ nonce: 'a b' }), req({ nonce: '' }), null, []]) assert.equal(parseRequest(bad), null)
  })

  it('requests are fresh for the TTL and not from the future', () => {
    const now = Date.parse('2026-10-07T12:00:00.000Z')
    const r = (min) => parseRequest(req({ requestedAt: new Date(now - min * 60e3).toISOString() }))
    assert.equal(isRequestFresh(r(19), now), true)
    assert.equal(isRequestFresh(r(21), now), false)
    assert.equal(isRequestFresh(r(-0.5), now), true)
    assert.equal(isRequestFresh(r(-2), now), false)
    assert.equal(REQUEST_TTL_MS, 20 * 60e3)
  })

  it('parsePostpone enforces the bounds', () => {
    const now = Date.parse('2026-10-07T12:00:00.000Z')
    const p = (o) => parsePostpone({ target: B, until: new Date(now + 3600e3).toISOString(), requestedAt: new Date(now).toISOString(), ...o }, now)
    assert.notEqual(p({}), null)
    assert.equal(p({ until: '9999-12-31T00:00:00.000Z' }), null)
    assert.equal(p({ requestedAt: undefined }), null)
    assert.equal(p({ requestedAt: new Date(now + 6 * 60e3).toISOString() }), null)
  })
})
