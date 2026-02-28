import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { searchConversations, extractSearchableText } from '../src/conversation-search.js'

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
  })

  describe('searchConversations', () => {
    let projectDir

    beforeEach(async () => {
      projectDir = join(tmpDir, `-test-project-${Date.now()}`)
      await mkdir(projectDir, { recursive: true })
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
