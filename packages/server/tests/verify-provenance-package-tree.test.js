import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  PROVENANCE_STATUS,
  verifyProvenance,
  sha256FileCached,
  _resetProvenanceCacheForTest,
} from '../src/utils/verify-provenance.js'
import { buildPackageTreeManifest } from '../src/utils/binary-package-manifest.js'
import { BinaryProvenanceLedger, _normalizeKey } from '../src/binary-provenance-trust.js'

/**
 * End-to-end coverage for #8040 (package-tree provenance manifests), driven
 * through the REAL `verifyProvenance` — no `classifyBinary`/`buildManifest`
 * override — against fixture package trees built fresh under `os.tmpdir()`.
 * The real installed codex/gemini/claude on a developer machine is never
 * touched: every fixture here is synthetic and disposed of in `afterEach`.
 */

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chroxy-verify-tree-'))
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

// Minimal in-memory ledger matching the real PathHashTrustLedger surface
// verifyProvenance consults (getRecord/approve), including the #8040
// `fields`/`kind` extension — used where a fixture-file ledger isn't needed.
function makeLedger(seed = {}) {
  const records = new Map(Object.entries(seed))
  return {
    getRecord: (p) => (records.has(p) ? { ...records.get(p) } : null),
    approve(p, hash, opts = {}) {
      const existing = records.get(p)
      const rec = { sha256: hash, firstSeen: 'x', approvedAt: 'x' }
      if (opts.fields && opts.fields.kind !== undefined) rec.kind = opts.fields.kind
      else if (existing && existing.kind !== undefined) rec.kind = existing.kind
      records.set(p, rec)
      return true
    },
    _records: records,
  }
}

// ── Fixture builders ────────────────────────────────────────────────────────

