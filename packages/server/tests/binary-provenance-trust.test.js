import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  BinaryProvenanceLedger,
  defaultBinaryTrustFile,
  binaryTrustFileExists,
} from '../src/binary-provenance-trust.js'
import { verifyProvenance } from '../src/utils/verify-provenance.js'

/**
 * Unit tests for the provider-binary provenance pin ledger (#6858) — a thin
 * subclass of the well-tested PathHashTrustLedger. Exercises the wiring
 * (wrapper key, approval field, best-effort flush) and the pin lifecycle over a
 * temp file so the real ~/.chroxy/binary-trust.json is never touched.
 */

const sha = (s) => createHash('sha256').update(s).digest('hex')
const HASH_A = sha('binary-a')
const HASH_B = sha('binary-b')

describe('BinaryProvenanceLedger (#6858)', () => {
  let dir
  let ledgerPath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-binary-trust-'))
    ledgerPath = join(dir, 'binary-trust.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('defaults its file to <config dir>/binary-trust.json', () => {
    // #7052 — CHROXY_CONFIG_DIR-rooted, so this is only `.chroxy/...` when the
    // override is unset (tests/_setup.mjs sets it suite-wide).
    assert.equal(defaultBinaryTrustFile(), join(process.env.CHROXY_CONFIG_DIR, 'binary-trust.json'))
  })

  it('falls back to ~/.chroxy/binary-trust.json when CHROXY_CONFIG_DIR is unset', () => {
    // Positive control: without this, the assertion above would also pass for a
    // resolver that had stopped consulting the home fallback entirely.
    const prev = process.env.CHROXY_CONFIG_DIR
    try {
      delete process.env.CHROXY_CONFIG_DIR
      // Pinned to the actual home root, not just "some directory named
      // .chroxy" — a regex alone still matches `/tmp/anything/.chroxy/...`, so
      // it could not tell a real home fallback from a lost one.
      assert.equal(defaultBinaryTrustFile(), join(homedir(), '.chroxy', 'binary-trust.json'))
    } finally {
      process.env.CHROXY_CONFIG_DIR = prev
    }
  })

  it('pins on approve and reports the record as trusted', () => {
    const led = new BinaryProvenanceLedger({ filePath: ledgerPath })
    assert.equal(led.getRecord('/opt/homebrew/bin/codex'), null)
    assert.equal(led.isTrusted('/opt/homebrew/bin/codex', HASH_A), false)

    assert.equal(led.approve('/opt/homebrew/bin/codex', HASH_A), true)
    assert.equal(led.isTrusted('/opt/homebrew/bin/codex', HASH_A), true)
    const rec = led.getRecord('/opt/homebrew/bin/codex')
    assert.equal(rec.sha256, HASH_A)
    assert.ok(rec.firstSeen)
    assert.ok(rec.approvedAt)
  })

  it('a changed hash is no longer trusted until re-approved (re-gate)', () => {
    const led = new BinaryProvenanceLedger({ filePath: ledgerPath })
    led.approve('/opt/homebrew/bin/codex', HASH_A)
    // Binary swapped: the new hash does not match the pinned one.
    assert.equal(led.isTrusted('/opt/homebrew/bin/codex', HASH_B), false)
    // Operator re-approves the new hash.
    led.approve('/opt/homebrew/bin/codex', HASH_B)
    assert.equal(led.isTrusted('/opt/homebrew/bin/codex', HASH_B), true)
  })

  it('persists to disk under the "binaries" wrapper key at mode 0600', () => {
    const led = new BinaryProvenanceLedger({ filePath: ledgerPath })
    led.approve('/opt/homebrew/bin/codex', HASH_A)
    assert.ok(binaryTrustFileExists(ledgerPath))
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    assert.ok(parsed.binaries, 'on-disk shape wraps records under "binaries"')
    assert.equal(parsed.binaries['/opt/homebrew/bin/codex'].sha256, HASH_A)
    // POSIX: owner-only permissions on the sidecar.
    if (process.platform !== 'win32') {
      const mode = statSync(ledgerPath).mode & 0o777
      assert.equal(mode, 0o600)
    }
  })

  it('reloads a persisted ledger from disk', () => {
    const first = new BinaryProvenanceLedger({ filePath: ledgerPath })
    first.approve('/opt/homebrew/bin/codex', HASH_A)
    const second = new BinaryProvenanceLedger({ filePath: ledgerPath })
    assert.equal(second.isTrusted('/opt/homebrew/bin/codex', HASH_A), true)
  })

  it('fails open to an empty ledger on a corrupt file', () => {
    writeFileSync(ledgerPath, '{ this is not valid json', 'utf8')
    const led = new BinaryProvenanceLedger({ filePath: ledgerPath })
    // A corrupt ledger must not lock every binary out — it loads empty.
    assert.equal(led.getRecord('/opt/homebrew/bin/codex'), null)
  })

  it('revoke drops the record so the binary re-gates', () => {
    const led = new BinaryProvenanceLedger({ filePath: ledgerPath })
    led.approve('/opt/homebrew/bin/codex', HASH_A)
    assert.equal(led.revoke('/opt/homebrew/bin/codex'), true)
    assert.equal(led.getRecord('/opt/homebrew/bin/codex'), null)
  })

  // #8068: since #8065, `chroxy resume` opens its own BinaryProvenanceLedger
  // on the same default `binary-trust.json` the daemon's SessionManager
  // already holds — two independent writer PROCESSES, each loading the file
  // once at construction. This is the issue's own repro (daemon started
  // first, `chroxy resume` pins a path, the daemon then pins one of its own).
  describe('two writer processes on the same file (#8068)', () => {
    it('a pin the CLI process wrote is not lost at the daemon process\'s next flush', () => {
      const daemon = new BinaryProvenanceLedger({ filePath: ledgerPath }) // daemon start
      const cli = new BinaryProvenanceLedger({ filePath: ledgerPath })    // chroxy resume, later

      cli.approve('/usr/local/bin/claude', HASH_A)
      daemon.approve('/opt/homebrew/bin/codex', HASH_B) // first-sight pin of its own

      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.ok(onDisk.binaries['/usr/local/bin/claude'], 'the chroxy-resume pin must survive the daemon\'s flush')
      assert.equal(onDisk.binaries['/usr/local/bin/claude'].sha256, HASH_A)
      assert.ok(onDisk.binaries['/opt/homebrew/bin/codex'], 'the daemon\'s own pin is still there too')
    })
  })

  // #8072 review C3: `verifyProvenance` calls `approve(path, hash,
  // { firstSight: true })` for its trust-on-first-use pin — a write from a
  // possibly-stale in-memory snapshot, not an operator decision. A stale
  // daemon (constructed before, or simply never having reloaded since, the
  // CLI's genuine pin landed) must not be able to overwrite that pin with
  // its own first-sight read of a swapped binary.
  describe('a stale TOFU write never overrides another process\'s genuine pin (#8072 review C3)', () => {
    it('the daemon\'s stale first-sight pin of a swapped binary does not overwrite the CLI\'s genuine pin', () => {
      const daemon = new BinaryProvenanceLedger({ filePath: ledgerPath }) // constructed first, sees nothing
      const cli = new BinaryProvenanceLedger({ filePath: ledgerPath })    // chroxy resume, later

      // CLI's own first sight of the real binary — nothing on disk yet to
      // conflict with, so this TOFU write applies.
      cli.approve('/usr/local/bin/claude', HASH_A, { firstSight: true })

      // The daemon's stale snapshot (constructed before the CLI's pin
      // landed, never reloaded) now "first sees" a swapped binary and
      // writes its own TOFU pin of the swapped hash.
      daemon.approve('/usr/local/bin/claude', HASH_B, { firstSight: true })

      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.equal(onDisk.binaries['/usr/local/bin/claude'].sha256, HASH_A,
        'the CLI\'s genuine pin must survive the daemon\'s stale TOFU write')
      assert.equal(daemon.isTrusted('/usr/local/bin/claude', HASH_B), false,
        'the daemon\'s own in-memory state must self-heal to the genuine pin after its flush')
      assert.equal(daemon.isTrusted('/usr/local/bin/claude', HASH_A), true,
        'so the NEXT verifyProvenance call in the daemon correctly blocks the swapped binary')
    })

    // #8072 review round 2, S1: the test above calls `approve(..., {
    // firstSight: true })` DIRECTLY, so it cannot tell "verifyProvenance
    // passes firstSight" apart from "the ledger honours firstSight when
    // asked" — deleting `{ firstSight: true }` from verify-provenance.js's
    // own call site (mutant MC3c) left this file, and verify-provenance's
    // own suite (whose fake ledger ignores opts entirely), green. This test
    // drives the SAME scenario through the real production entry point,
    // `verifyProvenance()` itself, with an injected `sha256File` — so a
    // dropped `firstSight` flag is caught here.
    it('verifyProvenance\'s own first-sight pin does not overwrite another process\'s genuine pin', () => {
      const path = '/usr/local/bin/claude'
      const daemon = new BinaryProvenanceLedger({ filePath: ledgerPath }) // constructed first, sees nothing
      const cli = new BinaryProvenanceLedger({ filePath: ledgerPath })    // chroxy resume, later

      // CLI's first verifyProvenance call ever for this path — first sight,
      // pins the real hash and allows.
      const cliVerdict = verifyProvenance({
        resolvedPath: path,
        mode: 'block',
        ledger: cli,
        sha256File: () => HASH_A,
      })
      assert.equal(cliVerdict.ok, true)
      assert.equal(cliVerdict.status, 'pinned')

      // The daemon's stale ledger (constructed before the CLI's pin landed,
      // never reloaded) also has no record for this path, so its own
      // verifyProvenance call ALSO takes the first-sight branch — pinning
      // whatever `sha256File` reports for the daemon's (possibly swapped)
      // view of the binary.
      const daemonVerdict = verifyProvenance({
        resolvedPath: path,
        mode: 'block',
        ledger: daemon,
        sha256File: () => HASH_B,
      })
      assert.equal(daemonVerdict.status, 'pinned')

      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.equal(onDisk.binaries[path].sha256, HASH_A,
        'the CLI\'s genuine pin (via verifyProvenance) must survive the daemon\'s stale first-sight write (via verifyProvenance)')

      // The daemon's NEXT verifyProvenance call must correctly detect the
      // hash mismatch and block, now that its memory has self-healed.
      const daemonNextVerdict = verifyProvenance({
        resolvedPath: path,
        mode: 'block',
        ledger: daemon,
        sha256File: () => HASH_B,
      })
      assert.equal(daemonNextVerdict.status, 'hash_mismatch')
      assert.equal(daemonNextVerdict.blocked, true)
    })
  })
})
