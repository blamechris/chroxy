import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
import {
  openNoFollow,
  _openNoFollowImpl,
  defaultOpenNoFollowDeps,
} from '../src/ws-file-ops/open-nofollow.js'

/**
 * #7280 — `O_NOFOLLOW` does not exist on Windows. Node exports it only under
 * `#ifdef O_NOFOLLOW`, so `fsConstants.O_NOFOLLOW` is `undefined` on win32 and
 * `undefined` in a bitwise OR coerces to `0`. Every `open()` that relied on the
 * flag to refuse a symlink opened the symlink's TARGET instead — silently, with
 * no error and no log line, while the surrounding comments asserted a
 * protection that was not there. The ELOOP branch became unreachable, so every
 * symlink-refusal test PASSED on Windows by never reaching the branch it meant
 * to test (docs/false-safety-guards.md — success and not-checking were the same
 * observable outcome).
 *
 * Three groups here, and each exists to be able to go red:
 *
 *  1. POSIX flag guard — the real constant exists AND the helper's default deps
 *     carry it AND the POSIX branch ORs it into the flags it hands `open`.
 *     Dropping `O_NOFOLLOW` from the POSIX branch reds this.
 *  2. Forced-win32 semantics — the win32 branch is exercised on EVERY platform
 *     by injecting deps, so macOS/Linux CI proves the Windows code path. The
 *     symlink-PLANTING cases are gated on `SKIP_NO_SYMLINK` (the Windows CI
 *     account has no symlink privilege), and the injected-lstat cases need no
 *     symlink at all, so the Windows runner still exercises the branch.
 *  3. Source sweep — no `open()` in reader.js / memory.js may pass O_NOFOLLOW
 *     itself; every one goes through the single helper. Leaving one site
 *     unconverted reds this.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SRC = join(HERE, '..', 'src', 'ws-file-ops')
const readerSrc = readFileSync(join(SRC, 'reader.js'), 'utf-8')
const memorySrc = readFileSync(join(SRC, 'memory.js'), 'utf-8')

/** A sentinel "O_NOFOLLOW" so the flag-OR assertion works on win32 too. */
const SENTINEL_NOFOLLOW = 0x4000000

/** Minimal FileHandle stand-in: records whether it was closed. */
function fakeHandle(statResult) {
  return {
    closed: false,
    async close() { this.closed = true },
    async stat() { return statResult },
  }
}

function statLike({ dev = 7n, ino = 42n, symlink = false } = {}) {
  return { dev, ino, isSymbolicLink: () => symlink }
}

