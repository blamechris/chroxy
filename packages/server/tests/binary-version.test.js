import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSemver,
  compareSemver,
  probeBinaryVersion,
  _resetProbeCacheForTest,
} from '../src/utils/binary-version.js'

/**
 * Unit tests for semver parse/compare + the cached `--version` probe (#7986).
 *
 * Every fs/exec touchpoint `probeBinaryVersion` uses is injected, so these run
 * with no real binary on disk.
 */

describe('parseSemver', () => {
  it('extracts the leading major.minor.patch from banner text', () => {
    assert.equal(parseSemver('2.1.283 (Claude Code)'), '2.1.283')
  })

  it('extracts from a bare version string', () => {
    assert.equal(parseSemver('2.1.141'), '2.1.141')
  })

  it('ignores a prerelease/suffix and keeps just the numeric core', () => {
    assert.equal(parseSemver('2.1.80-beta'), '2.1.80')
    assert.equal(parseSemver('v22.14.0'), '22.14.0')
  })

  it('returns null for garbage / no leading semver', () => {
    assert.equal(parseSemver('not a version'), null)
    assert.equal(parseSemver(''), null)
    assert.equal(parseSemver('claude version unknown'), null)
  })

  it('returns null for non-string input', () => {
    assert.equal(parseSemver(null), null)
    assert.equal(parseSemver(undefined), null)
    assert.equal(parseSemver(42), null)
  })
})

describe('compareSemver', () => {
  it('orders numerically, not lexically (2.1.9 < 2.1.10)', () => {
    assert.ok(compareSemver('2.1.9', '2.1.10') < 0)
    assert.ok(compareSemver('2.1.10', '2.1.9') > 0)
  })

  it('returns 0 for equal versions', () => {
    assert.equal(compareSemver('2.1.80', '2.1.80'), 0)
  })

  it('compares across major/minor/patch in order', () => {
    assert.ok(compareSemver('3.0.0', '2.9.9') > 0)
    assert.ok(compareSemver('2.0.0', '2.1.0') < 0)
    assert.ok(compareSemver('2.1.163', '2.1.80') > 0)
  })

  it('parses banner text on both sides before comparing', () => {
    assert.ok(compareSemver('2.1.163 (Claude Code)', '2.1.80') > 0)
  })

  it('fails CLOSED: an unparseable required side never lets found "pass"', () => {
    assert.ok(compareSemver('2.1.163', 'not-a-version') < 0)
    assert.ok(compareSemver('2.1.163', 'v2') < 0)
  })

  it('fails CLOSED: an unparseable found side is never >= a real required', () => {
    assert.ok(compareSemver('garbage', '2.1.80') < 0)
  })

  it('two unparseable sides still sort as less-than, not a tie', () => {
    assert.ok(compareSemver('garbage', 'also-garbage') < 0)
  })

  it('a leading prefix around an otherwise-valid triple still parses (banner text, not a strict grammar)', () => {
    // Unlike a strictly-anchored semver parser, parseSemver deliberately finds
    // the first \d+.\d+.\d+ run ANYWHERE in the string — the shape real
    // `--version` banners take (e.g. "2.1.283 (Claude Code)"). A leading
    // non-digit prefix like ">=" does not make the embedded triple invalid.
    assert.ok(compareSemver('2.1.163', '>=2.1.80') > 0)
  })
})

describe('probeBinaryVersion', () => {
  function statOf({ dev = 1, ino = 100, size = 999, mtimeMs = 111 } = {}) {
    return () => ({ dev, ino, size, mtimeMs })
  }

  beforeEach(() => {
    _resetProbeCacheForTest()
  })

  it('parses the version out of stdout', () => {
    const version = probeBinaryVersion('/fake/claude', ['--version'], {
      execFileSync: () => '2.1.283 (Claude Code)\n',
      statSync: statOf(),
    })
    assert.equal(version, '2.1.283')
  })

  it('passes the given args through to execFileSync', () => {
    let seenArgs = null
    probeBinaryVersion('/fake/claude', ['--version'], {
      execFileSync: (_path, args) => {
        seenArgs = args
        return '2.1.283\n'
      },
      statSync: statOf(),
    })
    assert.deepEqual(seenArgs, ['--version'])
  })

  it('defaults args to ["--version"] when omitted', () => {
    let seenArgs = null
    probeBinaryVersion('/fake/claude', undefined, {
      execFileSync: (_path, args) => {
        seenArgs = args
        return '2.1.283\n'
      },
      statSync: statOf(),
    })
    assert.deepEqual(seenArgs, ['--version'])
  })

  it('returns null ("unreadable") when execFileSync throws with no captured output', () => {
    const version = probeBinaryVersion('/fake/claude', ['--version'], {
      execFileSync: () => { throw new Error('boom') },
      statSync: statOf(),
    })
    assert.equal(version, null)
  })

  it('falls back to stderr on a non-zero exit that still printed a version', () => {
    const version = probeBinaryVersion('/fake/claude', ['--version'], {
      execFileSync: () => {
        const err = new Error('exit 1')
        err.stdout = ''
        err.stderr = '2.1.283 (Claude Code)\n'
        throw err
      },
      statSync: statOf(),
    })
    assert.equal(version, '2.1.283')
  })

  it('returns null when output has no parseable version', () => {
    const version = probeBinaryVersion('/fake/claude', ['--version'], {
      execFileSync: () => 'garbage, no version here\n',
      statSync: statOf(),
    })
    assert.equal(version, null)
  })

  it('caches a hit for the SAME stat identity — execFileSync is not called twice', () => {
    let calls = 0
    const seams = {
      execFileSync: () => { calls += 1; return '2.1.283\n' },
      statSync: statOf({ ino: 42, mtimeMs: 555 }),
    }
    const first = probeBinaryVersion('/fake/claude', ['--version'], seams)
    const second = probeBinaryVersion('/fake/claude', ['--version'], seams)
    assert.equal(first, '2.1.283')
    assert.equal(second, '2.1.283')
    assert.equal(calls, 1, 'the second call must be served from cache, not re-exec')
  })

  it('re-probes when the stat identity changes (e.g. `claude update` replaced the file)', () => {
    let calls = 0
    const execFileSync = () => { calls += 1; return calls === 1 ? '2.1.100\n' : '2.1.283\n' }

    const before = probeBinaryVersion('/fake/claude', ['--version'], {
      execFileSync,
      statSync: statOf({ ino: 7, mtimeMs: 1000, size: 500 }),
    })
    const after = probeBinaryVersion('/fake/claude', ['--version'], {
      execFileSync,
      // Same path, different inode/mtime/size — an in-place binary swap.
      statSync: statOf({ ino: 7, mtimeMs: 2000, size: 600 }),
    })

    assert.equal(before, '2.1.100')
    assert.equal(after, '2.1.283')
    assert.equal(calls, 2, 'a changed stat identity must trigger a fresh probe')
  })

  it('does not cache (and does not throw) when stat fails — probes fresh every call', () => {
    let calls = 0
    const version = probeBinaryVersion('/vanished/claude', ['--version'], {
      execFileSync: () => { calls += 1; return '2.1.283\n' },
      statSync: () => { throw new Error('ENOENT') },
    })
    assert.equal(version, '2.1.283')
    assert.equal(calls, 1)
  })
})
