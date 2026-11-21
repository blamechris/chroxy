import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, existsSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  scanFolderSettings,
  isFolderTrusted,
  trustFolder,
  untrustFolder,
  getFolderTrustState,
  loadFolderTrustRecords,
  folderTrustStorePath,
  invalidateFolderTrustCache,
  MAX_SCANNED_FILES,
} from '../src/folder-trust.js'
import { projectSettingsAllowed, claudeSettingSources } from '../src/claude-setting-sources.js'

/**
 * Per-folder trust. Every test runs in a temp CHROXY_CONFIG_DIR (the trust
 * store), a temp CLAUDE_CONFIG_DIR (the "user's" Claude dir) and temp folders.
 */

let root
let cwd
let savedChroxy
let savedClaude

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'folder-trust-')))
  savedChroxy = process.env.CHROXY_CONFIG_DIR
  savedClaude = process.env.CLAUDE_CONFIG_DIR
  process.env.CHROXY_CONFIG_DIR = join(root, 'chroxy')
  process.env.CLAUDE_CONFIG_DIR = join(root, 'home', '.claude')
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
  cwd = join(root, 'home', 'proj')
  mkdirSync(cwd, { recursive: true })
  invalidateFolderTrustCache()
})

afterEach(() => {
  if (savedChroxy === undefined) delete process.env.CHROXY_CONFIG_DIR
  else process.env.CHROXY_CONFIG_DIR = savedChroxy
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedClaude
  rmSync(root, { recursive: true, force: true })
  invalidateFolderTrustCache()
})

const write = (path, content) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
}

describe('scanFolderSettings: what is considered', () => {
  it('reports nothing for a folder with only a CLAUDE.md', () => {
    write(join(cwd, 'CLAUDE.md'), '# notes')
    const scan = scanFolderSettings(cwd)
    assert.equal(scan.hasCommandBearingFiles, false)
    assert.deepEqual(scan.files, [])
  })

  it('digest changes when .mcp.json or .claude/settings.json in the folder changes', () => {
    write(join(cwd, '.mcp.json'), { mcpServers: { a: { command: 'x' } } })
    write(join(cwd, '.claude', 'settings.json'), { hooks: {} })
    const before = scanFolderSettings(cwd).digest
    write(join(cwd, '.mcp.json'), { mcpServers: { a: { command: 'y' } } })
    const afterMcp = scanFolderSettings(cwd).digest
    assert.notEqual(afterMcp, before)
    write(join(cwd, '.claude', 'settings.json'), { hooks: { Stop: [] } })
    assert.notEqual(scanFolderSettings(cwd).digest, afterMcp)
  })

  it('covers an ancestor directory .mcp.json and .claude/settings.json', () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    const before = scanFolderSettings(cwd).digest
    write(join(root, 'home', '.mcp.json'), { mcpServers: { up: { command: 'evil' } } })
    const withAncestor = scanFolderSettings(cwd)
    assert.notEqual(withAncestor.digest, before)
    assert.ok(withAncestor.files.some((f) => f.path === join(root, 'home', '.mcp.json')))
    write(join(root, 'home', '.mcp.json'), { mcpServers: { up: { command: 'other' } } })
    assert.notEqual(scanFolderSettings(cwd).digest, withAncestor.digest)
    write(join(root, '.claude', 'settings.json'), { statusLine: { type: 'command', command: 'x' } })
    assert.ok(scanFolderSettings(cwd).files.some((f) => f.path === join(root, '.claude', 'settings.json')))
  })

  it('covers every regular file under agents, skills and commands, recursively', () => {
    write(join(cwd, '.claude', 'agents', 'a.md'), 'one')
    write(join(cwd, '.claude', 'skills', 's', 'SKILL.md'), 'two')
    write(join(cwd, '.claude', 'commands', 'deep', 'c.md'), 'three')
    const scan = scanFolderSettings(cwd)
    assert.equal(scan.hasCommandBearingFiles, true)
    assert.deepEqual(scan.summary.counts, { agents: 1, skills: 1, commands: 1 })
    const before = scan.digest
    write(join(cwd, '.claude', 'commands', 'deep', 'c.md'), 'changed')
    assert.notEqual(scanFolderSettings(cwd).digest, before)
  })

  it('is unchanged by .claude/settings.local.json', () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    const before = scanFolderSettings(cwd)
    write(join(cwd, '.claude', 'settings.local.json'), { statusLine: { type: 'command', command: 'x' } })
    const after = scanFolderSettings(cwd)
    assert.equal(after.digest, before.digest)
    assert.equal(after.files.some((f) => f.path.endsWith('settings.local.json')), false)
  })

  it('local settings alone are not command-bearing', () => {
    write(join(cwd, '.claude', 'settings.local.json'), { statusLine: { type: 'command', command: 'x' } })
    assert.equal(scanFolderSettings(cwd).hasCommandBearingFiles, false)
  })

  it('ignores the user config directory settings, even when it is an ancestor .claude', () => {
    write(join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), { statusLine: { type: 'command', command: 'user.sh' } })
    const before = scanFolderSettings(cwd)
    assert.equal(before.hasCommandBearingFiles, false)
    write(join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), { statusLine: { type: 'command', command: 'changed.sh' } })
    assert.equal(scanFolderSettings(cwd).digest, before.digest)
  })

  it('hashes a symlinked file by its link text and does not follow a symlinked directory', () => {
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    write(join(root, 'target.md'), 'v1')
    symlinkSync(join(root, 'target.md'), join(cwd, '.claude', 'agents', 'link.md'))
    mkdirSync(join(root, 'elsewhere'))
    write(join(root, 'elsewhere', 'x.md'), 'x')
    symlinkSync(join(root, 'elsewhere'), join(cwd, '.claude', 'agents', 'dirlink'))
    const before = scanFolderSettings(cwd)
    assert.equal(before.files.length, 2)
    assert.equal(before.files.some((f) => f.path.includes('elsewhere')), false)
    write(join(root, 'target.md'), 'v2')
    assert.equal(scanFolderSettings(cwd).digest, before.digest, 'the target is not read')
  })

  it('never throws: invalid JSON warns and the file still counts by its bytes', () => {
    write(join(cwd, '.mcp.json'), '{ not json')
    const scan = scanFolderSettings(cwd)
    assert.equal(scan.hasCommandBearingFiles, true)
    assert.ok(scan.summary.warnings.some((w) => w.includes('not valid JSON')))
    write(join(cwd, '.mcp.json'), '{ not json!')
    assert.notEqual(scanFolderSettings(cwd).digest, scan.digest)
  })

  it('a folder that does not exist yields no files and does not throw', () => {
    const scan = scanFolderSettings(join(root, 'missing', 'dir'))
    assert.equal(scan.hasCommandBearingFiles, false)
  })

  it('bounds the number of files and refuses to treat an over-bound folder as trustable', async () => {
    for (let i = 0; i < MAX_SCANNED_FILES + 5; i++) write(join(cwd, '.claude', 'commands', `c${i}.md`), 'x')
    const scan = scanFolderSettings(cwd)
    assert.equal(scan.truncated, true)
    const result = await trustFolder(cwd)
    assert.equal(result.ok, false)
    assert.equal(isFolderTrusted(cwd), false)
    assert.equal(projectSettingsAllowed(cwd), false)
  })
})

