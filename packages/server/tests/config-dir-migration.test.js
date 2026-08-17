import { describe, it, beforeEach, afterEach } from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EPHEMERAL_ENTRIES,
  HIGH_CONSEQUENCE_ENTRIES,
  detectStrandedState,
  formatStrandedWarning,
  migrateStrandedState,
} from '../src/config-dir-migration.js'
import { defaultConfigDir } from '../src/config-dir.js'

/**
 * #7240 — stranded `~/.chroxy` state detection + opt-in migration.
 *
 * **Every test injects `source` and `target` explicitly**, at temp paths whose
 * basenames are NOT `.chroxy`. That is deliberate. #7238's review found two
 * "positive controls" that did not control, and one of them passed because it
 * matched any directory *named* `.chroxy` — so a name-based implementation would
 * have satisfied it while being wrong. Naming the temp dirs `src-*` / `dst-*`
 * means nothing here can pass by recognising a name.
 *
 * The one test that exercises the real `CHROXY_CONFIG_DIR` wiring
 * ("reads the environment") sets and DELETES the variable itself, because
 * `tests/_setup.mjs` injects it unconditionally for every server test — the
 * other half of that same review finding, where a control never unset the
 * variable it claimed to test.
 */

let tmpRoot
let source
let target

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'chroxy-migr-'))
  source = join(tmpRoot, 'src-state')
  target = join(tmpRoot, 'dst-state')
  mkdirSync(source, { recursive: true })
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

const write = (dir, name, body = 'x', mode = 0o600) => {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, body)
  chmodSync(p, mode)
  return p
}

const modeOf = (p) => statSync(p).mode & 0o777

describe('detectStrandedState', () => {
  it('reports entries present at the source and absent at the target', () => {
    write(source, 'config.json')
    write(source, 'session-state.json')
    mkdirSync(target, { recursive: true })
    write(target, 'session-state.json')

    const d = detectStrandedState({ source, target })

    assert.equal(d.relocated, true)
    assert.deepEqual(d.stranded, ['config.json'])
    assert.equal(d.unreadable, null)
  })

  it('reports nothing when every entry has already been migrated', () => {
    write(source, 'config.json')
    write(source, 'credentials.json')
    write(target, 'config.json')
    write(target, 'credentials.json')

    const d = detectStrandedState({ source, target })

    assert.equal(d.relocated, true)
    assert.deepEqual(d.stranded, [])
    assert.deepEqual(d.highConsequence, [])
  })

  it('is a no-op when the root is not relocated (source and target are the same dir)', () => {
    write(source, 'config.json')

    const d = detectStrandedState({ source, target: source })

    assert.equal(d.relocated, false)
    assert.deepEqual(d.stranded, [])
  })

  it('treats a symlink to the source as the same dir, not a relocation', () => {
    write(source, 'config.json')
    const link = join(tmpRoot, 'link-to-src')
    symlinkSync(source, link)

    // A string compare would call these different and report every file as
    // stranded; dev+ino identity is what makes this correct.
    const d = detectStrandedState({ source, target: link })

    assert.equal(d.relocated, false, 'a symlinked target is the same directory')
    assert.deepEqual(d.stranded, [])
  })

  it('treats a non-canonical spelling of the source as the same dir', () => {
    write(source, 'config.json')
    const spelled = join(source, '..', 'src-state')

    const d = detectStrandedState({ source, target: spelled })

    assert.equal(d.relocated, false)
  })

  it('classifies the destructive entries as high-consequence', () => {
    for (const name of ['config.json', 'server-identity.json', 'credentials.json', 'push-tokens.json']) {
      write(source, name)
    }

    const d = detectStrandedState({ source, target })

    assert.deepEqual(d.highConsequence, ['config.json', 'server-identity.json', 'credentials.json'])
    assert.ok(d.stranded.includes('push-tokens.json'), 'non-sharp entries are still stranded')
  })

  it('excludes runtime-ephemeral entries from the stranded set', () => {
    for (const name of EPHEMERAL_ENTRIES) write(source, name)

    const d = detectStrandedState({ source, target })

    assert.equal(d.relocated, true)
    assert.deepEqual(d.stranded, [], 'a stale pid/lock is not state worth reporting')
  })

  it('reports nothing when the source does not exist', () => {
    rmSync(source, { recursive: true, force: true })

    const d = detectStrandedState({ source, target })

    assert.equal(d.relocated, true)
    assert.deepEqual(d.stranded, [])
  })

  it('reports an unreadable source instead of throwing', () => {
    // A file where a directory is expected — readdir fails, and the boot path
    // must degrade rather than crash the daemon.
    const notADir = write(source, 'config.json')

    const d = detectStrandedState({ source: notADir, target })

    assert.equal(d.relocated, true)
    assert.ok(d.unreadable, 'the readdir failure is surfaced, not swallowed')
    assert.deepEqual(d.stranded, [])
  })

  it('detects entries that are directories, not just files', () => {
    mkdirSync(join(source, 'skills'), { recursive: true })

    const d = detectStrandedState({ source, target })

    assert.deepEqual(d.stranded, ['skills'])
  })

  it('reads CHROXY_CONFIG_DIR at call time for its default target', () => {
    // The env seam, exercised end-to-end. _setup.mjs sets CHROXY_CONFIG_DIR for
    // every server test, so this test owns save/restore — including the DELETE
    // branch, which is the case a control that only ever sets the variable
    // silently never reaches.
    const saved = process.env.CHROXY_CONFIG_DIR
    try {
      write(source, 'config.json')

      process.env.CHROXY_CONFIG_DIR = target
      const relocated = detectStrandedState({ source })
      assert.equal(relocated.target, target, 'the default target follows the env var')
      assert.deepEqual(relocated.stranded, ['config.json'])

      delete process.env.CHROXY_CONFIG_DIR
      const unset = detectStrandedState({ source })
      assert.equal(unset.target, defaultConfigDir(), 'unset falls back to ~/.chroxy')
      assert.equal(unset.relocated, true, 'the injected source is not the real home')
    } finally {
      if (saved === undefined) delete process.env.CHROXY_CONFIG_DIR
      else process.env.CHROXY_CONFIG_DIR = saved
    }
  })

  it('is not relocated when CHROXY_CONFIG_DIR is relative (config-dir.js refuses it)', () => {
    const saved = process.env.CHROXY_CONFIG_DIR
    try {
      process.env.CHROXY_CONFIG_DIR = 'relative-state'
      // configDir() refuses a relative value back to ~/.chroxy, so a detection
      // that used the raw env value would claim a relocation that never happened.
      const d = detectStrandedState({ source: defaultConfigDir() })
      assert.equal(d.relocated, false)
    } finally {
      if (saved === undefined) delete process.env.CHROXY_CONFIG_DIR
      else process.env.CHROXY_CONFIG_DIR = saved
    }
  })
})

