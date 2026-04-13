import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { Supervisor } from '../src/supervisor.js'

/**
 * Adversary A9 (2026-04-11 audit) — known-good-ref poisoning via
 * write_file. The supervisor's rollback path now requires the ref in
 * ~/.chroxy/known-good-ref to match a `known-good-*` git tag, so a
 * poisoned ref (even one that points to a valid commit in the repo)
 * is refused.
 *
 * Tests run against a real git repo in a temp directory so we
 * exercise the real `_rollbackToKnownGood` (not the test-mock used by
 * the circuit-breaker suite).
 */

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim()
}

describe('Supervisor._rollbackToKnownGood — Adversary A9', () => {
  let tmpDir
  let repoDir
  let chroxyDir
  let originalCwd
  let knownGoodCommit
  let attackerCommit
  let supervisor

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-rollback-a9-'))
    repoDir = join(tmpDir, 'repo')
    chroxyDir = join(tmpDir, 'chroxy')
    mkdirSync(repoDir)
    mkdirSync(chroxyDir)

    git(['init', '-q', '-b', 'main'], repoDir)
    writeFileSync(join(repoDir, 'a.txt'), 'one')
    git(['add', 'a.txt'], repoDir)
    git(['commit', '-q', '-m', 'first'], repoDir)
    knownGoodCommit = git(['rev-parse', 'HEAD'], repoDir)
    git(['tag', 'known-good-1234567890'], repoDir)

    // Second commit that is NOT tagged — represents an attacker-
    // supplied ref. It's a valid commit in the repo, so the old
    // rollback logic would have accepted it; the new logic refuses
    // it because no `known-good-*` tag points here.
    writeFileSync(join(repoDir, 'a.txt'), 'two')
    git(['add', 'a.txt'], repoDir)
    git(['commit', '-q', '-m', 'second'], repoDir)
    attackerCommit = git(['rev-parse', 'HEAD'], repoDir)

    originalCwd = process.cwd()
    process.chdir(repoDir)

    supervisor = new Supervisor({
      apiToken: 'test-token-12345678',
      port: 0,
      tunnel: 'quick',
      pidFilePath: join(tmpDir, 'supervisor.pid'),
      knownGoodFile: join(chroxyDir, 'known-good-ref'),
      maxRestarts: 10,
    })
  })

  after(() => {
    try { process.chdir(originalCwd) } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it('accepts a ref that matches a known-good-* tag', () => {
    writeFileSync(join(chroxyDir, 'known-good-ref'), knownGoodCommit)
    const ok = supervisor._rollbackToKnownGood()
    assert.equal(ok, true, 'valid tagged ref must be accepted')
    // Checkout moved HEAD — put it back for the next test
    git(['checkout', '-q', 'main'], repoDir)
  })

  it('rejects a valid-but-untagged commit (A9 poisoning attempt)', () => {
    writeFileSync(join(chroxyDir, 'known-good-ref'), attackerCommit)
    const ok = supervisor._rollbackToKnownGood()
    assert.equal(ok, false,
      'untagged commit must be refused even though it resolves in git')
  })

  it('rejects a completely bogus hex string', () => {
    writeFileSync(join(chroxyDir, 'known-good-ref'), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    const ok = supervisor._rollbackToKnownGood()
    assert.equal(ok, false, 'unknown SHA must be refused')
  })

  it('rejects non-hex content (branch name, path traversal, option flags)', () => {
    for (const attack of ['main', '../../etc/passwd', '-rf', '--help', 'HEAD~1', 'refs/heads/main']) {
      writeFileSync(join(chroxyDir, 'known-good-ref'), attack)
      const ok = supervisor._rollbackToKnownGood()
      assert.equal(ok, false, `non-hex input "${attack}" must be refused`)
    }
  })

  it('rejects empty file', () => {
    writeFileSync(join(chroxyDir, 'known-good-ref'), '')
    const ok = supervisor._rollbackToKnownGood()
    assert.equal(ok, false, 'empty ref file must be refused')
  })
})
