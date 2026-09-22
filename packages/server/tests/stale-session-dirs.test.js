/**
 * The boot-time stale-dir sweep must not delete through a base it does not own
 * (#7872).
 *
 * `sweepStaleOwnedDirs(base)` runs at daemon boot for BOTH hook-routed
 * providers (claude-tui's sink base, claude-cli's sidecar base) — before any
 * session start, so before `ensureOwnedBaseDir` has ever looked at the path. On
 * Linux `os.tmpdir()` is the shared `/tmp`, so another local user can
 * pre-create the base as a symlink to a directory of their choosing, and an
 * unchecked sweep then `rm -rf`s that directory's orphan-looking `s-*`
 * children. The create path refuses exactly that base (#7337, #7372); these
 * tests pin the delete path to the same refusal — expressed as a SKIP with a
 * warning, never a throw, because a throwing sweep would let one planted
 * symlink wedge daemon boot.
 *
 * Every fixture lives under its own mkdtemp dir — never the real provider
 * bases, which are other test files' fixture space and `node --test` runs
 * files in parallel (see sweep-stale-provider-dirs.test.js).
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { sweepStaleOwnedDirs, OWNER_PID_FILE } from '../src/utils/stale-session-dirs.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { CliSession } from '../src/cli-session.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

function recordingLog() {
  const warns = []
  const infos = []
  return { warns, infos, warn: (m) => warns.push(String(m)), info: (m) => infos.push(String(m)) }
}

/** An `s-*` dir with no pidfile, aged well past the default 60s grace. */
function makeAgedOrphan(parent, name) {
  const dir = join(parent, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'data'), 'precious')
  const old = new Date(Date.now() - 60 * 60_000)
  utimesSync(dir, old, old)
  return dir
}

