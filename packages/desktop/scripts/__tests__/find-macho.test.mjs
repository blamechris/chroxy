// find-macho.test.mjs — coverage for packages/desktop/scripts/find-macho.mjs
// (#7986): the Mach-O-by-magic-bytes detector that closes the extension-less
// hole in bundle-server.sh's unsigned-native-binary guard.
//
// No external test framework — plain node:test, run directly:
//   node packages/desktop/scripts/__tests__/find-macho.test.mjs

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findMachOFiles, machOKind } from '../find-macho.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = join(__dirname, '..', 'find-macho.mjs')

// chmod 000 has no effect on a process running as root (root bypasses
// permission checks entirely), so the mid-walk-failure test below would
// silently pass for the wrong reason under such a runner rather than
// exercising anything. Skipped rather than asserting a premise that isn't
// true in that environment.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

// Every temp dir created by a test, torn down once at the end. Not per-test
// (each test creates its own uniquely-named mkdtemp dir, so nothing collides
// between tests run in any order).
const tempDirs = []
function tmpDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `find-macho-${prefix}-`))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function writeBytes(path, bytes) {
  writeFileSync(path, Buffer.from(bytes))
}

// --- magic byte fixtures, as they sit ON DISK -------------------------------
const THIN32_MAGIC = [0xfe, 0xed, 0xfa, 0xce] // MH_MAGIC
const THIN32_CIGAM = [0xce, 0xfa, 0xed, 0xfe] // MH_CIGAM (byte-swapped)
const THIN64_MAGIC = [0xfe, 0xed, 0xfa, 0xcf] // MH_MAGIC_64
const THIN64_CIGAM = [0xcf, 0xfa, 0xed, 0xfe] // MH_CIGAM_64 (byte-swapped)
const FAT_MAGIC = [0xca, 0xfe, 0xba, 0xbe]
const FAT_MAGIC_64 = [0xca, 0xfe, 0xba, 0xbf]

const nfat = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]

describe('machOKind — thin Mach-O, every magic in both byte orders', () => {
  it('MH_MAGIC (32-bit, native order) -> thin32', () => {
    assert.equal(machOKind(Buffer.from(THIN32_MAGIC)), 'thin32')
  })
  it('MH_CIGAM (32-bit, byte-swapped) -> thin32', () => {
    assert.equal(machOKind(Buffer.from(THIN32_CIGAM)), 'thin32')
  })
  it('MH_MAGIC_64 (64-bit, native order) -> thin64', () => {
    assert.equal(machOKind(Buffer.from(THIN64_MAGIC)), 'thin64')
  })
  it('MH_CIGAM_64 (64-bit, byte-swapped) -> thin64', () => {
    assert.equal(machOKind(Buffer.from(THIN64_CIGAM)), 'thin64')
  })
  it('a thin magic followed by arbitrary trailing bytes is still recognized', () => {
    assert.equal(machOKind(Buffer.from([...THIN64_MAGIC, 0x01, 0x02, 0x03, 0x04])), 'thin64')
  })
})

describe('machOKind — fat Mach-O vs. the Java class file ambiguity', () => {
  it('FAT_MAGIC with a plausible nfat_arch (1) -> fat', () => {
    assert.equal(machOKind(Buffer.from([...FAT_MAGIC, ...nfat(1)])), 'fat')
  })
  it('FAT_MAGIC with a plausible nfat_arch (29, the upper bound) -> fat', () => {
    assert.equal(machOKind(Buffer.from([...FAT_MAGIC, ...nfat(29)])), 'fat')
  })
  it('FAT_MAGIC_64 with a plausible nfat_arch -> fat64', () => {
    assert.equal(machOKind(Buffer.from([...FAT_MAGIC_64, ...nfat(2)])), 'fat64')
  })
  it('nfat_arch = 0 is NOT flagged (below the plausible range)', () => {
    assert.equal(machOKind(Buffer.from([...FAT_MAGIC, ...nfat(0)])), null)
  })
  it('nfat_arch = 30 is NOT flagged (above the plausible range)', () => {
    assert.equal(machOKind(Buffer.from([...FAT_MAGIC, ...nfat(30)])), null)
  })
  it('a real Java class file (cafebabe, major version 52 = 0x34) is NOT flagged', () => {
    // Exactly the disambiguating case: minor_version=0x0000, major_version=0x0034
    // read together as one big-endian uint32 is 52 — far outside 1..29.
    assert.equal(machOKind(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34])), null)
  })
  it('a Java class file with a very old major version could theoretically collide — documented, not asserted', () => {
    // Nothing to assert here: this is the boundary file(1) accepts as ambiguous
    // too. Left out deliberately rather than asserting a wrong answer.
  })
})

