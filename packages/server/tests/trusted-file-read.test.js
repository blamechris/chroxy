import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync, mkdirSync, constants as fsConstants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
import {
  readTrustedSecretFile,
  _openTrustedFdSync,
  defaultTrustedFileReadDeps,
  DEFAULT_TRUSTED_FILE_MAX_SIZE,
} from '../src/trusted-file-read.js'

const TRUSTED_FILE_READ_MODULE_PATH = new URL('../src/trusted-file-read.js', import.meta.url).pathname

/**
 * #7893 — four credential-file readers (`event-ingest.js`,
 * `session-token-store.js`, `credential-store.js`, `byok-mcp-oauth-store.js`)
 * used to `statSync(path)` (check mode/owner) and then separately
 * `readFileSync(path)` the same path — a rename/symlink-swap window between
 * the two. This module is the shared, TOCTOU-safe replacement: open with
 * O_NOFOLLOW, fstat the OPENED HANDLE, read from the SAME fd. These tests
 * cover the helper directly; per-store wiring is covered in each store's own
 * test file (a symlink swap after the file is created must now be refused).
 */

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-trusted-read-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('#7893 readTrustedSecretFile — real filesystem, POSIX', () => {
  it('reads a regular 0600 file (positive control)', { skip: process.platform === 'win32' }, () => {
    withTmpDir((dir) => {
      const file = join(dir, 'secret')
      writeFileSync(file, 'hello-secret\n', { mode: 0o600 })
      const result = readTrustedSecretFile(file, { mode: 0o600 })
      assert.equal(result.status, 'ok')
      assert.equal(result.content, 'hello-secret\n')
      assert.equal(result.mode, 0o600)
    })
  })

  it('reports absent (ENOENT) for a missing file', () => {
    withTmpDir((dir) => {
      const result = readTrustedSecretFile(join(dir, 'nope'), { mode: 0o600 })
      assert.deepEqual(result, { status: 'absent' })
    })
  })

  it('refuses a widened (0644) file — exact mode, not "no wider than"', { skip: process.platform === 'win32' }, () => {
    withTmpDir((dir) => {
      const file = join(dir, 'secret')
      writeFileSync(file, 'x', { mode: 0o600 })
      chmodSync(file, 0o644)
      const result = readTrustedSecretFile(file, { mode: 0o600 })
      assert.equal(result.status, 'refused')
      assert.equal(result.code, 'EMODE')
      assert.equal(result.mode, 0o644)
    })
  })

  it('refuses a NARROWER (0400) file too — the boundary is exactly 0600', { skip: process.platform === 'win32' }, () => {
    withTmpDir((dir) => {
      const file = join(dir, 'secret')
      writeFileSync(file, 'x', { mode: 0o600 })
      chmodSync(file, 0o400)
      const result = readTrustedSecretFile(file, { mode: 0o600 })
      assert.equal(result.status, 'refused')
      assert.equal(result.code, 'EMODE')
      assert.equal(result.mode, 0o400)
    })
  })

  it('refuses a symlink at the path — REAL O_NOFOLLOW, never follows it', { skip: process.platform === 'win32' ? 'covered by the forced-win32 branch below' : SKIP_NO_SYMLINK }, () => {
    withTmpDir((dir) => {
      const target = join(dir, 'elsewhere-0600')
      writeFileSync(target, 'ELSEWHERE-SECRET', { mode: 0o600 })
      const link = join(dir, 'secret')
      symlinkSync(target, link)
      const result = readTrustedSecretFile(link, { mode: 0o600 })
      assert.equal(result.status, 'refused')
      assert.equal(result.code, 'ELOOP', 'a symlink to a well-formed 0600 file must still be refused outright — the mode of the TARGET is irrelevant once O_NOFOLLOW is in play')
    })
  })

  it('refuses a foreign-owned file when checkOwner is set', { skip: typeof process.getuid !== 'function' }, () => {
    withTmpDir((dir) => {
      const file = join(dir, 'secret')
      writeFileSync(file, 'x', { mode: 0o600 })
      const realGetuid = process.getuid
      const realUid = realGetuid.call(process)
      process.getuid = () => realUid + 1
      try {
        const result = readTrustedSecretFile(file, { mode: 0o600, checkOwner: true })
        assert.equal(result.status, 'refused')
        assert.equal(result.code, 'EOWNER')
        assert.equal(result.uid, realUid)
      } finally {
        process.getuid = realGetuid
      }
    })
  })

  it('does NOT check owner unless checkOwner is set', { skip: typeof process.getuid !== 'function' }, () => {
    withTmpDir((dir) => {
      const file = join(dir, 'secret')
      writeFileSync(file, 'x', { mode: 0o600 })
      const realGetuid = process.getuid
      process.getuid = () => realGetuid.call(process) + 1
      try {
        const result = readTrustedSecretFile(file, { mode: 0o600 })
        assert.equal(result.status, 'ok', 'checkOwner defaults to off — most stores never checked owner')
      } finally {
        process.getuid = realGetuid
      }
    })
  })

  it('refuses a directory at the path (not a regular file)', { skip: process.platform === 'win32' }, () => {
    withTmpDir((dir) => {
      const sub = join(dir, 'a-directory')
      mkdirSync(sub)
      const result = readTrustedSecretFile(sub, { mode: 0o600 })
      assert.equal(result.status, 'refused')
      assert.equal(result.code, 'ENOTFILE')
    })
  })

  it('skips the mode/owner check on win32 (mode bits do not reflect NTFS ACLs — #4144)', () => {
    withTmpDir((dir) => {
      const file = join(dir, 'secret')
      writeFileSync(file, 'win-content', { mode: 0o644 })
      const deps = { ...defaultTrustedFileReadDeps, platform: 'win32' }
      const result = readTrustedSecretFile(file, { mode: 0o600, checkOwner: true, deps })
      assert.equal(result.status, 'ok', 'win32 must skip the mode/owner boundary entirely, matching every sibling store')
    })
  })
})