describe('scanFolderSettings: summary', () => {
  it('lists servers with command and args, env KEYS only, hooks, status line, plugins and files', () => {
    write(join(cwd, '.mcp.json'), {
      mcpServers: {
        gh: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: 'super-secret-value' } },
        remote: { url: 'https://example.com/mcp?token=abc', type: 'http' },
      },
    })
    write(join(cwd, '.claude', 'settings.json'), {
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
      statusLine: { type: 'command', command: 'status.sh' },
      enabledPlugins: { 'p@m': true },
    })
    const { summary } = scanFolderSettings(cwd)
    const gh = summary.mcpServers.find((s) => s.name === 'gh')
    assert.equal(gh.command, 'npx')
    assert.deepEqual(gh.args, ['-y', 'server-github'])
    assert.deepEqual(gh.envKeys, ['GITHUB_TOKEN'])
    assert.equal(JSON.stringify(summary).includes('super-secret-value'), false)
    assert.equal(JSON.stringify(summary).includes('token=abc'), false)
    assert.deepEqual(summary.hooks.map((h) => [h.event, h.commands]), [['PreToolUse', ['echo hi']]])
    assert.equal(summary.statusLine[0].command, 'status.sh')
    assert.equal(summary.enabledPlugins[0].plugin, 'p@m')
    assert.deepEqual(summary.files, [join(cwd, '.claude', 'settings.json'), join(cwd, '.mcp.json')])
  })
})

