/**
 * Tests for scripts/lint-nofollow-nonblock.mjs (#7938).
 *
 * The lint gates every raw fs `open()`/`openSync()` call whose flags include
 * `O_NOFOLLOW`: it must also include `O_NONBLOCK`, or carry an allowlist
 * reason. Strategy: run the lint as a child process against a temp fixture
 * `src/` tree (`--src-dir`) and assert the EXIT CODE, not just the printed
 * text — matching `lint-argv-sinks.test.js`'s convention. Every positive
 * result below carries a POSITIVE CONTROL proving the case would have failed
 * without the thing that's supposed to save it (docs/false-safety-guards.md).
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LINT_SCRIPT = resolve(__dirname, '..', 'scripts', 'lint-nofollow-nonblock.mjs')

const tmpRoots = []
after(() => {
  for (const d of tmpRoots) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

/**
 * Build a fixture src/ tree and run the lint against it.
 * @param {Record<string,string>} files repo-relative path -> source
 * @param {{ extraArgs?: string[] }} [opts]
 */
function runLint(files, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'chroxy-lint-nofollow-'))
  tmpRoots.push(root)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })

  for (const [rel, source] of Object.entries(files)) {
    const full = join(srcDir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, source)
  }

  const args = [LINT_SCRIPT, '--src-dir', srcDir, ...(opts.extraArgs ?? [])]
  const res = spawnSync(process.execPath, args, { encoding: 'utf8' })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

// ─── Fixture sources ────────────────────────────────────────────────────────

const DIRECT_LITERAL_UNGUARDED = `
import { openSync, constants as fsConstants } from 'node:fs'
export function readIt(p) {
  return openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
}
`

const DIRECT_LITERAL_GUARDED = `
import { openSync, constants as fsConstants } from 'node:fs'
export function readIt(p) {
  return openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
}
`

const DESTRUCTURED_CONSTANTS_UNGUARDED = `
import { openSync, constants } from 'node:fs'
const { O_RDONLY, O_NOFOLLOW } = constants
export function readIt(p) {
  return openSync(p, O_RDONLY | O_NOFOLLOW)
}
`

const DESTRUCTURED_CONSTANTS_GUARDED = `
import { openSync, constants } from 'node:fs'
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants
export function readIt(p) {
  return openSync(p, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
}
`

const CONST_HELD_MULTILINE_UNGUARDED = `
import { openSync, constants as fsConstants } from 'node:fs'
const FLAGS =
  fsConstants.O_RDONLY |
  fsConstants.O_NOFOLLOW
export function readIt(p) {
  return openSync(
    p,
    FLAGS,
  )
}
`

const CONST_HELD_MULTILINE_GUARDED = `
import { openSync, constants as fsConstants } from 'node:fs'
const FLAGS =
  fsConstants.O_RDONLY |
  fsConstants.O_NOFOLLOW |
  fsConstants.O_NONBLOCK
export function readIt(p) {
  return openSync(
    p,
    FLAGS,
  )
}
`

// claude-hooks/config.js's real shape: a `let` mutated via conditional `|=`.
const LET_COMPOUND_ASSIGNMENT_GUARDED = `
import { openSync, constants as fsConstants } from 'node:fs'
export function readIt(p, isWin32) {
  let flags = fsConstants.O_RDONLY
  if (!isWin32) flags |= fsConstants.O_NOFOLLOW
  if (!isWin32) flags |= fsConstants.O_NONBLOCK
  return openSync(p, flags)
}
`

const LET_COMPOUND_ASSIGNMENT_UNGUARDED = `
import { openSync, constants as fsConstants } from 'node:fs'
export function readIt(p, isWin32) {
  let flags = fsConstants.O_RDONLY
  if (!isWin32) flags |= fsConstants.O_NOFOLLOW
  return openSync(p, flags)
}
`

const UNRESOLVABLE_CALL_EXPRESSION = `
import { openSync, constants as fsConstants } from 'node:fs'
import { getExtraFlags } from './extra.js'
export function readIt(p) {
  return openSync(p, fsConstants.O_NOFOLLOW | getExtraFlags())
}
`

const ALLOWLISTED_WITH_REASON = `
import { openSync, constants as fsConstants } from 'node:fs'
export function openDir(p) {
  // lint-allow-nofollow-blocking: O_DIRECTORY — a FIFO cannot satisfy O_DIRECTORY, so blocking is impossible here
  return openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY)
}
`

const ALLOWLIST_MARKER_WITHOUT_REASON = `
import { openSync, constants as fsConstants } from 'node:fs'
export function openDir(p) {
  // lint-allow-nofollow-blocking:
  return openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY)
}
`

