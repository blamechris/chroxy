import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, readdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MANIFEST_FORMAT_VERSION,
  hasShebang,
  isScriptFile,
  findEnclosingPackageRoot,
  classifyResolvedBinary,
  resolveHoistedOptionalDependencyRoots,
  buildPackageTreeManifest,
} from '../src/utils/binary-package-manifest.js'
import { sha256File, sha256FileCached, _resetProvenanceCacheForTest } from '../src/utils/verify-provenance.js'

/**
 * Unit tests for the package-tree provenance manifest (#8040). Every fixture
 * here is built fresh under `os.tmpdir()` — the real installed codex/gemini
 * on a developer machine is never touched, resolved, stated, or hashed.
 */

let dir
beforeEach(() => {
  // Canonicalize immediately: on macOS `/var` is itself a symlink to
  // `/private/var`, and `classifyResolvedBinary`/`buildPackageTreeManifest`
  // both realpath internally (see their docblocks) — comparing against the
  // raw `os.tmpdir()`-derived path would spuriously fail on that spelling
  // difference, not a real defect.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-pkg-manifest-')))
  _resetProvenanceCacheForTest()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(relPath, content) {
  const full = join(dir, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  return full
}

describe('hasShebang / isScriptFile', () => {
  it('detects a #! shebang', () => {
    const p = write('script.sh', '#!/bin/sh\necho hi\n')
    assert.equal(hasShebang(p), true)
  })

  it('reports false for a file with no shebang', () => {
    const p = write('data.bin', 'not a script')
    assert.equal(hasShebang(p), false)
  })

  it('reports false (never throws) for a missing file', () => {
    assert.equal(hasShebang(join(dir, 'does-not-exist')), false)
  })

  it('never misclassifies native binary magic bytes as a shebang', () => {
    // Mach-O 64-bit magic (little-endian): 0xcf 0xfa 0xed 0xfe
    const p = write('native-macho', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
    assert.equal(hasShebang(p), false)
    // ELF magic
    const p2 = write('native-elf', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]))
    assert.equal(hasShebang(p2), false)
  })

  it('isScriptFile is true for .js/.mjs/.cjs regardless of content', () => {
    assert.equal(isScriptFile(write('a.js', 'not really js')), true)
    assert.equal(isScriptFile(write('a.mjs', 'x')), true)
    assert.equal(isScriptFile(write('a.cjs', 'x')), true)
  })

  it('isScriptFile is true for an extension-less shebang script', () => {
    const p = write('bin/tool', '#!/usr/bin/env node\n')
    assert.equal(isScriptFile(p), true)
  })

  it('isScriptFile is false for an extension-less non-shebang file', () => {
    const p = write('bin/tool', Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    assert.equal(isScriptFile(p), false)
  })
})

describe('findEnclosingPackageRoot', () => {
  it('finds the nearest ancestor package.json with a name', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }))
    const entry = write('bin/entry.js', '#!/usr/bin/env node\n')
    const found = findEnclosingPackageRoot(entry)
    assert.ok(found)
    assert.equal(found.root, dir)
    assert.equal(found.packageJson.name, 'fixture-pkg')
  })

  it('skips a name-less marker package.json and keeps climbing', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }))
    mkdirSync(join(dir, 'marker'), { recursive: true })
    writeFileSync(join(dir, 'marker', 'package.json'), JSON.stringify({ type: 'module' }))
    const entry = write('marker/sub/entry.js', '#!/usr/bin/env node\n')
    const found = findEnclosingPackageRoot(entry)
    assert.ok(found, 'must not stop at the name-less marker')
    assert.equal(found.root, dir)
    assert.equal(found.packageJson.name, 'fixture-pkg')
  })

  it('skips a malformed package.json and keeps climbing', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }))
    mkdirSync(join(dir, 'broken'), { recursive: true })
    writeFileSync(join(dir, 'broken', 'package.json'), '{ not valid json')
    const entry = write('broken/sub/entry.js', '#!/usr/bin/env node\n')
    const found = findEnclosingPackageRoot(entry)
    assert.ok(found)
    assert.equal(found.root, dir)
  })

  it('returns null when no ancestor has a named package.json', () => {
    const entry = write('a/b/c/entry.js', '#!/usr/bin/env node\n')
    // dir itself (a tmp dir) has no package.json anywhere above it either.
    const found = findEnclosingPackageRoot(entry)
    assert.equal(found, null)
  })
})