describe('machOKind — short and empty buffers', () => {
  it('an empty buffer -> null', () => {
    assert.equal(machOKind(Buffer.alloc(0)), null)
  })
  it('a 1-byte buffer -> null', () => {
    assert.equal(machOKind(Buffer.from([0xfe])), null)
  })
  it('a 3-byte buffer (one short of any magic) -> null', () => {
    assert.equal(machOKind(Buffer.from([0xfe, 0xed, 0xfa])), null)
  })
  it('a fat-magic buffer truncated before nfat_arch (5 bytes) -> null, not a guess', () => {
    assert.equal(machOKind(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00])), null)
  })
  it('a fat-magic buffer with exactly 4 bytes (no nfat_arch at all) -> null', () => {
    assert.equal(machOKind(Buffer.from(FAT_MAGIC)), null)
  })
  it('null/undefined input -> null', () => {
    assert.equal(machOKind(null), null)
    assert.equal(machOKind(undefined), null)
  })
  it('an ordinary text file\'s bytes -> null', () => {
    assert.equal(machOKind(Buffer.from('#!/usr/bin/env bash\n')), null)
  })
})

describe('findMachOFiles — walking the tree', () => {
  it('finds a Mach-O file nested under a scoped package directory', () => {
    const root = tmpDir('scoped')
    mkdirSync(join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64'), { recursive: true })
    const target = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude')
    writeBytes(target, THIN64_MAGIC)
    mkdirSync(join(root, 'node_modules', 'ordinary-pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'ordinary-pkg', 'index.js'), '// not a binary\n')

    const found = findMachOFiles(root)
    assert.deepEqual(found, [target])
  })

  it('finds multiple Mach-O files across nested and doubly-nested scoped dirs', () => {
    const root = tmpDir('multi')
    const a = join(root, 'node_modules', 'pkg-a', 'bin', 'tool')
    const b = join(root, 'node_modules', '@scope', 'pkg-b', 'node_modules', '@scope', 'pkg-c', 'tool2')
    mkdirSync(dirname(a), { recursive: true })
    mkdirSync(dirname(b), { recursive: true })
    writeBytes(a, THIN32_MAGIC)
    writeBytes(b, FAT_MAGIC_64.concat(nfat(3)))

    const found = findMachOFiles(root).sort()
    assert.deepEqual(found, [a, b].sort())
  })

  it('returns absolute paths even when given a relative root', () => {
    const root = tmpDir('relative')
    const target = join(root, 'tool')
    writeBytes(target, THIN64_MAGIC)
    const found = findMachOFiles(root)
    assert.equal(found.length, 1)
    assert.ok(pathResolve(found[0]) === found[0], 'result must already be absolute')
  })

  it('an empty directory yields no results', () => {
    const root = tmpDir('empty')
    mkdirSync(join(root, 'nested', 'deeper'), { recursive: true })
    assert.deepEqual(findMachOFiles(root), [])
  })
})

describe('findMachOFiles — symlinks are never followed', () => {
  it('a symlinked FILE pointing at a real Mach-O binary is not reported', () => {
    const root = tmpDir('symlink-file')
    const real = join(root, 'real-target')
    writeBytes(real, THIN64_MAGIC)
    const linkDir = join(root, 'inside')
    mkdirSync(linkDir, { recursive: true })
    symlinkSync(real, join(linkDir, 'link-to-macho'), 'file')

    // Only the real file is found; the symlink pointing at the same bytes is not.
    const found = findMachOFiles(root)
    assert.deepEqual(found, [real])
  })

  it('a symlinked DIRECTORY is not descended into', () => {
    const root = tmpDir('symlink-dir')
    const realDir = join(root, 'real-dir')
    mkdirSync(realDir, { recursive: true })
    writeBytes(join(realDir, 'tool'), THIN64_MAGIC)
    symlinkSync(realDir, join(root, 'link-to-dir'), 'dir')

    // The file only shows up via the real path, never via the symlinked one.
    const found = findMachOFiles(root)
    assert.deepEqual(found, [join(realDir, 'tool')])
  })

  it('a directory-symlink CYCLE does not loop — the walk terminates', () => {
    const root = tmpDir('cycle')
    const a = join(root, 'a')
    const b = join(root, 'a', 'b')
    mkdirSync(b, { recursive: true })
    writeBytes(join(b, 'tool'), THIN64_MAGIC)
    // b/loop -> a (an ancestor), which would recurse forever if followed.
    symlinkSync(a, join(b, 'loop'), 'dir')

    const found = findMachOFiles(root)
    assert.deepEqual(found, [join(b, 'tool')])
  })
})

describe('findMachOFiles — excludeRegex prunes', () => {
  it('prunes a whole directory: nothing inside it is found, even a real Mach-O', () => {
    const root = tmpDir('exclude-dir')
    const exemptDir = join(root, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64')
    mkdirSync(exemptDir, { recursive: true })
    writeBytes(join(exemptDir, 'spawn-helper'), THIN64_MAGIC)
    const other = join(root, 'node_modules', 'some-pkg', 'tool')
    mkdirSync(dirname(other), { recursive: true })
    writeBytes(other, THIN64_MAGIC)

    const found = findMachOFiles(root, { excludeRegex: /\/node-pty\/prebuilds\/darwin-/ })
    assert.deepEqual(found, [other])
  })

  it('a non-matching excludeRegex changes nothing', () => {
    const root = tmpDir('exclude-noop')
    const target = join(root, 'node_modules', 'some-pkg', 'tool')
    mkdirSync(dirname(target), { recursive: true })
    writeBytes(target, THIN64_MAGIC)

    const found = findMachOFiles(root, { excludeRegex: /this-never-matches-anything/ })
    assert.deepEqual(found, [target])
  })
})

describe('CLI — node find-macho.mjs <root> [--exclude-regex <re>]', () => {
  it('exits 0 and prints every found path, one per line', () => {
    const root = tmpDir('cli-ok')
    const a = join(root, 'tool-a')
    const b = join(root, 'nested', 'tool-b')
    mkdirSync(dirname(b), { recursive: true })
    writeBytes(a, THIN64_MAGIC)
    writeBytes(b, THIN32_MAGIC)
    writeFileSync(join(root, 'not-macho.txt'), 'hello\n')

    const result = spawnSync(process.execPath, [CLI_PATH, root], { encoding: 'utf8' })
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    const lines = result.stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(lines, [a, b].sort())
  })

  it('exits 0 with empty output when nothing is found (a clean scan finding nothing)', () => {
    const root = tmpDir('cli-clean')
    writeFileSync(join(root, 'ordinary.js'), '// nothing here\n')

    const result = spawnSync(process.execPath, [CLI_PATH, root], { encoding: 'utf8' })
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.equal(result.stdout.trim(), '')
  })

  it('respects --exclude-regex', () => {
    const root = tmpDir('cli-exclude')
    const excluded = join(root, 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper')
    mkdirSync(dirname(excluded), { recursive: true })
    writeBytes(excluded, THIN64_MAGIC)
    const kept = join(root, 'tool')
    writeBytes(kept, THIN64_MAGIC)

    const result = spawnSync(
      process.execPath,
      [CLI_PATH, root, '--exclude-regex', '/node-pty/prebuilds/darwin-'],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.deepEqual(result.stdout.split('\n').filter(Boolean), [kept])
  })

  // #7986 review N6: `status !== 0` also accepts `null` (the process crashed
  // or was killed by a signal rather than exiting cleanly) — every real
  // failure path in find-macho.mjs calls `process.exit(1)` after printing a
  // `[find-macho] ...` line to stderr, so asserting the exact status AND the
  // stderr prefix distinguishes "the guard refused, as designed" from "the
  // guard's own process died" (which would read as red too, but for the
  // wrong reason).
  it('exits NON-ZERO when the root does not exist', () => {
    const root = join(tmpDir('cli-missing'), 'does-not-exist')
    const result = spawnSync(process.execPath, [CLI_PATH, root], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^\[find-macho\]/)
  })

  it('exits NON-ZERO when the root is a file, not a directory', () => {
    const root = tmpDir('cli-not-dir')
    const file = join(root, 'a-file')
    writeFileSync(file, 'not a directory\n')
    const result = spawnSync(process.execPath, [CLI_PATH, file], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^\[find-macho\]/)
  })

  it('exits NON-ZERO on an invalid --exclude-regex', () => {
    const root = tmpDir('cli-bad-regex')
    const result = spawnSync(process.execPath, [CLI_PATH, root, '--exclude-regex', '('], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^\[find-macho\]/)
  })

  it('exits NON-ZERO with no arguments at all', () => {
    const result = spawnSync(process.execPath, [CLI_PATH], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^\[find-macho\]/)
  })

  it(
    'a scan error AFTER root/regex validation (a directory going unreadable mid-walk) ' +
      'is not swallowed — exits non-zero, not 0',
    { skip: isRoot ? 'chmod 000 has no effect running as root' : false },
    () => {
      // The root itself and --exclude-regex are both validated before
      // findMachOFiles() is ever called (see the two earlier try/catch blocks
      // in main()), so neither the "missing root" nor the "bad regex" case
      // above exercises the CLI's OWN try/catch around the scan itself. This
      // is the one that does: a directory that exists and validates fine, but
      // fails once the walk actually descends into it.
      const root = tmpDir('cli-unreadable')
      const blocked = join(root, 'blocked')
      mkdirSync(blocked, { recursive: true })
      writeBytes(join(blocked, 'tool'), THIN64_MAGIC)
      chmodSync(blocked, 0o000)
      try {
        const result = spawnSync(process.execPath, [CLI_PATH, root], { encoding: 'utf8' })
        assert.notEqual(result.status, 0, `a scan error must not exit 0 (stdout: ${JSON.stringify(result.stdout)})`)
        assert.match(result.stderr, /find-macho/)
      } finally {
        chmodSync(blocked, 0o755)
      }
    },
  )
})
