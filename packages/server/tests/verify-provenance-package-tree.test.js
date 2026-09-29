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
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@google/gemini-cli' }))
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

// ── Symlinks ─────────────────────────────────────────────────────────────

describe('verifyProvenance — package tree (#8040): symlinks', () => {
  it('retargeting a symlink INSIDE the tree is refused', () => {
    const pkgRoot = join(dir, 'pkg')
    mkdirSync(pkgRoot, { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }))
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
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }))
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

  it('a non-matching legacy hash is a mismatch — exactly as pre-#8040, without walking the manifest', () => {
    const { resolvedPath } = buildCodexFixture(dir)
    const ledger = makeLedger({ [resolvedPath]: { sha256: 'f'.repeat(64), firstSeen: 'x', approvedAt: 'x' } })

    const v = verifyProvenance({ resolvedPath, mode: 'block', ledger })
    assert.equal(v.status, PROVENANCE_STATUS.HASH_MISMATCH)
    assert.equal(v.blocked, true)
    assert.equal(v.hash, hashFile(resolvedPath), 'the mismatch verdict compares the ENTRY hash, not a manifest digest')
    // Must not have been silently "upgraded" to a tree record on a mismatch.
    assert.equal(ledger.getRecord(resolvedPath).kind, undefined)
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
})

// ── Bounds: cap exceeded fails closed ───────────────────────────────────────

describe('verifyProvenance — package tree (#8040): cap exceeded fails closed', () => {
  it('block mode: exceeding the file-count cap refuses the spawn', () => {
    const pkgRoot = join(dir, 'pkg')
    mkdirSync(pkgRoot, { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }))
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
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }))
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
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }))
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
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }))
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
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }))
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
