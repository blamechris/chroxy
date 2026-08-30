import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import {
  encodeProjectPath,
  decodeProjectPath,
  resolveJsonlPath,
  getJsonlMtime,
  readConversationHistoryWithMetaAsync,
  MAX_TRANSCRIPT_BYTES,
  MAX_MESSAGES,
} from '../src/jsonl-reader.js'

describe('encodeProjectPath', () => {
  it('replaces slashes with dashes', async () => {
    assert.equal(
      encodeProjectPath('/Users/alice/projects/myrepo'),
      '-Users-alice-projects-myrepo',
    )
  })

  it('handles root path', async () => {
    assert.equal(encodeProjectPath('/'), '-')
  })

  it('handles path without leading slash', async () => {
    assert.equal(encodeProjectPath('foo/bar'), 'foo-bar')
  })
})

describe('decodeProjectPath', () => {
  it('decodes path that exists on disk', async () => {
    // /tmp always exists on macOS/Linux
    const result = decodeProjectPath('-tmp')
    assert.equal(result, '/tmp')
  })

  it('returns null for nonexistent path', async () => {
    const result = decodeProjectPath('-nonexistent-path-that-does-not-exist')
    assert.equal(result, null)
  })

  it('returns null for path that decodes to a file, not directory', async () => {
    // Even if the decoded path exists, it must be a directory
    assert.equal(decodeProjectPath('no-leading-slash'), null)
  })
})

