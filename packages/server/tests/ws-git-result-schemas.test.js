import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ServerGitCommitResultSchema,
  ServerGitStageResultSchema,
  ServerGitUnstageResultSchema,
} from '@chroxy/protocol'

/**
 * #7085 stage 2 — schemas for the three git write-op acks, previously on the
 * outbound-coverage allowlist.
 *
 * The point of these schemas is a future dev/CI gate that safeParses everything
 * the server sends. That makes a WRONG schema worse than a missing one: a
 * missing one leaves the type allowlisted, while a wrong one throws on real
 * traffic the moment the gate lands.
 *
 * So the shapes here were taken from the producers, not from ws-server.js's
 * roster — which documented all three as carrying a `success` boolean that none
 * of them has ever sent. (The roster's TYPE names are pinned by the coverage
 * test; its FIELD lists were pinned by nothing, so they drifted freely. Both the
 * roster and these schemas are corrected in the same change.)
 */

const GIT_JS = fileURLToPath(new URL('../src/ws-file-ops/git.js', import.meta.url))

/**
 * Every payload shape the producer actually emits, transcribed from
 * `ws-file-ops/git.js`. Kept as literals rather than driving the handlers,
 * which would need a real git fixture; the drift guard below is what stops
 * this list from silently falling behind.
 */
const REAL_PAYLOADS = {
  git_commit_result: [
    // success path — hash scraped from `git commit` stdout
    { type: 'git_commit_result', hash: 'a1b2c3d', message: 'feat: thing', error: null },
    // success, but the hash could not be scraped from stdout
    { type: 'git_commit_result', hash: null, message: 'feat: thing', error: null },
    { type: 'git_commit_result', hash: null, message: null, error: 'Git commit is not available in this mode' },
    { type: 'git_commit_result', hash: null, message: null, error: 'Commit message cannot be empty' },
    { type: 'git_commit_result', hash: null, message: null, error: 'Failed to create commit' },
  ],
  git_stage_result: [
    { type: 'git_stage_result', error: null },
    { type: 'git_stage_result', error: 'Git staging is not available in this mode' },
    { type: 'git_stage_result', error: 'No files specified to stage' },
    { type: 'git_stage_result', error: 'Access denied: path outside project directory — x' },
    { type: 'git_stage_result', error: 'Failed to stage files' },
  ],
  git_unstage_result: [
    { type: 'git_unstage_result', error: null },
    { type: 'git_unstage_result', error: 'Git unstaging is not available in this mode' },
    { type: 'git_unstage_result', error: 'No files specified to unstage' },
    { type: 'git_unstage_result', error: 'Access denied: path outside project directory — x' },
    { type: 'git_unstage_result', error: 'Failed to unstage files' },
  ],
}

const SCHEMAS = {
  git_commit_result: ServerGitCommitResultSchema,
  git_stage_result: ServerGitStageResultSchema,
  git_unstage_result: ServerGitUnstageResultSchema,
}

describe('#7085 git write-op result schemas', () => {
  for (const [type, payloads] of Object.entries(REAL_PAYLOADS)) {
    it(`${type}: every real producer payload is accepted`, () => {
      for (const payload of payloads) {
        const r = SCHEMAS[type].safeParse(payload)
        assert.ok(
          r.success,
          `the server emits this and the schema refuses it — the outbound gate would throw on real traffic:\n` +
          `${JSON.stringify(payload)}\n${JSON.stringify(r.error?.issues ?? [])}`,
        )
      }
    })
  }

  it('CONTROL: the schemas are not blanket-permissive', () => {
    // Without this, "every real payload is accepted" would pass for a schema
    // that accepts literally anything, proving nothing about the shapes.
    assert.equal(ServerGitStageResultSchema.safeParse({ type: 'git_stage_result' }).success, false, 'error is required')
    assert.equal(ServerGitStageResultSchema.safeParse({ type: 'wrong', error: null }).success, false, 'type is pinned')
    assert.equal(ServerGitCommitResultSchema.safeParse({ type: 'git_commit_result', hash: 1, message: null, error: null }).success, false, 'hash must be a string')
    assert.equal(ServerGitCommitResultSchema.safeParse({ type: 'git_commit_result', error: null }).success, false, 'hash/message are required')
  })

  it('the roster\'s phantom `success` field really is absent from the producer', () => {
    // This is the drift that made writing these schemas from the roster unsafe.
    // If a `success` field is ever genuinely added, this fails and the schemas
    // (and roster) must be updated together.
    const src = readFileSync(GIT_JS, 'utf8')
    assert.equal(
      /type:\s*'git_(commit|stage|unstage)_result',\s*\n?\s*success/.test(src), false,
      'a git result now emits `success` — update the schemas and the ws-server roster',
    )
  })

  it('DRIFT GUARD: no producer branch emits a shape this test does not cover', () => {
    // The payload table above is hand-transcribed, so it can fall behind a new
    // branch. Count the emit sites per type and require the table to cover at
    // least as many — a new branch with an unlisted shape fails here rather
    // than surfacing as a thrown gate months later.
    const src = readFileSync(GIT_JS, 'utf8')
    for (const type of Object.keys(REAL_PAYLOADS)) {
      const emits = [...src.matchAll(new RegExp(`type:\\s*'${type}'`, 'g'))].length
      assert.ok(emits > 0, `no producer found for ${type} — did the file move?`)
      assert.ok(
        REAL_PAYLOADS[type].length >= emits,
        `${type}: ${emits} producer branches but only ${REAL_PAYLOADS[type].length} shapes covered — ` +
        'transcribe the new branch into REAL_PAYLOADS',
      )
    }
  })
})