describe('#7893 readTrustedSecretFile — the FD is the trust boundary, never the path again', () => {
  // The seam-based test the issue calls for: prove there is no window between
  // the trust check and the read by asserting the implementation NEVER calls
  // a path-based stat function after open, and that the content returned is
  // whatever the OPENED FD produced — not anything a (hypothetical) second
  // path-based lookup could substitute.
  it('reads from the opened fd, never re-stats or re-opens the path', () => {
    const calls = []
    const deps = {
      hasONoFollow: true,
      oNofollow: 0x00100000, // sentinel bit distinct from any real flag
      platform: 'linux',
      openSync: (path, flags) => { calls.push(['openSync', path, flags]); return 7 },
      closeSync: (fd) => { calls.push(['closeSync', fd]) },
      fstatSync: (fd) => {
        calls.push(['fstatSync', fd])
        return { mode: 0o600n, uid: BigInt(typeof process.getuid === 'function' ? process.getuid() : 0), isFile: () => true }
      },
      lstatSync: () => {
        throw new Error('lstatSync must not be called on the POSIX branch — that would re-touch the PATH after open and reopen the TOCTOU window')
      },
      readFileSync: (fd, encoding) => { calls.push(['readFileSync', fd, encoding]); return 'TRUSTED-FD-CONTENT' },
    }
    const result = readTrustedSecretFile('/some/secret/path', { mode: 0o600, deps })
    assert.equal(result.status, 'ok')
    assert.equal(result.content, 'TRUSTED-FD-CONTENT')
    assert.deepEqual(calls.map((c) => c[0]), ['openSync', 'fstatSync', 'readFileSync', 'closeSync'],
      'exactly these calls, in this order — no extra path-based lookup between the check and the read')
    assert.equal(calls[1][1], 7, 'fstat must target the FD returned by open, not the path')
    assert.equal(calls[2][1], 7, 'read must target the FD returned by open, not the path')
  })

  it('a swapped fd identity (simulated) never leaks through — the mode check runs on THIS open\'s fstat only', () => {
    // Even if a caller's deps somehow returned a DIFFERENT stat than what the
    // fd actually is, the implementation must use exactly that one fstat
    // result for the mode/owner boundary and exactly that one fd for the
    // read — it must never call fstat or read a second time "to be sure".
    let fstatCalls = 0
    let readCalls = 0
    const deps = {
      hasONoFollow: true,
      oNofollow: 1,
      platform: 'linux',
      openSync: () => 99,
      closeSync: () => {},
      fstatSync: () => { fstatCalls++; return { mode: 0o600n, uid: 0n, isFile: () => true } },
      lstatSync: () => { throw new Error('unused') },
      readFileSync: () => { readCalls++; return 'ONE-READ-ONLY' },
    }
    const result = readTrustedSecretFile('/x', { mode: 0o600, checkOwner: false, deps })
    assert.equal(result.status, 'ok')
    assert.equal(fstatCalls, 1, 'exactly one fstat — a second one would be a new TOCTOU window of its own')
    assert.equal(readCalls, 1)
  })
})