describe('#7280 openNoFollow — POSIX branch keeps O_NOFOLLOW', () => {
  it('O_NOFOLLOW is a real constant on this platform', { skip: process.platform === 'win32' ? 'win32 does not define O_NOFOLLOW — that is the bug this file exists for' : false }, () => {
    assert.notEqual(fsConstants.O_NOFOLLOW, undefined,
      'fsConstants.O_NOFOLLOW is undefined on a non-win32 platform — the guard would silently no-op')
    assert.equal(typeof fsConstants.O_NOFOLLOW, 'number')
    assert.notEqual(fsConstants.O_NOFOLLOW, 0,
      'O_NOFOLLOW is 0 — ORing it contributes nothing')
  })

  it('the default deps carry the REAL O_NOFOLLOW on a non-win32 platform', { skip: process.platform === 'win32' ? 'win32 has no O_NOFOLLOW to carry' : false }, () => {
    assert.equal(defaultOpenNoFollowDeps.hasONoFollow, true)
    assert.equal(defaultOpenNoFollowDeps.oNofollow, fsConstants.O_NOFOLLOW)
  })

  it('the POSIX branch ORs O_NOFOLLOW into the flags it passes to open', async () => {
    const calls = []
    const fh = fakeHandle(statLike())
    const got = await _openNoFollowImpl('/some/path', fsConstants.O_RDONLY, undefined, {
      hasONoFollow: true,
      oNofollow: SENTINEL_NOFOLLOW,
      platform: 'linux',
      open: async (p, flags, mode) => { calls.push({ p, flags, mode }); return fh },
      lstat: async () => { throw new Error('lstat must not be used on the POSIX branch') },
      fstat: async () => { throw new Error('fstat must not be used on the POSIX branch') },
    })
    assert.equal(got, fh)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].flags & SENTINEL_NOFOLLOW, SENTINEL_NOFOLLOW,
      'the POSIX branch dropped O_NOFOLLOW from the flags — the guard is a no-op')
    assert.equal(calls[0].flags, fsConstants.O_RDONLY | SENTINEL_NOFOLLOW)
  })

  it('the POSIX branch passes mode through unchanged', async () => {
    const calls = []
    await _openNoFollowImpl('/some/path', fsConstants.O_WRONLY, 0o666, {
      hasONoFollow: true,
      oNofollow: SENTINEL_NOFOLLOW,
      platform: 'linux',
      open: async (p, flags, mode) => { calls.push({ p, flags, mode }); return fakeHandle(statLike()) },
      lstat: async () => { throw new Error('unused') },
      fstat: async () => { throw new Error('unused') },
    })
    assert.equal(calls[0].mode, 0o666)
  })

  it('refuses a planted symlink with ELOOP through the REAL helper', { skip: process.platform === 'win32' ? 'covered by the forced-win32 cases below' : SKIP_NO_SYMLINK }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-nofollow-posix-'))
    try {
      const target = join(dir, 'secret.txt')
      await writeFile(target, 'SECRET')
      const link = join(dir, 'link.txt')
      await symlink(target, link)
      await assert.rejects(
        () => openNoFollow(link, fsConstants.O_RDONLY),
        (err) => err.code === 'ELOOP'
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('opens a regular file through the REAL helper (positive control)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-nofollow-ok-'))
    try {
      const target = join(dir, 'plain.txt')
      await writeFile(target, 'PLAIN')
      const fh = await openNoFollow(target, fsConstants.O_RDONLY)
      try {
        assert.equal((await fh.readFile()).toString('utf-8'), 'PLAIN')
      } finally {
        await fh.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('#7280 openNoFollow — forced win32 branch (runs on every platform)', () => {
  /** Real fs deps, but with the O_NOFOLLOW constant forcibly absent. */
  const forcedWin32 = {
    ...defaultOpenNoFollowDeps,
    hasONoFollow: false,
    oNofollow: undefined,
    platform: 'win32',
  }

  it('refuses a symlink reported by lstat, WITHOUT ever calling open (no symlink fixture needed)', async () => {
    let opened = 0
    await assert.rejects(
      () => _openNoFollowImpl('C:\\ws\\link.txt', fsConstants.O_RDONLY, undefined, {
        hasONoFollow: false,
        oNofollow: undefined,
        platform: 'win32',
        lstat: async () => statLike({ symlink: true }),
        open: async () => { opened++; return fakeHandle(statLike()) },
        fstat: async (fh) => fh.stat(),
      }),
      (err) => err.code === 'ELOOP'
    )
    assert.equal(opened, 0, 'the win32 branch opened the symlink it had already identified')
  })

  it('refuses a REAL planted symlink and does not open the target', { skip: SKIP_NO_SYMLINK }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-nofollow-win-'))
    try {
      const target = join(dir, 'secret.txt')
      await writeFile(target, 'SECRET')
      const link = join(dir, 'link.txt')
      await symlink(target, link)
      await assert.rejects(
        () => _openNoFollowImpl(link, fsConstants.O_RDONLY, undefined, forcedWin32),
        (err) => err.code === 'ELOOP'
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('opens a REAL regular file and runs the fd-identity check (positive control)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-nofollow-win-ok-'))
    try {
      const target = join(dir, 'plain.txt')
      await writeFile(target, 'PLAIN')
      let fstatCalls = 0
      let lstatCalls = 0
      const fh = await _openNoFollowImpl(target, fsConstants.O_RDONLY, undefined, {
        ...forcedWin32,
        lstat: async (...args) => { lstatCalls++; return defaultOpenNoFollowDeps.lstat(...args) },
        fstat: async (...args) => { fstatCalls++; return defaultOpenNoFollowDeps.fstat(...args) },
      })
      try {
        assert.equal((await fh.readFile()).toString('utf-8'), 'PLAIN',
          'the win32 branch must return a usable file handle for a regular file')
      } finally {
        await fh.close()
      }
      assert.equal(fstatCalls, 1, 'the post-open fd-identity check did not run')
      assert.equal(lstatCalls, 2, 'the win32 branch must lstat BEFORE the open and again AFTER it')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses with ELOOP when the fd identity does not match the path after open (TOCTOU swap)', async () => {
    const fh = fakeHandle(statLike({ ino: 999n }))
    let lstatCalls = 0
    await assert.rejects(
      () => _openNoFollowImpl('C:\\ws\\swapped.txt', fsConstants.O_RDONLY, undefined, {
        hasONoFollow: false,
        oNofollow: undefined,
        platform: 'win32',
        // First lstat: an innocent regular file. Second (post-open): still a
        // regular file, but a DIFFERENT one — the swap the check exists for.
        lstat: async () => { lstatCalls++; return statLike({ ino: lstatCalls === 1 ? 999n : 1234n }) },
        open: async () => fh,
        fstat: async (h) => h.stat(),
      }),
      (err) => err.code === 'ELOOP'
    )
    assert.equal(fh.closed, true, 'the refused file handle was leaked instead of closed')
  })

  it('refuses with ELOOP when a symlink appears at the path after the open', async () => {
    const fh = fakeHandle(statLike())
    let lstatCalls = 0
    await assert.rejects(
      () => _openNoFollowImpl('C:\\ws\\raced.txt', fsConstants.O_RDONLY, undefined, {
        hasONoFollow: false,
        oNofollow: undefined,
        platform: 'win32',
        lstat: async () => { lstatCalls++; return statLike({ symlink: lstatCalls !== 1 }) },
        open: async () => fh,
        fstat: async (h) => h.stat(),
      }),
      (err) => err.code === 'ELOOP'
    )
    assert.equal(fh.closed, true)
  })

  it('refuses with ELOOP when the post-open lstat fails (fail-closed, cannot verify)', async () => {
    const fh = fakeHandle(statLike())
    let lstatCalls = 0
    await assert.rejects(
      () => _openNoFollowImpl('C:\\ws\\vanished.txt', fsConstants.O_RDONLY, undefined, {
        hasONoFollow: false,
        oNofollow: undefined,
        platform: 'win32',
        lstat: async () => {
          lstatCalls++
          if (lstatCalls === 1) return statLike()
          throw Object.assign(new Error('gone'), { code: 'ENOENT' })
        },
        open: async () => fh,
        fstat: async (h) => h.stat(),
      }),
      (err) => err.code === 'ELOOP'
    )
    assert.equal(fh.closed, true)
  })

  it('refuses with ELOOP when the inode is 0 (identity check would be vacuous)', async () => {
    const fh = fakeHandle(statLike({ ino: 0n }))
    await assert.rejects(
      () => _openNoFollowImpl('C:\\ws\\noindex.txt', fsConstants.O_RDONLY, undefined, {
        hasONoFollow: false,
        oNofollow: undefined,
        platform: 'win32',
        lstat: async () => statLike({ ino: 0n }),
        open: async () => fh,
        fstat: async (h) => h.stat(),
      }),
      (err) => err.code === 'ELOOP'
    )
    assert.equal(fh.closed, true)
  })

  it('proceeds to open when the pre-open lstat reports ENOENT and O_CREAT is set', async () => {
    const fh = fakeHandle(statLike())
    let opened = 0
    let lstatCalls = 0
    const got = await _openNoFollowImpl('C:\\ws\\new.txt', fsConstants.O_WRONLY | fsConstants.O_CREAT, 0o666, {
      hasONoFollow: false,
      oNofollow: undefined,
      platform: 'win32',
      lstat: async () => {
        lstatCalls++
        if (lstatCalls === 1) throw Object.assign(new Error('nope'), { code: 'ENOENT' })
        return statLike()
      },
      open: async () => { opened++; return fh },
      fstat: async (h) => h.stat(),
    })
    assert.equal(got, fh)
    assert.equal(opened, 1)
  })

  it('does NOT swallow a pre-open lstat failure that is not ENOENT (fail-closed)', async () => {
    let opened = 0
    await assert.rejects(
      () => _openNoFollowImpl('C:\\ws\\denied.txt', fsConstants.O_RDONLY, undefined, {
        hasONoFollow: false,
        oNofollow: undefined,
        platform: 'win32',
        lstat: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) },
        open: async () => { opened++; return fakeHandle(statLike()) },
        fstat: async (h) => h.stat(),
      }),
      (err) => err.code === 'EACCES'
    )
    assert.equal(opened, 0)
  })

  it('REFUSES rather than falling back to a plain open on an unexpected platform', async () => {
    let opened = 0
    await assert.rejects(
      () => _openNoFollowImpl('/some/path', fsConstants.O_RDONLY, undefined, {
        hasONoFollow: false,
        oNofollow: undefined,
        platform: 'sunos',
        lstat: async () => statLike(),
        open: async () => { opened++; return fakeHandle(statLike()) },
        fstat: async (h) => h.stat(),
      }),
      (err) => err.code === 'ENOSYS' && /O_NOFOLLOW/.test(err.message)
    )
    assert.equal(opened, 0, 'an unexpected platform must be a refusal, never a silent plain open')
  })
})

describe('#7280 source sweep — every O_NOFOLLOW open goes through the one helper', () => {
  // Collapsed to a boolean before asserting (CLAUDE.md "Collapse to a boolean
  // before asserting against file text"): a failing assert.match against a
  // multi-KB source slice carries the whole file as `actual` and has wedged the
  // runner (#7340, false-safety entry 17).
  const files = [
    { name: 'ws-file-ops/reader.js', src: readerSrc, calls: 5 },
    { name: 'ws-file-ops/memory.js', src: memorySrc, calls: 1 },
  ]

  for (const { name, src, calls } of files) {
    it(`${name} never passes O_NOFOLLOW to open() itself`, () => {
      assert.ok(!/fsConstants\.O_NOFOLLOW/.test(src),
        `${name} still references fsConstants.O_NOFOLLOW directly — on win32 that term is undefined and ORs to 0, so the symlink guard silently no-ops (#7280). Route the open through openNoFollow().`)
    })

    it(`${name} does not import a raw open from fs/promises`, () => {
      const importLine = src.match(/^import\s+\{([^}]*)\}\s+from\s+'(?:node:)?fs\/promises'/m)
      assert.ok(importLine, `${name}: could not find the fs/promises import to inspect`)
      const named = importLine[1].split(',').map((s) => s.trim())
      assert.ok(!named.includes('open'),
        `${name} imports \`open\` from fs/promises — a raw open here cannot refuse a symlink on win32 (#7280). Use openNoFollow().`)
    })

    it(`${name} imports and calls openNoFollow ${calls}x`, () => {
      assert.ok(/import\s+\{[^}]*\bopenNoFollow\b[^}]*\}\s+from\s+'\.\/open-nofollow\.js'/.test(src),
        `${name} does not import openNoFollow from ./open-nofollow.js`)
      const found = (src.match(/\bopenNoFollow\(/g) || []).length
      assert.equal(found, calls,
        `${name} calls openNoFollow() ${found}x, expected ${calls}. A new open site was added without the helper, or a site was removed — re-derive the count.`)
    })
  }
})
