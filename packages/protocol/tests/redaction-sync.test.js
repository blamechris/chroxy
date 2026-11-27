import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// #9235: packages/server/src/redaction.js is the one authored source; the protocol copy
// is generated from it. This is the drift gate. It runs in the Protocol Tests job, which
// has no path filter (CI runs every job on every pull_request and push), so a change to
// EITHER file reaches it. packages/protocol/dist is covered by check-dist-drift.sh.
const SCRIPT = fileURLToPath(new URL('../scripts/sync-redaction.mjs', import.meta.url))
const SERVER = fileURLToPath(new URL('../../server/src/redaction.js', import.meta.url))
const COPY = fileURLToPath(new URL('../src/redaction.js', import.meta.url))
const FIX = 'Edit packages/server/src/redaction.js only, then run: npm run sync-redaction -w @chroxy/protocol && npm run build -w @chroxy/protocol'

const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' })

describe('protocol redaction copy', () => {
  it('is byte-identical to the server source', () => {
    const r = run('--check')
    assert.equal(r.status, 0, `the protocol copy has drifted. ${FIX}\n${r.stderr}`)
    assert.ok(readFileSync(SERVER).equals(readFileSync(COPY)), `copy differs. ${FIX}`)
  })

  describe('the gate itself (on temp copies)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'redaction-sync-'))
    after(() => rmSync(dir, { recursive: true, force: true }))
    const srcP = join(dir, 'server.js')
    const destP = join(dir, 'protocol.js')
    const reset = () => { copyFileSync(SERVER, srcP); copyFileSync(SERVER, destP) }

    it('goes red when one byte of the protocol copy changes, and names the sync command', () => {
      reset()
      writeFileSync(destP, readFileSync(destP, 'utf8') + ' ')
      const r = run('--check', '--src', srcP, '--dest', destP)
      assert.equal(r.status, 1)
      assert.ok(r.stderr.includes('npm run sync-redaction'), r.stderr)
    })

    it('goes red when the server source changes without a sync', () => {
      reset()
      writeFileSync(srcP, readFileSync(srcP, 'utf8') + '\n')
      assert.equal(run('--check', '--src', srcP, '--dest', destP).status, 1)
    })

    it('a sync makes it green again, and a second sync writes nothing', () => {
      const w = run('--src', srcP, '--dest', destP)
      assert.equal(w.status, 0)
      assert.ok(w.stdout.includes('wrote'), w.stdout)
      assert.equal(run('--check', '--src', srcP, '--dest', destP).status, 0)
      assert.ok(run('--src', srcP, '--dest', destP).stdout.includes('already in sync'))
    })

    it('goes red when the copy is missing', () => {
      rmSync(destP)
      assert.equal(run('--check', '--src', srcP, '--dest', destP).status, 1)
    })
  })
})