describe('classifyResolvedBinary', () => {
  it('classifies a script with an enclosing package as a launcher', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }))
    const entry = write('bin/entry.js', '#!/usr/bin/env node\n')
    const c = classifyResolvedBinary(entry)
    assert.equal(c.kind, 'launcher')
    assert.equal(c.packageRoot, dir)
  })

  it('classifies a native (non-script) resolution as native', () => {
    const p = write('native-bin', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]))
    assert.deepEqual(classifyResolvedBinary(p), { kind: 'native' })
  })

  it('classifies a script with NO enclosing package as native (keeps single-file hash)', () => {
    const p = write('standalone/tool.js', 'console.log(1)\n')
    assert.deepEqual(classifyResolvedBinary(p), { kind: 'native' })
  })

  it('classifies an empty/non-string path as native without throwing', () => {
    assert.deepEqual(classifyResolvedBinary(''), { kind: 'native' })
    assert.deepEqual(classifyResolvedBinary(undefined), { kind: 'native' })
  })

  // Regression: npm's real bin symlink layout is EXACTLY this shape —
  // `/opt/homebrew/bin/codex` is a symlink to
  // `../lib/node_modules/@openai/codex/bin/codex.js`. Package-root detection
  // climbs ancestor DIRECTORIES of the resolved path, a pure string
  // operation — climbing from the SYMLINK's own directory (a `bin/` dir with
  // no package.json anywhere above it) would never reach the real package
  // tree, silently classifying every npm-global-style install as `native`
  // and defeating the entire feature for the exact case the issue reports.
  it('follows a symlinked entry to find the REAL package root (npm bin-link layout)', () => {
    const pkgRoot = join(dir, 'lib', 'node_modules', 'fixture-codex')
    mkdirSync(join(pkgRoot, 'bin'), { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-codex' }))
    const realEntry = join(pkgRoot, 'bin', 'codex.js')
    writeFileSync(realEntry, '#!/usr/bin/env node\n')

    const binDir = join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const symlinkEntry = join(binDir, 'codex')
    symlinkSync(join('..', 'lib', 'node_modules', 'fixture-codex', 'bin', 'codex.js'), symlinkEntry)

    const c = classifyResolvedBinary(symlinkEntry)
    assert.equal(c.kind, 'launcher', 'a symlinked npm bin entry must still be classified as a launcher')
    assert.equal(c.packageRoot, pkgRoot)
    assert.equal(c.packageJson.name, 'fixture-codex')
  })
})

