import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSemver,
  compareSemver,
  resolveDeclaredMinVersion,
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

  // A clean, successful spawnSync result — the only shape output is ever
  // accepted from (see the C1 fix: `result.error` unset AND `status === 0`).
  function ok({ stdout = '', stderr = '' } = {}) {
    return () => ({ error: undefined, status: 0, signal: null, stdout, stderr })
  }

  beforeEach(() => {
    _resetProbeCacheForTest()
  })

  it('parses the version out of stdout', () => {
    const version = probeBinaryVersion('/fake/claude', ['--version'], {
      spawnSync: ok({ stdout: '2.1.283 (Claude Code)\n' }),
      statSync: statOf(),
    })
    assert.equal(version, '2.1.283')
  })

  it('passes the given args through to spawnSync', () => {
    let seenArgs = null
    probeBinaryVersion('/fake/claude', ['--version'], {
      spawnSync: (_path, args) => {
        seenArgs = args
        return { error: undefined, status: 0, stdout: '2.1.283\n', stderr: '' }
      },
      statSync: statOf(),
    })
    assert.deepEqual(seenArgs, ['--version'])
  })

  it('defaults args to ["--version"] when omitted', () => {
    let seenArgs = null
    probeBinaryVersion('/fake/claude', undefined, {
      spawnSync: (_path, args) => {
        seenArgs = args
        return { error: undefined, status: 0, stdout: '2.1.283\n', stderr: '' }
      },
      statSync: statOf(),
    })
    assert.deepEqual(seenArgs, ['--version'])
  })

  it('returns null ("unreadable") when spawnSync reports a spawn error (e.g. ENOENT)', () => {
    const version = probeBinaryVersion('/fake/claude', ['--version'], {
      spawnSync: () => ({ error: new Error('ENOENT'), status: null, stdout: null, stderr: null }),
      statSync: statOf(),
    })
    assert.equal(version, null)
  })

  it('returns null when output has no parseable version', () => {
    const version = probeBinaryVersion('/fake/claude', ['--version'], {
      spawnSync: ok({ stdout: 'garbage, no version here\n' }),
      statSync: statOf(),
    })
    assert.equal(version, null)
  })

  it('exit 0 with the version only on stderr is still parsed (some CLIs print their banner there)', () => {
    const version = probeBinaryVersion('/fake/claude', ['--version'], {
      spawnSync: ok({ stdout: '', stderr: '2.1.283 (Claude Code)\n' }),
      statSync: statOf(),
    })
    assert.equal(version, '2.1.283')
  })

  // #7986 review C1: previously, a non-zero exit fell back to reading
  // stdout/stderr off the thrown error and parsed ANY leading semver found
  // there — including Node's own crash-footer version. A `claude` that
  // crashes on `--version` (e.g. a broken npm/JS shim) prints exactly that
  // shape to stderr, and the old code accepted it as claude's own version,
  // letting a broken install satisfy the minimum-version floor. This is the
  // regression test: it must return null, not "22.23.2".
  it('a non-zero exit with a Node.js crash footer on stderr is "unreadable", NOT parsed as the version (C1)', () => {
    const version = probeBinaryVersion('/fake/claude', ['--version'], {
      spawnSync: () => ({
        error: undefined,
        status: 1,
        signal: null,
        stdout: '',
        stderr: 'Uncaught Error: broken install\n    at Object.<anonymous> (/fake/claude:1:1)\nNode.js v22.23.2\n',
      }),
      statSync: statOf(),
    })
    assert.equal(version, null)
  })

  it('a signal or timeout (null status) is "unreadable", even with output captured', () => {
    const version = probeBinaryVersion('/fake/claude', ['--version'], {
      spawnSync: () => ({ error: undefined, status: null, signal: 'SIGTERM', stdout: '2.1.283\n', stderr: '' }),
      statSync: statOf(),
    })
    assert.equal(version, null)
  })

  it('caches a hit for the SAME stat identity — spawnSync is not called twice', () => {
    let calls = 0
    const seams = {
      spawnSync: () => { calls += 1; return { error: undefined, status: 0, stdout: '2.1.283\n', stderr: '' } },
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
    const spawnSync = () => {
      calls += 1
      return { error: undefined, status: 0, stdout: calls === 1 ? '2.1.100\n' : '2.1.283\n', stderr: '' }
    }

    const before = probeBinaryVersion('/fake/claude', ['--version'], {
      spawnSync,
      statSync: statOf({ ino: 7, mtimeMs: 1000, size: 500 }),
    })
    const after = probeBinaryVersion('/fake/claude', ['--version'], {
      spawnSync,
      // Same path, different inode/mtime/size — an in-place binary swap.
      statSync: statOf({ ino: 7, mtimeMs: 2000, size: 600 }),
    })

    assert.equal(before, '2.1.100')
    assert.equal(after, '2.1.283')
    assert.equal(calls, 2, 'a changed stat identity must trigger a fresh probe')
  })

  it('does not cache a FAILED probe — a transient timeout must not pin "unreadable"', () => {
    let calls = 0
    const seams = {
      spawnSync: () => {
        calls += 1
        if (calls === 1) return { error: undefined, status: null, signal: 'SIGTERM', stdout: '', stderr: '' }
        return { error: undefined, status: 0, stdout: '2.1.283\n', stderr: '' }
      },
      statSync: statOf({ ino: 9, mtimeMs: 3000 }),
    }
    const first = probeBinaryVersion('/fake/claude', ['--version'], seams)
    const second = probeBinaryVersion('/fake/claude', ['--version'], seams)
    assert.equal(first, null)
    assert.equal(second, '2.1.283', 'the unchanged binary must be re-probed after a failed read')
    assert.equal(calls, 2)
  })

  it('does not cache a NON-ZERO exit — a retried probe re-runs, not pinned "unreadable" (C1)', () => {
    let calls = 0
    const seams = {
      spawnSync: () => {
        calls += 1
        if (calls === 1) return { error: undefined, status: 1, stdout: '', stderr: 'Node.js v22.23.2\n' }
        return { error: undefined, status: 0, stdout: '2.1.283\n', stderr: '' }
      },
      statSync: statOf({ ino: 11, mtimeMs: 4000 }),
    }
    const first = probeBinaryVersion('/fake/claude', ['--version'], seams)
    const second = probeBinaryVersion('/fake/claude', ['--version'], seams)
    assert.equal(first, null)
    assert.equal(second, '2.1.283')
    assert.equal(calls, 2, 'a non-zero exit must never be cached as "unreadable"')
  })

  it('does not cache (and does not throw) when stat fails — probes fresh every call', () => {
    let calls = 0
    const version = probeBinaryVersion('/vanished/claude', ['--version'], {
      spawnSync: () => { calls += 1; return { error: undefined, status: 0, stdout: '2.1.283\n', stderr: '' } },
      statSync: () => { throw new Error('ENOENT') },
    })
    assert.equal(version, '2.1.283')
    assert.equal(calls, 1)
  })
})

describe('resolveDeclaredMinVersion', () => {
  it('passes a plain version string through', () => {
    assert.equal(resolveDeclaredMinVersion('2.1.80'), '2.1.80')
  })

  it('calls a thunk and returns its string', () => {
    assert.equal(resolveDeclaredMinVersion(() => '2.1.141'), '2.1.141')
  })

  it('returns null for a thunk that returns null or an empty string', () => {
    assert.equal(resolveDeclaredMinVersion(() => null), null)
    assert.equal(resolveDeclaredMinVersion(() => ''), null)
  })

  it('returns null for a thunk that throws, rather than propagating', () => {
    assert.equal(resolveDeclaredMinVersion(() => { throw new Error('boom') }), null)
  })

  it('returns null for undefined, null, empty and non-string values', () => {
    for (const v of [undefined, null, '', 2, {}, []]) {
      assert.equal(resolveDeclaredMinVersion(v), null, `for ${JSON.stringify(v)}`)
    }
  })
})
