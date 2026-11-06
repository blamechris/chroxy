import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchConversations } from '../src/conversation-search.js'

const OWN = '55555555-5555-4555-8555-555555555555'
const SIBLING = '66666666-6666-4666-8666-666666666666'
const rec = (text) => JSON.stringify({ type: 'user', cwd: '/work/proj', message: { content: [{ type: 'text', text }] } }) + '\n'

describe('conversation search restricted to one conversation', () => {
  let dir
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-search-restrict-'))
    const proj = join(dir, '-work-proj')
    mkdirSync(proj, { recursive: true })
    // The sibling matches the query MORE often, so an unrestricted search ranks it first.
    writeFileSync(join(proj, `${OWN}.jsonl`), rec('needle once in the caller\'s own conversation text padding padding'))
    writeFileSync(join(proj, `${SIBLING}.jsonl`), rec('needle needle one') + rec('needle needle two') + rec('needle needle three'))
  })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  it('unrestricted: the sibling outranks and, with a cap of one, displaces the caller\'s conversation (control)', async () => {
    const out = await searchConversations('needle', { projectsDir: dir, maxResults: 1 })
    assert.deepEqual(out.map((r) => r.conversationId), [SIBLING])
  })

  it('restricted: only that conversation is read, ranked and returned, whatever the sibling contains', async () => {
    const out = await searchConversations('needle', { projectsDir: dir, maxResults: 1, conversationId: OWN })
    assert.deepEqual(out.map((r) => r.conversationId), [OWN])
    const none = await searchConversations('needle', { projectsDir: dir, maxResults: 1, conversationId: '77777777-7777-4777-8777-777777777777' })
    assert.deepEqual(none, [])
  })
})
