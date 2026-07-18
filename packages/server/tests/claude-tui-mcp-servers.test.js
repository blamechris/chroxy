import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'

/**
 * #6820 — MCP visibility parity for the claude-tui provider.
 *
 * The interactive TUI communicates over a PTY + hook payloads and exposes NO
 * runtime MCP status, so unlike sdk/cli-session (which parse live `mcp_servers`
 * off the stream-json `system/init` event), ClaudeTuiSession emits the
 * CONFIGURED server list discovered from the same ~/.claude.json / .mcp.json
 * sources Claude Code reads, tagged with status `configured` (never `connected`)
 * so the client renders a neutral, not-live indicator.
 *
 * The test drives `_emitConfiguredMcpServers()` directly (the method both
 * `emit('ready')` sites call) rather than spawning a real PTY, and points
 * config discovery at a temp file via CHROXY_CLAUDE_CONFIG so the assertions
 * never depend on the dev machine's real ~/.claude.json.
 */
describe('ClaudeTuiSession — configured mcp_servers emission (#6820)', () => {
  let skillsDir
  let cwd
  let cfgDir
  let configPath
  let prevConfigEnv

  beforeEach(() => {
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-skills-'))
    cwd = mkdtempSync(join(tmpdir(), 'chroxy-tui-mcp-cwd-'))
    cfgDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-mcp-cfg-'))
    configPath = join(cfgDir, 'claude.json')
    prevConfigEnv = process.env.CHROXY_CLAUDE_CONFIG
    process.env.CHROXY_CLAUDE_CONFIG = configPath
  })

  afterEach(() => {
    if (prevConfigEnv === undefined) delete process.env.CHROXY_CLAUDE_CONFIG
    else process.env.CHROXY_CLAUDE_CONFIG = prevConfigEnv
    rmSync(skillsDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
  })

  it('emits configured servers with status "configured"', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { fs: { command: 'npx' }, gh: { command: 'node' } } }),
    )
    const session = new ClaudeTuiSession({ cwd, skillsDir, repoSkillsDir: null })
    const events = []
    session.on('mcp_servers', (data) => events.push(data))

    session._emitConfiguredMcpServers()

    assert.equal(events.length, 1)
    assert.deepEqual(events[0], {
      servers: [
        { name: 'fs', status: 'configured' },
        { name: 'gh', status: 'configured' },
      ],
    })
  })

  it('merges project-local .mcp.json into the emitted list', () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: { globalfs: { command: 'npx' } } }))
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { repotool: { command: 'node' } } }),
    )
    const session = new ClaudeTuiSession({ cwd, skillsDir, repoSkillsDir: null })
    const events = []
    session.on('mcp_servers', (data) => events.push(data))

    session._emitConfiguredMcpServers()

    assert.deepEqual(events[0], {
      servers: [
        { name: 'globalfs', status: 'configured' },
        { name: 'repotool', status: 'configured' },
      ],
    })
  })

  it('emits an empty list when nothing is configured (clears stale state)', () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
    const session = new ClaudeTuiSession({ cwd, skillsDir, repoSkillsDir: null })
    const events = []
    session.on('mcp_servers', (data) => events.push(data))

    session._emitConfiguredMcpServers()

    assert.deepEqual(events, [{ servers: [] }])
  })

  it('never throws on a corrupt config — still emits an empty list', () => {
    writeFileSync(configPath, '{ corrupt json')
    const session = new ClaudeTuiSession({ cwd, skillsDir, repoSkillsDir: null })
    const events = []
    session.on('mcp_servers', (data) => events.push(data))

    assert.doesNotThrow(() => session._emitConfiguredMcpServers())
    assert.deepEqual(events, [{ servers: [] }])
  })

  it('emits an empty list even when discovery itself THROWS (clears stale client state)', () => {
    // discoverConfiguredMcpServers is designed never to throw, but the catch
    // block's documented contract must hold if it ever does: clients holding a
    // previous list must still get the clearing empty-list emission. Force the
    // throw deterministically by making the `cwd` read (the discovery
    // argument, evaluated inside the try) blow up.
    const session = new ClaudeTuiSession({ cwd, skillsDir, repoSkillsDir: null })
    Object.defineProperty(session, 'cwd', {
      get() {
        throw new Error('boom: forced discovery failure')
      },
    })
    const events = []
    session.on('mcp_servers', (data) => events.push(data))

    assert.doesNotThrow(() => session._emitConfiguredMcpServers())
    assert.deepEqual(events, [{ servers: [] }])
  })
})