const ASYNC_FS_PROMISES_OPEN_UNGUARDED = `
import { open } from 'fs/promises'
import { constants as fsConstants } from 'fs'
export async function readIt(p) {
  return open(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
}
`

const ASYNC_FS_PROMISES_OPEN_GUARDED = `
import { open } from 'fs/promises'
import { constants as fsConstants } from 'fs'
export async function readIt(p) {
  return open(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
}
`

const NAMESPACE_IMPORT_UNGUARDED = `
import * as fs from 'node:fs'
export function readIt(p) {
  return fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
}
`

// Mirrors open-nofollow.js's own dependency-injection seam: the real `open`
// arrives as a destructured PARAMETER (not an fs import), so it is only
// recognised via the RESERVED_OPEN_NAMES literal-name rule.
const DI_SEAM_PARAMETER_UNGUARDED = `
export async function openNoFollowLike(path, flags, mode, deps) {
  const { oNofollow, open } = deps
  return open(path, flags | oNofollow, mode)
}
`

const DI_SEAM_PARAMETER_GUARDED = `
export async function openNoFollowLike(path, flags, mode, deps) {
  const { oNofollow, open } = deps
  const O_NONBLOCK = 0x800
  return open(path, flags | oNofollow | O_NONBLOCK, mode)
}
`

// A string mode specifier ('ax', 'r', …) is not a flags bitmask at all.
const STRING_MODE_SPECIFIER_IRRELEVANT = `
import { openSync } from 'node:fs'
export function createIt(p) {
  return openSync(p, 'ax', 0o600)
}
`

// No O_NOFOLLOW anywhere — an ordinary, unrelated open.
const NO_NOFOLLOW_AT_ALL = `
import { openSync, constants as fsConstants } from 'node:fs'
export function readIt(p) {
  return openSync(p, fsConstants.O_RDONLY)
}
`

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('#7938 lint-nofollow-nonblock — direct literal flags', () => {
  test('red: O_RDONLY | O_NOFOLLOW with no O_NONBLOCK', () => {
    const { status, stderr } = runLint({ 'a.js': DIRECT_LITERAL_UNGUARDED })
    assert.equal(status, 1)
    assert.match(stderr, /missing O_NONBLOCK/)
  })

  test('green: same call plus | O_NONBLOCK (positive control for the red case above)', () => {
    const { status, stdout } = runLint({ 'a.js': DIRECT_LITERAL_GUARDED })
    assert.equal(status, 0)
    assert.match(stdout, /OK:/)
  })
})

describe('#7938 lint-nofollow-nonblock — destructured constants', () => {
  test('red: const { O_NOFOLLOW } = fs.constants, no O_NONBLOCK', () => {
    const { status, stderr } = runLint({ 'a.js': DESTRUCTURED_CONSTANTS_UNGUARDED })
    assert.equal(status, 1)
    assert.match(stderr, /missing O_NONBLOCK/)
  })

  test('green: same, destructured O_NONBLOCK also present', () => {
    const { status } = runLint({ 'a.js': DESTRUCTURED_CONSTANTS_GUARDED })
    assert.equal(status, 0)
  })
})

describe('#7938 lint-nofollow-nonblock — const-held, multi-line calls', () => {
  test('red: flags held in a module const, call spread across multiple lines', () => {
    const { status, stderr } = runLint({ 'a.js': CONST_HELD_MULTILINE_UNGUARDED })
    assert.equal(status, 1)
    assert.match(stderr, /missing O_NONBLOCK/)
    // Proves this is AST-based, not a same-line grep: neither the flags
    // definition nor the call site has O_NOFOLLOW/O_NONBLOCK on one line.
  })

  test('green: same shape with O_NONBLOCK also OR-ed into the const', () => {
    const { status } = runLint({ 'a.js': CONST_HELD_MULTILINE_GUARDED })
    assert.equal(status, 0)
  })
})

describe('#7938 lint-nofollow-nonblock — let + conditional compound assignment (claude-hooks/config.js shape)', () => {
  test('green: flags built via `let` + two conditional |=, both present', () => {
    const { status } = runLint({ 'a.js': LET_COMPOUND_ASSIGNMENT_GUARDED })
    assert.equal(status, 0)
  })

  test('red: same shape missing the O_NONBLOCK |= (positive control for the green case above)', () => {
    const { status, stderr } = runLint({ 'a.js': LET_COMPOUND_ASSIGNMENT_UNGUARDED })
    assert.equal(status, 1)
    assert.match(stderr, /missing O_NONBLOCK/)
  })
})

describe('#7938 lint-nofollow-nonblock — unresolvable flags expression', () => {
  test('red: O_NOFOLLOW present but ORed with an opaque function call — never passes', () => {
    const { status, stderr } = runLint({ 'a.js': UNRESOLVABLE_CALL_EXPRESSION })
    assert.equal(status, 1)
    assert.match(stderr, /could not be fully resolved/)
  })
})

