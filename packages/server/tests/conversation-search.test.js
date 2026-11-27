import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { searchConversations, extractSearchableText } from '../src/conversation-search.js'

const NOISE_STRINGS = [
  '<task-notification>background task finished</task-notification>',
  '<ci-monitor-event name="x">green</ci-monitor-event>',
  '<system-reminder>be brief</system-reminder>',
  '<command-name>/clear</command-name>',
  '<command-message>clear</command-message>',
  '<command-args>now</command-args>',
  '<local-command-stdout>ok</local-command-stdout>',
  '<local-command-stderr>oops</local-command-stderr>',
  '<local-command-caveat>caveat</local-command-caveat>',
  '<bash-input>ls</bash-input>',
  '<bash-stdout>out</bash-stdout>',
  '<bash-stderr>err</bash-stderr>',
]

// Helper to create a fake JSONL conversation file
function makeEntry(type, text, cwd) {
  const entry = { type }
  if (type === 'user') {
    entry.message = { content: [{ type: 'text', text }] }
  } else if (type === 'assistant') {
    entry.message = { content: [{ type: 'text', text }] }
  }
  if (cwd) entry.cwd = cwd
  return JSON.stringify(entry)
}

describe('conversation-search', () => {
  let tmpDir

  before(async () => {
    tmpDir = join(tmpdir(), `chroxy-search-test-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  // #6448 — bound the query length (every candidate file is substring-scanned).
  it('returns [] for a query longer than the max length (DoS guard)', async () => {
    const res = await searchConversations('x'.repeat(501))
    assert.deepEqual(res, [])
  })

  describe('extractSearchableText', () => {
    it('extracts text from user message with array content', () => {
      const entry = { type: 'user', message: { content: [{ type: 'text', text: 'hello world' }] } }
      assert.ok(extractSearchableText(entry).includes('hello world'))
    })

    it('extracts text from user message with string content', () => {
      const entry = { type: 'user', message: { content: 'hello world' } }
      assert.ok(extractSearchableText(entry).includes('hello world'))
    })

    it('extracts text from assistant message', () => {
      const entry = { type: 'assistant', message: { content: [{ type: 'text', text: 'response text' }] } }
      assert.ok(extractSearchableText(entry).includes('response text'))
    })

    it('returns empty string for entries without text', () => {
      const entry = { type: 'result' }
      assert.equal(extractSearchableText(entry), '')
    })

    it('skips tool_result content blocks', () => {
      const entry = { type: 'user', message: { content: [{ type: 'tool_result', content: 'secret' }] } }
      assert.equal(extractSearchableText(entry), '')
    })

    describe('user strings no person typed (#9363)', () => {
      for (const noise of NOISE_STRINGS) {
        it(`does not index ${noise.slice(0, 22)}`, () => {
          assert.equal(extractSearchableText({ type: 'user', message: { content: noise } }), '')
        })
      }

      for (const flag of ['isMeta', 'isCompactSummary', 'isSidechain']) {
        it(`does not index a string entry flagged ${flag}`, () => {
          assert.equal(extractSearchableText({ type: 'user', [flag]: true, message: { content: 'plain text' } }), '')
        })
      }

      it('still indexes a string prompt that only mentions a tag mid-text', () => {
        const text = 'why does <system-reminder> show up?'
        assert.equal(extractSearchableText({ type: 'user', message: { content: text } }), text)
      })

      it('leaves array user content and assistant string content as before', () => {
        const wrapped = '<system-reminder>x</system-reminder>'
        assert.equal(extractSearchableText({ type: 'user', message: { content: [{ type: 'text', text: wrapped }] } }), wrapped)
        assert.equal(extractSearchableText({ type: 'assistant', message: { content: wrapped } }), wrapped)
      })
    })
  })

  describe('searchConversations', () => {
    let projectDir

    beforeEach(async () => {
      projectDir = join(tmpDir, `-test-project-${Date.now()}`)
      await mkdir(projectDir, { recursive: true })
    })

    it('does not match wrapper-only user strings, previews the first real prompt, and finds it', async () => {
      const str = (content) => JSON.stringify({ type: 'user', cwd: '/test', message: { content } })
      const lines = [
        str('<local-command-stdout>zebrafish</local-command-stdout>'),
        str('<system-reminder>zebrafish</system-reminder>'),
        str('refactor the quokka module'),
      ]
      await writeFile(join(projectDir, 'noise.jsonl'), lines.join('\n'))

      assert.equal((await searchConversations('zebrafish', { projectsDir: tmpDir })).length, 0)
      const hits = await searchConversations('quokka', { projectsDir: tmpDir })
      assert.equal(hits.length, 1)
      assert.equal(hits[0].preview, 'refactor the quokka module')
    })

    it('previews a real prompt after noise when the match is in assistant text', async () => {
      const lines = [
        JSON.stringify({ type: 'user', cwd: '/test', message: { content: '<command-name>/clear</command-name>' } }),
        JSON.stringify({ type: 'user', message: { content: 'first real prompt' } }),
        makeEntry('assistant', 'the axolotl answer'),
      ]
      await writeFile(join(projectDir, 'noise2.jsonl'), lines.join('\n'))
      const hits = await searchConversations('axolotl', { projectsDir: tmpDir })
      assert.equal(hits[0].preview, 'first real prompt')
    })

    it('still finds a prompt that only mentions a tag mid-text', async () => {
      await writeFile(join(projectDir, 'mention.jsonl'), JSON.stringify({ type: 'user', cwd: '/test', message: { content: 'why does <system-reminder> keep appearing wombat' } }))
      const hits = await searchConversations('wombat', { projectsDir: tmpDir })
      assert.equal(hits.length, 1)
      assert.ok(hits[0].preview.includes('<system-reminder>'))
    })

    it('returns empty array when no files match', async () => {
      const lines = [
        makeEntry('user', 'no match here', '/test'),
        makeEntry('assistant', 'nothing relevant'),
      ]
      await writeFile(join(projectDir, 'conv1.jsonl'), lines.join('\n'))

      const results = await searchConversations('xyznotfound', { projectsDir: tmpDir })
      assert.equal(results.length, 0)
    })

    it('finds matches in user messages', async () => {
      const lines = [
        makeEntry('user', 'fix the authentication bug', '/test'),
        makeEntry('assistant', 'I will look into it'),
      ]
      await writeFile(join(projectDir, 'conv2.jsonl'), lines.join('\n'))

      const results = await searchConversations('authentication', { projectsDir: tmpDir })
      assert.ok(results.length > 0)
      assert.ok(results[0].snippet.toLowerCase().includes('authentication'))
    })

    it('finds matches in assistant messages', async () => {
      const lines = [
        makeEntry('user', 'help me', '/test'),
        makeEntry('assistant', 'The database connection is failing'),
      ]
      await writeFile(join(projectDir, 'conv3.jsonl'), lines.join('\n'))

      const results = await searchConversations('database', { projectsDir: tmpDir })
      assert.ok(results.length > 0)
    })

    it('is case-insensitive', async () => {
      const lines = [
        makeEntry('user', 'Fix the WebSocket handler', '/test'),
      ]
      await writeFile(join(projectDir, 'conv4.jsonl'), lines.join('\n'))

      const results = await searchConversations('websocket', { projectsDir: tmpDir })
      assert.ok(results.length > 0)
    })

    it('respects maxResults limit', async () => {
      // Create multiple conversations with matching content
      for (let i = 0; i < 5; i++) {
        const dir = join(tmpDir, `-limit-test-${Date.now()}-${i}`)
        await mkdir(dir, { recursive: true })
        const lines = [makeEntry('user', `match keyword conversation ${i}`, '/test')]
        await writeFile(join(dir, `conv-limit-${i}.jsonl`), lines.join('\n'))
      }

      const results = await searchConversations('keyword', { projectsDir: tmpDir, maxResults: 2 })
      assert.ok(results.length <= 2)
    })

    it('returns conversation metadata with results', async () => {
      const lines = [
        makeEntry('user', 'deploy the server to production', '/home/user/project'),
        makeEntry('assistant', 'Starting deployment...'),
      ]
      await writeFile(join(projectDir, 'conv5.jsonl'), lines.join('\n'))

      const results = await searchConversations('deploy', { projectsDir: tmpDir })
      assert.ok(results.length > 0)
      const result = results[0]
      assert.ok(result.conversationId)
      assert.ok(result.snippet)
      assert.ok(typeof result.matchCount === 'number')
    })

    it('returns empty for empty query', async () => {
      const results = await searchConversations('', { projectsDir: tmpDir })
      assert.equal(results.length, 0)
    })

    it('returns empty for whitespace-only query', async () => {
      const results = await searchConversations('   ', { projectsDir: tmpDir })
      assert.equal(results.length, 0)
    })
  })
})