describe('trust store', () => {
  it('trusts the current digest and an edit makes the folder untrusted again', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: { a: { command: 'x' } } })
    assert.equal(isFolderTrusted(cwd), false)
    const result = await trustFolder(cwd)
    assert.equal(result.ok, true)
    assert.equal(result.status, 'trusted')
    assert.equal(isFolderTrusted(cwd), true)
    write(join(cwd, '.mcp.json'), { mcpServers: { a: { command: 'changed' } } })
    assert.equal(isFolderTrusted(cwd), false)
    assert.equal(getFolderTrustState(cwd).status, 'untrusted')
  })

  it('a record for another path or another digest does not match', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trustFolder(cwd)
    const other = join(root, 'home', 'other')
    write(join(other, '.mcp.json'), { mcpServers: {} })
    assert.equal(isFolderTrusted(other), false)
    const records = loadFolderTrustRecords()
    writeFileSync(folderTrustStorePath(), JSON.stringify({ records: [{ ...records[0], digest: 'f'.repeat(64) }] }))
    assert.equal(isFolderTrusted(cwd), false)
  })

  it('writes the store with mode 0600 as atomic temp+rename (no temp left behind)', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trustFolder(cwd)
    const path = folderTrustStorePath()
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(existsSync(`${path}.tmp`), false)
    const stored = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(stored.records.length, 1)
    assert.equal(stored.records[0].v, 1)
    assert.equal(stored.records[0].path, realpathSync(cwd))
    assert.match(stored.records[0].digest, /^[0-9a-f]{64}$/)
    assert.ok(stored.records[0].trustedAt)
  })

  it('drops records of an unknown version at load', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trustFolder(cwd)
    const [record] = loadFolderTrustRecords()
    writeFileSync(folderTrustStorePath(), JSON.stringify({ records: [{ ...record, v: 2 }] }))
    assert.deepEqual(loadFolderTrustRecords(), [])
    assert.equal(isFolderTrusted(cwd), false)
  })

  it('a corrupt store reads as no trust', () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    writeFileSync(folderTrustStorePath(), '{ nope')
    assert.equal(isFolderTrusted(cwd), false)
  })

  it('untrustFolder removes the record', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trustFolder(cwd)
    const result = await untrustFolder(cwd)
    assert.equal(result.status, 'untrusted')
    assert.equal(isFolderTrusted(cwd), false)
    assert.deepEqual(loadFolderTrustRecords(), [])
  })

  it('a trust change invalidates the scan cache at once', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    assert.equal(isFolderTrusted(cwd, { cached: true }), false) // primes the cache with the v1 digest
    write(join(cwd, '.mcp.json'), { mcpServers: { edited: { command: 'x' } } }) // the cached scan is now stale
    await trustFolder(cwd) // records the CURRENT (v2) digest
    assert.equal(isFolderTrusted(cwd, { cached: true }), true, 'a stale cached scan must not outlive the trust change')
    await untrustFolder(cwd)
    assert.equal(isFolderTrusted(cwd, { cached: true }), false)
  })

  it('the cache is only used when asked for', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trustFolder(cwd)
    assert.equal(isFolderTrusted(cwd, { cached: true }), true)
    write(join(cwd, '.mcp.json'), { mcpServers: { x: { command: 'new' } } })
    assert.equal(isFolderTrusted(cwd), false, 'an uncached check sees the edit')
  })

  it('two concurrent trust changes do not lose a record', async () => {
    const other = join(root, 'home', 'other')
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    write(join(other, '.mcp.json'), { mcpServers: {} })
    await Promise.all([trustFolder(cwd), trustFolder(other)])
    assert.equal(loadFolderTrustRecords().length, 2)
  })
})

describe('projectSettingsAllowed', () => {
  it('none: a folder with no command-bearing files loads project settings', () => {
    write(join(cwd, 'CLAUDE.md'), '# hi')
    assert.equal(projectSettingsAllowed(cwd), true)
    assert.deepEqual(claudeSettingSources(cwd), ['user', 'project'])
  })

  it('untrusted: false, and only the user scope', () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    assert.equal(projectSettingsAllowed(cwd), false)
    assert.deepEqual(claudeSettingSources(cwd), ['user'])
  })

  it('trusted: true and ["user","project"], never local', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trustFolder(cwd)
    assert.equal(projectSettingsAllowed(cwd), true)
    assert.deepEqual(claudeSettingSources(cwd), ['user', 'project'])
    assert.equal(claudeSettingSources(cwd).includes('local'), false)
  })

  it('a trusted folder whose .mcp.json changes is no longer allowed', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trustFolder(cwd)
    write(join(cwd, '.mcp.json'), { mcpServers: { n: { command: 'new' } } })
    assert.equal(projectSettingsAllowed(cwd), false)
  })

  it('no cwd is untrusted', () => {
    assert.equal(projectSettingsAllowed(undefined), false)
    assert.equal(projectSettingsAllowed(''), false)
    assert.deepEqual(claudeSettingSources(undefined), ['user'])
  })
})
