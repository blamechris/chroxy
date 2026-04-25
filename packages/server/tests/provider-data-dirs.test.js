/**
 * Tests for provider-driven data directories (#2965).
 *
 * Each provider exposes a static `dataDir` property. The registry
 * aggregates them so conversation-scanner and ws-file-ops iterate
 * all active provider directories instead of hard-coding ~/.claude/.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ------------------------------------------------------------------ //
// Provider static dataDir getters
// ------------------------------------------------------------------ //

describe('Provider static dataDir (#2965)', () => {
  it('CliSession exposes a non-empty static dataDir', async () => {
    const { CliSession } = await import('../src/cli-session.js')
    assert.equal(typeof CliSession.dataDir, 'string', 'CliSession.dataDir must be a string')
    assert.ok(CliSession.dataDir.length > 0, 'CliSession.dataDir must be non-empty')
    assert.ok(CliSession.dataDir.includes('.claude'), 'CliSession.dataDir should reference .claude')
  })

  it('CodexSession exposes a non-empty static dataDir', async () => {
    const { CodexSession } = await import('../src/codex-session.js')
    assert.equal(typeof CodexSession.dataDir, 'string', 'CodexSession.dataDir must be a string')
    assert.ok(CodexSession.dataDir.length > 0, 'CodexSession.dataDir must be non-empty')
    assert.ok(CodexSession.dataDir.includes('.codex'), 'CodexSession.dataDir should reference .codex')
  })

  it('GeminiSession exposes a non-empty static dataDir', async () => {
    const { GeminiSession } = await import('../src/gemini-session.js')
    assert.equal(typeof GeminiSession.dataDir, 'string', 'GeminiSession.dataDir must be a string')
    assert.ok(GeminiSession.dataDir.length > 0, 'GeminiSession.dataDir must be non-empty')
    assert.ok(GeminiSession.dataDir.includes('.gemini'), 'GeminiSession.dataDir should reference .gemini')
  })
})

// ------------------------------------------------------------------ //
// getProviderDataDirs logic — tested via standalone helper
// to avoid triggering the @anthropic-ai/claude-agent-sdk import chain
// that causes providers.js imports to fail in this test environment.
// The full integration (with the real registry) is exercised by
// providers.test.js once the SDK package is available.
// ------------------------------------------------------------------ //

describe('getProviderDataDirs logic (#2965)', () => {
  /**
   * Inline the deduplication algorithm from providers.js so we can test
   * it without importing the full module (which pulls in sdk-session.js).
   */
  function collectDataDirs(providerClasses) {
    const seen = new Set()
    const dirs = []
    for (const ProviderClass of providerClasses) {
      const dir = ProviderClass.dataDir
      if (typeof dir !== 'string' || dir.length === 0) continue
      if (seen.has(dir)) continue
      seen.add(dir)
      dirs.push(dir)
    }
    return dirs
  }

  it('collects dataDir from each provider class', async () => {
    const { CliSession } = await import('../src/cli-session.js')
    const { CodexSession } = await import('../src/codex-session.js')
    const { GeminiSession } = await import('../src/gemini-session.js')

    const dirs = collectDataDirs([CliSession, CodexSession, GeminiSession])
    assert.ok(dirs.some(d => d.includes('.claude')), 'must include .claude')
    assert.ok(dirs.some(d => d.includes('.codex')), 'must include .codex')
    assert.ok(dirs.some(d => d.includes('.gemini')), 'must include .gemini')
  })

  it('deduplicates when two providers share the same dataDir', async () => {
    const { CliSession } = await import('../src/cli-session.js')

    // Claude CLI and SDK share ~/.claude — only one entry expected
    class FakeClaudeSDK {
      static get dataDir() { return CliSession.dataDir }
    }

    const dirs = collectDataDirs([CliSession, FakeClaudeSDK])
    const claudeDirs = dirs.filter(d => d.includes('.claude'))
    assert.equal(claudeDirs.length, 1, '.claude must appear only once')
  })

  it('skips providers that have no dataDir', async () => {
    class NoDataDir {}
    class HasDataDir {
      static get dataDir() { return '/tmp/test-provider' }
    }

    const dirs = collectDataDirs([NoDataDir, HasDataDir])
    assert.equal(dirs.length, 1)
    assert.equal(dirs[0], '/tmp/test-provider')
  })

  it('returns empty array when no provider has a dataDir', () => {
    class A {}
    class B {}
    const dirs = collectDataDirs([A, B])
    assert.deepEqual(dirs, [])
  })
})

// ------------------------------------------------------------------ //
// scanConversations — multi-provider merging
// ------------------------------------------------------------------ //

