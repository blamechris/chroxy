import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
import {
  openNoFollow,
  _openNoFollowImpl,
  defaultOpenNoFollowDeps,
  NO_FILE_INDEX,
} from '../src/ws-file-ops/open-nofollow.js'
import { addLogListener, removeLogListener } from '../src/logger.js'

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

/** The real O_NONBLOCK value on this platform (0 — a no-op OR — on win32). */
const REAL_O_NONBLOCK = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0

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
    assert.equal(calls[0].flags, fsConstants.O_RDONLY | SENTINEL_NOFOLLOW | REAL_O_NONBLOCK)
  })

  // #7938 — a planted FIFO with no O_NONBLOCK hangs the open() itself,
  // forever, before ANY post-open isFile() refusal can run. This is the
  // exact defect class that hit claude-hooks resolveIngestSecret (#7923),
  // trusted-file-read.js's credential-store read (#7924), and claude-tui's
  // _hookReadFile (#7926) — three independent sites, one hang each, all
  // caught only by adversarial review. openNoFollow is the ONE place that
  // fix now lives, so every caller inherits it.
  it('the POSIX branch ORs O_NONBLOCK into the flags it passes to open', { skip: process.platform === 'win32' ? 'covered by the forced-win32 cases below' : false }, async () => {
    assert.notEqual(fsConstants.O_NONBLOCK, undefined,
      'fsConstants.O_NONBLOCK is undefined on a non-win32 platform — the guard would silently no-op')
    const calls = []
    const fh = fakeHandle(statLike())
    await _openNoFollowImpl('/some/path', fsConstants.O_RDONLY, undefined, {
      hasONoFollow: true,
      oNofollow: SENTINEL_NOFOLLOW,
      platform: 'linux',
      open: async (p, flags, mode) => { calls.push({ p, flags, mode }); return fh },
      lstat: async () => { throw new Error('lstat must not be used on the POSIX branch') },
      fstat: async () => { throw new Error('fstat must not be used on the POSIX branch') },
    })
    assert.equal(calls[0].flags & fsConstants.O_NONBLOCK, fsConstants.O_NONBLOCK,
      'the POSIX branch dropped O_NONBLOCK from the flags — a planted FIFO with no writer would hang open() forever (#7938)')
  })

  it('a real FIFO planted where a regular file is expected does not hang openNoFollow (#7938)', { skip: process.platform === 'win32' ? 'no mkfifo on win32' : false }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-nofollow-fifo-'))
    try {
      const fifoPath = join(dir, 'evil.fifo')
      execFileSync('mkfifo', [fifoPath])
      // #7041: generous, because all this must separate is "returned" from
      // "blocked forever" (a regression blocks indefinitely), not time the call.
      const HANG_GUARD_MS = 15_000
      const result = await Promise.race([
        openNoFollow(fifoPath, fsConstants.O_RDONLY).then(
          (fh) => ({ outcome: 'resolved', fh }),
          (err) => ({ outcome: 'rejected', err }),
        ),
        new Promise((resolve) => setTimeout(() => resolve({ outcome: 'hung' }), HANG_GUARD_MS).unref()),
      ])
      assert.notEqual(result.outcome, 'hung',
        `openNoFollow blocked for >= ${HANG_GUARD_MS}ms opening a planted FIFO — the underlying open() needs O_NONBLOCK (#7938)`)
      // O_NONBLOCK makes the OPEN return; it is the caller's job to then
      // refuse a non-regular file via fstat before reading (see reader.js /
      // memory.js's post-open isFile() checks) — openNoFollow itself has no
      // opinion on file type, only on symlinks and (now) blocking.
      if (result.outcome === 'resolved') {
        await result.fh.close().catch(() => {})
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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

/**
 * #7284 — `open(O_WRONLY | O_TRUNC)` fails EINVAL on Windows (measured on the
 * chroxy-win host, with and without O_NOFOLLOW). The win32 branch therefore
 * never hands O_TRUNC to `open`: it opens WITHOUT it (an existing-file-only
 * open, so it still never creates), runs the fd-identity check, and only then
 * truncates THROUGH THE VERIFIED HANDLE. These cases force that branch on every
 * platform; the injected `open` throws the Windows EINVAL for any O_TRUNC it is
 * handed, so a regression reds here rather than only on the Windows runner.
 */
describe('#7284 openNoFollow — win32 truncates through the verified handle, never via O_TRUNC', () => {
  const O_TRUNC = fsConstants.O_TRUNC
  const WRITE_TRUNC = fsConstants.O_WRONLY | O_TRUNC

  const winEinval = () => Object.assign(new Error('EINVAL: invalid argument, open'), { code: 'EINVAL' })

  /** Real fs, forced onto the win32 branch, with Windows' O_TRUNC rejection. */
  function windowsLikeDeps(events) {
    return {
      ...defaultOpenNoFollowDeps,
      hasONoFollow: false,
      oNofollow: undefined,
      platform: 'win32',
      open: async (p, flags, mode) => {
        events?.push('open')
        if (flags & O_TRUNC && !(flags & fsConstants.O_CREAT)) throw winEinval()
        return defaultOpenNoFollowDeps.open(p, flags, mode)
      },
      fstat: async (fh) => { events?.push('fstat'); return defaultOpenNoFollowDeps.fstat(fh) },
    }
  }

  it('overwrites an existing file: content replaced, not appended, no O_TRUNC reaches open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-nofollow-trunc-'))
    try {
      const target = join(dir, 'overwrite.txt')
      await writeFile(target, 'a much longer original body')
      const fh = await _openNoFollowImpl(target, WRITE_TRUNC, 0o666, windowsLikeDeps())
      try { await fh.writeFile(Buffer.from('short')) } finally { await fh.close() }
      assert.equal(readFileSync(target, 'utf-8'), 'short')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not CREATE: a missing file is still ENOENT and nothing appears on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-nofollow-trunc-'))
    try {
      const target = join(dir, 'missing.txt')
      await assert.rejects(
        () => _openNoFollowImpl(target, WRITE_TRUNC, 0o666, windowsLikeDeps()),
        (err) => err.code === 'ENOENT'
      )
      assert.throws(() => readFileSync(target), (err) => err.code === 'ENOENT',
        'the overwrite path created a file it must only ever overwrite')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('truncates only AFTER the identity check, on the handle it verified', async () => {
    const events = []
    const fh = {
      ...fakeHandle(statLike()),
      async truncate(len) { events.push(`truncate(${len})`) },
    }
    const got = await _openNoFollowImpl('C:\\ws\\f.txt', WRITE_TRUNC, 0o666, {
      hasONoFollow: false,
      oNofollow: undefined,
      platform: 'win32',
      lstat: async () => { events.push('lstat'); return statLike() },
      open: async (p, flags) => { events.push(`open:${(flags & O_TRUNC) ? 'O_TRUNC' : 'plain'}`); return fh },
      fstat: async (h) => { events.push('fstat'); return h.stat() },
    })
    assert.equal(got, fh)
    assert.deepEqual(events.filter((e) => e !== 'lstat' && e !== 'fstat'), ['open:plain', 'truncate(0)'])
    assert.ok(events.lastIndexOf('fstat') < events.indexOf('truncate(0)'),
      'truncate ran before the fd-identity check finished')
  })

  it('a refused identity check truncates NOTHING (the swapped-in file keeps its content)', async () => {
    let truncated = 0
    const fh = {
      ...fakeHandle(statLike({ ino: 999n })),
      async truncate() { truncated++ },
    }
    let lstatCalls = 0
    await assert.rejects(
      () => _openNoFollowImpl('C:\\ws\\swapped.txt', WRITE_TRUNC, 0o666, {
        hasONoFollow: false,
        oNofollow: undefined,
        platform: 'win32',
        lstat: async () => { lstatCalls++; return statLike({ ino: lstatCalls === 1 ? 999n : 1234n }) },
        open: async () => fh,
        fstat: async (h) => h.stat(),
      }),
      (err) => err.code === 'ELOOP'
    )
    assert.equal(truncated, 0, 'the file was truncated before the open was proven to be the right file')
    assert.equal(fh.closed, true)
  })

  it('a truncate that fails closes the handle and surfaces the error', async () => {
    const fh = {
      ...fakeHandle(statLike()),
      async truncate() { throw Object.assign(new Error('locked'), { code: 'EBUSY' }) },
    }
    await assert.rejects(
      () => _openNoFollowImpl('C:\\ws\\locked.txt', WRITE_TRUNC, 0o666, {
        hasONoFollow: false,
        oNofollow: undefined,
        platform: 'win32',
        lstat: async () => statLike(),
        open: async () => fh,
        fstat: async (h) => h.stat(),
      }),
      (err) => err.code === 'EBUSY'
    )
    assert.equal(fh.closed, true, 'a handle whose truncate failed was leaked')
  })

  it('a read-only open never calls truncate', async () => {
    const fh = { ...fakeHandle(statLike()), async truncate() { throw new Error('truncate must not run') } }
    await _openNoFollowImpl('C:\\ws\\r.txt', fsConstants.O_RDONLY, undefined, {
      hasONoFollow: false,
      oNofollow: undefined,
      platform: 'win32',
      lstat: async () => statLike(),
      open: async () => fh,
      fstat: async (h) => h.stat(),
    })
  })

  it('the POSIX branch is unchanged: O_TRUNC goes to open, and truncate is never called', async () => {
    const calls = []
    const fh = { ...fakeHandle(statLike()), async truncate() { throw new Error('truncate must not run on POSIX') } }
    await _openNoFollowImpl('/some/path', WRITE_TRUNC, 0o666, {
      hasONoFollow: true,
      oNofollow: SENTINEL_NOFOLLOW,
      platform: 'linux',
      open: async (p, flags, mode) => { calls.push({ flags, mode }); return fh },
      lstat: async () => { throw new Error('lstat must not be used on the POSIX branch') },
      fstat: async () => { throw new Error('fstat must not be used on the POSIX branch') },
    })
    assert.equal(calls[0].flags, WRITE_TRUNC | SENTINEL_NOFOLLOW | REAL_O_NONBLOCK)
    assert.equal(calls[0].mode, 0o666)
  })
})

/** A log sink that records every call, for the #7874 assertions. */
function recordingLog() {
  const calls = []
  const rec = (level) => (msg) => { calls.push({ level, msg }) }
  return { calls, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }
}

/**
 * The injected win32 deps for one step-3 outcome. `pre` is the pre-open lstat,
 * `post` the post-open lstat, `onFd` the fstat of the opened handle.
 */
function win32Deps({ pre = statLike(), post = statLike(), onFd = statLike(), postThrows = null, log } = {}) {
  const fh = fakeHandle(onFd)
  let lstatCalls = 0
  const deps = {
    hasONoFollow: false,
    oNofollow: undefined,
    platform: 'win32',
    lstat: async () => {
      lstatCalls++
      if (lstatCalls === 1) return pre
      if (postThrows) throw postThrows
      return post
    },
    open: async () => fh,
    fstat: async (h) => h.stat(),
  }
  if (log) deps.log = log
  return { deps, fh }
}

describe('#7874 openNoFollow — a volume reporting file index 0 is refused, and SAYS so', () => {
  // Policy (owner decision, 2026-09-26): keep the hard refusal, with a log line
  // that names the index-0 cause so the refusal cannot be mistaken for a
  // symlink. The wire code stays ELOOP. These run on every platform through
  // injected deps: no CI runner has an index-less volume to test against.
  for (const [label, fdIno, pathIno] of [
    ['the fd', 0n, 42n],
    ['the path', 42n, 0n],
    ['both', 0n, 0n],
  ]) {
    it(`index 0 on ${label}: ELOOP on the wire, reason 'no-file-index', ONE warn naming the cause and the path`, async () => {
      const log = recordingLog()
      const { deps, fh } = win32Deps({
        pre: statLike({ ino: pathIno }),
        post: statLike({ ino: pathIno, dev: 9n }),
        onFd: statLike({ ino: fdIno, dev: 9n }),
        log,
      })
      let caught = null
      await _openNoFollowImpl('C:\\ws\\noindex.txt', fsConstants.O_RDONLY, undefined, deps).catch((e) => { caught = e })
      assert.ok(caught, 'the open was not refused')
      assert.equal(caught.code, 'ELOOP', 'the wire contract changed; every caller keys on ELOOP')
      assert.equal(caught.reason, NO_FILE_INDEX)
      assert.equal(fh.closed, true, 'the refused handle was leaked')
      assert.equal(log.calls.length, 1, `expected exactly one log call, got ${log.calls.length}`)
      const [{ level, msg }] = log.calls
      assert.equal(level, 'warn')
      assert.ok(msg.includes('C:\\ws\\noindex.txt'), 'the line does not name the path')
      assert.ok(msg.includes('file index 0'), 'the line does not name the cause')
      assert.ok(msg.includes('No symlink was seen'), 'the line does not say no symlink was seen')
      assert.ok(msg.includes('dev=9'), 'the line does not name the volume')
    })
  }

  // Distinguishable means the OTHER refusals do not emit this line. If every
  // refusal logged it (say, from inside `eloop()`), the log would say "file
  // index 0" for a real symlink and mislead the reader the other way.
  for (const [label, opts] of [
    ['a symlink before open', { pre: statLike({ symlink: true }) }],
    ['a symlink after open', { post: statLike({ symlink: true }) }],
    ['an identity mismatch', { post: statLike({ ino: 43n }) }],
    ['a failed post-open lstat', { postThrows: Object.assign(new Error('gone'), { code: 'ENOENT' }) }],
    // One side reports index 0, but the two stats are on DIFFERENT volumes:
    // that proves a swap, and must not be logged as an index-less volume
    // ("no symlink was seen, use NTFS") when it may be a live race.
    ['index 0 on one side across two volumes', { post: statLike({ ino: 42n, dev: 10n }), onFd: statLike({ ino: 0n, dev: 9n }) }],
  ]) {
    it(`${label} is refused WITHOUT the index-0 line or reason`, async () => {
      const log = recordingLog()
      const { deps } = win32Deps({ ...opts, log })
      let caught = null
      await _openNoFollowImpl('C:\\ws\\other.txt', fsConstants.O_RDONLY, undefined, deps).catch((e) => { caught = e })
      assert.ok(caught, 'the open was not refused')
      assert.equal(caught.code, 'ELOOP')
      assert.equal(caught.reason, undefined)
      assert.equal(log.calls.length, 0, `unexpected log line: ${log.calls.map((c) => c.msg).join(' | ')}`)
    })
  }

  it('a log sink that THROWS does not change the refusal: still ELOOP, still no-file-index, handle closed', async () => {
    const throwing = { debug() {}, info() {}, error() {}, warn() { throw new Error('sink exploded') } }
    const { deps, fh } = win32Deps({ post: statLike({ ino: 0n }), onFd: statLike({ ino: 0n }), log: throwing })
    let caught = null
    await _openNoFollowImpl('C:\\ws\\bad-sink.txt', fsConstants.O_RDONLY, undefined, deps).catch((e) => { caught = e })
    assert.ok(caught, 'the open was not refused')
    assert.equal(caught.code, 'ELOOP')
    assert.equal(caught.reason, NO_FILE_INDEX, `the sink's throw replaced the refusal: ${caught.message}`)
    assert.equal(fh.closed, true)
  })

  it('with no injected log (the production shape), the line reaches the REAL logger', async () => {
    const entries = []
    const listener = (e) => { entries.push(e) }
    addLogListener(listener)
    try {
      const { deps } = win32Deps({ post: statLike({ ino: 0n }), onFd: statLike({ ino: 0n }) })
      assert.equal('log' in deps, false)
      await assert.rejects(
        () => _openNoFollowImpl('C:\\ws\\real-sink.txt', fsConstants.O_RDONLY, undefined, deps),
        (err) => err.code === 'ELOOP' && err.reason === NO_FILE_INDEX
      )
    } finally {
      removeLogListener(listener)
    }
    const mine = entries.filter((e) => e.message.includes('C:\\ws\\real-sink.txt'))
    assert.equal(mine.length, 1, `expected one real log entry for the path, got ${mine.length}`)
    assert.equal(mine[0].component, 'open-nofollow')
    assert.equal(mine[0].level, 'warn')
  })
})

/** Bindings that can open a path without the symlink refusal (#7280). */
const OPEN_CAPABLE = new Set(['open', 'openSync', 'promises'])

/**
 * The IMPORTED names in `import { a, b as c } from '<mod>'`, or null when the
 * file has no such import. `b as c` yields `b`: the alias is what an evasion
 * renames, so the imported name is the one worth judging. `[^}]` matches a
 * newline, so a reformatted multi-line import is still parsed rather than
 * silently read as "no import".
 */
function namedImportsFrom(src, mod) {
  const m = src.match(new RegExp(`^import\\s*\\{([^}]*)\\}\\s*from\\s*'(?:node:)?${mod.replace('/', '\\/')}'`, 'm'))
  if (!m) return null
  return m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
}

/** Every import statement in `src` that pulls from `fs` or `fs/promises`. */
function fsFamilyImports(src) {
  return src.match(/^import\s[^;\n]*?from\s*'(?:node:)?fs(?:\/promises)?'/gm) || []
}

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

    it(`${name} imports no open-capable binding from fs or fs/promises`, () => {
      // Judge the IMPORTED name, never the local one. An earlier form of this
      // assertion compared the raw `a, b as c` entries against 'open', so
      // `import { open as rawOpen }` read as the unrelated name
      // `'open as rawOpen'` and passed — and a NEW raw-open site added under
      // that alias survived all three sweep assertions (the call count stays
      // put because no openNoFollow site was removed). Proven by mutation
      // before this was widened.
      const promisesNames = namedImportsFrom(src, 'fs/promises')
      assert.ok(promisesNames, `${name}: could not find the fs/promises import to inspect — the sweep cannot verify what it cannot parse (#7280)`)

      const leaked = [...promisesNames, ...(namedImportsFrom(src, 'fs') || [])]
        .filter((n) => OPEN_CAPABLE.has(n))
      assert.deepEqual(leaked, [],
        `${name} imports ${leaked.join(', ')} from fs/fs-promises — any of these can open a path without refusing a symlink on win32 (#7280). Use openNoFollow().`)

      // A namespace or default import re-exposes the whole module under one
      // local name, which no named-import check can see through. Every
      // fs-family import must therefore be a pure `{ ... }` named import.
      const nonNamed = fsFamilyImports(src).filter((stmt) => !/^import\s*\{/.test(stmt))
      assert.deepEqual(nonNamed, [],
        `${name} takes a namespace or default import of fs/fs-promises — that re-exposes open() under a local name the sweep cannot follow (#7280). Import only the named helpers you need.`)
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
