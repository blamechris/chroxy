import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import {
  encodeProjectPath,
  resolveJsonlPath,
  getJsonlMtime,
  readConversationHistory,
  readConversationHistoryAsync,
} from '../src/jsonl-reader.js'

describe('encodeProjectPath', () => {
  it('replaces slashes with dashes', () => {
    assert.equal(
      encodeProjectPath('/Users/blamechris/Projects/chroxy'),
      '-Users-blamechris-Projects-chroxy',
    )
  })

  it('handles root path', () => {
    assert.equal(encodeProjectPath('/'), '-')
  })

  it('handles path without leading slash', () => {
    assert.equal(encodeProjectPath('foo/bar'), 'foo-bar')
  })
})

describe('resolveJsonlPath', () => {
  it('builds correct path from cwd and conversation ID', () => {
    const result = resolveJsonlPath('/Users/test/project', 'abc-123')
    const expected = join(
      homedir(),
      '.claude',
      'projects',
      '-Users-test-project',
      'abc-123.jsonl',
    )
    assert.equal(result, expected)
  })
})

describe('getJsonlMtime', () => {
  let tempDir

  it('returns mtime for existing file', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-jsonl-test-'))
    const filePath = join(tempDir, 'test.jsonl')
    writeFileSync(filePath, '{}')
    const mtime = getJsonlMtime(filePath)
    assert.equal(typeof mtime, 'number')
    assert.ok(mtime > 0)
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns null for missing file', () => {
    assert.equal(getJsonlMtime('/nonexistent/path/file.jsonl'), null)
  })
})