describe('#7938 lint-nofollow-nonblock — allowlist', () => {
  test('green: allowlisted with a non-empty reason', () => {
    const { status } = runLint({ 'a.js': ALLOWLISTED_WITH_REASON })
    assert.equal(status, 0)
  })

  test('red: allowlist marker present but WITHOUT a reason — must not be honoured', () => {
    const { status, stderr } = runLint({ 'a.js': ALLOWLIST_MARKER_WITHOUT_REASON })
    assert.equal(status, 1)
    assert.match(stderr, /missing O_NONBLOCK/)
  })
})

describe('#7938 lint-nofollow-nonblock — async fs/promises open()', () => {
  test('red: fs/promises open() missing O_NONBLOCK', () => {
    const { status, stderr } = runLint({ 'a.js': ASYNC_FS_PROMISES_OPEN_UNGUARDED })
    assert.equal(status, 1)
    assert.match(stderr, /missing O_NONBLOCK/)
  })

  test('green: same, with O_NONBLOCK (positive control)', () => {
    const { status } = runLint({ 'a.js': ASYNC_FS_PROMISES_OPEN_GUARDED })
    assert.equal(status, 0)
  })
})

describe('#7938 lint-nofollow-nonblock — namespace import (fs.openSync / fs.constants)', () => {
  test('red: import * as fs, fs.openSync(p, fs.constants.O_NOFOLLOW), no O_NONBLOCK', () => {
    const { status, stderr } = runLint({ 'a.js': NAMESPACE_IMPORT_UNGUARDED })
    assert.equal(status, 1)
    assert.match(stderr, /missing O_NONBLOCK/)
  })
})

describe('#7938 lint-nofollow-nonblock — dependency-injection seam (open-nofollow.js shape)', () => {
  test('red: a call to a bare `open` identifier bound via destructuring from a parameter, not an fs import', () => {
    const { status, stderr } = runLint({ 'a.js': DI_SEAM_PARAMETER_UNGUARDED })
    assert.equal(status, 1, 'the reserved-name rule must catch this even though `open` is not imported from fs')
    assert.match(stderr, /missing O_NONBLOCK/)
  })

  test('green: same shape with O_NONBLOCK added (positive control, and the real open-nofollow.js regression case)', () => {
    const { status } = runLint({ 'a.js': DI_SEAM_PARAMETER_GUARDED })
    assert.equal(status, 0)
  })
})

describe('#7938 lint-nofollow-nonblock — non-candidates are never flagged', () => {
  test('a string mode specifier ("ax") is not a flags bitmask — skipped, not flagged', () => {
    const { status, stdout } = runLint({ 'a.js': STRING_MODE_SPECIFIER_IRRELEVANT })
    assert.equal(status, 2, 'the ONLY file in this fixture has no O_NOFOLLOW evidence at all — zero-findings fail-closed applies')
    // (see the dedicated zero-findings describe block below for the direct assertion)
    void stdout
  })

  test('an open() with no O_NOFOLLOW evidence anywhere is not a candidate (companion file carries real evidence)', () => {
    const { status } = runLint({ 'unrelated.js': NO_NOFOLLOW_AT_ALL, 'real.js': DIRECT_LITERAL_GUARDED })
    assert.equal(status, 0, 'the unrelated open must not be flagged, and the real O_NOFOLLOW open is already guarded')
  })
})

describe('#7938 lint-nofollow-nonblock — fail-closed on zero O_NOFOLLOW opens found', () => {
  test('exit 2 when the scanned tree has open() calls but none reference O_NOFOLLOW', () => {
    const { status, stderr } = runLint({ 'a.js': NO_NOFOLLOW_AT_ALL })
    assert.equal(status, 2)
    assert.match(stderr, /found 0 O_NOFOLLOW-flavoured open/)
  })

  test('exit 2 when the scanned tree has no matching files at all (--min-files floor)', () => {
    const { status, stderr } = runLint({ 'a.js': NO_NOFOLLOW_AT_ALL }, { extraArgs: ['--min-files', '5'] })
    assert.equal(status, 2)
    assert.match(stderr, /scanned only 1 file/)
  })
})

describe('#7938 lint-nofollow-nonblock — --dry-run never fails the exit code', () => {
  test('a real offender still prints, but exits 0 under --dry-run', () => {
    const { status, stderr } = runLint({ 'a.js': DIRECT_LITERAL_UNGUARDED }, { extraArgs: ['--dry-run'] })
    assert.equal(status, 0)
    assert.match(stderr, /missing O_NONBLOCK/)
  })
})
