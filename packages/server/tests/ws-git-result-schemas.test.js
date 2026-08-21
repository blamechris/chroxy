import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  ServerGitCommitResultSchema,
  ServerGitStageResultSchema,
  ServerGitUnstageResultSchema,
} from '@chroxy/protocol'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { GIT } from '../src/git.js'
import { disableRepoAutoGc, rmDirRobustAsync } from './test-helpers.js'

/**
 * #7085 stage 2 — schemas for the three git write-op acks.
 *
 * These schemas exist to back a future dev/CI gate that safeParses everything
 * the server sends, which makes a WRONG schema worse than a missing one: a
 * missing one leaves the type allowlisted, while a wrong one throws on real
 * traffic the moment the gate lands.
 *
 * So this drives the REAL handlers against a REAL git repo and parses what they
 * actually emit. An earlier version asserted against a hand-transcribed table of
 * payload literals and justified it with "driving the handlers would need a real
 * git fixture" — which was simply false: `git-stage-commit.test.js` already has
 * that fixture and already drives every branch. A transcribed table only pins
 * the transcription; no line of `ws-file-ops/git.js` could be deleted and fail it.
 */

const GIT_JS = fileURLToPath(new URL('../src/ws-file-ops/git.js', import.meta.url))

const SCHEMAS = {
  git_commit_result: ServerGitCommitResultSchema,
  git_stage_result: ServerGitStageResultSchema,
  git_unstage_result: ServerGitUnstageResultSchema,
}

/**
 * Emit sites per type in the producer. Exact equality, not `>=`: the first
 * version compared the transcribed-shape count against the emit count, which
 * left slack wherever one site can emit more than one shape — `git_commit_result`
 * had 4 sites and 5 shapes, so adding a fifth site would NOT have tripped it.
 * Counting sites against a pinned number fires for every type.
 */
const EXPECTED_EMIT_SITES = {
  git_commit_result: 4,
  // 6 since #7281 added the empty-pathspec rejection to gitStage and gitUnstage.
  git_stage_result: 6,
  git_unstage_result: 6,
}

/** Every response the handlers produced, so one fixture covers all three types. */
const captured = []