describe('sweepStaleOwnedDirs — base ownership (#7872)', () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-sweep-base-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses a base that is a symlink, and deletes nothing through it', { skip: SKIP_NO_SYMLINK }, () => {
    const target = join(root, 'someone-elses-dir')
    mkdirSync(target)
    const victim = makeAgedOrphan(target, 's-victim')
    const base = join(root, 'squatted-base')
    symlinkSync(target, base)

    const log = recordingLog()
    const result = sweepStaleOwnedDirs(base, { logger: log })

    assert.equal(existsSync(victim), true,
      'a symlinked base lets another local user aim the boot sweep at a directory of their choosing')
    assert.equal(readFileSync(join(victim, 'data'), 'utf8'), 'precious')
    assert.deepEqual(result, { swept: 0, kept: 0 })
    assert.equal(log.warns.length, 1, `exactly one warning; got ${JSON.stringify(log.warns)}`)
    assert.ok(log.warns[0].includes(base) && /symlink/i.test(log.warns[0]),
      `the warning must name the path and the reason; got ${JSON.stringify(log.warns[0])}`)
  })

  // A foreign-owned base cannot be BUILT as a normal user (no chown), so the
  // uid comparison is exercised by changing the other side of it: the sweep
  // reads `process.getuid()` at call time, and a base we own looks foreign to a
  // process claiming a different uid. POSIX only — Windows has no uid and the
  // check is skipped there by design, mirroring ensureOwnedBaseDir.
  it('refuses a base owned by another uid', { skip: typeof process.getuid !== 'function' }, () => {
    const base = join(root, 'foreign-base')
    mkdirSync(base)
    const orphan = makeAgedOrphan(base, 's-orphan')

    const realGetuid = process.getuid
    const realUid = realGetuid.call(process)
    process.getuid = () => realUid + 1
    let result
    const log = recordingLog()
    try {
      result = sweepStaleOwnedDirs(base, { logger: log })
    } finally {
      process.getuid = realGetuid
    }

    assert.equal(existsSync(orphan), true, 'a base owned by another uid must not be swept')
    assert.deepEqual(result, { swept: 0, kept: 0 })
    assert.equal(log.warns.length, 1, `exactly one warning; got ${JSON.stringify(log.warns)}`)
    assert.ok(log.warns[0].includes(base) && log.warns[0].includes(`uid ${realUid}`),
      `the warning must name the path and the owning uid; got ${JSON.stringify(log.warns[0])}`)
  })

  // Root is where the ownership check matters most, and uid 0 is FALSY: an
  // `if (uid && …)` rewrite of the `uid !== undefined` test switches the check
  // off for exactly the process whose recursive delete can do the most damage.
  // Every other test here runs with a non-zero uid, and that mutant survived
  // all of them. Running as root (the Linux docker runners), the fixture is
  // built for real with chown; otherwise the process claims uid 0.
  it('refuses a foreign base when the daemon runs as root (uid 0)', { skip: typeof process.getuid !== 'function' }, () => {
    const base = join(root, 'foreign-to-root')
    mkdirSync(base)
    const orphan = makeAgedOrphan(base, 's-orphan')

    const realGetuid = process.getuid
    const realUid = realGetuid.call(process)
    if (realUid === 0) chownSync(base, 1, 1)
    let result
    const log = recordingLog()
    try {
      if (realUid !== 0) process.getuid = () => 0
      result = sweepStaleOwnedDirs(base, { logger: log })
    } finally {
      process.getuid = realGetuid
    }

    assert.equal(existsSync(orphan), true, 'a root daemon must not sweep a base owned by another uid')
    assert.deepEqual(result, { swept: 0, kept: 0 })
    assert.equal(log.warns.length, 1, `exactly one warning; got ${JSON.stringify(log.warns)}`)
    assert.ok(log.warns[0].includes(base) && log.warns[0].includes('not 0'),
      `the warning must name the path and the daemon's uid; got ${JSON.stringify(log.warns[0])}`)
  })

  // Both boot callers, driven through their real static entry points with
  // only the base getter redirected (the pattern claude-tui-session.test.js
  // and cli-permission-mode-sidecar.test.js already use). Every other test in
  // this file calls sweepStaleOwnedDirs directly, so a caller that resolved its
  // base first — `sweepStaleOwnedDirs(realpathSync(SINK_BASE), …)`, a natural
  // "normalise /var → /private/var" change — would hand the check the link's
  // TARGET, pass the symlink test by construction, and stay green here while
  // the boot sweep deletes through the squat again (#7262's shape: a guard
  // correct for every input it sees and never reached by a caller).
  for (const [label, Cls, prop, sweep] of [
    ['claude-tui sink', ClaudeTuiSession, 'SINK_BASE', 'sweepStaleSinkDirs'],
    ['claude-cli sidecar', CliSession, 'PERMISSION_MODE_SIDECAR_BASE', 'sweepStaleSidecarDirs'],
  ]) {
    it(`boot caller ${Cls.name}.${sweep} (${label}) refuses a symlinked base`, { skip: SKIP_NO_SYMLINK }, () => {
      const target = join(root, 'someone-elses-dir')
      mkdirSync(target)
      const victim = makeAgedOrphan(target, 's-victim')
      const base = join(root, 'squatted-base')
      symlinkSync(target, base)

      const original = Object.getOwnPropertyDescriptor(Cls, prop)
      assert.ok(original && typeof original.get === 'function', `${Cls.name}.${prop} is expected to be a static getter`)
      const log = recordingLog()
      let result
      try {
        Object.defineProperty(Cls, prop, { get: () => base, configurable: true })
        result = Cls[sweep](log)
      } finally {
        Object.defineProperty(Cls, prop, original)
      }

      assert.equal(existsSync(victim), true, `${Cls.name}.${sweep} deleted through a symlinked base`)
      assert.deepEqual(result, { swept: 0, kept: 0 })
      assert.equal(log.warns.length, 1, `exactly one warning; got ${JSON.stringify(log.warns)}`)
      assert.ok(log.warns[0].includes(base) && /symlink/i.test(log.warns[0]),
        `the warning must name the configured base and the reason; got ${JSON.stringify(log.warns[0])}`)
    })
  }

  it('refuses a base that is a regular file', () => {
    const base = join(root, 'not-a-dir')
    writeFileSync(base, 'i am a file')

    const log = recordingLog()
    const result = sweepStaleOwnedDirs(base, { logger: log })

    assert.deepEqual(result, { swept: 0, kept: 0 })
    assert.equal(readFileSync(base, 'utf8'), 'i am a file')
    assert.equal(log.warns.length, 1, `exactly one warning; got ${JSON.stringify(log.warns)}`)
    assert.ok(log.warns[0].includes(base) && /not a directory/i.test(log.warns[0]),
      `the warning must name the path and the reason; got ${JSON.stringify(log.warns[0])}`)
  })

  it('a missing base is the common path: zero counts and NO warning', () => {
    const log = recordingLog()
    const result = sweepStaleOwnedDirs(join(root, 'never-created'), { logger: log })

    assert.deepEqual(result, { swept: 0, kept: 0 })
    assert.deepEqual(log.warns, [], 'a fresh host has no base yet — that must not become log noise')
    assert.deepEqual(log.infos, [])
  })

  // Positive control: a fix that refuses EVERY base would pass all four tests
  // above and silently bring back the crash leak #5323 exists to stop.
  it('still sweeps an owned base: reaps the aged orphan, keeps the live owner', () => {
    const base = join(root, 'owned-base')
    mkdirSync(base, { mode: 0o700 })
    const orphan = makeAgedOrphan(base, 's-orphan')
    const live = join(base, 's-live')
    mkdirSync(live)
    writeFileSync(join(live, OWNER_PID_FILE), String(process.pid))

    const log = recordingLog()
    const result = sweepStaleOwnedDirs(base, { logger: log })

    assert.equal(existsSync(orphan), false, 'an aged pidfile-less dir under an owned base must be reaped')
    assert.equal(existsSync(live), true, 'a dir whose owner pid is alive must be kept')
    assert.deepEqual(result, { swept: 1, kept: 1 })
    assert.deepEqual(log.warns, [])
  })

  // The neighbouring class: the base is ours, but one CHILD is a symlink out of
  // it. rmSync lstat's its argument and unlinks a symlink rather than
  // descending, so the link goes and its target survives. This pins that, so a
  // future "harden the sweep" change that resolves children first cannot turn
  // a child link into the same primitive the base check just closed.
  it('an s-* child that is a symlink is unlinked, not followed', { skip: SKIP_NO_SYMLINK }, () => {
    const base = join(root, 'owned-base')
    mkdirSync(base, { mode: 0o700 })
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep-me'), 'precious')
    const link = join(base, 's-linkchild')
    symlinkSync(outside, link)
    // The grace check stats THROUGH the link, so age the target past the
    // default grace. (`graceMs: 0` is not enough: a fresh mtime carries a
    // sub-millisecond fraction that can sit ahead of Date.now(), and the link
    // then reads as brand new and is kept.)
    const old = new Date(Date.now() - 60 * 60_000)
    utimesSync(outside, old, old)

    const result = sweepStaleOwnedDirs(base, { logger: recordingLog() })

    assert.equal(existsSync(link), false, 'the orphan-looking link itself is swept')
    assert.equal(existsSync(join(outside, 'keep-me')), true, 'but the directory it pointed at is untouched')
    assert.equal(readFileSync(join(outside, 'keep-me'), 'utf8'), 'precious')
    assert.deepEqual(result, { swept: 1, kept: 0 })
  })
})
