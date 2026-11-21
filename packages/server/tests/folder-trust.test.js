import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, existsSync, readdirSync, symlinkSync, realpathSync, chmodSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
  readTrustedProjectSettings,
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

// trustFolder as the dashboard does it: bound to the digest of the state it reviewed.
const trust = (dir) => trustFolder(dir, scanFolderSettings(dir).digest)

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

  it('follows a symlinked file: the TARGET bytes are hashed, so editing the target revokes trust', async () => {
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    write(join(root, 'target.md'), 'v1')
    symlinkSync(join(root, 'target.md'), join(cwd, '.claude', 'agents', 'link.md'))
    const before = scanFolderSettings(cwd)
    assert.equal(before.files.length, 1)
    assert.equal(before.hardIncomplete, false)
    assert.equal(before.summary.files[0].linkTarget, join(root, 'target.md'))
    await trust(cwd)
    assert.equal(isFolderTrusted(cwd), true)
    write(join(root, 'target.md'), 'v2')
    assert.notEqual(scanFolderSettings(cwd).digest, before.digest)
    assert.equal(isFolderTrusted(cwd), false)
  })

  it('walks a symlinked directory and covers the files in it', () => {
    write(join(root, 'shared', 's', 'SKILL.md'), 'skill')
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
    symlinkSync(join(root, 'shared'), join(cwd, '.claude', 'skills', 'linked'))
    const scan = scanFolderSettings(cwd)
    assert.equal(scan.hardIncomplete, false)
    assert.ok(scan.files.some((f) => f.path.endsWith(join('linked', 's', 'SKILL.md'))))
    const before = scan.digest
    write(join(root, 'shared', 's', 'SKILL.md'), 'changed')
    assert.notEqual(scanFolderSettings(cwd).digest, before)
  })

  it('a dangling link, a link cycle and a link to a non-regular file are HARD (untrusted and untrustable)', async () => {
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    symlinkSync(join(root, 'nowhere.md'), join(cwd, '.claude', 'agents', 'dangling.md'))
    assert.equal(scanFolderSettings(cwd).hardIncomplete, true)
    rmSync(join(cwd, '.claude', 'agents', 'dangling.md'))
    symlinkSync(join(cwd, '.claude', 'agents'), join(cwd, '.claude', 'agents', 'loop'))
    const cycle = scanFolderSettings(cwd)
    assert.equal(cycle.hardIncomplete, true)
    assert.ok(cycle.summary.warnings.some((w) => w.includes('symlink cycle')))
    rmSync(join(cwd, '.claude', 'agents', 'loop'))
    symlinkSync('/dev/null', join(cwd, '.claude', 'agents', 'dev.md'))
    assert.equal(scanFolderSettings(cwd).hardIncomplete, true)
    assert.equal((await trust(cwd)).ok, false)
    assert.equal(isFolderTrusted(cwd), false)
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

  it('too many files is HARD: untrusted and untrustable', async () => {
    for (let i = 0; i < MAX_SCANNED_FILES + 5; i++) write(join(cwd, '.claude', 'commands', `c${i}.md`), 'x')
    const scan = scanFolderSettings(cwd)
    assert.equal(scan.hardIncomplete, true)
    const result = await trust(cwd)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'FOLDER_TRUST_UNTRUSTABLE')
    assert.equal(isFolderTrusted(cwd), false)
    assert.equal(projectSettingsAllowed(cwd), false)
  })

  it('a file over the per-file limit is HARD and never hashed by size/mtime', async () => {
    write(join(cwd, '.claude', 'agents', 'big.md'), 'x'.repeat(2000))
    const scan = scanFolderSettings(cwd, { maxFileBytes: 1000 })
    assert.equal(scan.hardIncomplete, true)
    assert.ok(scan.summary.untrustable)
    assert.ok(scan.summary.warnings.some((w) => w.includes('too large')))
    assert.equal(scanFolderSettings(cwd).hardIncomplete, false, 'under the real limit it is fine')
  })

  it('the total byte budget is HARD', () => {
    for (let i = 0; i < 5; i++) write(join(cwd, '.claude', 'agents', `a${i}.md`), 'x'.repeat(400))
    assert.equal(scanFolderSettings(cwd, { maxTotalBytes: 1000 }).hardIncomplete, true)
  })

  it('every file is hashed by content: same size and mtime, different bytes, different digest', () => {
    const f = join(cwd, '.claude', 'agents', 'a.md')
    write(f, 'aaaa')
    const t = statSync(f).mtime
    const before = scanFolderSettings(cwd).digest
    write(f, 'bbbb')
    utimesSync(f, t, t)
    assert.notEqual(scanFolderSettings(cwd).digest, before)
  })

  it('a FIFO is HARD and the scan returns promptly (no hang)', { skip: process.platform === 'win32' }, async () => {
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    execFileSync('mkfifo', [join(cwd, '.claude', 'agents', 'pipe.md')])
    const t0 = Date.now()
    const scan = scanFolderSettings(cwd)
    assert.ok(Date.now() - t0 < 2000)
    assert.equal(scan.hardIncomplete, true)
    assert.equal((await trust(cwd)).ok, false)
    assert.equal(isFolderTrusted(cwd), false)
  })

  it('an unreadable directory (EACCES) is HARD', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    write(join(cwd, '.claude', 'agents', 'a.md'), 'x')
    mkdirSync(join(cwd, 'sub', 'locked'), { recursive: true })
    chmodSync(join(cwd, 'sub', 'locked'), 0o000)
    try {
      assert.equal(scanFolderSettings(cwd).hardIncomplete, true)
    } finally {
      chmodSync(join(cwd, 'sub', 'locked'), 0o755)
    }
    mkdirSync(join(cwd, '.claude', 'skills', 'locked'), { recursive: true })
    chmodSync(join(cwd, '.claude', 'skills', 'locked'), 0o000)
    try {
      assert.equal(scanFolderSettings(cwd).hardIncomplete, true)
    } finally {
      chmodSync(join(cwd, '.claude', 'skills', 'locked'), 0o755)
    }
  })

  it('only ENOENT and ENOTDIR mean absent: a file where a directory should be is absent, not an error', () => {
    write(join(cwd, '.claude'), 'a file named .claude')
    const scan = scanFolderSettings(cwd)
    assert.equal(scan.hardIncomplete, false)
    assert.equal(scan.hasCommandBearingFiles, false)
  })

  it('a skill, agent or command that exists only in an ANCESTOR is listed and untrusted', async () => {
    write(join(root, 'home', '.claude', 'skills-ancestor-marker'), 'x') // not a content dir: ignored
    write(join(root, '.claude', 'skills', 'up', 'SKILL.md'), 'ancestor skill')
    write(join(root, 'home', '.claude', 'agents', 'unused.md'), 'x')
    const scan = scanFolderSettings(cwd)
    assert.ok(scan.files.some((f) => f.path === join(root, '.claude', 'skills', 'up', 'SKILL.md')))
    assert.equal(scan.hasCommandBearingFiles, true)
    assert.equal(isFolderTrusted(cwd), false)
    assert.equal(projectSettingsAllowed(cwd), false)
    // `home/.claude` is the user's own Claude dir here: its agents are not the project's.
    assert.equal(scan.files.some((f) => f.path.includes(join('home', '.claude'))), false)
  })

  it('a nested .claude/skills below the folder is covered: changing it alters the digest', () => {
    write(join(cwd, 'packages', 'a', '.claude', 'skills', 's', 'SKILL.md'), 'one')
    const scan = scanFolderSettings(cwd)
    assert.ok(scan.files.some((f) => f.path.includes(join('packages', 'a', '.claude'))))
    write(join(cwd, 'packages', 'a', '.claude', 'skills', 's', 'SKILL.md'), 'two')
    assert.notEqual(scanFolderSettings(cwd).digest, scan.digest)
  })

  it('the nested search skips .git and node_modules', () => {
    write(join(cwd, 'node_modules', 'pkg', '.claude', 'skills', 's', 'SKILL.md'), 'x')
    write(join(cwd, '.git', 'x', '.claude', 'skills', 's', 'SKILL.md'), 'x')
    assert.equal(scanFolderSettings(cwd).hasCommandBearingFiles, false)
  })

  it('hitting the nested-walk cap is SOFT: still trustable, with a visible warning', async () => {
    for (let i = 0; i < 6; i++) mkdirSync(join(cwd, `d${i}`), { recursive: true })
    const scan = scanFolderSettings(cwd, { maxNestedDirs: 3 })
    assert.equal(scan.hardIncomplete, false)
    assert.ok(scan.summary.warnings.some((w) => w.includes('Folder tree too large to scan fully: nested skills beyond 3 directories are not covered')))
  })

  it('the nested search also stops after too many directory entries (SOFT)', () => {
    for (let i = 0; i < 20; i++) write(join(cwd, 'many', `f${i}.txt`), 'x')
    const scan = scanFolderSettings(cwd, { maxNestedEntries: 10 })
    assert.equal(scan.hardIncomplete, false)
    assert.ok(scan.summary.warnings.some((w) => w.includes('Folder tree too large to scan fully')))
  })

  it('in a linked git worktree the MAIN checkout skills are included', () => {
    const main = join(root, 'main')
    write(join(main, '.claude', 'skills', 'm', 'SKILL.md'), 'main skill')
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true })
    const wt = join(root, 'wt')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`)
    const scan = scanFolderSettings(wt)
    assert.ok(scan.files.some((f) => f.path === join(main, '.claude', 'skills', 'm', 'SKILL.md')))
    // a normal repository (".git" is a directory) does not reach for anything else
    const plain = join(root, 'plain')
    mkdirSync(join(plain, '.git'), { recursive: true })
    assert.equal(scanFolderSettings(plain).hasCommandBearingFiles, false)
  })

})

describe('trust does not survive an incomplete scan', () => {
  it('trusted, then something unreadable appears that the digest cannot see: untrusted', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trust(cwd)
    assert.equal(isFolderTrusted(cwd), true)
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    symlinkSync(join(root, 'nowhere.md'), join(cwd, '.claude', 'agents', 'dangling.md'))
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
    assert.deepEqual(summary.files.map((f) => f.path), [join(cwd, '.claude', 'settings.json'), join(cwd, '.mcp.json')])
    assert.equal(summary.hasCommandBearingFiles, true)
  })
})

describe('trust store', () => {
  it('trusts the current digest and an edit makes the folder untrusted again', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: { a: { command: 'x' } } })
    assert.equal(isFolderTrusted(cwd), false)
    const result = await trust(cwd)
    assert.equal(result.ok, true)
    assert.equal(result.status, 'trusted')
    assert.equal(isFolderTrusted(cwd), true)
    write(join(cwd, '.mcp.json'), { mcpServers: { a: { command: 'changed' } } })
    assert.equal(isFolderTrusted(cwd), false)
    assert.equal(getFolderTrustState(cwd).status, 'untrusted')
  })

  it('a record for another path or another digest does not match', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trust(cwd)
    const other = join(root, 'home', 'other')
    write(join(other, '.mcp.json'), { mcpServers: {} })
    assert.equal(isFolderTrusted(other), false)
    const records = loadFolderTrustRecords()
    writeFileSync(folderTrustStorePath(), JSON.stringify({ records: [{ ...records[0], digest: 'f'.repeat(64) }] }))
    assert.equal(isFolderTrusted(cwd), false)
  })

  it('writes the store with mode 0600 as atomic temp+rename (no temp left behind)', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trust(cwd)
    const path = folderTrustStorePath()
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(join(path, '..')).filter((n) => n.endsWith('.tmp') || n.endsWith('.lock')), [])
    const stored = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(stored.records.length, 1)
    assert.equal(stored.records[0].v, 2)
    assert.deepEqual(stored.records[0].files.map((f) => f.path), [join(realpathSync(cwd), '.mcp.json')])
    assert.match(stored.records[0].files[0].sha256, /^[0-9a-f]{64}$/)
    assert.equal(stored.records[0].path, realpathSync(cwd))
    assert.match(stored.records[0].digest, /^[0-9a-f]{64}$/)
    assert.ok(stored.records[0].trustedAt)
  })

  it('drops v1 and unknown-version records at load, and records whose digest does not match their files', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trust(cwd)
    const [record] = loadFolderTrustRecords()
    for (const bad of [{ ...record, v: 1 }, { ...record, v: 3 }, { ...record, digest: 'f'.repeat(64) }]) {
      writeFileSync(folderTrustStorePath(), JSON.stringify({ records: [bad] }))
      assert.deepEqual(loadFolderTrustRecords(), [])
      assert.equal(isFolderTrusted(cwd), false)
    }
    const v1 = { v: 1, path: record.path, digest: record.digest, trustedAt: record.trustedAt }
    writeFileSync(folderTrustStorePath(), JSON.stringify({ records: [v1] }))
    assert.equal(isFolderTrusted(cwd), false, 'no shim: a v1 record does not grant trust')
  })

  it('trust is bound to the reviewed digest: a stale or missing digest is refused', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    const reviewed = scanFolderSettings(cwd).digest
    write(join(cwd, '.mcp.json'), { mcpServers: { swapped: { command: 'x' } } })
    const stale = await trustFolder(cwd, reviewed)
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'FOLDER_TRUST_CHANGED')
    assert.equal(isFolderTrusted(cwd), false)
    assert.equal((await trustFolder(cwd, undefined)).ok, false)
    assert.equal((await trustFolder(cwd, scanFolderSettings(cwd).digest)).ok, true)
  })

  it('writes with unique temp names, and a second process lock does not corrupt the store', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    const other = join(root, 'home', 'other')
    write(join(other, '.mcp.json'), { mcpServers: {} })
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    // A lock left by a dead process is recovered.
    writeFileSync(`${folderTrustStorePath()}.lock`, `2147483646\n${Date.now()}\n`)
    await Promise.all([trust(cwd), trust(other)])
    assert.equal(loadFolderTrustRecords().length, 2)
    assert.equal(existsSync(`${folderTrustStorePath()}.lock`), false)
  })

  it('a live lock held by another process makes the writer wait', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    const lock = `${folderTrustStorePath()}.lock`
    writeFileSync(lock, `${process.pid}\n${Date.now()}\n`) // this process is alive
    let done = false
    const p = trust(cwd).then((r) => { done = true; return r })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(done, false, 'blocked while the lock is held')
    rmSync(lock)
    assert.equal((await p).ok, true)
  })

  it('a folder with nothing command-bearing can be trusted; adding any such file then untrusts it', async () => {
    write(join(cwd, 'CLAUDE.md'), '# notes')
    assert.equal(projectSettingsAllowed(cwd), false, 'untrusted until trusted')
    const result = await trust(cwd)
    assert.equal(result.ok, true)
    assert.equal(projectSettingsAllowed(cwd), true)
    write(join(cwd, '.claude', 'agents', 'new.md'), 'x')
    assert.equal(projectSettingsAllowed(cwd), false)
  })

  it('a corrupt store reads as no trust', () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    writeFileSync(folderTrustStorePath(), '{ nope')
    assert.equal(isFolderTrusted(cwd), false)
  })

  it('untrustFolder removes the record', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trust(cwd)
    const result = await untrustFolder(cwd)
    assert.equal(result.status, 'untrusted')
    assert.equal(isFolderTrusted(cwd), false)
    assert.deepEqual(loadFolderTrustRecords(), [])
  })

  it('a trust change invalidates the scan cache at once', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    assert.equal(isFolderTrusted(cwd, { cached: true }), false) // primes the cache with the v1 digest
    write(join(cwd, '.mcp.json'), { mcpServers: { edited: { command: 'x' } } }) // the cached scan is now stale
    await trust(cwd) // records the CURRENT (v2) digest
    assert.equal(isFolderTrusted(cwd, { cached: true }), true, 'a stale cached scan must not outlive the trust change')
    await untrustFolder(cwd)
    assert.equal(isFolderTrusted(cwd, { cached: true }), false)
  })

  it('the cache is only used when asked for', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trust(cwd)
    assert.equal(isFolderTrusted(cwd, { cached: true }), true)
    write(join(cwd, '.mcp.json'), { mcpServers: { x: { command: 'new' } } })
    assert.equal(isFolderTrusted(cwd), false, 'an uncached check sees the edit')
  })

  it('two concurrent trust changes do not lose a record', async () => {
    const other = join(root, 'home', 'other')
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    write(join(other, '.mcp.json'), { mcpServers: {} })
    await Promise.all([trust(cwd), trust(other)])
    assert.equal(loadFolderTrustRecords().length, 2)
  })
})

describe('projectSettingsAllowed', () => {
  it('no implicit loading: a folder with no command-bearing files is untrusted too', () => {
    write(join(cwd, 'CLAUDE.md'), '# hi')
    assert.equal(projectSettingsAllowed(cwd), false)
    assert.deepEqual(claudeSettingSources(cwd), ['user'])
    assert.equal(scanFolderSettings(cwd).summary.hasCommandBearingFiles, false)
  })

  it('untrusted: false, and only the user scope', () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    assert.equal(projectSettingsAllowed(cwd), false)
    assert.deepEqual(claudeSettingSources(cwd), ['user'])
  })

  it('trusted: true and ["user","project"], never local', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trust(cwd)
    assert.equal(projectSettingsAllowed(cwd), true)
    assert.deepEqual(claudeSettingSources(cwd), ['user', 'project'])
    assert.equal(claudeSettingSources(cwd).includes('local'), false)
  })

  it('a trusted folder whose .mcp.json changes is no longer allowed', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trust(cwd)
    write(join(cwd, '.mcp.json'), { mcpServers: { n: { command: 'new' } } })
    assert.equal(projectSettingsAllowed(cwd), false)
  })

  it('no cwd is untrusted', () => {
    assert.equal(projectSettingsAllowed(undefined), false)
    assert.equal(projectSettingsAllowed(''), false)
    assert.deepEqual(claudeSettingSources(undefined), ['user'])
  })
})

describe('summary bounds', () => {
  it('says how many items are not shown and when long values were shortened', () => {
    const servers = {}
    for (let i = 0; i < 60; i++) servers[`s${i}`] = { command: 'x'.repeat(i === 0 ? 700 : 1) }
    write(join(cwd, '.mcp.json'), { mcpServers: servers })
    const { summary } = scanFolderSettings(cwd)
    assert.equal(summary.mcpServers.length, 50)
    assert.ok(summary.warnings.includes('10 more MCP servers not shown'))
    assert.ok(summary.warnings.some((w) => w.includes('shortened')))
  })

  it('a config file too large to parse is still covered by the digest', () => {
    write(join(cwd, '.mcp.json'), `{"mcpServers":{},"pad":"${'x'.repeat(300 * 1024)}"}`)
    const scan = scanFolderSettings(cwd)
    assert.equal(scan.hardIncomplete, false)
    assert.equal(scan.files.length, 1)
    assert.ok(scan.summary.warnings.some((w) => w.includes('too large to summarize')))
  })
})

describe('readTrustedProjectSettings', () => {
  const settings = (command) => ({ statusLine: { type: 'command', command } })

  it('returns the file only when trusted and the bytes match the record', async () => {
    const f = join(cwd, '.claude', 'settings.json')
    write(f, settings('a.sh'))
    assert.equal(readTrustedProjectSettings(cwd), null, 'untrusted')
    await trust(cwd)
    assert.equal(JSON.parse(readTrustedProjectSettings(cwd)).statusLine.command, 'a.sh')
    write(f, settings('b.sh'))
    assert.equal(readTrustedProjectSettings(cwd), null, 'edited after trust')
    await untrustFolder(cwd)
    write(f, settings('a.sh'))
    assert.equal(readTrustedProjectSettings(cwd), null, 'untrusted again')
  })

  it('returns null when the file was not part of what was trusted', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trust(cwd)
    write(join(cwd, '.claude', 'settings.json'), settings('late.sh'))
    assert.equal(readTrustedProjectSettings(cwd), null)
  })
})