describe('resolveJsonlPath', () => {
  it('builds correct path from cwd and conversation ID', async () => {
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

  it('returns mtime for existing file', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-jsonl-test-'))
    const filePath = join(tempDir, 'test.jsonl')
    writeFileSync(filePath, '{}')
    const mtime = getJsonlMtime(filePath)
    assert.equal(typeof mtime, 'number')
    assert.ok(mtime > 0)
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns null for missing file', async () => {
    assert.equal(getJsonlMtime('/nonexistent/path/file.jsonl'), null)
  })
})

describe('readConversationHistoryWithMetaAsync — parsed message shapes (#7520: the sole reader)', () => {
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
    it('returns empty array for nonexistent file', async () => {
      const result = (await readConversationHistoryWithMetaAsync('/nonexistent/path/file.jsonl')).messages
      assert.deepEqual(result, [])
    })
  })

  describe('user messages', () => {
    it('parses user text entries', async () => {
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
        const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
        assert.equal(result.length, 1)
        assert.equal(result[0].type, 'user_input')
        assert.equal(result[0].content, 'Hello Claude')
        assert.equal(result[0].messageId, 'u1')
        assert.equal(result[0].timestamp, new Date('2026-01-15T10:00:00.000Z').getTime())
      } finally {
        teardown()
      }
    })

    it('joins multiple text blocks with newlines', async () => {
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
        const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
        assert.equal(result.length, 1)
        assert.equal(result[0].content, 'Line 1\nLine 2')
      } finally {
        teardown()
      }
    })

    it('skips user entries with tool_result content', async () => {
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
        const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
        assert.equal(result.length, 0)
      } finally {
        teardown()
      }
    })

    it('skips user entries without array content', async () => {
      setup()
      try {
        const filePath = writeJsonl('test.jsonl', [
          { type: 'user', uuid: 'u4', message: { content: 'just a string' } },
          { type: 'user', uuid: 'u5', message: {} },
        ])
        const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
        assert.equal(result.length, 0)
      } finally {
        teardown()
      }
    })
  })

  describe('assistant messages', () => {
    it('parses assistant text responses', async () => {
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
        const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
        assert.equal(result.length, 1)
        assert.equal(result[0].type, 'response')
        assert.equal(result[0].content, 'Here is my response.')
        assert.equal(result[0].messageId, 'a1')
      } finally {
        teardown()
      }
    })

    it('parses assistant tool_use blocks', async () => {
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
        const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
        assert.equal(result.length, 1)
        assert.equal(result[0].type, 'tool_use')
        assert.equal(result[0].tool, 'Read')
        assert.equal(result[0].messageId, 'tool-1')
        assert.deepEqual(JSON.parse(result[0].content), { file_path: '/tmp/test.js' })
      } finally {
        teardown()
      }
    })

    it('handles mixed text and tool_use in one assistant entry', async () => {
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
        const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
        assert.equal(result.length, 2)
        assert.equal(result[0].type, 'response')
        assert.equal(result[0].content, 'Let me read that file.')
        assert.equal(result[1].type, 'tool_use')
        assert.equal(result[1].tool, 'Read')
      } finally {
        teardown()
      }
    })

    it('uses "unknown" for tool_use without name', async () => {
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
        const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
        assert.equal(result[0].tool, 'unknown')
      } finally {
        teardown()
      }
    })
  })

  describe('skipped entries', () => {
    it('skips queue-operation entries', async () => {
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
        const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
        assert.equal(result.length, 1)
        assert.equal(result[0].content, 'kept')
      } finally {
        teardown()
      }
    })

    it('skips file-history-snapshot entries', async () => {
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
        const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
        assert.equal(result.length, 1)
        assert.equal(result[0].content, 'kept')
      } finally {
        teardown()
      }
    })
  })

  describe('malformed data handling', () => {
    it('skips malformed JSON lines', async () => {
      setup()
      try {
        const filePath = join(tempDir, 'malformed.jsonl')
        writeFileSync(filePath, [
          '{"type":"user","uuid":"u20","message":{"content":[{"type":"text","text":"good"}]}}',
          'NOT VALID JSON',
          '{"type":"assistant","uuid":"a20","message":{"content":[{"type":"text","text":"also good"}]}}',
        ].join('\n'))
        const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
        assert.equal(result.length, 2)
        assert.equal(result[0].content, 'good')
        assert.equal(result[1].content, 'also good')
      } finally {
        teardown()
      }
    })

    it('handles empty file', async () => {
      setup()
      try {
        const filePath = join(tempDir, 'empty.jsonl')
        writeFileSync(filePath, '')
        const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
        assert.deepEqual(result, [])
      } finally {
        teardown()
      }
    })
  })

  describe('message cap', () => {
    it('caps at 500 most recent messages', async () => {
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
        const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
        assert.equal(result.length, 500)
        // Should keep the most recent (last 500)
        assert.equal(result[0].content, 'message 100')
        assert.equal(result[499].content, 'message 599')
      } finally {
        teardown()
      }
    })

    it('returns all messages when under cap', async () => {
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
        const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
        assert.equal(result.length, 10)
      } finally {
        teardown()
      }
    })
  })

  describe('full conversation flow', () => {
    it('parses a realistic conversation', async () => {
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

        const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
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

describe('readConversationHistoryWithMetaAsync — read behaviour', () => {
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
    const result = (await readConversationHistoryWithMetaAsync('/nonexistent/path/file.jsonl')).messages
    assert.deepEqual(result, [])
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

      const result = (await readConversationHistoryWithMetaAsync(filePath)).messages
      assert.equal(result.length, 2)
    } finally {
      teardown()
    }
  })
})

// #6860 — DoS guard: a transcript larger than the byte ceiling is read from the
// TAIL only (bounded), never fully buffered. The maxBytes override lets these
// tests exercise the cap without writing a real 25MB file.
describe('transcript byte ceiling', () => {
  let tempDir

  function writeJsonl(filename, entries) {
    const filePath = join(tempDir, filename)
    const content = entries.map(e => JSON.stringify(e)).join('\n')
    writeFileSync(filePath, content)
    return filePath
  }

  function setup() {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-jsonl-ceiling-'))
  }

  function teardown() {
    rmSync(tempDir, { recursive: true, force: true })
  }

  function manyEntries(n) {
    const entries = []
    for (let i = 0; i < n; i++) {
      entries.push({ type: 'user', uuid: `u-${i}`, message: { content: [{ type: 'text', text: `message-${i}` }] } })
    }
    return entries
  }

  it('exposes a sane default ceiling', async () => {
    assert.equal(typeof MAX_TRANSCRIPT_BYTES, 'number')
    assert.ok(MAX_TRANSCRIPT_BYTES >= 10 * 1024 * 1024 && MAX_TRANSCRIPT_BYTES <= 50 * 1024 * 1024,
      'ceiling should sit in the 10-50MB band')
  })

  it('async: caps an oversized transcript to a tail window instead of buffering the whole file', async () => {
    setup()
    try {
      const filePath = writeJsonl('big.jsonl', manyEntries(50))
      // Default (huge) ceiling returns everything.
      const full = (await readConversationHistoryWithMetaAsync(filePath)).messages
      assert.equal(full.length, 50)
      // Tiny override forces a tail read — earliest messages are dropped.
      const capped = (await readConversationHistoryWithMetaAsync(filePath, 200)).messages
      assert.ok(capped.length > 0 && capped.length < 50,
        'must return a truncated subset (tail), not the whole file')
      assert.equal(capped[capped.length - 1].content, 'message-49',
        'the most-recent message must be retained')
      assert.ok(!capped.some(m => m.content === 'message-0'),
        'the earliest message must be dropped by the tail cap')
    } finally {
      teardown()
    }
  })

  it('reads the whole file untruncated when under the ceiling', async () => {
    setup()
    try {
      const filePath = writeJsonl('small.jsonl', manyEntries(5))
      const result = (await readConversationHistoryWithMetaAsync(filePath, 10 * 1024 * 1024)).messages
      assert.equal(result.length, 5)
      assert.equal(result[0].content, 'message-0')
    } finally {
      teardown()
    }
  })
})

/**
 * #7484 — the transcript read has TWO of its own truncations, and a caller
 * holding only the returned array can infer neither: 500 messages back is
 * equally the shape of a 500-message transcript that lost nothing, and a tail
 * read looks exactly like a short file. `request_full_history` puts `truncated`
 * on the wire for this slice, so the reader has to say.
 */
describe('#7484 — the meta reader reports the slice\'s own truncation', () => {
  let tempDir

  function writeJsonl(filename, entries) {
    const filePath = join(tempDir, filename)
    writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n'))
    return filePath
  }

  function setup() {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-jsonl-meta-'))
  }

  function teardown() {
    rmSync(tempDir, { recursive: true, force: true })
  }

  // A FIXED timestamp, not the parser's `Date.now()` fallback: two reads of the
  // same file must be comparable entry-for-entry.
  function userEntries(n) {
    return Array.from({ length: n }, (_, i) => ({
      type: 'user',
      uuid: `u-${i}`,
      timestamp: '2026-01-15T00:00:00.000Z',
      message: { content: [{ type: 'text', text: `message ${i}` }] },
    }))
  }

  it('exports the message cap rather than leaving callers to re-derive it', async () => {
    assert.equal(MAX_MESSAGES, 500)
  })

  it('flags truncated when the MAX_MESSAGES cap drops the head of the transcript', async () => {
    setup()
    try {
      const filePath = writeJsonl('over-cap.jsonl', userEntries(MAX_MESSAGES + 100))
      const { messages, truncated } = await readConversationHistoryWithMetaAsync(filePath)
      assert.equal(messages.length, MAX_MESSAGES)
      assert.equal(truncated, true, 'the 100 dropped messages are exactly what `truncated` exists to announce')
      assert.equal(messages[0].content, 'message 100', 'and the retained slice is the most recent')
    } finally {
      teardown()
    }
  })

  it('POSITIVE CONTROL: a transcript EXACTLY at the cap lost nothing and is not flagged', async () => {
    // The boundary is the whole point: `messages.length === 500` cannot be the
    // signal, because a complete 500-message transcript looks identical.
    setup()
    try {
      const filePath = writeJsonl('at-cap.jsonl', userEntries(MAX_MESSAGES))
      const { messages, truncated } = await readConversationHistoryWithMetaAsync(filePath)
      assert.equal(messages.length, MAX_MESSAGES)
      assert.equal(truncated, false)
      assert.equal(messages[0].content, 'message 0', 'nothing was dropped from the head')
    } finally {
      teardown()
    }
  })

  it('POSITIVE CONTROL: a short transcript is not flagged', async () => {
    setup()
    try {
      const filePath = writeJsonl('small.jsonl', userEntries(3))
      assert.deepEqual(
        (await readConversationHistoryWithMetaAsync(filePath)).truncated,
        false,
      )
    } finally {
      teardown()
    }
  })

  it('flags truncated when the BYTE ceiling forces a tail read', async () => {
    // The other truncation, and the one no message count can reveal.
    setup()
    try {
      const filePath = writeJsonl('big.jsonl', userEntries(50))
      const { messages, truncated } = await readConversationHistoryWithMetaAsync(filePath, 200)
      assert.ok(messages.length > 0 && messages.length < 50, 'a tail window, not the whole file')
      assert.equal(truncated, true, 'the head of the file was dropped before parsing ever started')
    } finally {
      teardown()
    }
  })

  it('an unreadable transcript is EMPTY, not truncated', async () => {
    // Nothing was dropped from a slice that does not exist. Flagging it would
    // put a permanent "history incomplete" banner on every session without a
    // transcript — the majority of them.
    const meta = await readConversationHistoryWithMetaAsync('/nonexistent/path/file.jsonl')
    assert.deepEqual(meta, { messages: [], truncated: false })
  })

  it('the async reader reports the same metadata as the sync one', async () => {
    setup()
    try {
      const over = writeJsonl('async-over.jsonl', userEntries(MAX_MESSAGES + 1))
      const under = writeJsonl('async-under.jsonl', userEntries(2))
      const overMeta = await readConversationHistoryWithMetaAsync(over)
      const underMeta = await readConversationHistoryWithMetaAsync(under)
      assert.equal(overMeta.truncated, true)
      assert.equal(overMeta.messages.length, MAX_MESSAGES)
      assert.equal(underMeta.truncated, false)
      assert.deepEqual(
        await readConversationHistoryWithMetaAsync('/nonexistent/path/file.jsonl'),
        { messages: [], truncated: false },
      )
    } finally {
      teardown()
    }
  })


})
