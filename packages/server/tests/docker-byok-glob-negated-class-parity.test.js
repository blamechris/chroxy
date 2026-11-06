import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { DockerByokSession, CONTAINER_WORKSPACE } from '../src/docker-byok-session.js'
import { executeBuiltinTool } from '../src/byok-tool-executor.js'

const pexec = promisify(execFile)

/**
 * #7899 — host/container parity for NEGATED bracket classes (`[^X]`, `[!x]`)
 * and the neighbouring class shapes (ranges, literal brackets, non-ASCII).
 *
 * The host half was fixed by #7910 (the host Glob no longer routes through
 * `fs.glob`, whose hard-coded case folding on macOS/Windows excluded BOTH
 * cases of a negated class). What stayed open was the container half: nothing
 * pinned that the container returns the same answer as the host.
 *
 * ORACLE. The container IS bash, so a real bash is the reference for the
 * container side; the host is held to the same expected values. Every case
 * carries a HAND-WRITTEN expectation, and both sides must equal it, so a
 * regression on either side goes red on its own rather than only when the two
 * disagree (two sides regressing identically would pass a pure A-equals-B test).
 *
 * CASE MODE. These expectations are CASE-SENSITIVE and must hold regardless of
 * the host filesystem: macOS APFS and Windows are case-insensitive, Linux is
 * not. A case-insensitive filesystem cannot hold `xyz.ts` and `Xyz.ts` as two
 * files, so every scenario creates names that differ from each other by more
 * than case, and exercises the case distinction by choosing the pattern, never
 * by relying on two spellings coexisting.
 *
 * Same harness as docker-byok-glob-case-newline.test.js: the container command
 * runs through a REAL bash against a REAL temp dir with `/workspace` rewritten.
 * No Docker daemon is involved. POSIX only (no bash on the Windows runner); the
 * host-only half of this contract is pinned in byok-tool-executor.test.js.
 */

const POSIX_ONLY = process.platform === 'win32'

let fixtureRoot
let workspaceDir

function bashBackend() {
  return {
    async execInEnvironment(_containerId, opts) {
      const local = opts.cmd.split(CONTAINER_WORKSPACE).join(workspaceDir)
      const { stdout, stderr } = await pexec('bash', ['-c', local], { maxBuffer: 8 << 20 })
      return { stdout, stderr }
    },
  }
}

function buildSession() {
  const session = new DockerByokSession({
    cwd: '/host/cwd',
    _execFile: (cmd, args, o, cb) => { if (typeof cb === 'function') cb(null, '', '') },
    _dockerBackend: bashBackend(),
  })
  session._containerReady = true
  session._containerId = 'CONTAINER_7899'
  return session
}

function hostGlob(pattern) {
  return executeBuiltinTool({
    toolName: 'Glob',
    input: { pattern },
    cwd: workspaceDir,
    cwdRealCache: new Map(),
    cwdCacheTtl: 30_000,
  })
}

function containerGlob(pattern) {
  return buildSession()._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern } })
}

/** Normalise a Glob result to a sorted list of matches; "No matches" is []. */
function matchesOf(result) {
  assert.equal(result.isError, false, `unexpected tool error: ${result.content}`)
  if (result.content.startsWith('No matches')) return []
  return result.content.split('\n').sort()
}

/**
 * [files, pattern, expected, label]. Names within one scenario never differ
 * only by case (see CASE MODE above).
 */