describe('scanConversations with multiple provider dirs (#2965)', () => {
  let claudeDir
  let codexDir

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

  function makeConversation(projectsDir, projectName, convId, text) {
    const pd = join(projectsDir, projectName)
    mkdirSync(pd, { recursive: true })
    writeFileSync(join(pd, `${convId}.jsonl`), jsonlLines(userEntry(text)))
  }

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'chroxy-2965-claude-'))
    codexDir = mkdtempSync(join(tmpdir(), 'chroxy-2965-codex-'))
  })

  afterEach(async () => {
    rmSync(claudeDir, { recursive: true, force: true })
    rmSync(codexDir, { recursive: true, force: true })
    const { clearScanCache } = await import('../src/conversation-scanner.js')
    clearScanCache()
  })

  it('merges conversations from two provider projectsDirs', async () => {
    const { scanConversations, clearScanCache } = await import('../src/conversation-scanner.js')

    const claudeProjects = join(claudeDir, 'projects')
    const codexProjects = join(codexDir, 'projects')
    mkdirSync(claudeProjects, { recursive: true })
    mkdirSync(codexProjects, { recursive: true })

    makeConversation(claudeProjects, 'my-repo', 'conv-claude-1', 'Claude conversation')
    makeConversation(codexProjects, 'my-repo', 'conv-codex-1', 'Codex conversation')

    clearScanCache()
    const result = await scanConversations({
      projectsDirs: [claudeProjects, codexProjects],
    })

    const ids = result.map(r => r.conversationId)
    assert.ok(ids.includes('conv-claude-1'), 'must include claude conversation')
    assert.ok(ids.includes('conv-codex-1'), 'must include codex conversation')
    assert.equal(result.length, 2)
  })

  it('accepts legacy single projectsDir option and still works', async () => {
    const { scanConversations, clearScanCache } = await import('../src/conversation-scanner.js')

    const claudeProjects = join(claudeDir, 'projects')
    mkdirSync(claudeProjects, { recursive: true })
    makeConversation(claudeProjects, 'my-repo', 'conv-legacy', 'Legacy option')

    clearScanCache()
    const result = await scanConversations({ projectsDir: claudeProjects })
    assert.equal(result.length, 1)
    assert.equal(result[0].conversationId, 'conv-legacy')
  })

  it('deduplicates results when same dir appears twice in projectsDirs', async () => {
    const { scanConversations, clearScanCache } = await import('../src/conversation-scanner.js')

    const claudeProjects = join(claudeDir, 'projects')
    mkdirSync(claudeProjects, { recursive: true })
    makeConversation(claudeProjects, 'my-repo', 'conv-dedup', 'Dedup test')

    clearScanCache()
    // Pass same dir twice — should not double-count
    const result = await scanConversations({
      projectsDirs: [claudeProjects, claudeProjects],
    })
    assert.equal(result.length, 1)
  })

  it('sorts merged results by most recently modified first', async () => {
    const { scanConversations, clearScanCache } = await import('../src/conversation-scanner.js')
    const { utimesSync } = await import('fs')

    const claudeProjects = join(claudeDir, 'projects')
    const codexProjects = join(codexDir, 'projects')
    mkdirSync(claudeProjects, { recursive: true })
    mkdirSync(codexProjects, { recursive: true })

    makeConversation(claudeProjects, 'repo', 'old-claude', 'Old claude')
    const oldPath = join(claudeProjects, 'repo', 'old-claude.jsonl')
    utimesSync(oldPath, new Date('2020-01-01'), new Date('2020-01-01'))

    makeConversation(codexProjects, 'repo', 'new-codex', 'New codex')

    clearScanCache()
    const result = await scanConversations({
      projectsDirs: [claudeProjects, codexProjects],
    })
    assert.equal(result.length, 2)
    assert.equal(result[0].conversationId, 'new-codex', 'newest should be first')
    assert.equal(result[1].conversationId, 'old-claude', 'oldest should be last')
  })

  it('tolerates one dir not existing and returns results from the others', async () => {
    const { scanConversations, clearScanCache } = await import('../src/conversation-scanner.js')

    const claudeProjects = join(claudeDir, 'projects')
    mkdirSync(claudeProjects, { recursive: true })
    makeConversation(claudeProjects, 'repo', 'conv-exists', 'Exists')

    clearScanCache()
    const result = await scanConversations({
      projectsDirs: [claudeProjects, '/nonexistent/path/projects'],
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].conversationId, 'conv-exists')
  })
})

// ------------------------------------------------------------------ //
// listAgents — multi-provider agent directory merging
// ------------------------------------------------------------------ //