describe('#7893 _openTrustedFdSync — POSIX branch keeps O_NOFOLLOW (mutation: dropping it must go red)', () => {
  it('the default deps carry the REAL O_NOFOLLOW on a non-win32 platform', { skip: process.platform === 'win32' ? 'win32 has no O_NOFOLLOW to carry' : false }, () => {
    assert.equal(defaultTrustedFileReadDeps.hasONoFollow, true)
    assert.equal(defaultTrustedFileReadDeps.oNofollow, fsConstants.O_NOFOLLOW)
  })

  it('the POSIX branch ORs O_NOFOLLOW into the flags it passes to openSync', () => {
    const calls = []
    const SENTINEL = 0x4000000
    _openTrustedFdSync('/some/path', {
      hasONoFollow: true,
      oNofollow: SENTINEL,
      platform: 'linux',
      openSync: (p, flags) => { calls.push({ p, flags }); return 3 },
      closeSync: () => {},
      fstatSync: () => ({ mode: 0o600n, uid: 0n, isFile: () => true }),
      lstatSync: () => { throw new Error('lstat must not be used on the POSIX branch') },
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].flags & SENTINEL, SENTINEL, 'the POSIX branch dropped O_NOFOLLOW from the flags — the guard is a no-op')
    // #7893 hardening: O_NONBLOCK is also ORed in (keeps a planted FIFO's
    // open() from blocking the daemon forever — see the FIFO test below).
    // Real on every POSIX target this ships for, hence the exact-equality
    // check; falls back to a no-op 0 only if a platform's Node build lacks
    // the constant.
    const expectedNonblock = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0
    assert.equal(calls[0].flags, fsConstants.O_RDONLY | SENTINEL | expectedNonblock)
  })

  it('fstat failure after a successful open still closes the fd (no leak)', () => {
    const calls = []
    assert.throws(
      () => _openTrustedFdSync('/some/path', {
        hasONoFollow: true,
        oNofollow: 1,
        platform: 'linux',
        openSync: () => { calls.push('open'); return 42 },
        closeSync: (fd) => { calls.push(`close:${fd}`) },
        fstatSync: () => { throw Object.assign(new Error('simulated EIO'), { code: 'EIO' }) },
        lstatSync: () => { throw new Error('lstat must not be used on the POSIX branch') },
      }),
      (err) => err.code === 'EIO',
    )
    assert.deepEqual(calls, ['open', 'close:42'], 'the fd opened before the failing fstat must be closed, not leaked')
  })

  it('refuses a planted symlink with ELOOP through the REAL helper', { skip: process.platform === 'win32' ? 'covered by the forced-win32 branch below' : SKIP_NO_SYMLINK }, () => {
    withTmpDir((dir) => {
      const target = join(dir, 'secret.txt')
      writeFileSync(target, 'SECRET')
      const link = join(dir, 'link.txt')
      symlinkSync(target, link)
      assert.throws(
        () => _openTrustedFdSync(link, defaultTrustedFileReadDeps),
        (err) => err.code === 'ELOOP',
      )
    })
  })
})