const CASES = [
  // The issue's own acceptance criteria, both directions.
  [['xyz.ts'], '[^X]*.ts', ['xyz.ts'], '[^X] keeps a lowercase x'],
  [['xyz.ts'], '[!x]*.ts', [], '[!x] excludes a lowercase x'],
  [['Xyz.ts'], '[!x]*.ts', ['Xyz.ts'], '[!x] keeps an uppercase X'],
  [['Xyz.ts'], '[^X]*.ts', [], '[^X] excludes an uppercase X'],
  [['xyz.ts'], '[^x]*.ts', [], '[^x] excludes a lowercase x'],
  [['Xyz.ts'], '[!X]*.ts', [], '[!X] excludes an uppercase X'],
  // Mixed tree: only the excluded one drops out.
  [['Xyz.ts', 'abc.ts'], '[^X]*.ts', ['abc.ts'], 'mixed tree, [^X]'],
  [['xyz.ts', 'abc.ts'], '[!x]*.ts', ['abc.ts'], 'mixed tree, [!x]'],
  // Negated ranges are case-sensitive too.
  [['Bbc.ts', 'abc.ts'], '[!a-c]*.ts', ['Bbc.ts'], 'negated lowercase range keeps B'],
  [['bbc.ts'], '[!a-c]*.ts', [], 'negated lowercase range excludes b'],
  [['bbc.ts', 'Abc.ts'], '[^A-C]*.ts', ['bbc.ts'], 'negated uppercase range keeps b'],
  // Positive ranges: no folding in either direction.
  [['Bbc.ts'], '[A-C]*.ts', ['Bbc.ts'], 'uppercase range matches B'],
  [['bbc.ts'], '[A-C]*.ts', [], 'uppercase range does not match b'],
  [['Bbc.ts'], '[a-c]*.ts', [], 'lowercase range does not match B'],
  // Negated class later in the pattern, and after a directory segment.
  [['aXb.ts', 'axb.js'], 'a[^X]b.*', ['axb.js'], 'negated class mid-segment'],
  [['src/xyz.ts', 'src/Xyz.ts.bak'], 'src/[^X]*.ts', ['src/xyz.ts'], 'negated class after a directory'],
  // Non-ASCII, LOCALE-NEUTRAL shapes only: a multibyte character in the class
  // against an ASCII leading character, and an ASCII class against a multibyte
  // name. Where the CLASS and the leading NAME character are both multibyte,
  // bash in the C locale (a container's default) compares bytes, not
  // characters, so it is not comparable here — see the host-only test below.
  [['abc.ts'], '[^É]*.ts', ['abc.ts'], 'multibyte class, ASCII name: [^É] keeps a'],
  [['élan.ts', 'xyz.ts'], '[!x]*.ts', ['élan.ts'], 'ASCII negated class keeps a multibyte name'],
  // Literal bracket and a `]`-first class.
  [['[x].ts', 'x.ts'], '[[]x].ts', ['[x].ts'], 'literal [ via [[]'],
  [['a.ts', ']a.ts'], '[!]]*.ts', ['a.ts'], '[!]] excludes a leading ]'],
]

describe('Glob negated-class host/container parity (#7899)', { skip: POSIX_ONLY }, () => {
  before(async () => {
    const { stdout } = await pexec('bash', ['-c', 'printf ok'])
    assert.equal(stdout, 'ok', 'the local bash harness must work, or this suite proves nothing')
  })

  let originalHome
  let originalConfigDir
  let originalApiKey
  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'chroxy-7899-'))
    workspaceDir = join(fixtureRoot, 'ws')
    mkdirSync(workspaceDir, { recursive: true })
    originalHome = process.env.HOME
    originalConfigDir = process.env.CHROXY_CONFIG_DIR
    originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.HOME = fixtureRoot
    process.env.CHROXY_CONFIG_DIR = join(fixtureRoot, '.chroxy')
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-fixture'
  })
  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    if (originalConfigDir) process.env.CHROXY_CONFIG_DIR = originalConfigDir
    else delete process.env.CHROXY_CONFIG_DIR
    if (originalApiKey) process.env.ANTHROPIC_API_KEY = originalApiKey
    else delete process.env.ANTHROPIC_API_KEY
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  function seed(files) {
    for (const f of files) {
      const full = join(workspaceDir, f)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, '1')
    }
  }

  for (const [files, pattern, expected, label] of CASES) {
    it(`${label}: ${pattern} over ${JSON.stringify(files)}`, async () => {
      seed(files)
      const want = [...expected].sort()
      assert.deepEqual(matchesOf(await containerGlob(pattern)), want, 'container (bash) disagrees with the expectation')
      assert.deepEqual(matchesOf(await hostGlob(pattern)), want, 'host disagrees with the expectation')
    })
  }

  it('an escaped bracket is refused identically on both sides (backslash is rejected up front)', async () => {
    seed(['xyz.ts'])
    const pattern = '\\[^X\\]*.ts'
    const container = await containerGlob(pattern)
    const host = await hostGlob(pattern)
    assert.equal(container.isError, true)
    assert.equal(host.isError, true)
    assert.equal(container.content.split(':')[0], host.content.split(':')[0], 'same error class on both sides')
  })

  // Host-only: character semantics for a negated class naming a multibyte
  // character. The container (bash, C locale unless the image sets one)
  // compares BYTES — `[^É]` is the byte set {C3, 89}, so `élan.ts` (leading
  // byte C3) is wrongly excluded there. That divergence is locale-driven, is
  // not a case-folding problem, and is reported on #7899 rather than pinned.
  it('host: a negated class naming a multibyte character is case-sensitive per character', async () => {
    seed(['élan.ts'])
    assert.deepEqual(matchesOf(await hostGlob('[^É]*.ts')), ['élan.ts'])
    rmSync(join(workspaceDir, 'élan.ts'))
    seed(['Élan.ts'])
    assert.deepEqual(matchesOf(await hostGlob('[^É]*.ts')), [])
    assert.deepEqual(matchesOf(await hostGlob('[!é]*.ts')), ['Élan.ts'])
  })
})