/** npm-global-style codex: entry + NESTED platform package under node_modules. */
function buildCodexFixture(root) {
  const pkgRoot = join(root, 'lib', 'node_modules', '@openai', 'codex')
  mkdirSync(join(pkgRoot, 'bin'), { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: '@openai/codex',
    bin: { codex: 'bin/codex.js' },
    optionalDependencies: { '@openai/codex-native': '1.0.0' },
  }))
  const entry = join(pkgRoot, 'bin', 'codex.js')
  writeFileSync(entry, '#!/usr/bin/env node\n// codex launcher\n')

  const nativeRoot = join(pkgRoot, 'node_modules', '@openai', 'codex-native')
  mkdirSync(join(nativeRoot, 'vendor', 'aarch64-apple-darwin', 'bin'), { recursive: true })
  writeFileSync(join(nativeRoot, 'package.json'), JSON.stringify({ name: '@openai/codex-native' }))
  writeFileSync(join(nativeRoot, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex'), 'native codex binary bytes v1')
  writeFileSync(join(nativeRoot, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex-code-mode-host'), 'native host binary v1')

  // The bin symlink, exactly like the real /opt/homebrew/bin/codex layout.
  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  const symlinkEntry = join(binDir, 'codex')
  symlinkSync(join('..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), symlinkEntry)

  return {
    resolvedPath: symlinkEntry,
    nativeBinaryPath: join(nativeRoot, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex'),
  }
}

/** gemini-style: entry + sibling bundle chunk files, no bin symlink needed. */
function buildGeminiFixture(root) {
  const pkgRoot = join(root, 'libexec', 'lib', 'node_modules', '@google', 'gemini-cli')
  mkdirSync(join(pkgRoot, 'bundle'), { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', bin: { gemini: 'bundle/gemini.js' } }))
  const entry = join(pkgRoot, 'bundle', 'gemini.js')
  writeFileSync(entry, '#!/usr/bin/env node\nimport "./chunk-a.js"\n')
  writeFileSync(join(pkgRoot, 'bundle', 'chunk-a.js'), 'export const a = 1\n')
  writeFileSync(join(pkgRoot, 'bundle', 'chunk-b.js'), 'export const b = 2\n')
  return { resolvedPath: entry, chunkBPath: join(pkgRoot, 'bundle', 'chunk-b.js') }
}

const hashFile = (p) => sha256FileCached(p, { platform: 'linux' })

// ── Acceptance: codex-shaped fixture ────────────────────────────────────────

describe('verifyProvenance — package tree (#8040): codex-shaped fixture', () => {
  it('block mode: untouched fixture is OK / PINNED — no refusal', () => {
    const { resolvedPath } = buildCodexFixture(dir)
    const ledger = makeLedger()
    const first = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(first.status, PROVENANCE_STATUS.PINNED)
    assert.equal(first.blocked, false)

    const second = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(second.status, PROVENANCE_STATUS.OK)
    assert.equal(second.blocked, false)
    assert.equal(second.hash, first.hash, 'an unchanged tree must hash identically')
  })

  it('block mode: swapping ONLY the nested native binary is REFUSED (the acceptance mutant)', () => {
    const { resolvedPath, nativeBinaryPath } = buildCodexFixture(dir)
    const ledger = makeLedger()
    const pinned = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(pinned.status, PROVENANCE_STATUS.PINNED)

    // Swap ONLY the native vendor binary — the launcher script itself (and
    // its own hash) is untouched.
    writeFileSync(nativeBinaryPath, 'SWAPPED native codex binary bytes')

    const after = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(after.status, PROVENANCE_STATUS.HASH_MISMATCH)
    assert.equal(after.blocked, true, 'a swap of the native binary behind the launcher must be refused in block mode')
  })

  it('warn mode: the same swap surfaces a mismatch but allows the spawn', () => {
    const { resolvedPath, nativeBinaryPath } = buildCodexFixture(dir)
    const ledger = makeLedger()
    verifyProvenance({ resolvedPath, mode: 'warn', ledger })
    writeFileSync(nativeBinaryPath, 'SWAPPED')
    const after = verifyProvenance({ resolvedPath, mode: 'warn', ledger })
    assert.equal(after.status, PROVENANCE_STATUS.HASH_MISMATCH)
    assert.equal(after.blocked, false)
    assert.equal(after.ok, true)
  })
})

// ── Acceptance: gemini-shaped fixture ───────────────────────────────────────

describe('verifyProvenance — package tree (#8040): gemini-shaped fixture', () => {
  it('block mode: swapping ONE bundle chunk is refused', () => {
    const { resolvedPath, chunkBPath } = buildGeminiFixture(dir)
    const ledger = makeLedger()
    const pinned = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(pinned.status, PROVENANCE_STATUS.PINNED)

    writeFileSync(chunkBPath, 'export const b = "SWAPPED"\n')

    const after = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(after.status, PROVENANCE_STATUS.HASH_MISMATCH)
    assert.equal(after.blocked, true)
  })

  it('untouched fixture passes on repeat calls', () => {
    const { resolvedPath } = buildGeminiFixture(dir)
    const ledger = makeLedger()
    verifyProvenance({ resolvedPath, mode: 'block', ledger })
    const after = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(after.status, PROVENANCE_STATUS.OK)
    assert.equal(after.blocked, false)
  })
})

// ── Hoisted optional dependency (outside the package root) ─────────────────

describe('verifyProvenance — package tree (#8040): hoisted optional dependency', () => {
  function buildHoistedFixture(root) {
    const pkgRoot = join(root, 'node_modules', 'fixture-codex')
    mkdirSync(join(pkgRoot, 'bin'), { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
      name: 'fixture-codex',
      bin: { codex: 'bin/codex.js' },
      optionalDependencies: { 'fixture-codex-native': '1.0.0' },
    }))
    const entry = join(pkgRoot, 'bin', 'codex.js')
    writeFileSync(entry, '#!/usr/bin/env node\n')

    // HOISTED sibling — NOT nested inside pkgRoot/node_modules.
    const nativeRoot = join(root, 'node_modules', 'fixture-codex-native')
    mkdirSync(join(nativeRoot, 'vendor'), { recursive: true })
    writeFileSync(join(nativeRoot, 'package.json'), JSON.stringify({ name: 'fixture-codex-native' }))
    const nativeBinary = join(nativeRoot, 'vendor', 'codex')
    writeFileSync(nativeBinary, 'hoisted native binary v1')

    return { resolvedPath: entry, nativeBinary }
  }

  it('block mode: swapping the hoisted binary (outside the launcher package root) is refused', () => {
    const { resolvedPath, nativeBinary } = buildHoistedFixture(dir)
    const ledger = makeLedger()
    const pinned = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(pinned.status, PROVENANCE_STATUS.PINNED)

    writeFileSync(nativeBinary, 'SWAPPED hoisted native binary')

    const after = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(after.status, PROVENANCE_STATUS.HASH_MISMATCH)
    assert.equal(after.blocked, true, 'a swap of a HOISTED optional-dependency binary must be caught too')
  })
})

// ── #8093 review C1: a hoisted optional dep reached through a BIN SYMLINK ──
// (bun global, yarn-classic global) — the symlink lives OUTSIDE any
// node_modules, so resolving the hoisted dependency from the symlink's own
// (unresolved) path searches the wrong directory entirely and misses a
// sibling that IS installed right next to the real package.

describe('verifyProvenance — package tree (#8040): C1 — hoisted dep reached through a bin symlink (bun/yarn-classic global layout)', () => {
  /**
   * Mirrors bun global (`~/.bun/bin/codex` -> `../install/global/node_modules/
   * @openai/codex/bin/codex.js`) and yarn-classic global: a FLAT
   * `node_modules` holding the launcher package AND its hoisted platform
   * package as SIBLINGS, reached through a bin symlink that lives OUTSIDE
   * that `node_modules` directory entirely.
   */
  function buildFlatGlobalFixture(root) {
    const installNodeModules = join(root, 'install', 'global', 'node_modules')
    const pkgRoot = join(installNodeModules, 'fixture-codex')
    mkdirSync(join(pkgRoot, 'bin'), { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
      name: 'fixture-codex',
      bin: { codex: 'bin/codex.js' },
      optionalDependencies: { 'fixture-codex-native': '1.0.0' },
    }))
    const realEntry = join(pkgRoot, 'bin', 'codex.js')
    writeFileSync(realEntry, '#!/usr/bin/env node\n')

    // The hoisted sibling — installed directly under the SAME node_modules
    // directory as the launcher package, NOT nested inside it.
    const nativeRoot = join(installNodeModules, 'fixture-codex-native')
    mkdirSync(join(nativeRoot, 'vendor'), { recursive: true })
    writeFileSync(join(nativeRoot, 'package.json'), JSON.stringify({ name: 'fixture-codex-native' }))
    const nativeBinary = join(nativeRoot, 'vendor', 'codex')
    writeFileSync(nativeBinary, 'flat-global native binary v1')

    // The bin symlink lives OUTSIDE `install/global/node_modules` entirely —
    // `root/bin/codex`, exactly like `~/.bun/bin/codex`.
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })
    const symlinkEntry = join(binDir, 'codex')
    symlinkSync(join('..', 'install', 'global', 'node_modules', 'fixture-codex', 'bin', 'codex.js'), symlinkEntry)

    return { resolvedPath: symlinkEntry, realEntry, nativeBinary }
  }

  it('block mode: swapping the hoisted native binary is refused (repro for #8093 review C1)', () => {
    const { resolvedPath, nativeBinary } = buildFlatGlobalFixture(dir)
    const ledger = makeLedger()
    const pinned = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(pinned.status, PROVENANCE_STATUS.PINNED)

    writeFileSync(nativeBinary, 'SWAPPED flat-global native binary')

    const after = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(after.status, PROVENANCE_STATUS.HASH_MISMATCH,
      'a hoisted dep reached through a bin symlink outside any node_modules must still be covered — this is the C1 repro: ' +
      'resolving optionalDependencies from the UNRESOLVED symlink path searches the wrong directory and misses this sibling entirely')
    assert.equal(after.blocked, true)
  })

  it('resolving the same layout from the REAL (already-resolved) .js path also catches the swap (control)', () => {
    const { realEntry, nativeBinary } = buildFlatGlobalFixture(dir)
    const ledger = makeLedger()
    verifyProvenance({ resolvedPath: realEntry, mode: 'block', ledger })
    writeFileSync(nativeBinary, 'SWAPPED')
    const after = verifyProvenance({ resolvedPath: realEntry, mode: 'block', ledger })
    assert.equal(after.status, PROVENANCE_STATUS.HASH_MISMATCH)
    assert.equal(after.blocked, true)
  })
})

// ── Symlinks ─────────────────────────────────────────────────────────────

describe('verifyProvenance — package tree (#8040): symlinks', () => {
  it('retargeting a symlink INSIDE the tree is refused', () => {
    const pkgRoot = join(dir, 'pkg')
    mkdirSync(pkgRoot, { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg', bin: 'entry.js' }))
    const entry = join(pkgRoot, 'entry.js')
    writeFileSync(entry, '#!/usr/bin/env node\n')
    writeFileSync(join(pkgRoot, 'target-a'), 'a')
    writeFileSync(join(pkgRoot, 'target-b'), 'b')
    symlinkSync('target-a', join(pkgRoot, 'link'))

    const ledger = makeLedger()
    const pinned = verifyProvenance({ resolvedPath: entry, mode: 'block', ledger })
    assert.equal(pinned.status, PROVENANCE_STATUS.PINNED)

    rmSync(join(pkgRoot, 'link'))
    symlinkSync('target-b', join(pkgRoot, 'link'))

    const after = verifyProvenance({ resolvedPath: entry, mode: 'block', ledger })
    assert.equal(after.status, PROVENANCE_STATUS.HASH_MISMATCH)
    assert.equal(after.blocked, true)
  })

  it('a symlink pointing OUTSIDE the root is never followed — changing its target does not affect the verdict', () => {
    const pkgRoot = join(dir, 'pkg')
    mkdirSync(pkgRoot, { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg', bin: 'entry.js' }))
    const entry = join(pkgRoot, 'entry.js')
    writeFileSync(entry, '#!/usr/bin/env node\n')
    const outside = join(dir, 'outside.txt')
    writeFileSync(outside, 'outside v1')
    symlinkSync(outside, join(pkgRoot, 'link-outside'))

    const ledger = makeLedger()
    const pinned = verifyProvenance({ resolvedPath: entry, mode: 'block', ledger })
    assert.equal(pinned.status, PROVENANCE_STATUS.PINNED)

    writeFileSync(outside, 'outside v2 — changed but must not matter')

    const after = verifyProvenance({ resolvedPath: entry, mode: 'block', ledger })
    assert.equal(after.status, PROVENANCE_STATUS.OK)
    assert.equal(after.blocked, false, 'a symlink target OUTSIDE the root must never be read/followed')
  })
})

// ── #8093 review C4: the manifest must bind WHICH file is the entry ────────

describe('verifyProvenance — package tree (#8040): C4 — entry retarget within the same tree', () => {
  it('retargeting the resolved bin symlink at a DIFFERENT script already inside the same tree is refused', () => {
    const pkgRoot = join(dir, 'pkg')
    mkdirSync(join(pkgRoot, 'bin'), { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
      name: 'fixture-pkg',
      bin: { fixture: 'bin/main.js', alt: 'bin/alt.js' },
    }))
    writeFileSync(join(pkgRoot, 'bin', 'main.js'), '#!/usr/bin/env node\nconsole.log("main")\n')
    writeFileSync(join(pkgRoot, 'bin', 'alt.js'), '#!/usr/bin/env node\nconsole.log("alt")\n')

    // The RESOLVED path is a symlink — user-writable, exactly like the real
    // /opt/homebrew/bin/codex — initially pointing at bin/main.js.
    const binDir = join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const resolvedPath = join(binDir, 'fixture')
    symlinkSync(join(pkgRoot, 'bin', 'main.js'), resolvedPath)

    const ledger = makeLedger()
    const pinned = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(pinned.status, PROVENANCE_STATUS.PINNED)

    // Retarget the SAME symlink (SAME ledger key) at a DIFFERENT script
    // already inside the identical, UNCHANGED tree — no file's content
    // changed anywhere.
    rmSync(resolvedPath, { force: true })
    symlinkSync(join(pkgRoot, 'bin', 'alt.js'), resolvedPath)

    const after = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(after.status, PROVENANCE_STATUS.HASH_MISMATCH,
      'retargeting the entry to a DIFFERENT script inside the same tree must be refused — the digest must bind WHICH file is launched, not just the tree\'s content')
    assert.equal(after.blocked, true)
    assert.notEqual(after.hash, pinned.hash, 'the two entries must produce DIFFERENT digests despite an otherwise byte-identical tree')
  })
})

// ── Native single-file resolution: positive control (unchanged since #6858) ─

describe('verifyProvenance — package tree (#8040): native resolution is unaffected (positive control)', () => {
  it('a native (non-script) binary keeps the plain single-file hash', () => {
    const p = write('native-binary', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]))
    const ledger = makeLedger()
    const pinned = verifyProvenance({ resolvedPath: p, mode: 'block', ledger })
    assert.equal(pinned.status, PROVENANCE_STATUS.PINNED)
    assert.equal(pinned.hash, hashFile(p), 'a native resolution must hash exactly the one file, byte for byte')
    assert.equal(ledger.getRecord(p).kind, 'file')
  })

  it('a swap of a native binary is still refused exactly as before', () => {
    const p = write('native-binary', 'v1 native bytes')
    const ledger = makeLedger()
    verifyProvenance({ resolvedPath: p, mode: 'block', ledger })
    writeFileSync(p, 'v2 SWAPPED native bytes')
    const after = verifyProvenance({ resolvedPath: p, mode: 'block', ledger })
    assert.equal(after.status, PROVENANCE_STATUS.HASH_MISMATCH)
    assert.equal(after.blocked, true)
  })

  it('a name-less package.json marker along the climb is skipped — falls back correctly', () => {
    // No NAMED package.json anywhere above this entry at all → native.
    mkdirSync(join(dir, 'marker'), { recursive: true })
    writeFileSync(join(dir, 'marker', 'package.json'), JSON.stringify({ type: 'module' }))
    const entry = write('marker/entry.js', '#!/usr/bin/env node\n')
    const ledger = makeLedger()
    const v = verifyProvenance({ resolvedPath: entry, mode: 'block', ledger })
    assert.equal(v.status, PROVENANCE_STATUS.PINNED)
    assert.equal(ledger.getRecord(entry).kind, 'file', 'no named package.json anywhere above — stays a single-file (native) hash')
  })
})

// ── Legacy-record migration (#8040 requirement 6) ───────────────────────────

describe('verifyProvenance — package tree (#8040): legacy single-file record migration', () => {
  it('matching entry hash upgrades the legacy record to a tree digest, with no refusal', () => {
    const { resolvedPath } = buildCodexFixture(dir)
    const entryHash = hashFile(resolvedPath)
    // Seed a LEGACY record (pre-#8040 shape: no `kind` field) pinned against
    // just the launcher file's own hash — exactly what a pre-#8040 daemon
    // would have written.
    const ledger = makeLedger({ [resolvedPath]: { sha256: entryHash, firstSeen: 'x', approvedAt: 'x' } })
    assert.equal(ledger.getRecord(resolvedPath).kind, undefined, 'sanity: seeded record has no kind field, like a real legacy pin')

    const v = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(v.status, PROVENANCE_STATUS.OK, 'no weaker than before: the same trusted bytes must not be refused')
    assert.equal(v.blocked, false)

    const upgraded = ledger.getRecord(resolvedPath)
    assert.equal(upgraded.kind, 'tree', 'the record must be upgraded to the tree representation')
    assert.notEqual(upgraded.sha256, entryHash, 'the stored hash is now the manifest digest, not the entry-file hash')

    // Steady state: a repeat call now compares tree-vs-tree and stays OK.
    const again = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(again.status, PROVENANCE_STATUS.OK)
  })

  it('a non-matching legacy hash is a mismatch — exactly as pre-#8040, WITHOUT EVER building the manifest (#8093 review S1)', () => {
    const { resolvedPath } = buildCodexFixture(dir)
    const ledger = makeLedger({ [resolvedPath]: { sha256: 'f'.repeat(64), firstSeen: 'x', approvedAt: 'x' } })

    // #8093 review S1: the comment/docs claimed this decision never walks the
    // manifest, but the code built it FIRST regardless — count actual
    // `buildManifest` invocations via the real injectable seam, rather than
    // just asserting the outcome (which was already correct either way).
    let buildCalls = 0
    const countingBuildManifest = (...args) => {
      buildCalls += 1
      return buildPackageTreeManifest(...args)
    }

    const v = verifyProvenance({ resolvedPath, mode: 'block', ledger, buildManifest: countingBuildManifest })
    assert.equal(v.status, PROVENANCE_STATUS.HASH_MISMATCH)
    assert.equal(v.blocked, true)
    assert.equal(v.hash, hashFile(resolvedPath), 'the mismatch verdict compares the ENTRY hash, not a manifest digest')
    // Must not have been silently "upgraded" to a tree record on a mismatch.
    assert.equal(ledger.getRecord(resolvedPath).kind, undefined)
    assert.equal(buildCalls, 0, 'a legacy mismatch must be decided from the entry hash alone — the manifest must never be built to reach this refusal')
  })

  // #8093 review S1, consequence noted in the review: a legacy mismatch on an
  // over-cap tree must still report HASH_MISMATCH (from the cheap entry-hash
  // comparison), never UNREADABLE — the cap only matters once a manifest
  // build is actually attempted, which this path never reaches.
  it('a legacy mismatch is HASH_MISMATCH even when the tree itself would exceed the cap', () => {
    const { resolvedPath } = buildCodexFixture(dir)
    const ledger = makeLedger({ [resolvedPath]: { sha256: 'f'.repeat(64), firstSeen: 'x', approvedAt: 'x' } })
    const v = verifyProvenance({ resolvedPath, mode: 'block', ledger, manifestLimits: { maxFiles: 1 } })
    assert.equal(v.status, PROVENANCE_STATUS.HASH_MISMATCH, 'the cap must never be consulted for a legacy mismatch — no manifest build means no cap check')
    assert.equal(v.blocked, true)
  })

  it('a legacy record with an EXPLICIT kind:"file" migrates the same way as one with no kind at all', () => {
    const { resolvedPath } = buildCodexFixture(dir)
    const entryHash = hashFile(resolvedPath)
    const ledger = makeLedger({ [resolvedPath]: { sha256: entryHash, firstSeen: 'x', approvedAt: 'x', kind: 'file' } })
    const v = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(v.status, PROVENANCE_STATUS.OK)
    assert.equal(ledger.getRecord(resolvedPath).kind, 'tree')
  })
})

// ── Ledger schema round-trip through the REAL persisted ledger ─────────────

describe('verifyProvenance — package tree (#8040): real BinaryProvenanceLedger persistence round-trip', () => {
  let ledgerDir
  let ledgerPath
  beforeEach(() => {
    ledgerDir = mkdtempSync(join(tmpdir(), 'chroxy-binary-trust-tree-'))
    ledgerPath = join(ledgerDir, 'binary-trust.json')
  })
  afterEach(() => rmSync(ledgerDir, { recursive: true, force: true }))

  it('a tree-kind pin persists `kind` to disk and reloads it correctly', () => {
    const { resolvedPath } = buildCodexFixture(dir)
    const led = new BinaryProvenanceLedger({ filePath: ledgerPath })
    const v = verifyProvenance({ resolvedPath, mode: 'block', ledger: led })
    assert.equal(v.status, PROVENANCE_STATUS.PINNED)

    const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    const diskKey = _normalizeKey(resolvedPath) // ledger keys are case-folded on macOS/Windows
    assert.equal(onDisk.binaries[diskKey].kind, 'tree', 'kind must round-trip through the real ledger file')
    assert.equal(onDisk.binaries[diskKey].sha256, v.hash)

    // A FRESH ledger instance loading the same file must see the same kind
    // and correctly compare against it (steady state, no refusal).
    const led2 = new BinaryProvenanceLedger({ filePath: ledgerPath })
    const v2 = verifyProvenance({ resolvedPath, mode: 'block', ledger: led2 })
    assert.equal(v2.status, PROVENANCE_STATUS.OK)
  })

  it('a legacy record (no kind) written directly via approve() migrates and the upgrade survives a flush/reload cycle', () => {
    const { resolvedPath } = buildCodexFixture(dir)
    const entryHash = hashFile(resolvedPath)
    const led = new BinaryProvenanceLedger({ filePath: ledgerPath })
    led.approve(resolvedPath, entryHash) // legacy-shaped: no `fields`/`kind`

    const v = verifyProvenance({ resolvedPath, mode: 'block', ledger: led })
    assert.equal(v.status, PROVENANCE_STATUS.OK)

    const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    assert.equal(onDisk.binaries[_normalizeKey(resolvedPath)].kind, 'tree', 'the migration write must be flushed to disk')

    const led2 = new BinaryProvenanceLedger({ filePath: ledgerPath })
    assert.equal(led2.getRecord(resolvedPath).kind, 'tree')
  })

  // #8093 review C2: the reviewer's exact repro. Two real ledger instances
  // over ONE file, both loading the SAME legacy pin. B migrates first,
  // against the genuine (untouched) tree — a real, correct upgrade, flushed
  // to disk. The native binary is THEN swapped. A's own in-memory record is
  // still the ORIGINAL legacy pin (it never saw B's flush) — without a
  // reload, A would re-derive the migration decision from that stale record,
  // see its own (now-tampered) tree digest as "the" upgrade, and `approve()`
  // — an explicit `'set'` write — would win the #8068 merge outright,
  // silently replacing B's genuine digest with A's tampered one and
  // reporting `ok` in block mode.
  it('a stale legacy record must not migrate over — or overwrite — a DIFFERENT process\'s genuine tree pin (repro for #8093 review C2)', () => {
    const { resolvedPath, nativeBinaryPath } = buildCodexFixture(dir)
    const entryHash = hashFile(resolvedPath)

    // Seed the legacy pin on disk BEFORE either daemon instance exists, so
    // both load it into their own memory at construction.
    const seeder = new BinaryProvenanceLedger({ filePath: ledgerPath })
    seeder.approve(resolvedPath, entryHash) // legacy-shaped: no kind

    const daemonA = new BinaryProvenanceLedger({ filePath: ledgerPath })
    const daemonB = new BinaryProvenanceLedger({ filePath: ledgerPath })

    // B migrates first, against the GENUINE, untouched tree.
    const bVerdict = verifyProvenance({ resolvedPath, mode: 'block', ledger: daemonB })
    assert.equal(bVerdict.status, PROVENANCE_STATUS.OK, 'B\'s migration against the genuine tree must succeed with no refusal')
    const genuineDigest = bVerdict.hash

    // The attack: the native binary is swapped AFTER B's genuine pin landed.
    writeFileSync(nativeBinaryPath, 'SWAPPED — attacker-controlled native binary')

    // A's in-memory record is STILL the original legacy pin — it has not
    // reloaded since construction, well before B's flush.
    const aVerdict = verifyProvenance({ resolvedPath, mode: 'block', ledger: daemonA })
    assert.equal(aVerdict.status, PROVENANCE_STATUS.HASH_MISMATCH,
      'A must refresh from disk before deciding this is still a migration — it must see B\'s genuine tree pin and compare the SWAPPED tree against THAT, not re-migrate from its own stale legacy snapshot')
    assert.equal(aVerdict.blocked, true, 'the swapped binary must be refused, not silently approved via a stale migration')

    const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    const diskRecord = onDisk.binaries[_normalizeKey(resolvedPath)]
    assert.equal(diskRecord.sha256, genuineDigest,
      'B\'s genuine tree pin must survive completely untouched — A must never have overwritten it with a digest computed against the tampered tree')
    assert.equal(diskRecord.kind, 'tree')
  })

  // #8093 round 2: with the migrate write now a compare-and-swap, the OUTER
  // reload-before-decide is no longer load-bearing for CORRECTNESS on its
  // own — the CAS itself rejects a stale write regardless of whether this
  // reload ran (proven by the test above and the narrower-window tests
  // below, neither of which depends on this reload distinguishing anything).
  // It remains load-bearing for A never even ATTEMPTING a doomed migrate
  // write once disk already shows the tree kind: without it, A still walks
  // the tree, still computes a digest, and still calls `approve()` with an
  // `expect` snapshot that the CAS is guaranteed to reject — correct, but a
  // wasted write attempt (and the walk to produce it) on every such turn.
  it('once a DIFFERENT process has already migrated, a stale-since-construction A never attempts a migrate write at all (efficiency, not a bypass)', () => {
    const { resolvedPath } = buildCodexFixture(dir)
    const entryHash = hashFile(resolvedPath)

    const seeder = new BinaryProvenanceLedger({ filePath: ledgerPath })
    seeder.approve(resolvedPath, entryHash)

    // A is constructed BEFORE B's migration lands — its own in-memory view
    // starts (and, without a reload, would stay) legacy-shaped, exactly like
    // the wide-gap repro above. Only a reload can bring it up to date.
    const daemonA = new BinaryProvenanceLedger({ filePath: ledgerPath })
    let migrateAttempts = 0
    const realApproveA = daemonA.approve.bind(daemonA)
    daemonA.approve = (p, h, opts) => {
      if (opts && opts.expect) migrateAttempts += 1
      return realApproveA(p, h, opts)
    }

    const daemonB = new BinaryProvenanceLedger({ filePath: ledgerPath })
    const bVerdict = verifyProvenance({ resolvedPath, mode: 'block', ledger: daemonB })
    assert.equal(bVerdict.status, PROVENANCE_STATUS.OK)

    const aVerdict = verifyProvenance({ resolvedPath, mode: 'block', ledger: daemonA })
    assert.equal(aVerdict.status, PROVENANCE_STATUS.OK)
    assert.equal(migrateAttempts, 0, 'a path a DIFFERENT process already migrated must never make THIS instance re-enter the migrate branch at all — without the outer reload, a stale-since-construction instance has no way to learn that except by attempting (and having rejected) a doomed CAS write')
  })

  // #8093 round 2: the test above closes the WIDE window (A's snapshot is
  // stale from CONSTRUCTION) via the outer reload-before-decide — by the
  // time A's outer reload runs, B has ALREADY flushed, so A's outer reload
  // itself observes B's tree record and A never even enters the migrate
  // branch. The round-2 finding is about a NARROWER window: B's write lands
  // strictly AFTER A's own reload (A still sees the legacy record and
  // proceeds to migrate) but BEFORE A's own `approve()` call actually runs —
  // the exact gap `computeTreeHash()` (a pure, ledger-free computation)
  // sits in. The only way to land a write there through the real
  // `verifyProvenance()` call is to hook the ledger method it calls at that
  // exact point — `approve()` — since nothing else touches the ledger
  // between A's reload and A's write in the real control flow.
  describe('the NARROWER window: a genuine write landing between A\'s reload and A\'s own write (#8093 round 2, C2)', () => {
    function makeInterleavedLedgers(genuineDigest) {
      const daemonA = new BinaryProvenanceLedger({ filePath: ledgerPath })
      const realApproveA = daemonA.approve.bind(daemonA)
      daemonA.approve = (p, h, opts) => {
        if (opts && opts.expect) {
          // B is a separate instance/process over the SAME file, writing
          // its own genuine migration strictly AFTER A's own reload (A is
          // already past that point, mid-call, by the time this runs) but
          // BEFORE A's write below — the exact gap the review identified.
          const daemonB = new BinaryProvenanceLedger({ filePath: ledgerPath })
          daemonB.approve(p, genuineDigest, { fields: { kind: 'tree' }, expect: opts.expect })
        }
        return realApproveA(p, h, opts)
      }
      return daemonA
    }

    it('a TAMPERED tree is refused: A\'s own digest reflects the tamper, B\'s genuine pin survives untouched', () => {
      const { resolvedPath, nativeBinaryPath } = buildCodexFixture(dir)
      const entryHash = hashFile(resolvedPath)

      // Capture the GENUINE digest before any tampering, via a throwaway
      // scratch ledger — never touches `ledgerPath`. This is what a
      // concurrent B, migrating slightly earlier against the untouched
      // tree, would have computed and flushed for real.
      const scratchLedgerDir = mkdtempSync(join(tmpdir(), 'chroxy-binary-trust-scratch-'))
      const scratchLedger = new BinaryProvenanceLedger({ filePath: join(scratchLedgerDir, 'binary-trust.json') })
      const genuineDigest = verifyProvenance({ resolvedPath, mode: 'block', ledger: scratchLedger }).hash
      rmSync(scratchLedgerDir, { recursive: true, force: true })

      // NOW tamper — after the genuine digest was captured, before A ever
      // looks at the tree.
      writeFileSync(nativeBinaryPath, 'SWAPPED — attacker-controlled native binary')

      const seeder = new BinaryProvenanceLedger({ filePath: ledgerPath })
      seeder.approve(resolvedPath, entryHash) // legacy pin — the entry file itself never changed

      const daemonA = makeInterleavedLedgers(genuineDigest)
      const aVerdict = verifyProvenance({ resolvedPath, mode: 'block', ledger: daemonA })

      assert.equal(aVerdict.status, PROVENANCE_STATUS.HASH_MISMATCH,
        'A\'s own digest reflects the TAMPERED tree, and must never be reported as matching a hash the ledger does not actually hold')
      assert.equal(aVerdict.blocked, true, 'block mode must refuse the tampered tree')
      assert.equal(aVerdict.pinnedHash, genuineDigest, 'the reported pinnedHash must be B\'s genuine digest — the value the ledger actually holds')

      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      const diskRecord = onDisk.binaries[_normalizeKey(resolvedPath)]
      assert.equal(diskRecord.sha256, genuineDigest, 'B\'s genuine tree pin must survive untouched — this is the CAS actually working, not another reload moving the gap')
      assert.equal(diskRecord.kind, 'tree')
    })

    it('a MATCHING tree (no tamper) is OK: A\'s own digest agrees with B\'s genuine pin', () => {
      const { resolvedPath } = buildCodexFixture(dir)
      const entryHash = hashFile(resolvedPath)

      const scratchLedgerDir = mkdtempSync(join(tmpdir(), 'chroxy-binary-trust-scratch-'))
      const scratchLedger = new BinaryProvenanceLedger({ filePath: join(scratchLedgerDir, 'binary-trust.json') })
      const genuineDigest = verifyProvenance({ resolvedPath, mode: 'block', ledger: scratchLedger }).hash
      rmSync(scratchLedgerDir, { recursive: true, force: true })

      // No tampering this time — the tree A itself walks is byte-identical
      // to what B (and the scratch capture) saw.
      const seeder = new BinaryProvenanceLedger({ filePath: ledgerPath })
      seeder.approve(resolvedPath, entryHash)

      const daemonA = makeInterleavedLedgers(genuineDigest)
      const aVerdict = verifyProvenance({ resolvedPath, mode: 'block', ledger: daemonA })

      assert.equal(aVerdict.status, PROVENANCE_STATUS.OK,
        'A\'s own independently-computed digest genuinely matches what the ledger holds, even though A\'s own CAS lost the race — this must not be refused')
      assert.equal(aVerdict.blocked, false)
      assert.equal(aVerdict.hash, genuineDigest)

      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.equal(onDisk.binaries[_normalizeKey(resolvedPath)].sha256, genuineDigest)
    })
  })
})

// ── Bounds: cap exceeded fails closed ───────────────────────────────────────

describe('verifyProvenance — package tree (#8040): cap exceeded fails closed', () => {
  it('block mode: exceeding the file-count cap refuses the spawn', () => {
    const pkgRoot = join(dir, 'pkg')
    mkdirSync(pkgRoot, { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg', bin: 'entry.js' }))
    const entry = join(pkgRoot, 'entry.js')
    writeFileSync(entry, '#!/usr/bin/env node\n')
    for (let i = 0; i < 10; i++) writeFileSync(join(pkgRoot, `f${i}.txt`), `x${i}`)

    const ledger = makeLedger()
    const v = verifyProvenance({ resolvedPath: entry, mode: 'block', ledger, manifestLimits: { maxFiles: 3 } })
    assert.equal(v.status, PROVENANCE_STATUS.UNREADABLE)
    assert.equal(v.blocked, true, 'a cap breach must fail CLOSED in block mode')
    assert.equal(ledger._records.size, 0, 'must never have pinned a truncated/incomplete manifest')
  })

  it('warn mode: exceeding the cap surfaces but allows', () => {
    const pkgRoot = join(dir, 'pkg')
    mkdirSync(pkgRoot, { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg', bin: 'entry.js' }))
    const entry = join(pkgRoot, 'entry.js')
    writeFileSync(entry, '#!/usr/bin/env node\n')
    for (let i = 0; i < 10; i++) writeFileSync(join(pkgRoot, `f${i}.txt`), `x${i}`)

    const ledger = makeLedger()
    const v = verifyProvenance({ resolvedPath: entry, mode: 'warn', ledger, manifestLimits: { maxFiles: 3 } })
    assert.equal(v.status, PROVENANCE_STATUS.UNREADABLE)
    assert.equal(v.blocked, false)
    assert.equal(v.ok, true)
  })
})

// ── Per-turn cost: the no-change path must not re-hash unchanged files ──────

describe('verifyProvenance — package tree (#8040): per-turn cost', () => {
  it('a second call against an UNCHANGED tree reuses sha256FileCached — no file content is re-read', () => {
    const pkgRoot = join(dir, 'pkg')
    mkdirSync(pkgRoot, { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg', bin: 'bin.js' }))
    const entry = join(pkgRoot, 'bin.js')
    writeFileSync(entry, '#!/usr/bin/env node\n')
    for (let i = 0; i < 50; i++) {
      mkdirSync(join(pkgRoot, 'lib', `d${i % 5}`), { recursive: true })
      writeFileSync(join(pkgRoot, 'lib', `d${i % 5}`, `f${i}.js`), `module.exports = ${i}\n`)
    }

    let reads = 0
    const countingSha256File = (p, opts) => sha256FileCached(p, {
      ...opts,
      readFileSync: (...args) => { reads += 1; return readFileSync(...args) },
    })

    const ledger = makeLedger()
    const first = verifyProvenance({ resolvedPath: entry, mode: 'block', ledger, sha256File: countingSha256File, platform: 'linux' })
    assert.equal(first.status, PROVENANCE_STATUS.PINNED)
    const readsAfterFirst = reads
    assert.ok(readsAfterFirst >= 51, 'the cold walk must read the entry plus every fixture file at least once')

    const second = verifyProvenance({ resolvedPath: entry, mode: 'block', ledger, sha256File: countingSha256File, platform: 'linux' })
    assert.equal(second.status, PROVENANCE_STATUS.OK)
    assert.equal(reads, readsAfterFirst, 'a second, unchanged-tree call must not re-read ANY file content')
  })
})

// ── Perf measurement: synthetic ~1000-file fixture ──────────────────────────

describe('verifyProvenance — package tree (#8040): synthetic ~1000-file timing', () => {
  it('measures cold vs warm (no-change) manifest build time on a ~1000-file tree', () => {
    const pkgRoot = join(dir, 'pkg')
    mkdirSync(pkgRoot, { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg', bin: 'bundle/entry.js' }))
    const entry = join(pkgRoot, 'bundle', 'entry.js')
    mkdirSync(join(pkgRoot, 'bundle'), { recursive: true })
    writeFileSync(entry, '#!/usr/bin/env node\n')

    const FILE_COUNT = 999 // + the entry itself = 1000
    let totalBytes = 0
    for (let i = 0; i < FILE_COUNT; i++) {
      const subdir = join(pkgRoot, 'bundle', `chunk-dir-${i % 20}`)
      mkdirSync(subdir, { recursive: true })
      const content = `export const chunk${i} = ${'x'.repeat(200)}\n`
      totalBytes += content.length
      writeFileSync(join(subdir, `chunk-${i}.js`), content)
    }

    const ledger = makeLedger()
    const t0 = process.hrtime.bigint()
    const cold = verifyProvenance({ resolvedPath: entry, mode: 'block', ledger, platform: 'linux' })
    const t1 = process.hrtime.bigint()
    const warm = verifyProvenance({ resolvedPath: entry, mode: 'block', ledger, platform: 'linux' })
    const t2 = process.hrtime.bigint()

    const coldMs = Number(t1 - t0) / 1e6
    const warmMs = Number(t2 - t1) / 1e6

    assert.equal(cold.status, PROVENANCE_STATUS.PINNED)
    assert.equal(warm.status, PROVENANCE_STATUS.OK)

    console.log(`[#8040 perf] ~${FILE_COUNT + 1} files, ${totalBytes} bytes: cold=${coldMs.toFixed(2)}ms warm(no-change)=${warmMs.toFixed(2)}ms`)

    // Loose sanity bound, not a strict benchmark — the point is to prove the
    // warm (no-change, per-turn) path stays cheap, not to pin an exact number.
    assert.ok(warmMs < 1000, `warm no-change walk should stay well under 1s for ${FILE_COUNT} tiny files, got ${warmMs}ms`)
  })

  it('measures raw SHA-256 throughput on a large file, to extrapolate the win32 full-tree-rehash cost', () => {
    // Real per-file content is dominated by per-call overhead for many tiny
    // files (readdir/stat/crypto-init), which is NOT representative of the
    // actual large binaries a launcher's tree contains (codex's native
    // binary is ~270 MB by itself; gemini's tree is ~98 MB total). Measure
    // throughput on one large file instead, then extrapolate.
    const bigPath = join(dir, 'big.bin')
    const SIZE = 32 * 1024 * 1024 // 32 MiB — large enough to amortize open/read overhead
    writeFileSync(bigPath, Buffer.alloc(SIZE, 7))
    const t0 = process.hrtime.bigint()
    hashFile(bigPath)
    const t1 = process.hrtime.bigint()
    const ms = Number(t1 - t0) / 1e6
    const mbPerSec = (SIZE / (1024 * 1024)) / (ms / 1000)

    const CODEX_NATIVE_MB = 277
    const GEMINI_TREE_MB = 98
    const codexEstMs = (CODEX_NATIVE_MB / mbPerSec) * 1000
    const geminiEstMs = (GEMINI_TREE_MB / mbPerSec) * 1000

    console.log(`[#8040 perf] raw SHA-256 throughput: ${mbPerSec.toFixed(0)} MB/s (${ms.toFixed(1)}ms for ${SIZE / 1024 / 1024}MB)`
      + ` — win32 full-rehash ESTIMATE: codex-native(~${CODEX_NATIVE_MB}MB)=${codexEstMs.toFixed(0)}ms, gemini-tree(~${GEMINI_TREE_MB}MB)=${geminiEstMs.toFixed(0)}ms`)

    assert.ok(mbPerSec > 0)
  })

  it('on win32, sha256FileCached never caches — every call re-hashes the WHOLE tree (documented #8030 limitation)', () => {
    const pkgRoot = join(dir, 'pkg')
    mkdirSync(pkgRoot, { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg', bin: 'entry.js' }))
    const entry = join(pkgRoot, 'entry.js')
    writeFileSync(entry, '#!/usr/bin/env node\n')
    for (let i = 0; i < 30; i++) writeFileSync(join(pkgRoot, `f${i}.js`), `module.exports=${i}\n`)

    let reads = 0
    const countingSha256File = (p, opts) => sha256FileCached(p, {
      ...opts,
      readFileSync: (...args) => { reads += 1; return readFileSync(...args) },
    })
    const ledger = makeLedger()
    verifyProvenance({ resolvedPath: entry, mode: 'block', ledger, sha256File: countingSha256File, platform: 'win32' })
    const readsAfterFirst = reads
    verifyProvenance({ resolvedPath: entry, mode: 'block', ledger, sha256File: countingSha256File, platform: 'win32' })
    assert.equal(reads, readsAfterFirst * 2, 'win32 must re-read every file on every call — no stat-identity cache there (#8030)')
  })
})