describe('#7893 _openTrustedFdSync — forced win32 branch (runs on every platform)', () => {
  const forcedWin32 = { ...defaultTrustedFileReadDeps, hasONoFollow: false, oNofollow: undefined, platform: 'win32' }

  function statLike({ dev = 7n, ino = 42n, symlink = false } = {}) {
    return { dev, ino, isSymbolicLink: () => symlink, mode: 0o600n, uid: 0n, isFile: () => true }
  }

  it('refuses a symlink reported by lstat, WITHOUT ever calling open', () => {
    let opened = 0
    assert.throws(
      () => _openTrustedFdSync('C:\\ws\\link.txt', {
        hasONoFollow: false,
        oNofollow: undefined,
        platform: 'win32',
        lstatSync: () => statLike({ symlink: true }),
        openSync: () => { opened++; return 5 },
        fstatSync: () => statLike(),
        closeSync: () => {},
      }),
      (err) => err.code === 'ELOOP',
    )
    assert.equal(opened, 0, 'the win32 branch opened the symlink it had already identified')
  })

  it('refuses a REAL planted symlink and does not open the target', { skip: SKIP_NO_SYMLINK }, () => {
    withTmpDir((dir) => {
      const target = join(dir, 'secret.txt')
      writeFileSync(target, 'SECRET')
      const link = join(dir, 'link.txt')
      symlinkSync(target, link)
      assert.throws(
        () => _openTrustedFdSync(link, forcedWin32),
        (err) => err.code === 'ELOOP',
      )
    })
  })

  it('opens a REAL regular file and runs the fd-identity check (positive control)', () => {
    withTmpDir((dir) => {
      const target = join(dir, 'plain.txt')
      writeFileSync(target, 'PLAIN')
      let fstatCalls = 0
      let lstatCalls = 0
      const { fd, stat } = _openTrustedFdSync(target, {
        ...forcedWin32,
        lstatSync: (...args) => { lstatCalls++; return defaultTrustedFileReadDeps.lstatSync(...args) },
        fstatSync: (...args) => { fstatCalls++; return defaultTrustedFileReadDeps.fstatSync(...args) },
      })
      try {
        assert.ok(stat.isFile())
      } finally {
        defaultTrustedFileReadDeps.closeSync(fd)
      }
      assert.equal(fstatCalls, 1)
      assert.equal(lstatCalls, 2, 'the win32 branch must lstat BEFORE the open and again AFTER it')
    })
  })

  it('refuses with ELOOP when the fd identity does not match the path after open (TOCTOU swap)', () => {
    let lstatCalls = 0
    let closed = false
    assert.throws(
      () => _openTrustedFdSync('C:\\ws\\swapped.txt', {
        hasONoFollow: false,
        oNofollow: undefined,
        platform: 'win32',
        lstatSync: () => { lstatCalls++; return statLike({ ino: lstatCalls === 1 ? 999n : 1234n }) },
        openSync: () => 8,
        fstatSync: () => statLike({ ino: 999n }),
        closeSync: () => { closed = true },
      }),
      (err) => err.code === 'ELOOP',
    )
    assert.equal(closed, true, 'the refused fd was leaked instead of closed')
  })

  it('refuses with ELOOP when a symlink appears at the path after the open', () => {
    let lstatCalls = 0
    assert.throws(
      () => _openTrustedFdSync('C:\\ws\\raced.txt', {
        hasONoFollow: false,
        oNofollow: undefined,
        platform: 'win32',
        lstatSync: () => { lstatCalls++; return statLike({ symlink: lstatCalls !== 1 }) },
        openSync: () => 9,
        fstatSync: () => statLike(),
        closeSync: () => {},
      }),
      (err) => err.code === 'ELOOP',
    )
  })

  it('REFUSES rather than falling back to a plain open on an unexpected platform', () => {
    let opened = 0
    assert.throws(
      () => _openTrustedFdSync('/some/path', {
        hasONoFollow: false,
        oNofollow: undefined,
        platform: 'sunos',
        lstatSync: () => statLike(),
        openSync: () => { opened++; return 1 },
        fstatSync: () => statLike(),
        closeSync: () => {},
      }),
      (err) => err.code === 'ENOSYS' && /O_NOFOLLOW/.test(err.message),
    )
    assert.equal(opened, 0)
  })
})

