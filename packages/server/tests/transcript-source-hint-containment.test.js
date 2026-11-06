import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTranscriptSource } from '../src/transcript-sources.js'
import { encodeProjectPath } from '../src/jsonl-reader.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

// The cwd-derived path (no scanner locator) is a storage key only: it must meet
// the same containment and identity checks a scanner-found file does.
const ID = '33333333-3333-4333-8333-333333333333'
const CWD = '/work/area/project'

describe('transcript source derived from a cwd', () => {
  let root
  let store
  let outside
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'transcript-hint-')))
    store = join(root, 'store')
    outside = join(root, 'outside')
    mkdirSync(store, { recursive: true })
    mkdirSync(outside, { recursive: true })
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  const sources = () => [{ provider: 'claude', projectsDir: store }]
  const resolve = (cwd = CWD) => resolveTranscriptSource({ provider: 'claude', conversationId: ID, cwd, sources: sources() })

  it('resolves a file inside the store and reports its identity', () => {
    const dir = join(store, encodeProjectPath(CWD))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${ID}.jsonl`), '{"type":"user"}\n')
    const r = resolve()
    assert.equal(r.ok, true)
    assert.equal(r.path, join(dir, `${ID}.jsonl`))
    assert.equal(typeof r.identity.ino, 'bigint')
  })

  it('reports a missing file as unavailable rather than handing back an unchecked path', () => {
    const r = resolve('/work/area/never-written')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'source_unavailable')
  })

  it('refuses a project directory that is a link pointing outside the store', { skip: SKIP_NO_SYMLINK }, () => {
    const planted = '/work/area/planted'
    mkdirSync(join(outside, 'elsewhere'), { recursive: true })
    writeFileSync(join(outside, 'elsewhere', `${ID}.jsonl`), '{"type":"user"}\n')
    symlinkSync(join(outside, 'elsewhere'), join(store, encodeProjectPath(planted)))
    const r = resolve(planted)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'invalid_source')
    assert.match(r.reason, /outside/)
  })

  it('refuses a transcript file that is a link pointing outside the store', { skip: SKIP_NO_SYMLINK }, () => {
    const planted = '/work/area/file-link'
    const dir = join(store, encodeProjectPath(planted))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(outside, 'target.jsonl'), '{"type":"user"}\n')
    symlinkSync(join(outside, 'target.jsonl'), join(dir, `${ID}.jsonl`))
    const r = resolve(planted)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'invalid_source')
  })

  it('still refuses a cwd of the wrong type or none', () => {
    for (const cwd of [null, '', 7]) {
      const r = resolveTranscriptSource({ provider: 'claude', conversationId: ID, cwd, sources: sources() })
      assert.equal(r.ok, false)
    }
  })
})