describe('formatStrandedWarning', () => {
  it('says nothing when nothing is stranded', () => {
    write(target, 'config.json')
    write(source, 'config.json')
    assert.deepEqual(formatStrandedWarning(detectStrandedState({ source, target })), [])
  })

  it('says nothing when the root is not relocated', () => {
    write(source, 'config.json')
    assert.deepEqual(formatStrandedWarning(detectStrandedState({ source, target: source })), [])
  })

  it('names the stranded entries, both roots, and the remedy', () => {
    write(source, 'session-state.json')
    const text = formatStrandedWarning(detectStrandedState({ source, target })).join('\n')

    assert.match(text, /session-state\.json/)
    assert.match(text, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(text, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(text, /chroxy config-dir migrate/)
  })

  it('warns against chroxy init only when config.json is the stranded file', () => {
    write(source, 'config.json')
    const withConfig = formatStrandedWarning(detectStrandedState({ source, target })).join('\n')
    assert.match(withConfig, /Do NOT run 'chroxy init'/)

    rmSync(join(source, 'config.json'))
    write(source, 'push-tokens.json')
    const without = formatStrandedWarning(detectStrandedState({ source, target })).join('\n')
    assert.doesNotMatch(without, /chroxy init/, 'init advice is scoped to the case it applies to')
  })

  it('shell-quotes both paths in the cp hint', () => {
    // The hint is a command a human copies and runs. Unquoted, a path with a
    // space becomes a DIFFERENT command — `cp -a /srv/my state/. /dst/` copies
    // two wrong sources — and a metacharacter is worse than wrong.
    const spaced = join(tmpRoot, 'dir with spaces')
    mkdirSync(spaced, { recursive: true })
    write(spaced, 'config.json')

    const text = formatStrandedWarning(detectStrandedState({ source: spaced, target })).join('\n')
    const cp = text.split('\n').find((l) => l.includes('cp -a'))

    assert.ok(cp.includes(`'${spaced}/.'`), `source not quoted in: ${cp}`)
    assert.ok(cp.includes(`'${target}/'`), `target not quoted in: ${cp}`)
  })

  it('escapes an embedded single quote rather than breaking out of the quoting', () => {
    const tricky = join(tmpRoot, "o'brien")
    mkdirSync(tricky, { recursive: true })
    write(tricky, 'config.json')

    const text = formatStrandedWarning(detectStrandedState({ source: tricky, target })).join('\n')
    const cp = text.split('\n').find((l) => l.includes('cp -a'))

    // The close-escape-reopen idiom, not a raw quote that would terminate the
    // string. The opening quote sits at the head of the whole path, not next to
    // the `o`, so match only the escape itself.
    assert.match(cp, /o'\\''brien\/\.'/)
  })

  it('the printed cp command actually runs, for a path with a space and a quote', () => {
    // Pattern-matching the quoting only proves it looks right. A naive
    // "quote count must be even" check is itself wrong here — `'a'\''b'` is
    // valid POSIX with five quotes — so the only honest assertion is to hand
    // the produced command to a real shell and see what it does.
    const nasty = join(tmpRoot, "weird 'dir' name")
    mkdirSync(nasty, { recursive: true })
    write(nasty, 'config.json', 'PAYLOAD')
    mkdirSync(target, { recursive: true })

    const text = formatStrandedWarning(detectStrandedState({ source: nasty, target })).join('\n')
    const cp = text.split('\n').find((l) => l.includes('cp -a')).replace(/^\s*or:\s*/, '').trim()

    const res = spawnSync('sh', ['-c', cp], { encoding: 'utf8' })

    assert.equal(res.status, 0, `command failed: ${cp}\n${res.stderr}`)
    assert.equal(readFileSync(join(target, 'config.json'), 'utf-8'), 'PAYLOAD',
      'the copy-pasteable hint must copy the right thing')
  })

  it('calls out the identity-key MITM consequence when server-identity.json is stranded', () => {
    write(source, 'server-identity.json')
    const text = formatStrandedWarning(detectStrandedState({ source, target })).join('\n')
    assert.match(text, /MITM/)
  })
})

describe('migrateStrandedState', () => {
  it('copies stranded entries into the target', () => {
    write(source, 'config.json', '{"apiToken":"t"}')
    write(source, 'session-state.json', '{}')

    const r = migrateStrandedState({ source, target })

    assert.deepEqual(r.copied.sort(), ['config.json', 'session-state.json'])
    assert.deepEqual(r.failed, [])
    assert.equal(readFileSync(join(target, 'config.json'), 'utf-8'), '{"apiToken":"t"}')
  })

  it('preserves 0600 file modes', () => {
    write(source, 'credentials.json', 'secret', 0o600)

    migrateStrandedState({ source, target })

    assert.equal(modeOf(join(target, 'credentials.json')), 0o600)
  })

  it('preserves 0700 directory modes', () => {
    // cpSync preserves file modes but creates directories at the default 0755 —
    // verified, not assumed. Without the explicit mode mirror, a 0700 skills/
    // dir holding runtime prompts widens to world-readable on migration.
    const skills = join(source, 'skills')
    mkdirSync(skills, { recursive: true })
    write(skills, 'a.md', '# skill', 0o600)
    chmodSync(skills, 0o700)

    migrateStrandedState({ source, target })

    assert.equal(modeOf(join(target, 'skills')), 0o700, 'directory mode must not widen on copy')
    assert.equal(modeOf(join(target, 'skills', 'a.md')), 0o600)
  })

  it('preserves modes on nested directories', () => {
    const nested = join(source, 'worktrees', 'inner')
    mkdirSync(nested, { recursive: true })
    write(nested, 'f', 'x', 0o600)
    chmodSync(nested, 0o700)
    chmodSync(join(source, 'worktrees'), 0o700)

    migrateStrandedState({ source, target })

    assert.equal(modeOf(join(target, 'worktrees')), 0o700)
    assert.equal(modeOf(join(target, 'worktrees', 'inner')), 0o700)
  })

  it('never overwrites an entry already present in the target', () => {
    write(source, 'config.json', 'FROM-SOURCE')
    write(target, 'config.json', 'FROM-TARGET')

    const r = migrateStrandedState({ source, target })

    assert.deepEqual(r.copied, [])
    assert.equal(readFileSync(join(target, 'config.json'), 'utf-8'), 'FROM-TARGET',
      'the target root is authoritative — migration must never clobber it')
  })

  it('refuses to overwrite even when detection is stale (the TOCTOU race)', () => {
    // The detection above filters out anything already in the target, so the
    // cpSync flags never fire on the happy path — which means a test that only
    // pre-populates the target proves nothing about them. Feed a DELIBERATELY
    // STALE detection instead: the state after `detect` ran, then something else
    // created the file before the copy. That is the only way the second lock is
    // reachable, and without it `errorOnExist`/`force` are unverified.
    write(source, 'config.json', 'FROM-SOURCE')
    write(target, 'config.json', 'WRITTEN-AFTER-DETECTION')

    const stale = {
      relocated: true,
      source,
      target,
      stranded: ['config.json'],
      highConsequence: ['config.json'],
      unreadable: null,
    }
    const r = migrateStrandedState({ detection: stale })

    assert.deepEqual(r.copied, [], 'the copy must lose the race, not win it')
    assert.equal(r.failed.length, 1)
    assert.equal(readFileSync(join(target, 'config.json'), 'utf-8'), 'WRITTEN-AFTER-DETECTION')
  })

  it('leaves the source in place (it copies, it does not move)', () => {
    write(source, 'config.json', 'body')

    migrateStrandedState({ source, target })

    assert.ok(existsSync(join(source, 'config.json')), 'the operator keeps a fallback')
  })

  it('creates the target at 0700 when it does not exist', () => {
    write(source, 'config.json')
    assert.equal(existsSync(target), false)

    migrateStrandedState({ source, target })

    assert.equal(modeOf(target), 0o700)
  })

  it('does nothing when the root is not relocated', () => {
    write(source, 'config.json')

    const r = migrateStrandedState({ source, target: source })

    assert.equal(r.reason, 'not-relocated')
    assert.deepEqual(r.copied, [])
  })

  it('does nothing when there is nothing stranded', () => {
    write(source, 'config.json')
    write(target, 'config.json')

    const r = migrateStrandedState({ source, target })

    assert.equal(r.reason, 'nothing-stranded')
  })

  it('skips runtime-ephemeral entries', () => {
    write(source, 'supervisor.pid', '4242')
    write(source, 'config.json')

    const r = migrateStrandedState({ source, target })

    assert.deepEqual(r.copied, ['config.json'])
    assert.equal(existsSync(join(target, 'supervisor.pid')), false,
      'a PID from the previous root must not follow the state forward')
  })

  it('reports a per-entry failure without abandoning the rest', () => {
    write(source, 'config.json', 'ok')
    const dangling = join(source, 'broken-link')
    symlinkSync(join(tmpRoot, 'does-not-exist'), dangling)

    const r = migrateStrandedState({ source, target })

    assert.ok(r.copied.includes('config.json'), 'a good entry still lands')
    assert.equal(r.copied.includes('broken-link'), false)
    assert.equal(r.failed.length, 1)
    assert.equal(r.failed[0].name, 'broken-link')
  })

  it('converges when re-run after a partial migration', () => {
    write(source, 'config.json')
    write(source, 'credentials.json')
    write(target, 'config.json')

    const first = migrateStrandedState({ source, target })
    assert.deepEqual(first.copied, ['credentials.json'])

    const second = migrateStrandedState({ source, target })
    assert.equal(second.reason, 'nothing-stranded')
  })
})

describe('HIGH_CONSEQUENCE_ENTRIES', () => {
  it('names the entries whose loss is destructive rather than inconvenient', () => {
    // Pinned so a future edit that drops one has to say so: losing config.json
    // costs every paired device a re-pair, and losing server-identity.json makes
    // pinned clients report a MITM.
    assert.deepEqual(HIGH_CONSEQUENCE_ENTRIES,
      ['config.json', 'server-identity.json', 'credentials.json'])
  })
})

describe('the stranded set is derived, not enumerated', () => {
  it('flags a state file no list in this repo has ever mentioned', () => {
    // The guard against docs/false-safety-guards.md's "hardcoded list next to a
    // set that grows". A future module writing a new state file must be covered
    // the day it ships, with nothing to update here.
    write(source, 'a-state-file-invented-by-this-test.json')

    const d = detectStrandedState({ source, target })

    assert.deepEqual(d.stranded, ['a-state-file-invented-by-this-test.json'])
  })

  it('flags every entry the source holds, not a fixed subset', () => {
    const names = Array.from({ length: 25 }, (_, i) => `state-${i}.json`)
    for (const n of names) write(source, n)

    const d = detectStrandedState({ source, target })

    assert.equal(d.stranded.length, 25)
    assert.deepEqual(new Set(d.stranded), new Set(names))
    assert.deepEqual(readdirSync(source).sort(), d.stranded, 'nothing is filtered out silently')
  })
})
