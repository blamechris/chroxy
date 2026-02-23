import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionDB } from '../src/session-db.js'

const TEST_DIR = join(tmpdir(), `chroxy-session-db-test-${Date.now()}`)

function testDbPath(name = 'test') {
  return join(TEST_DIR, `${name}.db`)
}

describe('SessionDB', () => {
  before(() => {
    mkdirSync(TEST_DIR, { recursive: true })
  })

  after(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
  })

  describe('initialization', () => {
    it('creates database and tables', () => {
      const db = new SessionDB(testDbPath('init'))
      try {
        // Should not throw
        const sessions = db.getActiveSessions()
        assert.deepStrictEqual(sessions, [])
      } finally {
        db.close()
      }
    })

    it('creates parent directory if missing', () => {
      const nested = join(TEST_DIR, 'nested', 'deep', 'test.db')
      const db = new SessionDB(nested)
      try {
        assert.ok(existsSync(nested))
      } finally {
        db.close()
      }
    })

    it('uses WAL mode', () => {
      const db = new SessionDB(testDbPath('wal'))
      try {
        // WAL file should exist after first write
        db.saveSession({ id: 'test', cwd: '/tmp' })
        // Check pragma
        const result = db._db.pragma('journal_mode')
        assert.strictEqual(result[0].journal_mode, 'wal')
      } finally {
        db.close()
      }
    })
  })

  describe('session CRUD', () => {
    let db

    beforeEach(() => {
      db = new SessionDB(testDbPath(`crud-${Date.now()}`))
    })

    after(() => { try { db?.close() } catch {} })

    it('creates and retrieves a session', () => {
      db.saveSession({
        id: 'session-1',
        sdkSessionId: 'sdk-123',
        cwd: '/home/user/project',
        name: 'My Session',
        model: 'claude-3-5-sonnet',
        permissionMode: 'approve',
      })

      const session = db.getSession('session-1')
      assert.ok(session)
      assert.strictEqual(session.id, 'session-1')
      assert.strictEqual(session.sdk_session_id, 'sdk-123')
      assert.strictEqual(session.cwd, '/home/user/project')
      assert.strictEqual(session.name, 'My Session')
      assert.strictEqual(session.model, 'claude-3-5-sonnet')
      assert.strictEqual(session.permission_mode, 'approve')
      assert.ok(session.created_at > 0)
      assert.ok(session.updated_at > 0)
      assert.strictEqual(session.destroyed_at, null)
    })

    it('updates session fields', () => {
      db.saveSession({ id: 's1', cwd: '/tmp', name: 'Original' })
      db.updateSession('s1', { name: 'Updated', model: 'claude-opus' })

      const session = db.getSession('s1')
      assert.strictEqual(session.name, 'Updated')
      assert.strictEqual(session.model, 'claude-opus')
    })

    it('soft-deletes a session', () => {
      db.saveSession({ id: 's1', cwd: '/tmp' })
      db.destroySession('s1')

      const session = db.getSession('s1')
      assert.ok(session.destroyed_at > 0)

      // Not in active sessions
      const active = db.getActiveSessions()
      assert.strictEqual(active.length, 0)
    })

    it('hard-deletes a session and its messages', () => {
      db.saveSession({ id: 's1', cwd: '/tmp' })
      db.recordMessage('s1', { type: 'message', messageType: 'response', content: 'Hello', timestamp: Date.now() })
      assert.strictEqual(db.getMessageCount('s1'), 1)

      db.deleteSession('s1')
      assert.strictEqual(db.getSession('s1'), null)
      assert.strictEqual(db.getMessageCount('s1'), 0) // CASCADE
    })

    it('lists active sessions in creation order', () => {
      db.saveSession({ id: 'a', cwd: '/a', name: 'A', createdAt: 1000 })
      db.saveSession({ id: 'c', cwd: '/c', name: 'C', createdAt: 3000 })
      db.saveSession({ id: 'b', cwd: '/b', name: 'B', createdAt: 2000 })

      const active = db.getActiveSessions()
      assert.strictEqual(active.length, 3)
      assert.strictEqual(active[0].id, 'a')
      assert.strictEqual(active[1].id, 'b')
      assert.strictEqual(active[2].id, 'c')
    })
  })

  describe('message recording', () => {
    let db

    beforeEach(() => {
      db = new SessionDB(testDbPath(`msg-${Date.now()}`))
      db.saveSession({ id: 's1', cwd: '/tmp' })
    })

    after(() => { try { db?.close() } catch {} })

    it('records and retrieves a message', () => {
      db.recordMessage('s1', {
        type: 'message',
        messageType: 'response',
        messageId: 'msg-1',
        content: 'Hello, world!',
        timestamp: 1000,
      })

      const history = db.getHistory('s1')
      assert.strictEqual(history.length, 1)
      assert.strictEqual(history[0].type, 'message')
      assert.strictEqual(history[0].message_type, 'response')
      assert.strictEqual(history[0].content, 'Hello, world!')
      assert.strictEqual(history[0].timestamp, 1000)
    })

    it('records tool start with input', () => {
      db.recordMessage('s1', {
        type: 'tool_start',
        messageId: 'tool-1',
        toolUseId: 'tu-1',
        tool: 'Read',
        input: { file_path: '/etc/hosts' },
        timestamp: 1000,
      })

      const history = db.getHistory('s1')
      assert.strictEqual(history.length, 1)
      assert.strictEqual(history[0].tool, 'Read')
      assert.deepStrictEqual(history[0].input, { file_path: '/etc/hosts' })
    })

    it('deduplicates by message_id', () => {
      const entry = {
        type: 'message',
        messageType: 'response',
        messageId: 'msg-dup',
        content: 'First',
        timestamp: 1000,
      }
      db.recordMessage('s1', entry)
      db.recordMessage('s1', { ...entry, content: 'Second' }) // Same messageId

      const history = db.getHistory('s1')
      assert.strictEqual(history.length, 1)
      assert.strictEqual(history[0].content, 'First') // First write wins (INSERT OR IGNORE)
    })

    it('allows duplicate content with different messageIds', () => {
      db.recordMessage('s1', { type: 'message', messageId: 'a', content: 'Hello', timestamp: 1000 })
      db.recordMessage('s1', { type: 'message', messageId: 'b', content: 'Hello', timestamp: 2000 })

      assert.strictEqual(db.getHistory('s1').length, 2)
    })

    it('records metadata as JSON', () => {
      db.recordMessage('s1', {
        type: 'message',
        messageType: 'prompt',
        content: 'Approve?',
        metadata: { options: [{ label: 'Yes', value: 'yes' }], expiresAt: 9999 },
        timestamp: 1000,
      })

      const history = db.getHistory('s1')
      assert.deepStrictEqual(history[0].metadata.options, [{ label: 'Yes', value: 'yes' }])
    })

    it('bulk inserts in a transaction', () => {
      const entries = Array.from({ length: 100 }, (_, i) => ({
        type: 'message',
        messageType: 'response',
        messageId: `msg-${i}`,
        content: `Message ${i}`,
        timestamp: 1000 + i,
      }))

      db.recordMessages('s1', entries)
      assert.strictEqual(db.getMessageCount('s1'), 100)
    })

    it('updates tool result by toolUseId', () => {
      db.recordMessage('s1', {
        type: 'tool_start',
        messageId: 'ts-1',
        toolUseId: 'tu-1',
        tool: 'Read',
        input: { path: '/etc/hosts' },
        timestamp: 1000,
      })

      db.updateToolResult('s1', 'tu-1', 'file contents here', { truncated: false })

      const history = db.getHistory('s1')
      assert.strictEqual(history[0].result, 'file contents here')
    })
  })

  describe('history retrieval', () => {
    let db

    beforeEach(() => {
      db = new SessionDB(testDbPath(`hist-${Date.now()}`))
      db.saveSession({ id: 's1', cwd: '/tmp' })
      // Insert 50 messages
      for (let i = 0; i < 50; i++) {
        db.recordMessage('s1', {
          type: 'message',
          messageType: 'response',
          messageId: `msg-${i}`,
          content: `Message ${i}`,
          timestamp: 1000 + i,
        })
      }
    })

    after(() => { try { db?.close() } catch {} })

    it('returns messages in chronological order', () => {
      const history = db.getHistory('s1', 10)
      assert.strictEqual(history.length, 10)
      // Last 10 messages should be msg-40 through msg-49
      assert.strictEqual(history[0].content, 'Message 40')
      assert.strictEqual(history[9].content, 'Message 49')
    })

    it('respects limit', () => {
      const history = db.getHistory('s1', 5)
      assert.strictEqual(history.length, 5)
    })

    it('returns all messages when limit exceeds count', () => {
      const history = db.getHistory('s1', 1000)
      assert.strictEqual(history.length, 50)
    })

    it('returns message count', () => {
      assert.strictEqual(db.getMessageCount('s1'), 50)
    })
  })

  describe('result recording', () => {
    let db

    beforeEach(() => {
      db = new SessionDB(testDbPath(`results-${Date.now()}`))
      db.saveSession({ id: 's1', cwd: '/tmp' })
    })

    after(() => { try { db?.close() } catch {} })

    it('records and aggregates costs', () => {
      db.recordResult('s1', { cost: 0.05, duration: 1200, inputTokens: 1000, outputTokens: 500, timestamp: Date.now() })
      db.recordResult('s1', { cost: 0.03, duration: 800, inputTokens: 800, outputTokens: 300, timestamp: Date.now() })

      const totalCost = db.getSessionCost('s1')
      assert.ok(Math.abs(totalCost - 0.08) < 0.001)
    })
  })

  describe('maintenance', () => {
    let db

    beforeEach(() => {
      db = new SessionDB(testDbPath(`maint-${Date.now()}`))
      db.saveSession({ id: 's1', cwd: '/tmp' })
    })

    after(() => { try { db?.close() } catch {} })

    it('prunes old messages keeping last N', () => {
      for (let i = 0; i < 100; i++) {
        db.recordMessage('s1', {
          type: 'message',
          messageId: `msg-${i}`,
          content: `Message ${i}`,
          timestamp: 1000 + i,
        })
      }

      db.pruneMessages('s1', 20)
      assert.strictEqual(db.getMessageCount('s1'), 20)

      // Should keep the most recent 20
      const history = db.getHistory('s1')
      assert.strictEqual(history[0].content, 'Message 80')
      assert.strictEqual(history[19].content, 'Message 99')
    })

    it('purges old destroyed sessions', () => {
      db.saveSession({ id: 'old', cwd: '/tmp' })
      db.destroySession('old')
      // Manually backdate destroyed_at
      db._db.prepare('UPDATE sessions SET destroyed_at = ? WHERE id = ?').run(
        Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
        'old'
      )

      db.purgeOldSessions(7 * 24 * 60 * 60 * 1000) // 7-day cutoff
      assert.strictEqual(db.getSession('old'), null)
      // Active session should survive
      assert.ok(db.getSession('s1'))
    })
  })

  describe('migration from JSON', () => {
    let db

    beforeEach(() => {
      db = new SessionDB(testDbPath(`migrate-${Date.now()}`))
    })

    after(() => { try { db?.close() } catch {} })

    it('imports sessions and messages from JSON state file', () => {
      const jsonPath = join(TEST_DIR, `state-${Date.now()}.json`)
      const state = {
        version: 1,
        timestamp: Date.now(),
        sessions: [
          {
            sdkSessionId: 'sdk-abc',
            cwd: '/home/user/project',
            name: 'Main Session',
            model: 'claude-3-5-sonnet',
            permissionMode: 'approve',
            history: [
              { type: 'message', messageType: 'user_input', content: 'Hello', timestamp: 1000 },
              { type: 'message', messageType: 'response', content: 'Hi there!', timestamp: 2000 },
              { type: 'tool_start', tool: 'Read', toolUseId: 'tu-1', input: '/etc/hosts', timestamp: 3000 },
            ],
          },
        ],
      }
      writeFileSync(jsonPath, JSON.stringify(state))

      const result = db.migrateFromJson(jsonPath)
      assert.strictEqual(result.sessions, 1)
      assert.strictEqual(result.messages, 3)

      // Verify session
      const sessions = db.getActiveSessions()
      assert.strictEqual(sessions.length, 1)
      assert.strictEqual(sessions[0].name, 'Main Session')
      assert.strictEqual(sessions[0].cwd, '/home/user/project')

      // Verify messages
      const history = db.getHistory(sessions[0].id)
      assert.strictEqual(history.length, 3)

      // Verify backup was created
      assert.ok(existsSync(jsonPath + '.bak'))
      assert.ok(!existsSync(jsonPath))
    })

    it('handles missing JSON file gracefully', () => {
      const result = db.migrateFromJson('/nonexistent/path.json')
      assert.strictEqual(result.sessions, 0)
      assert.strictEqual(result.messages, 0)
    })

    it('handles corrupt JSON gracefully', () => {
      const jsonPath = join(TEST_DIR, `corrupt-${Date.now()}.json`)
      writeFileSync(jsonPath, 'not valid json{{{')

      const result = db.migrateFromJson(jsonPath)
      assert.strictEqual(result.sessions, 0)
      assert.strictEqual(result.messages, 0)
    })
  })

  describe('performance', () => {
    it('handles realistic message volume efficiently', () => {
      const db = new SessionDB(testDbPath(`perf-${Date.now()}`))
      try {
        db.saveSession({ id: 'perf-test', cwd: '/tmp' })

        // Simulate a realistic conversation: 500 messages with tool use
        const start = Date.now()
        const entries = []
        for (let i = 0; i < 500; i++) {
          if (i % 5 === 0) {
            // User message
            entries.push({
              type: 'message',
              messageType: 'user_input',
              messageId: `user-${i}`,
              content: `User question ${i}: ${'x'.repeat(200)}`,
              timestamp: 1000 + i * 100,
            })
          } else if (i % 5 === 1) {
            // Response
            entries.push({
              type: 'stream',
              messageId: `stream-${i}`,
              content: `Response to question: ${'y'.repeat(2000)}`,
              timestamp: 1000 + i * 100,
            })
          } else if (i % 5 === 2) {
            // Tool start
            entries.push({
              type: 'tool_start',
              messageId: `tool-${i}`,
              toolUseId: `tu-${i}`,
              tool: 'Read',
              input: { file_path: `/path/to/file-${i}.js` },
              timestamp: 1000 + i * 100,
            })
          } else if (i % 5 === 3) {
            // Tool result
            entries.push({
              type: 'tool_result',
              toolUseId: `tu-${i - 1}`,
              result: `File contents: ${'z'.repeat(5000)}`,
              timestamp: 1000 + i * 100,
            })
          } else {
            // Result
            entries.push({
              type: 'result',
              messageId: `result-${i}`,
              metadata: { cost: 0.01, duration: 500, inputTokens: 1000, outputTokens: 200 },
              timestamp: 1000 + i * 100,
            })
          }
        }

        db.recordMessages('perf-test', entries)
        const insertTime = Date.now() - start

        // Retrieve history
        const readStart = Date.now()
        const history = db.getHistory('perf-test', 100)
        const readTime = Date.now() - readStart

        assert.strictEqual(history.length, 100)
        assert.strictEqual(db.getMessageCount('perf-test'), 500)

        // Performance assertions (generous bounds — should be well under these)
        assert.ok(insertTime < 1000, `Bulk insert took ${insertTime}ms (expected <1000ms)`)
        assert.ok(readTime < 100, `History read took ${readTime}ms (expected <100ms)`)

        console.log(`[perf] 500 message bulk insert: ${insertTime}ms, 100 message read: ${readTime}ms`)
      } finally {
        db.close()
      }
    })

    it('handles 5 concurrent sessions with 500 messages each', () => {
      const db = new SessionDB(testDbPath(`perf-multi-${Date.now()}`))
      try {
        const sessions = ['s1', 's2', 's3', 's4', 's5']
        for (const id of sessions) {
          db.saveSession({ id, cwd: `/tmp/${id}`, name: id })
        }

        const start = Date.now()
        for (const sessionId of sessions) {
          const entries = Array.from({ length: 500 }, (_, i) => ({
            type: 'message',
            messageType: i % 2 === 0 ? 'user_input' : 'response',
            messageId: `${sessionId}-${i}`,
            content: `Message ${i}: ${'x'.repeat(500)}`,
            timestamp: 1000 + i,
          }))
          db.recordMessages(sessionId, entries)
        }
        const totalTime = Date.now() - start

        // Verify all data
        for (const id of sessions) {
          assert.strictEqual(db.getMessageCount(id), 500)
        }

        assert.ok(totalTime < 5000, `5×500 message insert took ${totalTime}ms (expected <5000ms)`)
        console.log(`[perf] 5 sessions × 500 messages: ${totalTime}ms`)
      } finally {
        db.close()
      }
    })
  })

  describe('toWsMessage conversion', () => {
    let db

    beforeEach(() => {
      db = new SessionDB(testDbPath(`ws-${Date.now()}`))
      db.saveSession({ id: 's1', cwd: '/tmp' })
    })

    after(() => { try { db?.close() } catch {} })

    it('converts message rows to WS format', () => {
      db.recordMessage('s1', {
        type: 'message',
        messageType: 'response',
        messageId: 'msg-1',
        content: 'Hello!',
        timestamp: 1000,
      })

      const history = db.getHistory('s1')
      const wsMsg = db.toWsMessage(history[0])
      assert.strictEqual(wsMsg.type, 'message')
      assert.strictEqual(wsMsg.messageType, 'response')
      assert.strictEqual(wsMsg.content, 'Hello!')
      assert.strictEqual(wsMsg.timestamp, 1000)
      assert.strictEqual(wsMsg.sessionId, 's1')
    })

    it('converts tool_start rows to WS format', () => {
      db.recordMessage('s1', {
        type: 'tool_start',
        messageId: 'ts-1',
        toolUseId: 'tu-1',
        tool: 'Read',
        input: { file_path: '/etc/hosts' },
        timestamp: 1000,
      })

      const history = db.getHistory('s1')
      const wsMsg = db.toWsMessage(history[0])
      assert.strictEqual(wsMsg.type, 'tool_start')
      assert.strictEqual(wsMsg.tool, 'Read')
      assert.deepStrictEqual(wsMsg.input, { file_path: '/etc/hosts' })
    })

    it('converts stream (collapsed response) to WS message format', () => {
      db.recordMessage('s1', {
        type: 'stream',
        messageId: 'stream-1',
        content: 'Full response text',
        timestamp: 1000,
      })

      const history = db.getHistory('s1')
      const wsMsg = db.toWsMessage(history[0])
      assert.strictEqual(wsMsg.type, 'message')
      assert.strictEqual(wsMsg.messageType, 'response')
      assert.strictEqual(wsMsg.content, 'Full response text')
    })
  })
})
