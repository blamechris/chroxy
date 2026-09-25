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
 * @param {{ extraArgs?: string[], outside?: Record<string,string> }} [opts]
 *   `outside` files are written to a sibling tree passed as `--roster-dir`:
 *   files the lint does NOT scan but must prove free of O_NOFOLLOW.
 */
function runLint(files, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'chroxy-lint-nofollow-'))
  tmpRoots.push(root)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })

  const writeTree = (dir, tree) => {
    for (const [rel, source] of Object.entries(tree)) {
      const full = join(dir, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, source)
    }
  }
  writeTree(srcDir, files)
  const rosterArgs = []
  if (opts.outside) {
    const otherDir = join(root, 'other')
    mkdirSync(otherDir, { recursive: true })
    writeTree(otherDir, opts.outside)
    rosterArgs.push('--roster-dir', otherDir)
  }

  const args = [LINT_SCRIPT, '--src-dir', srcDir, ...rosterArgs, ...(opts.extraArgs ?? [])]
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

// open-nofollow.js's real O_NONBLOCK spelling: a platform-fallback const.
const DI_SEAM_PARAMETER_GUARDED = `
import { constants as fsConstants } from 'node:fs'
const HAS_O_NONBLOCK = typeof fsConstants.O_NONBLOCK === 'number' && fsConstants.O_NONBLOCK !== 0
const O_NONBLOCK = HAS_O_NONBLOCK ? fsConstants.O_NONBLOCK : 0
export async function openNoFollowLike(path, flags, mode, deps) {
  const { oNofollow, open } = deps
  return open(path, flags | oNofollow | O_NONBLOCK, mode)
}
`