describe('readConversationHistory', () => {
  let tempDir

  function writeJsonl(filename, entries) {
    const filePath = join(tempDir, filename)
    const content = entries.map(e => JSON.stringify(e)).join('\n')
    writeFileSync(filePath, content)
    return filePath
  }

  // Create temp dir before each describe block
  function setup() {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-jsonl-test-'))
  }

  function teardown() {
    rmSync(tempDir, { recursive: true, force: true })
  }

  describe('missing file', () => {
    it('returns empty array for nonexistent file', () => {
      const result = readConversationHistory('/nonexistent/path/file.jsonl')
      assert.deepEqual(result, [])
    })
  })

  describe('user messages', () => {
    it('parses user text entries', () => {
      setup()
      try {
        const filePath = writeJsonl('test.jsonl', [
          {
            type: 'user',
            uuid: 'u1',
            timestamp: '2026-01-15T10:00:00.000Z',
            message: {
              content: [{ type: 'text', text: 'Hello Claude' }],
            },
          },
        ])
        const result = readConversationHistory(filePath)
        assert.equal(result.length, 1)
        assert.equal(result[0].type, 'user_input')
        assert.equal(result[0].content, 'Hello Claude')
        assert.equal(result[0].messageId, 'u1')
        assert.equal(result[0].timestamp, new Date('2026-01-15T10:00:00.000Z').getTime())
      } finally {
        teardown()
      }
    })

    it('joins multiple text blocks with newlines', () => {
      setup()
      try {
        const filePath = writeJsonl('test.jsonl', [
          {
            type: 'user',
            uuid: 'u2',
            timestamp: '2026-01-15T10:00:00.000Z',
            message: {
              content: [
                { type: 'text', text: 'Line 1' },
                { type: 'text', text: 'Line 2' },
              ],
            },
          },
        ])
        const result = readConversationHistory(filePath)
        assert.equal(result.length, 1)
        assert.equal(result[0].content, 'Line 1\nLine 2')
      } finally {
        teardown()
      }
    })

    it('skips user entries with tool_result content', () => {
      setup()
      try {
        const filePath = writeJsonl('test.jsonl', [
          {
            type: 'user',
            uuid: 'u3',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'result' }],
            },
          },
        ])
        const result = readConversationHistory(filePath)
        assert.equal(result.length, 0)
      } finally {
        teardown()
      }
    })

    it('skips user entries without array content', () => {
      setup()
      try {
        const filePath = writeJsonl('test.jsonl', [
          { type: 'user', uuid: 'u4', message: { content: 'just a string' } },
          { type: 'user', uuid: 'u5', message: {} },
        ])
        const result = readConversationHistory(filePath)
        assert.equal(result.length, 0)
      } finally {
        teardown()
      }
    })
  })

  describe('assistant messages', () => {
    it('parses assistant text responses', () => {
      setup()
      try {
        const filePath = writeJsonl('test.jsonl', [
          {
            type: 'assistant',
            uuid: 'a1',
            timestamp: '2026-01-15T10:01:00.000Z',
            message: {
              content: [{ type: 'text', text: 'Here is my response.' }],
            },
          },
        ])
        const result = readConversationHistory(filePath)
        assert.equal(result.length, 1)
        assert.equal(result[0].type, 'response')
        assert.equal(result[0].content, 'Here is my response.')
        assert.equal(result[0].messageId, 'a1')
      } finally {
        teardown()
      }
    })

    it('parses assistant tool_use blocks', () => {
      setup()
      try {
        const filePath = writeJsonl('test.jsonl', [
          {
            type: 'assistant',
            uuid: 'a2',
            timestamp: '2026-01-15T10:02:00.000Z',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'tool-1',
                  name: 'Read',
                  input: { file_path: '/tmp/test.js' },
                },
              ],
            },
          },
        ])
        const result = readConversationHistory(filePath)
        assert.equal(result.length, 1)
        assert.equal(result[0].type, 'tool_use')
        assert.equal(result[0].tool, 'Read')
        assert.equal(result[0].messageId, 'tool-1')
        assert.deepEqual(JSON.parse(result[0].content), { file_path: '/tmp/test.js' })
      } finally {
        teardown()
      }
    })

    it('handles mixed text and tool_use in one assistant entry', () => {
      setup()
      try {
        const filePath = writeJsonl('test.jsonl', [
          {
            type: 'assistant',
            uuid: 'a3',
            timestamp: '2026-01-15T10:03:00.000Z',
            message: {
              content: [
                { type: 'text', text: 'Let me read that file.' },
                { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/tmp/foo' } },
              ],
            },
          },
        ])
        const result = readConversationHistory(filePath)
        assert.equal(result.length, 2)
        assert.equal(result[0].type, 'response')
        assert.equal(result[0].content, 'Let me read that file.')
        assert.equal(result[1].type, 'tool_use')
        assert.equal(result[1].tool, 'Read')
      } finally {
        teardown()
      }
    })

    it('uses "unknown" for tool_use without name', () => {
      setup()
      try {
        const filePath = writeJsonl('test.jsonl', [
          {
            type: 'assistant',
            uuid: 'a4',
            message: {
              content: [{ type: 'tool_use', id: 'tool-3', input: {} }],
            },
          },
        ])
        const result = readConversationHistory(filePath)
        assert.equal(result[0].tool, 'unknown')
      } finally {
        teardown()
      }
    })
  })

  describe('skipped entries', () => {
    it('skips queue-operation entries', () => {
      setup()
      try {
        const filePath = writeJsonl('test.jsonl', [
          { type: 'queue-operation', data: {} },
          {
            type: 'user',
            uuid: 'u10',
            message: { content: [{ type: 'text', text: 'kept' }] },
          },
        ])
        const result = readConversationHistory(filePath)
        assert.equal(result.length, 1)
        assert.equal(result[0].content, 'kept')
      } finally {
        teardown()
      }
    })

    it('skips file-history-snapshot entries', () => {
      setup()
      try {
        const filePath = writeJsonl('test.jsonl', [
          { type: 'file-history-snapshot', data: {} },
          {
            type: 'assistant',
            uuid: 'a10',
            message: { content: [{ type: 'text', text: 'kept' }] },
          },
        ])
        const result = readConversationHistory(filePath)
        assert.equal(result.length, 1)
        assert.equal(result[0].content, 'kept')
      } finally {
        teardown()
      }
    })
  })

  describe('malformed data handling', () => {
    it('skips malformed JSON lines', () => {
      setup()
      try {
        const filePath = join(tempDir, 'malformed.jsonl')
        writeFileSync(filePath, [
          '{"type":"user","uuid":"u20","message":{"content":[{"type":"text","text":"good"}]}}',
          'NOT VALID JSON',
          '{"type":"assistant","uuid":"a20","message":{"content":[{"type":"text","text":"also good"}]}}',
        ].join('\n'))
        const result = readConversationHistory(filePath)
        assert.equal(result.length, 2)
        assert.equal(result[0].content, 'good')
        assert.equal(result[1].content, 'also good')
      } finally {
        teardown()
      }
    })

    it('handles empty file', () => {
      setup()
      try {
        const filePath = join(tempDir, 'empty.jsonl')
        writeFileSync(filePath, '')
        const result = readConversationHistory(filePath)
        assert.deepEqual(result, [])
      } finally {
        teardown()
      }
    })
  })

  describe('message cap', () => {
    it('caps at 500 most recent messages', () => {
      setup()
      try {
        const entries = []
        for (let i = 0; i < 600; i++) {
          entries.push({
            type: 'user',
            uuid: `u-${i}`,
            timestamp: `2026-01-15T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
            message: { content: [{ type: 'text', text: `message ${i}` }] },
          })
        }
        const filePath = writeJsonl('large.jsonl', entries)
        const result = readConversationHistory(filePath)
        assert.equal(result.length, 500)
        // Should keep the most recent (last 500)
        assert.equal(result[0].content, 'message 100')
        assert.equal(result[499].content, 'message 599')
      } finally {
        teardown()
      }
    })

    it('returns all messages when under cap', () => {
      setup()
      try {
        const entries = []
        for (let i = 0; i < 10; i++) {
          entries.push({
            type: 'user',
            uuid: `u-${i}`,
            message: { content: [{ type: 'text', text: `msg ${i}` }] },
          })
        }
        const filePath = writeJsonl('small.jsonl', entries)
        const result = readConversationHistory(filePath)
        assert.equal(result.length, 10)
      } finally {
        teardown()
      }
    })
  })

  describe('full conversation flow', () => {
    it('parses a realistic conversation', () => {
      setup()
      try {
        const filePath = writeJsonl('conversation.jsonl', [
          // User message
          {
            type: 'user',
            uuid: 'u-1',
            timestamp: '2026-01-15T10:00:00.000Z',
            message: { content: [{ type: 'text', text: 'Read the file /tmp/test.js' }] },
          },
          // Assistant with text + tool_use
          {
            type: 'assistant',
            uuid: 'a-1',
            timestamp: '2026-01-15T10:00:01.000Z',
            message: {
              content: [
                { type: 'text', text: 'I\'ll read that file for you.' },
                { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/tmp/test.js' } },
              ],
            },
          },
          // Tool result (should be skipped)
          {
            type: 'user',
            uuid: 'u-2',
            timestamp: '2026-01-15T10:00:02.000Z',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'file contents here' }],
            },
          },
          // Queue operation (should be skipped)
          { type: 'queue-operation', data: 'something' },
          // Final assistant response
          {
            type: 'assistant',
            uuid: 'a-2',
            timestamp: '2026-01-15T10:00:03.000Z',
            message: {
              content: [{ type: 'text', text: 'Here are the file contents.' }],
            },
          },
        ])

        const result = readConversationHistory(filePath)
        assert.equal(result.length, 4)

        assert.equal(result[0].type, 'user_input')
        assert.equal(result[0].content, 'Read the file /tmp/test.js')

        assert.equal(result[1].type, 'response')
        assert.equal(result[1].content, 'I\'ll read that file for you.')

        assert.equal(result[2].type, 'tool_use')
        assert.equal(result[2].tool, 'Read')

        assert.equal(result[3].type, 'response')
        assert.equal(result[3].content, 'Here are the file contents.')
      } finally {
        teardown()
      }
    })
  })
})

describe('readConversationHistoryAsync', () => {
  let tempDir

  function writeJsonl(filename, entries) {
    const filePath = join(tempDir, filename)
    const content = entries.map(e => JSON.stringify(e)).join('\n')
    writeFileSync(filePath, content)
    return filePath
  }

  function setup() {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-jsonl-async-'))
  }

  function teardown() {
    rmSync(tempDir, { recursive: true, force: true })
  }

  it('returns empty array for nonexistent file', async () => {
    const result = await readConversationHistoryAsync('/nonexistent/path/file.jsonl')
    assert.deepEqual(result, [])
  })

  it('produces identical output to sync variant', async () => {
    setup()
    try {
      const filePath = writeJsonl('test.jsonl', [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-01-15T10:00:00.000Z',
          message: { content: [{ type: 'text', text: 'Hello Claude' }] },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-01-15T10:01:00.000Z',
          message: {
            content: [
              { type: 'text', text: 'Hi there!' },
              { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/x' } },
            ],
          },
        },
        { type: 'queue-operation', data: {} },
      ])

      const syncResult = readConversationHistory(filePath)
      const asyncResult = await readConversationHistoryAsync(filePath)

      assert.deepEqual(asyncResult, syncResult)
      assert.equal(asyncResult.length, 3)
      assert.equal(asyncResult[0].type, 'user_input')
      assert.equal(asyncResult[1].type, 'response')
      assert.equal(asyncResult[2].type, 'tool_use')
    } finally {
      teardown()
    }
  })

  it('handles malformed JSON lines', async () => {
    setup()
    try {
      const filePath = join(tempDir, 'malformed.jsonl')
      writeFileSync(filePath, [
        '{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"ok"}]}}',
        'NOT JSON',
        '{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"also ok"}]}}',
      ].join('\n'))

      const result = await readConversationHistoryAsync(filePath)
      assert.equal(result.length, 2)
    } finally {
      teardown()
    }
  })
})