describe('#7893 readTrustedSecretFile — a FIFO at the path must not block the daemon', () => {
  // Regression coverage for a live repro: BEFORE O_NONBLOCK was added to the
  // POSIX open flags, opening a FIFO with no writer present blocked
  // `openSync` forever — and since this is a synchronous call on Node's
  // single thread, that hangs the WHOLE daemon, not just this read. The
  // "attacker with write access to the containing directory" threat model
  // #7893 already assumes can plant a FIFO exactly as easily as a symlink.
  //
  // The call itself runs in a SUBPROCESS with an enforced wall-clock
  // timeout, never in this test process directly — a mutation that
  // reintroduces the block must fail loudly and promptly, not wedge the
  // whole test run (docs/false-safety-guards.md: "a guard that HANGS
  // instead of failing" — catalogue entry 17, #7340).
  it('refuses a FIFO instead of blocking on open() with no writer present', { skip: process.platform === 'win32' ? 'FIFOs are not ordinary files at a Windows path' : false }, () => {
    withTmpDir((dir) => {
      const fifoPath = join(dir, 'secret')
      try {
        execFileSync('mkfifo', ['-m', '0600', fifoPath])
      } catch (err) {
        throw new Error(`mkfifo unavailable on this POSIX host — cannot exercise the FIFO-block regression directly: ${err.message}`)
      }

      const scriptPath = join(dir, 'run-read.mjs')
      writeFileSync(scriptPath, [
        `import { readTrustedSecretFile } from ${JSON.stringify(TRUSTED_FILE_READ_MODULE_PATH)}`,
        `const result = readTrustedSecretFile(${JSON.stringify(fifoPath)}, { mode: 0o600 })`,
        'process.stdout.write(JSON.stringify(result))',
      ].join('\n'))

      let out
      try {
        out = execFileSync(process.execPath, [scriptPath], {
          timeout: 5000,
          killSignal: 'SIGKILL',
          encoding: 'utf8',
        })
      } catch (err) {
        if (err.signal || err.killed) {
          assert.fail('readTrustedSecretFile blocked for 5s+ on a FIFO with no writer instead of returning immediately (O_NONBLOCK regression)')
        }
        throw err
      }

      const result = JSON.parse(out)
      assert.equal(result.status, 'refused')
      assert.equal(result.code, 'ENOTFILE', 'a FIFO must be refused as a non-regular file, never read from')
    })
  })
})

describe('#7893 readTrustedSecretFile — size cap (bounds what a same-uid attacker can force allocated)', () => {
  it('refuses a file over the configured maxSize, without reading it', { skip: process.platform === 'win32' }, () => {
    withTmpDir((dir) => {
      const file = join(dir, 'secret')
      writeFileSync(file, 'x'.repeat(100), { mode: 0o600 })
      const result = readTrustedSecretFile(file, { mode: 0o600, maxSize: 10 })
      assert.equal(result.status, 'refused')
      assert.equal(result.code, 'ETOOBIG')
    })
  })

  it('allows a file exactly at maxSize (boundary is size > maxSize, not >=)', { skip: process.platform === 'win32' }, () => {
    withTmpDir((dir) => {
      const file = join(dir, 'secret')
      writeFileSync(file, 'x'.repeat(10), { mode: 0o600 })
      const result = readTrustedSecretFile(file, { mode: 0o600, maxSize: 10 })
      assert.equal(result.status, 'ok')
      assert.equal(result.content, 'x'.repeat(10))
    })
  })

  it('the default cap is DEFAULT_TRUSTED_FILE_MAX_SIZE and refuses a real file over it end-to-end', { skip: process.platform === 'win32' }, () => {
    withTmpDir((dir) => {
      const file = join(dir, 'secret')
      writeFileSync(file, Buffer.alloc(DEFAULT_TRUSTED_FILE_MAX_SIZE + 1, 'a'), { mode: 0o600 })
      const result = readTrustedSecretFile(file, { mode: 0o600 })
      assert.equal(result.status, 'refused')
      assert.equal(result.code, 'ETOOBIG')
    })
  })

  it('the cap applies even with platform forced to win32 — it is a memory bound, not a mode-bits check', () => {
    withTmpDir((dir) => {
      const file = join(dir, 'secret')
      writeFileSync(file, 'x'.repeat(100), { mode: 0o644 })
      const deps = { ...defaultTrustedFileReadDeps, platform: 'win32' }
      const result = readTrustedSecretFile(file, { mode: 0o600, maxSize: 10, deps })
      assert.equal(result.status, 'refused')
      assert.equal(result.code, 'ETOOBIG')
    })
  })
})