describe('resolveHoistedOptionalDependencyRoots', () => {
  it('resolves an optional dependency hoisted OUTSIDE the package root (sibling node_modules layout)', () => {
    // <dir>/node_modules/fixture-codex (root) + a HOISTED sibling
    // <dir>/node_modules/fixture-codex-native — mirrors npm's real hoisting.
    const codexRoot = join(dir, 'node_modules', 'fixture-codex')
    mkdirSync(codexRoot, { recursive: true })
    writeFileSync(join(codexRoot, 'package.json'), JSON.stringify({
      name: 'fixture-codex',
      optionalDependencies: { 'fixture-codex-native': '1.0.0' },
    }))
    const entry = join(codexRoot, 'bin', 'codex.js')
    mkdirSync(join(codexRoot, 'bin'), { recursive: true })
    writeFileSync(entry, '#!/usr/bin/env node\n')

    const nativeRoot = join(dir, 'node_modules', 'fixture-codex-native')
    mkdirSync(join(nativeRoot, 'vendor'), { recursive: true })
    writeFileSync(join(nativeRoot, 'package.json'), JSON.stringify({ name: 'fixture-codex-native' }))
    writeFileSync(join(nativeRoot, 'vendor', 'codex'), 'native binary bytes')

    const roots = resolveHoistedOptionalDependencyRoots({
      packageRoot: codexRoot,
      packageJson: JSON.parse(readFileSync(join(codexRoot, 'package.json'), 'utf8')),
      entryPath: entry,
    })
    assert.equal(roots.length, 1)
    assert.equal(roots[0].name, 'fixture-codex-native')
    // Node's own module resolution realpath's what it resolves (unless
    // --preserve-symlinks), so compare against the CANONICAL path — on
    // macOS `/var` is itself a symlink to `/private/var`, and this is
    // exactly the mismatch `resolveHoistedOptionalDependencyRoots` guards
    // against internally (see its docblock).
    assert.equal(roots[0].root, realpathSync(nativeRoot))
  })

  it('skips a NESTED optional dependency (already inside the package root — covered by the main walk instead)', () => {
    const codexRoot = join(dir, 'node_modules', 'fixture-codex')
    mkdirSync(join(codexRoot, 'bin'), { recursive: true })
    writeFileSync(join(codexRoot, 'package.json'), JSON.stringify({
      name: 'fixture-codex',
      optionalDependencies: { 'fixture-codex-native': '1.0.0' },
    }))
    const entry = join(codexRoot, 'bin', 'codex.js')
    writeFileSync(entry, '#!/usr/bin/env node\n')

    const nestedNativeRoot = join(codexRoot, 'node_modules', 'fixture-codex-native')
    mkdirSync(nestedNativeRoot, { recursive: true })
    writeFileSync(join(nestedNativeRoot, 'package.json'), JSON.stringify({ name: 'fixture-codex-native' }))

    const roots = resolveHoistedOptionalDependencyRoots({
      packageRoot: codexRoot,
      packageJson: { name: 'fixture-codex', optionalDependencies: { 'fixture-codex-native': '1.0.0' } },
      entryPath: entry,
    })
    assert.equal(roots.length, 0, 'a nested optional dep is already covered by the recursive walk, not listed separately')
  })

  it('silently skips a missing optional dependency (normal — not installed for this platform)', () => {
    const codexRoot = join(dir, 'node_modules', 'fixture-codex')
    mkdirSync(join(codexRoot, 'bin'), { recursive: true })
    writeFileSync(join(codexRoot, 'package.json'), JSON.stringify({
      name: 'fixture-codex',
      optionalDependencies: { 'fixture-codex-native': '1.0.0' },
    }))
    const entry = join(codexRoot, 'bin', 'codex.js')
    writeFileSync(entry, '#!/usr/bin/env node\n')

    const roots = resolveHoistedOptionalDependencyRoots({
      packageRoot: codexRoot,
      packageJson: { name: 'fixture-codex', optionalDependencies: { 'fixture-codex-native': '1.0.0' } },
      entryPath: entry,
    })
    assert.deepEqual(roots, [])
  })

  it('returns [] when there are no optionalDependencies', () => {
    const roots = resolveHoistedOptionalDependencyRoots({
      packageRoot: dir,
      packageJson: { name: 'fixture' },
      entryPath: join(dir, 'entry.js'),
    })
    assert.deepEqual(roots, [])
  })
})