describe('listAgents with multiple provider agentsDirs (#2965)', () => {
  let claudeDir
  let codexDir
  let tempCwd

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'chroxy-2965-agents-claude-'))
    codexDir = mkdtempSync(join(tmpdir(), 'chroxy-2965-agents-codex-'))
    tempCwd = mkdtempSync(join(tmpdir(), 'chroxy-2965-cwd-'))
  })

  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true })
    rmSync(codexDir, { recursive: true, force: true })
    rmSync(tempCwd, { recursive: true, force: true })
  })

  function makeAgentFile(dir, name, description = '') {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.md`), `${description}\n\nSome content here.`)
  }

  it('listAgents accepts a userAgentsDirs array and merges results', async () => {
    const { createBrowserOps } = await import('../src/ws-file-ops/browser.js')

    const claudeAgents = join(claudeDir, 'agents')
    const codexAgents = join(codexDir, 'agents')

    makeAgentFile(claudeAgents, 'claude-agent', 'An agent from Claude')
    makeAgentFile(codexAgents, 'codex-agent', 'An agent from Codex')

    const received = []
    const sendFn = (_ws, msg) => received.push(msg)
    const resolveSessionCwd = async () => null
    const validatePathWithinCwd = async () => null

    const browser = createBrowserOps(sendFn, resolveSessionCwd, validatePathWithinCwd)
    // Pass userAgentsDirs to replace the default ~/.claude/agents scan
    await browser.listAgents(null, tempCwd, null, {
      userAgentsDirs: [claudeAgents, codexAgents],
    })

    const [response] = received
    assert.ok(response, 'should receive a response')
    assert.equal(response.type, 'agent_list')
    const names = response.agents.map(a => a.name)
    assert.ok(names.includes('claude-agent'), 'must include claude-agent')
    assert.ok(names.includes('codex-agent'), 'must include codex-agent')
  })

  it('listAgents deduplicates agents with the same name across dirs (first wins)', async () => {
    const { createBrowserOps } = await import('../src/ws-file-ops/browser.js')

    const claudeAgents = join(claudeDir, 'agents')
    const codexAgents = join(codexDir, 'agents')

    makeAgentFile(claudeAgents, 'shared-agent', 'Claude version')
    makeAgentFile(codexAgents, 'shared-agent', 'Codex version')

    const received = []
    const sendFn = (_ws, msg) => received.push(msg)

    const browser = createBrowserOps(sendFn, async () => null, async () => null)
    await browser.listAgents(null, tempCwd, null, {
      userAgentsDirs: [claudeAgents, codexAgents],
    })

    const [response] = received
    const agents = response.agents.filter(a => a.name === 'shared-agent')
    assert.equal(agents.length, 1, 'shared-agent must appear only once')
    assert.equal(agents[0].description, 'Claude version', 'first dir wins on dedup')
  })

  it('listAgents preserves first-wins order even when later dirs resolve faster (#3024)', async () => {
    // Parallel scanning must not let a faster dir leapfrog earlier dirs.
    // We simulate this by giving the first dir many more files than the
    // second dir — readdir on the larger dir is naturally slower, so any
    // implementation that races and accepts the first responder would
    // incorrectly let codex (smaller dir) win.
    const { createBrowserOps } = await import('../src/ws-file-ops/browser.js')

    const claudeAgents = join(claudeDir, 'agents')
    const codexAgents = join(codexDir, 'agents')

    // Create many files in claude dir, plus the shared-agent
    for (let i = 0; i < 50; i++) {
      makeAgentFile(claudeAgents, `claude-filler-${i}`, `Claude filler ${i}`)
    }
    makeAgentFile(claudeAgents, 'shared-agent', 'Claude version')

    // Codex has just the shared-agent
    makeAgentFile(codexAgents, 'shared-agent', 'Codex version')

    const received = []
    const sendFn = (_ws, msg) => received.push(msg)

    const browser = createBrowserOps(sendFn, async () => null, async () => null)
    await browser.listAgents(null, tempCwd, null, {
      userAgentsDirs: [claudeAgents, codexAgents],
    })

    const [response] = received
    const shared = response.agents.find(a => a.name === 'shared-agent')
    assert.ok(shared, 'shared-agent must be present')
    assert.equal(shared.description, 'Claude version', 'first dir must win regardless of scan completion order')
  })

  it('listAgents tolerates a missing dir and returns results from the others (#3024)', async () => {
    const { createBrowserOps } = await import('../src/ws-file-ops/browser.js')

    const claudeAgents = join(claudeDir, 'agents')
    makeAgentFile(claudeAgents, 'claude-agent', 'An agent from Claude')

    const received = []
    const sendFn = (_ws, msg) => received.push(msg)

    const browser = createBrowserOps(sendFn, async () => null, async () => null)
    await browser.listAgents(null, tempCwd, null, {
      userAgentsDirs: [claudeAgents, '/nonexistent/path/agents'],
    })

    const [response] = received
    const names = response.agents.map(a => a.name)
    assert.ok(names.includes('claude-agent'), 'must include agent from existing dir')
  })
})