// A hardcoded number merely NAMED O_NONBLOCK is not trusted by its name:
// 0x800 is O_NONBLOCK on Linux but O_EXCL on macOS (where O_NONBLOCK is 4).
const DI_SEAM_HARDCODED_NONBLOCK = `
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
    const { status, stderr } = runLint({ 'a.js': DI_SEAM_PARAMETER_GUARDED })
    assert.equal(status, 0, stderr)
  })

  test('red: an O_NONBLOCK-NAMED local holding a hardcoded number is not trusted by its name', () => {
    const { status, stderr } = runLint({ 'a.js': DI_SEAM_HARDCODED_NONBLOCK })
    assert.equal(status, 1)
    assert.ok(/missing O_NONBLOCK/.test(stderr), stderr)
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
    assert.match(stderr, /found 0 call arguments carrying O_NOFOLLOW/)
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

// ─── Flows a callee-gated check cannot see (review of #7955) ────────────────
//
// Each case is a RED fixture that must exit 1 and its GUARDED twin that must
// exit 0 — the twin is the positive control proving the red is about the
// missing O_NONBLOCK, not a lint that flags everything. Every tree also gets
// CONTROL, a guarded direct open, so a case whose only O_NOFOLLOW flow is
// caught by the REVERSE check can never fall into the zero-found exit 2 and
// be misread. Every red case here exited 0 against the lint as first
// submitted in #7955 (21 of the 23 shapes tried passed it).

const CONTROL = `
import { openSync, constants as c } from 'node:fs'
export function control(p) { return openSync(p, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK) }
`

const FLOW_CASES = [
  {
    name: 'flags const exported from another module',
    red: {
      'x.js': "import { constants as c } from 'node:fs'\nexport const SAFE_FLAGS = c.O_RDONLY | c.O_NOFOLLOW\n",
      'y.js': "import { openSync } from 'node:fs'\nimport { SAFE_FLAGS } from './x.js'\nexport function r(p) { return openSync(p, SAFE_FLAGS) }\n",
    },
    green: {
      'x.js': "import { constants as c } from 'node:fs'\nexport const SAFE_FLAGS = c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK\n",
      'y.js': "import { openSync } from 'node:fs'\nimport { SAFE_FLAGS } from './x.js'\nexport function r(p) { return openSync(p, SAFE_FLAGS) }\n",
    },
  },
  {
    name: 'flags passed through a function parameter',
    red: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nfunction openIt(p, flags) { return openSync(p, flags) }\nexport function r(p) { return openIt(p, c.O_RDONLY | c.O_NOFOLLOW) }\n" },
    green: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nfunction openIt(p, flags) { return openSync(p, flags) }\nexport function r(p) { return openIt(p, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK) }\n" },
  },
  {
    name: 'fs.constants destructured under an alias',
    red: { 'a.js': "import { openSync, constants } from 'node:fs'\nconst { O_NOFOLLOW: NF, O_RDONLY } = constants\nexport function r(p) { return openSync(p, O_RDONLY | NF) }\n" },
    green: { 'a.js': "import { openSync, constants } from 'node:fs'\nconst { O_NOFOLLOW: NF, O_NONBLOCK: NB, O_RDONLY } = constants\nexport function r(p) { return openSync(p, O_RDONLY | NF | NB) }\n" },
  },
  {
    name: "constants['O_NOFOLLOW'] element access",
    red: { 'a.js': "import { openSync, constants } from 'node:fs'\nexport function r(p) { return openSync(p, constants.O_RDONLY | constants['O_NOFOLLOW']) }\n" },
    green: { 'a.js': "import { openSync, constants } from 'node:fs'\nexport function r(p) { return openSync(p, constants.O_RDONLY | constants['O_NOFOLLOW'] | constants['O_NONBLOCK']) }\n" },
  },
  {
    name: 'O_NOFOLLOW imported from node:constants under an alias',
    red: { 'a.js': "import { openSync } from 'node:fs'\nimport { O_NOFOLLOW as NF, O_RDONLY } from 'node:constants'\nexport function r(p) { return openSync(p, O_RDONLY | NF) }\n" },
    green: { 'a.js': "import { openSync } from 'node:fs'\nimport { O_NOFOLLOW as NF, O_NONBLOCK as NB, O_RDONLY } from 'node:constants'\nexport function r(p) { return openSync(p, O_RDONLY | NF | NB) }\n" },
  },
  {
    name: 'fs.promises held in a const (fsp.open)',
    red: { 'a.js': "import fs from 'node:fs'\nconst fsp = fs.promises\nexport function r(p) { return fsp.open(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) }\n" },
    green: { 'a.js': "import fs from 'node:fs'\nconst fsp = fs.promises\nexport function r(p) { return fsp.open(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) }\n" },
  },
  {
    name: 'callback fs.open imported under an alias',
    red: { 'a.js': "import { open as fsOpen, constants as c } from 'node:fs'\nexport function r(p, cb) { return fsOpen(p, c.O_RDONLY | c.O_NOFOLLOW, cb) }\n" },
    green: { 'a.js': "import { open as fsOpen, constants as c } from 'node:fs'\nexport function r(p, cb) { return fsOpen(p, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK, cb) }\n" },
  },
  {
    name: 'dependency-injected open renamed to doOpen (trusted-file-read.js shape)',
    red: { 'a.js': "import { constants as c } from 'node:fs'\nexport function r(p, deps) { const { openSync: doOpen, oNofollow } = deps; return doOpen(p, c.O_RDONLY | oNofollow) }\n" },
    green: { 'a.js': "import { constants as c } from 'node:fs'\nexport function r(p, deps) { const { openSync: doOpen, oNofollow } = deps; return doOpen(p, c.O_RDONLY | oNofollow | c.O_NONBLOCK) }\n" },
  },
  {
    name: 'deps.openSync member call',
    red: { 'a.js': "import { constants as c } from 'node:fs'\nexport function r(p, deps) { return deps.openSync(p, c.O_RDONLY | c.O_NOFOLLOW) }\n" },
    green: { 'a.js': "import { constants as c } from 'node:fs'\nexport function r(p, deps) { return deps.openSync(p, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK) }\n" },
  },
  {
    name: 'a ternary whose O_NOFOLLOW branch lacks O_NONBLOCK',
    red: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport function r(p, x) { return openSync(p, x ? (c.O_RDONLY | c.O_NOFOLLOW) : (c.O_RDONLY | c.O_NONBLOCK)) }\n" },
    green: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport function r(p, x) { return openSync(p, x ? (c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK) : (c.O_RDONLY | c.O_NONBLOCK)) }\n" },
  },
  {
    name: 'a reassignment that drops O_NONBLOCK',
    red: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport function r(p, x) {\n  let flags = c.O_RDONLY | c.O_NONBLOCK\n  if (x) flags = c.O_RDONLY | c.O_NOFOLLOW\n  return openSync(p, flags)\n}\n" },
    green: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport function r(p, x) {\n  let flags = c.O_RDONLY | c.O_NONBLOCK\n  if (x) flags = c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK\n  return openSync(p, flags)\n}\n" },
  },
  {
    name: 'flags &= ~O_NONBLOCK after it was ORed in',
    red: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport function r(p) {\n  let flags = c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK\n  flags &= ~c.O_NONBLOCK\n  return openSync(p, flags)\n}\n" },
    green: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport function r(p) {\n  let flags = c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK\n  return openSync(p, flags)\n}\n" },
  },
  {
    name: '(flags | oNofollow) & ~O_NONBLOCK masking inside the expression',
    red: { 'a.js': "import { constants as c } from 'node:fs'\nexport function r(p, flags, deps) { const { open, oNofollow } = deps; return open(p, (flags | oNofollow) & ~c.O_NONBLOCK) }\n" },
    green: { 'a.js': "import { constants as c } from 'node:fs'\nexport function r(p, flags, deps) { const { open, oNofollow } = deps; return open(p, flags | oNofollow | c.O_NONBLOCK) }\n" },
  },
  {
    name: 'an O_NONBLOCK add guarded by an unrelated option',
    red: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport function r(p, opts) {\n  let flags = c.O_RDONLY | c.O_NOFOLLOW\n  if (opts.nonBlocking) flags |= c.O_NONBLOCK\n  return openSync(p, flags)\n}\n" },
    // claude-hooks/src/config.js's real shape: each add guarded by its OWN
    // feature detection; the O_NONBLOCK add is missing only where the
    // platform has no O_NONBLOCK.
    green: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport function r(p) {\n  const hasONoFollow = typeof c.O_NOFOLLOW === 'number'\n  const hasONonBlock = typeof c.O_NONBLOCK === 'number'\n  let flags = c.O_RDONLY\n  if (hasONoFollow) flags |= c.O_NOFOLLOW\n  if (hasONonBlock) flags |= c.O_NONBLOCK\n  return openSync(p, flags)\n}\n" },
  },
  {
    name: 'flags stored on this.flags',
    red: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport class K {\n  constructor() { this.flags = c.O_RDONLY | c.O_NOFOLLOW }\n  r(p) { return openSync(p, this.flags) }\n}\n" },
    green: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport class K {\n  constructor() { this.flags = c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK }\n  r(p) { return openSync(p, this.flags) }\n}\n" },
  },
  {
    name: 'readFileSync { flag } option bag',
    red: { 'a.js': "import { readFileSync, constants as c } from 'node:fs'\nexport function r(p) { return readFileSync(p, { flag: c.O_RDONLY | c.O_NOFOLLOW }) }\n" },
    green: { 'a.js': "import { readFileSync, constants as c } from 'node:fs'\nexport function r(p) { return readFileSync(p, { flag: c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK }) }\n" },
  },
  {
    name: 'flags returned from a helper',
    red: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nfunction flagsFor() { return c.O_RDONLY | c.O_NOFOLLOW }\nexport function r(p) { return openSync(p, flagsFor()) }\n" },
    green: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nfunction flagsFor() { return c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK }\nexport function r(p) { return openSync(p, flagsFor()) }\n" },
  },
  {
    name: 'an O_NONBLOCK |= that runs only AFTER the open',
    red: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport function r(p) {\n  let flags = c.O_RDONLY | c.O_NOFOLLOW\n  const fd = openSync(p, flags)\n  flags |= c.O_NONBLOCK\n  return fd\n}\n" },
    green: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport function r(p) {\n  let flags = c.O_RDONLY | c.O_NOFOLLOW\n  flags |= c.O_NONBLOCK\n  const fd = openSync(p, flags)\n  return fd\n}\n" },
  },
  {
    name: 'a reassignment after the O_NONBLOCK |= drops it again',
    red: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport function r(p) {\n  let flags = c.O_RDONLY | c.O_NOFOLLOW\n  flags |= c.O_NONBLOCK\n  flags = c.O_RDONLY | c.O_NOFOLLOW\n  return openSync(p, flags)\n}\n" },
    green: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport function r(p) {\n  let flags = c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK\n  flags = c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK\n  return openSync(p, flags)\n}\n" },
  },
  {
    name: 'an O_NONBLOCK |= inside a try block, after a call that can throw past it',
    red: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport function r(p, mayThrow) {\n  let flags = c.O_RDONLY | c.O_NOFOLLOW\n  try { mayThrow(); flags |= c.O_NONBLOCK } catch {}\n  return openSync(p, flags)\n}\n" },
    green: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nexport function r(p, mayThrow) {\n  let flags = c.O_RDONLY | c.O_NOFOLLOW\n  flags |= c.O_NONBLOCK\n  try { mayThrow() } catch {}\n  return openSync(p, flags)\n}\n" },
  },
  {
    // The default must be EXACTLY a bare identifier: `c.O_NOFOLLOW` would be
    // caught as a property reference, and in `O_RDONLY | O_NOFOLLOW` the
    // identifier's parent is the `|`, not the binding — neither reaches the
    // rule this case exists for.
    name: 'O_NOFOLLOW as a bare destructuring default',
    red: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nconst { O_RDONLY, O_NOFOLLOW } = c\nexport function r(p, opts) {\n  const { flags = O_NOFOLLOW } = opts\n  return openSync(p, flags | O_RDONLY)\n}\n" },
    green: { 'a.js': "import { openSync, constants as c } from 'node:fs'\nconst { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = c\nconst SAFE = O_RDONLY | O_NOFOLLOW | O_NONBLOCK\nexport function r(p, opts) {\n  const { flags = SAFE } = opts\n  return openSync(p, flags)\n}\n" },
  },
  {
    name: 'an .mjs source file',
    red: { 'a.mjs': "import { openSync, constants as c } from 'node:fs'\nexport function r(p) { return openSync(p, c.O_RDONLY | c.O_NOFOLLOW) }\n" },
    green: { 'a.mjs': "import { openSync, constants as c } from 'node:fs'\nexport function r(p) { return openSync(p, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK) }\n" },
  },
]

describe('#7938 lint-nofollow-nonblock — O_NOFOLLOW flows beyond a direct open() argument', () => {
  for (const c of FLOW_CASES) {
    test(`red: ${c.name}`, () => {
      const { status, stderr } = runLint({ ...c.red, 'zz-control.js': CONTROL })
      assert.equal(status, 1, stderr)
    })
    test(`green: ${c.name}, with O_NONBLOCK (positive control)`, () => {
      const { status, stderr } = runLint({ ...c.green, 'zz-control.js': CONTROL })
      assert.equal(status, 0, stderr)
    })
  }
})

describe('#7938 lint-nofollow-nonblock — roster: no unscanned file may use O_NOFOLLOW', () => {
  const UNSCANNED_USE = "import { openSync, constants as c } from 'node:fs'\nexport const r = (p) => openSync(p, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK)\n"
  const UNSCANNED_COMMENT_ONLY = "// mentions O_NOFOLLOW in prose only\nexport const x = 1\n"

  test('exit 2 when a file outside the scanned trees references O_NOFOLLOW (even correctly)', () => {
    const { status, stderr } = runLint({ 'a.js': CONTROL }, { outside: { 'pkg/src/b.js': UNSCANNED_USE } })
    assert.equal(status, 2)
    assert.ok(/outside the scanned trees reference O_NOFOLLOW/.test(stderr), stderr)
  })

  test('a comment-only mention outside the scanned trees is not a use (positive control)', () => {
    const { status, stderr } = runLint({ 'a.js': CONTROL }, { outside: { 'pkg/src/b.js': UNSCANNED_COMMENT_ONLY } })
    assert.equal(status, 0, stderr)
  })

  test('test files outside the scanned trees are exempt', () => {
    const { status, stderr } = runLint({ 'a.js': CONTROL }, { outside: { 'pkg/tests/b.test.js': UNSCANNED_USE } })
    assert.equal(status, 0, stderr)
  })
})

describe('#7938 lint-nofollow-nonblock — the real repo (what CI runs)', () => {
  test('default mode is green and checks every known O_NOFOLLOW open, including the DI-renamed one', () => {
    const res = spawnSync(process.execPath, [LINT_SCRIPT, '--list-checked'], { encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    const checkedFiles = new Set(res.stdout.split('\n')
      .filter((l) => l.startsWith('checked '))
      .map((l) => l.slice('checked '.length).replace(/:\d+$/, '')))
    // These are the files the issue audited. trusted-file-read.js reaches its
    // open through `openSync: doOpen` — the site the first version of this
    // lint documented as a known gap.
    for (const f of [
      'packages/server/src/ws-file-ops/open-nofollow.js',
      'packages/server/src/trusted-file-read.js',
      'packages/server/src/claude-tui-session.js',
      'packages/claude-hooks/src/config.js',
    ]) {
      assert.ok(checkedFiles.has(f), `${f} is not among the checked sites: ${[...checkedFiles].join(', ')}`)
    }
    const roster = /(\d+) roster file\(s\) clear/.exec(res.stdout)
    assert.ok(roster && Number(roster[1]) > 0, `the default-mode roster must enumerate files: ${res.stdout}`)
  })
})