describe('buildPackageTreeManifest', () => {
  const hashFile = (p) => sha256File(p)

  it('produces a stable digest for an unchanged tree, and a versioned header', () => {
    write('bin/entry.js', '#!/usr/bin/env node\n')
    write('lib/a.js', 'module.exports = 1\n')
    write('lib/b.js', 'module.exports = 2\n')
    const r1 = buildPackageTreeManifest({ packageRoot: dir, hashFile })
    const r2 = buildPackageTreeManifest({ packageRoot: dir, hashFile })
    assert.equal(r1.unreadable, false)
    assert.equal(r1.capped, false)
    assert.ok(r1.digest)
    assert.equal(r1.digest, r2.digest, 'an unchanged tree must hash identically across calls')
    assert.equal(r1.fileCount > 0, true)
  })

  it('changes the digest when ANY file content changes, anywhere in the tree', () => {
    write('bin/entry.js', '#!/usr/bin/env node\n')
    write('lib/a.js', 'module.exports = 1\n')
    const before = buildPackageTreeManifest({ packageRoot: dir, hashFile })
    write('lib/a.js', 'module.exports = 2\n')
    const after = buildPackageTreeManifest({ packageRoot: dir, hashFile })
    assert.notEqual(before.digest, after.digest)
  })

  it('changes the digest when a file is ADDED or REMOVED', () => {
    write('bin/entry.js', '#!/usr/bin/env node\n')
    const before = buildPackageTreeManifest({ packageRoot: dir, hashFile })
    write('lib/new.js', 'module.exports = 1\n')
    const after = buildPackageTreeManifest({ packageRoot: dir, hashFile })
    assert.notEqual(before.digest, after.digest)
  })

  it('walks NESTED node_modules — a file there changes the digest too', () => {
    write('bin/entry.js', '#!/usr/bin/env node\n')
    write('node_modules/dep/native', 'native bytes v1')
    const before = buildPackageTreeManifest({ packageRoot: dir, hashFile })
    write('node_modules/dep/native', 'native bytes v2 — SWAPPED')
    const after = buildPackageTreeManifest({ packageRoot: dir, hashFile })
    assert.notEqual(before.digest, after.digest, 'a change nested inside node_modules must change the digest')
  })

  it('records a symlink by its link TEXT and never follows it', () => {
    write('bin/entry.js', '#!/usr/bin/env node\n')
    // Target OUTSIDE the package root entirely.
    const outside = join(tmpdir(), `chroxy-outside-${process.pid}-${Date.now()}.txt`)
    writeFileSync(outside, 'outside content v1')
    symlinkSync(outside, join(dir, 'link-outside'))
    try {
      const before = buildPackageTreeManifest({ packageRoot: dir, hashFile })
      // Changing the EXTERNAL target's content must not affect the digest —
      // the symlink is recorded by its link text, never followed/read.
      writeFileSync(outside, 'outside content v2 — changed but must not matter')
      const after = buildPackageTreeManifest({ packageRoot: dir, hashFile })
      assert.equal(before.digest, after.digest, 'a symlink target change outside the root must not change the digest')
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('changes the digest when a symlink is RETARGETED (even if it still points outside)', () => {
    write('bin/entry.js', '#!/usr/bin/env node\n')
    const targetA = join(tmpdir(), `chroxy-target-a-${process.pid}.txt`)
    const targetB = join(tmpdir(), `chroxy-target-b-${process.pid}.txt`)
    writeFileSync(targetA, 'a')
    writeFileSync(targetB, 'b')
    symlinkSync(targetA, join(dir, 'link'))
    try {
      const before = buildPackageTreeManifest({ packageRoot: dir, hashFile })
      rmSync(join(dir, 'link'), { force: true })
      symlinkSync(targetB, join(dir, 'link'))
      const after = buildPackageTreeManifest({ packageRoot: dir, hashFile })
      assert.notEqual(before.digest, after.digest, 'retargeting a symlink must change the digest')
    } finally {
      rmSync(targetA, { force: true })
      rmSync(targetB, { force: true })
    }
  })

  it('caps the walk on file count and fails closed (unreadable) past it', () => {
    for (let i = 0; i < 10; i++) write(`file-${i}.txt`, `content ${i}`)
    const r = buildPackageTreeManifest({ packageRoot: dir, hashFile, maxFiles: 5 })
    assert.equal(r.capped, true)
    assert.equal(r.unreadable, false)
    assert.equal(r.digest, null)
    assert.ok(r.error)
  })

  it('caps the walk on total bytes and fails closed past it', () => {
    write('big.bin', Buffer.alloc(1000, 1))
    const r = buildPackageTreeManifest({ packageRoot: dir, hashFile, maxBytes: 100 })
    assert.equal(r.capped, true)
    assert.equal(r.digest, null)
  })

  it('reports unreadable (not capped) when a file cannot be hashed', () => {
    write('a.txt', 'ok')
    const boom = () => { throw new Error('EACCES') }
    const r = buildPackageTreeManifest({ packageRoot: dir, hashFile: boom })
    assert.equal(r.unreadable, true)
    assert.equal(r.capped, false)
    assert.equal(r.digest, null)
  })

  it('reports unreadable for an unsupported dirent type (e.g. a device/socket file)', () => {
    write('a.txt', 'ok')
    const fakeSeams = {
      readdirSync: (p, opts) => {
        // Real readdir for the root, but inject one bogus entry alongside it.
        const real = readdirSync(p, opts)
        return [...real, {
          name: 'weird-device',
          isSymbolicLink: () => false,
          isDirectory: () => false,
          isFile: () => false,
        }]
      },
    }
    const r = buildPackageTreeManifest({ packageRoot: dir, hashFile }, fakeSeams)
    assert.equal(r.unreadable, true)
    assert.match(r.error, /unsupported file type/)
  })

  it('includes an extraRoot under a distinct manifest prefix that cannot collide with an in-root path', () => {
    write('bin/entry.js', '#!/usr/bin/env node\n')
    const extraDir = mkdtempSync(join(tmpdir(), 'chroxy-extra-'))
    writeFileSync(join(extraDir, 'native'), 'native bytes v1')
    try {
      const before = buildPackageTreeManifest({ packageRoot: dir, extraRoots: [{ name: 'fixture-native', root: extraDir }], hashFile })
      writeFileSync(join(extraDir, 'native'), 'native bytes v2 — SWAPPED')
      const after = buildPackageTreeManifest({ packageRoot: dir, extraRoots: [{ name: 'fixture-native', root: extraDir }], hashFile })
      assert.notEqual(before.digest, after.digest, 'a change inside an extra (hoisted) root must change the digest')
    } finally {
      rmSync(extraDir, { recursive: true, force: true })
    }
  })

  it('the digest is a sha256 hex string folding in MANIFEST_FORMAT_VERSION', () => {
    write('bin/entry.js', '#!/usr/bin/env node\n')
    const r = buildPackageTreeManifest({ packageRoot: dir, hashFile })
    assert.match(r.digest, /^[a-f0-9]{64}$/)
    assert.ok(MANIFEST_FORMAT_VERSION.length > 0)
  })
})

describe('buildPackageTreeManifest reuses a cached per-file hasher (#8030 caching, #8040 no re-hash)', () => {
  beforeEach(() => _resetProvenanceCacheForTest())

  it('an unchanged tree re-walked with sha256FileCached does not re-read any file content', () => {
    write('bin/entry.js', '#!/usr/bin/env node\n')
    for (let i = 0; i < 20; i++) write(`lib/file-${i}.js`, `module.exports = ${i}\n`)

    let reads = 0
    const countingHash = (p, opts) => sha256FileCached(p, {
      ...opts,
      readFileSync: (...args) => { reads += 1; return readFileSync(...args) },
    })

    const first = buildPackageTreeManifest({ packageRoot: dir, hashFile: countingHash, platform: 'linux' })
    const readsAfterFirst = reads
    assert.ok(readsAfterFirst > 0, 'the first (cold) walk must read every file at least once')

    const second = buildPackageTreeManifest({ packageRoot: dir, hashFile: countingHash, platform: 'linux' })
    assert.equal(reads, readsAfterFirst, 'a second walk of an UNCHANGED tree must not re-read any file content')
    assert.equal(first.digest, second.digest)
  })
})
