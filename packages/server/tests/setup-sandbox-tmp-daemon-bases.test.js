/**
 * #8352 — the write sandbox must protect the live daemon's tmpdir bases.
 *
 * The full server suite deleted the real `tmpdir()/chroxy-claude-tui` (the
 * claude-tui hook-sink base) on a machine with a running daemon, which
 * validates that base by dev/ino and refuses every further tool event once it
 * changes. The #4633 guard did not notice: it protected `~/.chroxy` and
 * `~/.claude` only. `tests/_setup.mjs` now also protects each name in
 * `TMP_DAEMON_BASE_NAMES` (scripts/lib/test-fs-sandbox.mjs).
 *
 * Four things are pinned here, because a list beside a growing set is the
 * first recurring cause in docs/false-safety-guards.md:
 *
 *   1. ROSTER, source -> list: every `join(tmpdir(), 'chroxy-…')` base in
 *      `src/` is in `TMP_DAEMON_BASE_NAMES` (a NEW daemon base with no row is
 *      an unguarded hole).
 *   2. ROSTER, list -> source: every row names a base the source still builds
 *      (a stale row guards nothing and reads as cover).
 *   3. The class getters really resolve to `tmpdir()/<name>`, so (1) and (2),
 *      which read source TEXT, are tied to what the classes DO.
 *   4. BEHAVIOUR: a mutation of the real base — spelled lexically AND through
 *      realpath, as the sweeps spell it — throws CHROXY_TEST_SANDBOX, while a
 *      pinned per-test base and a lookalike sibling stay writable. Without the
 *      second half a guard that denies everything would pass the first
 *      (catalogue entry 18, #7273).
 *
 * The mutation probes below only ever hit paths that do not exist (`s-8352-…`),
 * so even a sandbox that failed to fire could not delete live state.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TMP_DAEMON_BASE_NAMES, tmpDaemonBaseRoots } from '../../../scripts/lib/test-fs-sandbox.mjs'
import { SANDBOX_IS_PROTECTED } from './_setup.mjs'
import { pinTmpDaemonBase } from './helpers/pin-tmp-daemon-base.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { CliSession } from '../src/cli-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { DockerByokSession } from '../src/docker-byok-session.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// Every static getter that returns a tmpdir-rooted daemon base, and the class
// that owns it. Sourced from the roster test below, not from memory.
const GETTERS = [
  [ClaudeTuiSession, 'SINK_BASE', 'chroxy-claude-tui'],
  [CliSession, 'PERMISSION_MODE_SIDECAR_BASE', 'chroxy-claude-cli'],
  [CodexAppServerSession, 'ATTACH_BASE', 'chroxy-codex-attach'],
  [DockerByokSession, 'ENV_FILE_BASE', 'chroxy-byok'],
]

// `join(tmpdir(), '…')` is not the only spelling a base could take, so the scan
// is for ANY line that mentions `tmpdir` next to a `chroxy-` literal, and each
// hit must either be a recognised base or an explicitly exempt file. A scan for
// only the one spelling would answer "no new base" for a base written as
// `path.join(os.tmpdir(), "chroxy-x")` (#7273: a check that matches nothing).
const EXEMPT_FILES = new Map([
  // `chroxy-pr-body-<random>.md` — a per-call random FILE written and read back
  // inside one request; not a base a daemon validates or sweeps.
  ['ws-file-ops/git.js', 'per-call random temp file, not a daemon base'],
])

function walk (dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

function scanSourceForTmpBases () {
  const found = new Set()
  const unrecognised = []
  for (const file of walk(SRC)) {
    // EXEMPT_FILES is keyed with '/' (POSIX); on Windows the walk yields '\\'.
    const rel = file.slice(SRC.length + 1).replace(/\\/g, '/')
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return // comments mention tmpdir freely
      if (!/tmpdir/.test(line) || !/chroxy-/.test(line)) return
      const m = line.match(/join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*['"](chroxy-[\w-]+)['"]\s*\)/)
      if (m) found.add(m[1])
      else if (!EXEMPT_FILES.has(rel)) unrecognised.push(`${rel}:${i + 1}: ${line.trim()}`)
    })
  }
  return { found, unrecognised }
}

describe('tmpdir daemon-base roster (#8352)', () => {
  const { found, unrecognised } = scanSourceForTmpBases()

  it('the scan finds the known bases (positive control — a scan that finds nothing proves nothing)', () => {
    assert.ok(found.size >= 4, `expected at least the 4 known bases in src/, found ${[...found]}`)
  })

  it('every tmpdir()/chroxy-* base in src/ is in TMP_DAEMON_BASE_NAMES (source -> list)', () => {
    const missing = [...found].filter((n) => !TMP_DAEMON_BASE_NAMES.includes(n))
    assert.deepEqual(missing, [],
      `a daemon base with no row in scripts/lib/test-fs-sandbox.mjs is an unguarded hole: ${missing}`)
  })

  it('every TMP_DAEMON_BASE_NAMES row is a base the source still builds (list -> source)', () => {
    const stale = TMP_DAEMON_BASE_NAMES.filter((n) => !found.has(n))
    assert.deepEqual(stale, [], `a row that no source getter produces guards nothing: ${stale}`)
  })

  it('no src/ line pairs tmpdir with a chroxy-* literal in a shape the scan cannot classify', () => {
    assert.deepEqual(unrecognised, [],
      'add the base to TMP_DAEMON_BASE_NAMES, or exempt the file in EXEMPT_FILES with a reason')
  })

  for (const [Cls, prop, name] of GETTERS) {
    it(`${Cls.name}.${prop} resolves to tmpdir()/${name} and is in the roster`, () => {
      assert.equal(Cls[prop], join(tmpdir(), name))
      assert.ok(TMP_DAEMON_BASE_NAMES.includes(name))
    })
  }

  it('the GETTERS table above covers the whole roster', () => {
    assert.deepEqual(GETTERS.map((g) => g[2]).sort(), [...TMP_DAEMON_BASE_NAMES].sort())
  })
})

describe('sandbox guard on the live daemon bases (#8352)', () => {
  const lexicalRoot = tmpdir()
  const realRoot = realpathSync(tmpdir())

  for (const name of TMP_DAEMON_BASE_NAMES) {
    for (const [spelling, root] of [['lexical', lexicalRoot], ['realpath', realRoot]]) {
      const base = join(root, name)
      const child = join(base, 's-8352-nonexistent')

      it(`${name} (${spelling}): the base and its children are protected`, () => {
        assert.equal(SANDBOX_IS_PROTECTED(base), true, 'the base itself')
        assert.equal(SANDBOX_IS_PROTECTED(child), true, 'a session dir under it')
      })

      it(`${name} (${spelling}): rmSync / mkdirSync / writeFileSync on the real base throw CHROXY_TEST_SANDBOX`, () => {
        const code = { code: 'CHROXY_TEST_SANDBOX' }
        // Nonexistent targets only, so the probe is harmless when the guard
        // works. If the guard were MISSING, `mkdirSync` would create one empty
        // `s-8352-nonexistent` dir inside the live base; the `finally` removes
        // it so a red run does not leave the failure it reports behind.
        try {
          assert.throws(() => rmSync(child, { recursive: true, force: true }), code)
          assert.throws(() => writeFileSync(join(child, 'owner.pid'), '1'), code)
          assert.throws(() => mkdirSync(child, { recursive: true }), code)
          assert.equal(existsSync(child), false, 'and nothing was created')
        } finally {
          try { if (existsSync(child)) rmSync(child, { recursive: true, force: true }) } catch { /* guarded: nothing to clean */ }
        }
      })
    }
  }

  it('a lookalike sibling and the tests\' own temp dirs are NOT protected (a guard that denies everything proves nothing)', () => {
    for (const name of TMP_DAEMON_BASE_NAMES) {
      assert.equal(SANDBOX_IS_PROTECTED(join(lexicalRoot, `${name}-lookalike`)), false, `${name}-lookalike`)
      assert.equal(SANDBOX_IS_PROTECTED(join(lexicalRoot, name.replace('chroxy-', 'chroxy-x-'))), false)
    }
    assert.equal(SANDBOX_IS_PROTECTED(join(lexicalRoot, 'chroxy-test-daemon-base-abc', 'chroxy-claude-tui')), false)
  })

  it('tmpDaemonBaseRoots spells each base lexically AND through realpath', () => {
    const roots = tmpDaemonBaseRoots(lexicalRoot)
    for (const name of TMP_DAEMON_BASE_NAMES) {
      assert.ok(roots.includes(join(lexicalRoot, name)), `${name} lexical`)
      assert.ok(roots.includes(join(realRoot, name)), `${name} realpath`)
    }
  })
})

describe('pinTmpDaemonBase (#8352)', () => {
  it('redirects the getter to a writable temp base with the same leaf, and restores it', () => {
    const before = Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'SINK_BASE')
    const realBase = ClaudeTuiSession.SINK_BASE
    const unpin = pinTmpDaemonBase(ClaudeTuiSession, 'SINK_BASE')
    const pinned = ClaudeTuiSession.SINK_BASE
    try {
      assert.notEqual(pinned, realBase)
      assert.equal(basename(pinned), basename(realBase), 'leaf preserved')
      assert.equal(SANDBOX_IS_PROTECTED(pinned), false)
      mkdirSync(join(pinned, 's-x'), { recursive: true }) // allowed: not the real base
      assert.ok(existsSync(join(pinned, 's-x')))
    } finally {
      unpin()
    }
    assert.equal(ClaudeTuiSession.SINK_BASE, realBase, 'getter restored')
    assert.equal(Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'SINK_BASE').get, before.get)
    assert.equal(existsSync(dirname(pinned)), false, 'temp root removed')
    unpin() // idempotent
  })

  it('refuses a property that is not an own static getter', () => {
    assert.throws(() => pinTmpDaemonBase(ClaudeTuiSession, 'NOT_A_THING'), /not an own static getter/)
  })
})
