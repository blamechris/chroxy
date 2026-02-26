import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { scanConversations, decodeProjectPath } from '../src/conversation-scanner.js'

describe('decodeProjectPath', () => {
  it('decodes path that exists on disk', () => {
    // /tmp always exists on macOS/Linux
    const result = decodeProjectPath('-tmp')
    assert.equal(result, '/tmp')
  })

  it('returns null for nonexistent path', () => {
    const result = decodeProjectPath('-nonexistent-path-that-does-not-exist')
    assert.equal(result, null)
  })

  it('returns null for path that decodes to a file, not directory', () => {
    // Even if the decoded path exists, it must be a directory
    assert.equal(decodeProjectPath('no-leading-slash'), null)
  })
})

describe('scanConversations', () => {
  let tempDir

  function makeProject(encodedName, files) {
    const projectDir = join(tempDir, encodedName)
    mkdirSync(projectDir, { recursive: true })
    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(projectDir, filename), content)
    }
    return projectDir
  }

  function jsonlLines(...entries) {
    return entries.map((e) => JSON.stringify(e)).join('\n')
  }

  function userEntry(text, opts = {}) {
    return {
      type: 'user',
      uuid: opts.uuid || 'u1',
      cwd: opts.cwd || '/tmp/project',
      timestamp: opts.timestamp || '2026-02-25T10:00:00.000Z',
      message: { content: [{ type: 'text', text }] },
    }
  }

  function assistantEntry(text, opts = {}) {
    return {
      type: 'assistant',
      uuid: opts.uuid || 'a1',
      timestamp: opts.timestamp || '2026-02-25T10:01:00.000Z',
      message: { content: [{ type: 'text', text }] },
    }
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-scanner-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns empty array when projects directory does not exist', async () => {
    const result = await scanConversations({ projectsDir: '/nonexistent/path' })
    assert.deepEqual(result, [])
  })

  it('returns empty array when projects directory is empty', async () => {
    const result = await scanConversations({ projectsDir: tempDir })
    assert.deepEqual(result, [])
  })

  it('scans a single conversation file', async () => {
    makeProject('test-project', {
      'abc-123.jsonl': jsonlLines(
        userEntry('Hello Claude'),
        assistantEntry('Hi there!'),
      ),
    })

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result.length, 1)
    assert.equal(result[0].conversationId, 'abc-123')
    assert.equal(result[0].preview, 'Hello Claude')
    assert.equal(result[0].cwd, '/tmp/project')
    assert.equal(typeof result[0].modifiedAt, 'string')
    assert.equal(typeof result[0].sizeBytes, 'number')
    assert.ok(result[0].sizeBytes > 0)
  })

  it('scans multiple conversations across projects', async () => {
    makeProject('project-a', {
      'conv-1.jsonl': jsonlLines(userEntry('First question', { cwd: '/tmp/a' })),
      'conv-2.jsonl': jsonlLines(userEntry('Second question', { cwd: '/tmp/a' })),
    })
    makeProject('project-b', {
      'conv-3.jsonl': jsonlLines(userEntry('Third question', { cwd: '/tmp/b' })),
    })

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result.length, 3)
  })

  it('extracts preview from first user message', async () => {
    makeProject('test-project', {
      'conv.jsonl': jsonlLines(
        { type: 'file-history-snapshot', snapshot: {} },
        userEntry('This is the actual first message'),
        assistantEntry('Response here'),
      ),
    })

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result[0].preview, 'This is the actual first message')
  })

  it('skips tool_result user entries for preview', async () => {
    makeProject('test-project', {
      'conv.jsonl': jsonlLines(
        {
          type: 'user',
          uuid: 'u-tool',
          cwd: '/tmp/project',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'result' }] },
        },
        userEntry('Real user message'),
      ),
    })

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result[0].preview, 'Real user message')
  })

  it('truncates preview to 200 characters', async () => {
    const longMessage = 'A'.repeat(300)
    makeProject('test-project', {
      'conv.jsonl': jsonlLines(userEntry(longMessage)),
    })

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result[0].preview.length, 200)
  })

  it('extracts CWD from JSONL entries', async () => {
    makeProject('test-project', {
      'conv.jsonl': jsonlLines(
        userEntry('Hello', { cwd: '/Users/test/my-project' }),
      ),
    })

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result[0].cwd, '/Users/test/my-project')
    assert.equal(result[0].project, '/Users/test/my-project')
    assert.equal(result[0].projectName, 'my-project')
  })

  it('sorts by most recently modified first', async () => {
    const projectDir = join(tempDir, 'test-project')
    mkdirSync(projectDir, { recursive: true })

    writeFileSync(
      join(projectDir, 'old.jsonl'),
      jsonlLines(userEntry('Old conversation')),
    )

    // Touch the old file to set an older mtime
    const { utimesSync } = await import('fs')
    const pastDate = new Date('2020-01-01')
    utimesSync(join(projectDir, 'old.jsonl'), pastDate, pastDate)

    writeFileSync(
      join(projectDir, 'new.jsonl'),
      jsonlLines(userEntry('New conversation')),
    )

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result.length, 2)
    assert.equal(result[0].conversationId, 'new')
    assert.equal(result[1].conversationId, 'old')
  })

  it('skips files smaller than 100 bytes', async () => {
    makeProject('test-project', {
      'tiny.jsonl': '{}',
      'normal.jsonl': jsonlLines(userEntry('Normal conversation')),
    })

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result.length, 1)
    assert.equal(result[0].conversationId, 'normal')
  })

  it('skips non-jsonl files', async () => {
    makeProject('test-project', {
      'conv.jsonl': jsonlLines(userEntry('Valid')),
      'notes.txt': 'not a conversation',
      'data.json': '{"foo": "bar"}',
    })

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result.length, 1)
  })

  it('skips non-directory entries in projects dir', async () => {
    // Create a file (not a directory) in the projects dir
    writeFileSync(join(tempDir, 'stray-file.txt'), 'not a project')
    makeProject('test-project', {
      'conv.jsonl': jsonlLines(userEntry('Valid')),
    })

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result.length, 1)
  })

  it('handles malformed JSONL lines gracefully', async () => {
    makeProject('test-project', {
      'conv.jsonl': [
        'NOT VALID JSON',
        JSON.stringify(userEntry('Valid message')),
        '{truncated json...',
      ].join('\n'),
    })

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result.length, 1)
    assert.equal(result[0].preview, 'Valid message')
  })

  it('returns null preview when no user message exists', async () => {
    makeProject('test-project', {
      'conv.jsonl': jsonlLines(
        { type: 'file-history-snapshot', snapshot: {} },
        assistantEntry('Only assistant messages here'),
        // Pad to meet minimum file size
        assistantEntry('More text to increase file size beyond 100 bytes threshold'),
      ),
    })

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result.length, 1)
    assert.equal(result[0].preview, null)
  })

  it('handles string message content (older format)', async () => {
    makeProject('test-project', {
      'conv.jsonl': jsonlLines(
        {
          type: 'user',
          uuid: 'u1',
          cwd: '/tmp/project',
          message: { content: 'Plain string message' },
        },
        assistantEntry('Padding to ensure file exceeds 100 bytes minimum threshold for scanner'),
      ),
    })

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result[0].preview, 'Plain string message')
  })

  it('handles multi-byte UTF-8 characters near the 32KB read boundary', async () => {
    // Build a JSONL file where multi-byte characters straddle the 32KB boundary.
    // The user message (preview source) is early in the file, padding fills to 32KB+.
    const userLine = JSON.stringify(userEntry('Preview with emoji 🎉'))
    // Pad with assistant entries containing multi-byte characters (3-byte CJK chars)
    const paddingLines = []
    let totalBytes = Buffer.byteLength(userLine, 'utf-8') + 1 // +1 for newline
    const target = 32 * 1024 + 512 // exceed 32KB to ensure boundary is crossed
    while (totalBytes < target) {
      // Use 3-byte CJK characters (日本語) to maximize chance of boundary split
      const line = JSON.stringify(assistantEntry('日本語テスト'.repeat(30)))
      paddingLines.push(line)
      totalBytes += Buffer.byteLength(line, 'utf-8') + 1
    }

    const content = [userLine, ...paddingLines].join('\n')
    makeProject('test-project', { 'conv.jsonl': content })

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result.length, 1)
    assert.equal(result[0].preview, 'Preview with emoji 🎉')
    // Ensure no U+FFFD replacement characters appear in the CWD
    assert.ok(!result[0].cwd.includes('\uFFFD'), 'CWD should not contain replacement characters')
  })

  it('does not produce replacement characters when buffer splits multi-byte char', async () => {
    // Construct content where a 4-byte emoji (🎉 = F0 9F 8E 89) is positioned
    // so the 32KB boundary falls in its middle
    const BOUNDARY = 32 * 1024
    const userLine = JSON.stringify(userEntry('Hello'))
    const userLineBytes = Buffer.byteLength(userLine, 'utf-8') + 1 // +1 newline

    // Create padding to get close to 32KB boundary
    // Leave room for one more line that will contain the boundary-spanning emoji
    const paddingText = 'x'.repeat(200)
    const paddingLine = JSON.stringify(assistantEntry(paddingText))
    const paddingLineBytes = Buffer.byteLength(paddingLine, 'utf-8') + 1

    const paddingLines = []
    let currentBytes = userLineBytes
    // Fill up to within one padding line of the boundary
    while (currentBytes + paddingLineBytes < BOUNDARY - 10) {
      paddingLines.push(paddingLine)
      currentBytes += paddingLineBytes
    }

    // Now add a line with emoji that will span the boundary
    const remaining = BOUNDARY - currentBytes
    // Fill remaining bytes with ASCII, then add multi-byte characters at the end
    const filler = 'a'.repeat(Math.max(0, remaining - 50))
    const boundaryLine = JSON.stringify(assistantEntry(filler + '🎉🎊🎈🎁'))
    paddingLines.push(boundaryLine)

    const content = [userLine, ...paddingLines].join('\n')
    makeProject('test-project', { 'conv.jsonl': content })

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result.length, 1)
    assert.equal(result[0].preview, 'Hello')
  })

  it('uses encoded directory name as projectName when CWD not available', async () => {
    makeProject('unknown-project', {
      'conv.jsonl': jsonlLines({
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'text', text: 'No CWD here' }] },
      }, {
        // Pad to meet minimum size
        type: 'assistant',
        uuid: 'a2',
        message: { content: [{ type: 'text', text: 'More padding text to reach 100 bytes' }] },
      }),
    })

    const result = await scanConversations({ projectsDir: tempDir })
    assert.equal(result.length, 1)
    assert.equal(result[0].cwd, null)
    assert.equal(result[0].projectName, 'unknown-project')
  })
})