describe('#7085 git write-op result schemas', () => {
  let tmpDir
  let fileOps
  const mockWs = {}

  before(async () => {
    assert.ok(
      ServerGitCommitResultSchema && ServerGitStageResultSchema && ServerGitUnstageResultSchema,
      'the git result schemas are missing from the resolved @chroxy/protocol.\n' +
      'A git worktree resolves that package from the MAIN checkout, so schemas added\n' +
      'in this branch are invisible there. Run from the main checkout or CI.',
    )

    tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-schemas-'))
    fileOps = createFileOps((_ws, msg) => captured.push(msg), tmpDir)
    execFileSync(GIT, ['init'], { cwd: tmpDir })
    disableRepoAutoGc(tmpDir) // #6098: stop background gc racing the teardown rm
    execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
    execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: tmpDir })
    await writeFile(join(tmpDir, 'README.md'), '# Test')
    execFileSync(GIT, ['add', '.'], { cwd: tmpDir })
    execFileSync(GIT, ['commit', '-m', 'Initial commit'], { cwd: tmpDir })

    // Success paths.
    await writeFile(join(tmpDir, 'new.txt'), 'new file')
    await fileOps.gitStage(mockWs, ['new.txt'], tmpDir)
    await fileOps.gitUnstage(mockWs, ['new.txt'], tmpDir)
    await fileOps.gitStage(mockWs, ['new.txt'], tmpDir)
    await fileOps.gitCommit(mockWs, 'test: a real commit', tmpDir)

    // Error paths: empty selection, no session cwd, traversal, empty message.
    await fileOps.gitStage(mockWs, [], tmpDir)
    await fileOps.gitUnstage(mockWs, [], tmpDir)
    await fileOps.gitStage(mockWs, ['file.txt'], null)
    await fileOps.gitUnstage(mockWs, ['file.txt'], null)
    await fileOps.gitCommit(mockWs, 'msg', null)
    await fileOps.gitStage(mockWs, ['../outside.txt'], tmpDir)
    await fileOps.gitUnstage(mockWs, ['../outside.txt'], tmpDir)
    await fileOps.gitCommit(mockWs, '   ', tmpDir)
    // #7281 — the empty-pathspec rejection. A separate branch from the traversal
    // one above: it fires before containment is consulted at all.
    await fileOps.gitStage(mockWs, [''], tmpDir)
    await fileOps.gitUnstage(mockWs, [''], tmpDir)

    await rm(join(tmpDir, 'new.txt'), { force: true })
  })

  after(async () => {
    if (tmpDir) await rmDirRobustAsync(tmpDir)
  })

  it('CONTROL: the fixture actually exercised all three producers', () => {
    // Every assertion below is vacuously true over an empty capture list, and a
    // handler that silently no-ops would look identical to one that passed.
    for (const type of Object.keys(SCHEMAS)) {
      const n = captured.filter((m) => m.type === type).length
      assert.ok(n > 0, `no ${type} was produced — the fixture did not drive that handler`)
    }
    // Both outcomes must be represented, or the success/failure shape divergence
    // (which is where `hash`/`message` differ) goes untested.
    const commits = captured.filter((m) => m.type === 'git_commit_result')
    assert.ok(commits.some((m) => m.error === null), 'no successful commit captured')
    assert.ok(commits.some((m) => m.error !== null), 'no failed commit captured')
  })

  it('every message the real handlers emitted parses against its schema', () => {
    for (const msg of captured) {
      const schema = SCHEMAS[msg.type]
      if (!schema) continue
      const r = schema.safeParse(msg)
      assert.ok(
        r.success,
        `the server emits this and the schema refuses it — the outbound gate would ` +
        `throw on real traffic:\n${JSON.stringify(msg)}\n${JSON.stringify(r.error?.issues ?? [])}`,
      )
    }
  })

  it('CONTROL: the schemas are not blanket-permissive', () => {
    // Without this, "everything the handlers emit parses" would pass for a
    // schema that accepts anything at all.
    assert.equal(ServerGitStageResultSchema.safeParse({ type: 'git_stage_result' }).success, false, 'error is required')
    assert.equal(ServerGitStageResultSchema.safeParse({ type: 'wrong', error: null }).success, false, 'type is pinned')
    assert.equal(ServerGitCommitResultSchema.safeParse({ type: 'git_commit_result', hash: 1, message: null, error: null }).success, false, 'hash must be a string')
    assert.equal(ServerGitCommitResultSchema.safeParse({ type: 'git_commit_result', error: null }).success, false, 'hash/message are required')
    assert.equal(ServerGitUnstageResultSchema.safeParse({ type: 'git_unstage_result', error: 0 }).success, false, 'error must be a string or null')
  })

  it('the roster\'s phantom `success` field really is absent from the producer', () => {
    // ws-server.js's roster documented all three as carrying `success`; none
    // does. If one is ever genuinely added, this fails and forces the schemas
    // and the roster to be updated together.
    //
    // Scans each emit's full object literal rather than only the field directly
    // after `type:`. The first version anchored `success` to that position, so a
    // `success` appended as the LAST field slipped through — verified by mutation.
    const src = readFileSync(GIT_JS, 'utf8')
    for (const type of Object.keys(SCHEMAS)) {
      for (const m of src.matchAll(new RegExp(`type:\\s*'${type}'`, 'g'))) {
        // From the type literal to the end of the object literal.
        const rest = src.slice(m.index, src.indexOf('}', m.index))
        assert.equal(
          /\bsuccess\s*:/.test(rest), false,
          `${type} now emits a \`success\` field — update the schema and the ws-server roster`,
        )
      }
    }
  })

  it('DRIFT GUARD: the producer has not gained or lost an emit site', () => {
    // Pinned to an exact count so a NEW branch emitting an unmodelled shape
    // fails here rather than surfacing as a thrown gate months later. The
    // fixture above cannot cover a branch it does not know about.
    const src = readFileSync(GIT_JS, 'utf8')
    for (const [type, expected] of Object.entries(EXPECTED_EMIT_SITES)) {
      const emits = [...src.matchAll(new RegExp(`type:\\s*'${type}'`, 'g'))].length
      assert.equal(
        emits, expected,
        `${type}: ${emits} emit sites, expected ${expected} — a producer branch was ` +
        'added or removed. Drive it from the fixture above, then update this count.',
      )
    }
  })
})
