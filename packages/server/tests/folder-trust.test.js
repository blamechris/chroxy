import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, existsSync, readdirSync, symlinkSync, realpathSync, chmodSync, utimesSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { canonicalJson } from '../src/byok-mcp-trust.js'
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
import { projectSettingsAllowedAsync, claudeSettingSourcesFor } from '../src/claude-setting-sources.js'

/**
 * Per-folder trust. Every test runs in a temp CHROXY_CONFIG_DIR (the trust
 * store), a temp CLAUDE_CONFIG_DIR (the "user's" Claude dir) and temp folders.
 */

let root
let cwd
let savedChroxy
let savedClaude

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'folder-trust-')))
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

  it('follows a symlinked file: the TARGET bytes are hashed, so editing the target revokes trust', { skip: SKIP_NO_SYMLINK }, async () => {
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

  it('walks a symlinked directory and covers the files in it', { skip: SKIP_NO_SYMLINK }, () => {
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

  it('a dangling link, a link cycle and a link to a non-regular file are HARD (untrusted and untrustable)', { skip: SKIP_NO_SYMLINK }, async () => {
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
    assert.equal(await projectSettingsAllowedAsync(cwd), false)
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

  it('a real-path error other than ENOENT (an unreadable ancestor) is HARD, not a silent fallback', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    mkdirSync(join(root, 'locked', 'child'), { recursive: true })
    chmodSync(join(root, 'locked'), 0o000)
    try {
      const scan = scanFolderSettings(join(root, 'locked', 'child'))
      assert.equal(scan.hardIncomplete, true)
      assert.equal(isFolderTrusted(join(root, 'locked', 'child')), false)
    } finally {
      chmodSync(join(root, 'locked'), 0o755)
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
    assert.equal(await projectSettingsAllowedAsync(cwd), false)
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

  it('hitting the nested-search directory cap is HARD: untrustable, with the size message', () => {
    for (let i = 0; i < 6; i++) mkdirSync(join(cwd, `d${i}`), { recursive: true })
    const scan = scanFolderSettings(cwd, { maxNestedDirs: 3 })
    assert.equal(scan.hardIncomplete, true)
    assert.ok(scan.summary.untrustable)
    assert.ok(scan.summary.warnings.includes('This folder is too large to review (more than 3 directories)'))
  })

  it('the nested search also stops, HARD, after too many directory entries', () => {
    for (let i = 0; i < 20; i++) write(join(cwd, 'many', `f${i}.txt`), 'x')
    const scan = scanFolderSettings(cwd, { maxNestedEntries: 10 })
    assert.equal(scan.hardIncomplete, true)
    assert.ok(scan.summary.warnings.some((w) => w.includes('more than 10 entries')))
  })

  it('the nested search has a wall-clock budget: exceeding it is HARD', () => {
    for (let i = 0; i < 5; i++) mkdirSync(join(cwd, `d${i}`), { recursive: true })
    const scan = scanFolderSettings(cwd, { nestedBudgetMs: -1 })
    assert.equal(scan.hardIncomplete, true)
    assert.ok(scan.summary.warnings.some((w) => w.includes('took too long')))
  })

  it('a large synthetic tree hits the cap, is HARD, and returns within the budget', () => {
    // 600 directories x 20 files: well past the caps passed here, quick to create.
    for (let i = 0; i < 300; i++) {
      mkdirSync(join(cwd, 'big', `d${i}`), { recursive: true })
      for (let j = 0; j < 5; j++) writeFileSync(join(cwd, 'big', `d${i}`, `f${j}`), '')
    }
    const t0 = Date.now()
    const scan = scanFolderSettings(cwd, { maxNestedDirs: 100 })
    assert.ok(Date.now() - t0 < 1500 + 500)
    assert.equal(scan.hardIncomplete, true)
  })

  it('enumeration stops AT the entry cap: later entries are never read (counted as read, not after listing)', () => {
    for (let i = 0; i < 2000; i++) writeFileSync(join(cwd, `e${i}`), '')
    // Instrument: only the entries counter matters, so read the budget through the scan result.
    const scan = scanFolderSettings(cwd, { maxNestedEntries: 50 })
    assert.equal(scan.hardIncomplete, true)
    assert.ok(scan.summary.warnings.some((w) => w.includes('more than 50 entries')))
  })

  it('the content traversal has its own directory budget (HARD)', () => {
    for (let i = 0; i < 8; i++) write(join(cwd, '.claude', 'skills', `s${i}`, 'SKILL.md'), 'x')
    const scan = scanFolderSettings(cwd, { maxContentDirs: 4 })
    assert.equal(scan.hardIncomplete, true)
    assert.ok(scan.summary.warnings.some((w) => w.includes('more than 4 directories')))
    assert.equal(scanFolderSettings(cwd, { maxContentEntries: 3 }).hardIncomplete, true)
  })

  it('a symlinked directory in the nested walk is followed: a .claude behind it is covered', { skip: SKIP_NO_SYMLINK }, () => {
    write(join(root, 'elsewhere', '.claude', 'skills', 's', 'SKILL.md'), 'via link')
    symlinkSync(join(root, 'elsewhere'), join(cwd, 'linked'))
    const scan = scanFolderSettings(cwd)
    assert.equal(scan.hardIncomplete, false)
    assert.ok(scan.files.some((f) => f.path === join(cwd, 'linked', '.claude', 'skills', 's', 'SKILL.md')))
  })

  it('a symlink cycle or a dangling link in the nested walk is HARD', { skip: SKIP_NO_SYMLINK }, () => {
    symlinkSync(cwd, join(cwd, 'loop'))
    const cycle = scanFolderSettings(cwd)
    assert.equal(cycle.hardIncomplete, true)
    assert.ok(cycle.summary.warnings.some((w) => w.includes('symlink cycle')))
    rmSync(join(cwd, 'loop'))
    symlinkSync(join(root, 'nope'), join(cwd, 'dangling'))
    assert.ok(scanFolderSettings(cwd).summary.warnings.some((w) => w.includes('dangling symlink')))
    assert.equal(scanFolderSettings(cwd).hardIncomplete, true)
  })

  it('a dangling content root is HARD, not absent', { skip: SKIP_NO_SYMLINK }, async () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    for (const sub of ['skills', 'agents', 'commands']) {
      symlinkSync(join(root, 'nowhere'), join(cwd, '.claude', sub))
      assert.equal(scanFolderSettings(cwd).hardIncomplete, true, sub)
      rmSync(join(cwd, '.claude', sub))
    }
    assert.equal(scanFolderSettings(cwd).hardIncomplete, false)
    // a dangling config file is HARD too
    symlinkSync(join(root, 'nowhere.json'), join(cwd, '.mcp.json'))
    assert.equal(scanFolderSettings(cwd).hardIncomplete, true)
  })

  it('an unparsable .git file (worktree pointer) is HARD', () => {
    const wt = join(root, 'wt-bad')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, '.git'), 'this is not a pointer\n')
    const scan = scanFolderSettings(wt)
    assert.equal(scan.hardIncomplete, true)
    assert.ok(scan.summary.warnings.some((w) => w.includes('unparsable .git file')))
  })

  it('the user config dir is recognised through a dotfile symlink (default ~/.claude -> elsewhere)', { skip: SKIP_NO_SYMLINK }, () => {
    const home = join(root, 'h2')
    mkdirSync(join(home, 'proj'), { recursive: true })
    write(join(root, 'dotfiles', 'claude', 'agents', 'mine.md'), 'user agent')
    write(join(root, 'dotfiles', 'claude', 'settings.json'), { statusLine: { type: 'command', command: 'u.sh' } })
    symlinkSync(join(root, 'dotfiles', 'claude'), join(home, '.claude'))
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
    process.env.HOME = home
    process.env.USERPROFILE = home
    delete process.env.CLAUDE_CONFIG_DIR
    try {
      const scan = scanFolderSettings(join(home, 'proj'))
      assert.equal(scan.hasCommandBearingFiles, false, 'the user dir is not the project')
      assert.equal(scan.hardIncomplete, false)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('a symlinked CLAUDE_CONFIG_DIR is resolved before comparing', { skip: SKIP_NO_SYMLINK }, () => {
    const real = join(root, 'realclaude')
    write(join(real, 'agents', 'mine.md'), 'x')
    mkdirSync(join(root, 'h3', 'proj'), { recursive: true })
    symlinkSync(real, join(root, 'h3', '.claude'))
    process.env.CLAUDE_CONFIG_DIR = join(root, 'h3', '.claude')
    assert.equal(scanFolderSettings(join(root, 'h3', 'proj')).hasCommandBearingFiles, false)
    process.env.CLAUDE_CONFIG_DIR = real
    assert.equal(scanFolderSettings(join(root, 'h3', 'proj')).hasCommandBearingFiles, false)
  })

  it('a symlinked cwd is scanned and trusted by its REAL path and real ancestors', { skip: SKIP_NO_SYMLINK }, async () => {
    write(join(root, 'real', '.mcp.json'), { mcpServers: {} })
    mkdirSync(join(root, 'real', 'proj'), { recursive: true })
    mkdirSync(join(root, 'rawparent'), { recursive: true })
    symlinkSync(join(root, 'real', 'proj'), join(root, 'rawparent', 'link'))
    write(join(root, 'rawparent', '.mcp.json'), { mcpServers: { raw: { command: 'x' } } })
    const scan = scanFolderSettings(join(root, 'rawparent', 'link'))
    assert.equal(scan.realPath, join(root, 'real', 'proj'))
    assert.ok(scan.files.some((f) => f.path === join(root, 'real', '.mcp.json')), 'real ancestor')
    assert.equal(scan.files.some((f) => f.path === join(root, 'rawparent', '.mcp.json')), false, 'raw ancestor is not the real tree')
    await trust(join(root, 'rawparent', 'link'))
    assert.equal(isFolderTrusted(join(root, 'real', 'proj')), true, 'keyed by real path')
  })

  it('a .claude reached through a nested symlink is covered', { skip: SKIP_NO_SYMLINK }, () => {
    write(join(root, 'store', 'skills', 's', 'SKILL.md'), 'linked .claude')
    mkdirSync(join(cwd, 'pkg'), { recursive: true })
    symlinkSync(join(root, 'store'), join(cwd, 'pkg', '.claude'))
    const scan = scanFolderSettings(cwd)
    assert.ok(scan.files.some((f) => f.path === join(cwd, 'pkg', '.claude', 'skills', 's', 'SKILL.md')))
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
  it('trusted, then something unreadable appears that the digest cannot see: untrusted', { skip: SKIP_NO_SYMLINK }, async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trust(cwd)
    assert.equal(isFolderTrusted(cwd), true)
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    symlinkSync(join(root, 'nowhere.md'), join(cwd, '.claude', 'agents', 'dangling.md'))
    assert.equal(isFolderTrusted(cwd), false)
    assert.equal(await projectSettingsAllowedAsync(cwd), false)
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
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600) // no POSIX mode bits on Windows; atomicity below still runs
    assert.deepEqual(readdirSync(join(path, '..')).filter((n) => n.endsWith('.tmp') || n.endsWith('.lock')), [])
    const stored = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(stored.records.length, 1)
    assert.equal(stored.records[0].v, 2)
    assert.deepEqual(stored.records[0].files.map((f) => f.path), [join(realpathSync.native(cwd), '.mcp.json')])
    assert.match(stored.records[0].files[0].sha256, /^[0-9a-f]{64}$/)
    assert.equal(stored.records[0].path, realpathSync.native(cwd))
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
    writeFileSync(lock, `${process.ppid}\n${Date.now()}\n`) // another process, alive
    let done = false
    const p = trust(cwd).then((r) => { done = true; return r })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(done, false, 'blocked while the lock is held')
    rmSync(lock)
    assert.equal((await p).ok, true)
  })

  it('a folder with nothing command-bearing can be trusted; adding any such file then untrusts it', async () => {
    write(join(cwd, 'CLAUDE.md'), '# notes')
    assert.equal(await projectSettingsAllowedAsync(cwd), false, 'untrusted until trusted')
    const result = await trust(cwd)
    assert.equal(result.ok, true)
    assert.equal(await projectSettingsAllowedAsync(cwd), true)
    write(join(cwd, '.claude', 'agents', 'new.md'), 'x')
    assert.equal(await projectSettingsAllowedAsync(cwd), false)
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
  it('no implicit loading: a folder with no command-bearing files is untrusted too', async () => {
    write(join(cwd, 'CLAUDE.md'), '# hi')
    assert.equal(await projectSettingsAllowedAsync(cwd), false)
    assert.deepEqual(claudeSettingSourcesFor(await projectSettingsAllowedAsync(cwd)), ['user'])
    assert.equal(scanFolderSettings(cwd).summary.hasCommandBearingFiles, false)
  })

  it('untrusted: false, and only the user scope', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    assert.equal(await projectSettingsAllowedAsync(cwd), false)
    assert.deepEqual(claudeSettingSourcesFor(await projectSettingsAllowedAsync(cwd)), ['user'])
  })

  it('trusted: true and ["user","project"], never local', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trust(cwd)
    assert.equal(await projectSettingsAllowedAsync(cwd), true)
    assert.deepEqual(claudeSettingSourcesFor(await projectSettingsAllowedAsync(cwd)), ['user', 'project'])
    assert.equal(claudeSettingSourcesFor(await projectSettingsAllowedAsync(cwd)).includes('local'), false)
  })

  it('a trusted folder whose .mcp.json changes is no longer allowed', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    await trust(cwd)
    write(join(cwd, '.mcp.json'), { mcpServers: { n: { command: 'new' } } })
    assert.equal(await projectSettingsAllowedAsync(cwd), false)
  })

  it('no cwd is untrusted', async () => {
    assert.equal(await projectSettingsAllowedAsync(undefined), false)
    assert.equal(await projectSettingsAllowedAsync(''), false)
    assert.deepEqual(claudeSettingSourcesFor(await projectSettingsAllowedAsync(undefined)), ['user'])
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

describe('cross-process store lock', () => {
  const MODULE = new URL('../src/folder-trust.js', import.meta.url).href
  const holder = (storePath) => `
    import { withInterprocessLock } from ${JSON.stringify(MODULE)}
    await withInterprocessLock(${JSON.stringify(storePath)}, async () => {
      console.log('LOCKED')
      await new Promise((resolve) => process.stdin.once('data', resolve))
    })
    console.log('RELEASED')
    process.exit(0)
  `

  it('a REAL child process holds the lock: the parent waits, then proceeds when the child releases', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    const child = spawn(process.execPath, ['--input-type=module', '-e', holder(folderTrustStorePath())], {
      env: { ...process.env }, stdio: ['pipe', 'pipe', 'inherit'],
    })
    let out = ''
    const locked = new Promise((resolve) => child.stdout.on('data', (d) => { out += d; if (out.includes('LOCKED')) resolve() }))
    const exited = new Promise((resolve) => child.on('exit', resolve))
    try {
      await locked
      let done = false
      const p = trust(cwd).then((r) => { done = true; return r })
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(done, false, 'the parent waits while another process holds the lock')
      child.stdin.write('go\n')
      await exited
      assert.equal((await p).ok, true)
      assert.equal(existsSync(`${folderTrustStorePath()}.lock`), false)
    } finally {
      child.kill()
    }
  })

  it('a stale lock (holder pid dead) is reclaimed by exactly one claimant', async () => {
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    const dead = spawn(process.execPath, ['-e', ''])
    await new Promise((resolve) => dead.on('exit', resolve))
    writeFileSync(`${folderTrustStorePath()}.lock`, `${dead.pid}\nold-token\n${Date.now()}\n`)
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    const other = join(root, 'home', 'other')
    write(join(other, '.mcp.json'), { mcpServers: {} })
    const results = await Promise.all([trust(cwd), trust(other)])
    assert.deepEqual(results.map((r) => r.ok), [true, true])
    assert.equal(loadFolderTrustRecords().length, 2)
    assert.deepEqual(readdirSync(process.env.CHROXY_CONFIG_DIR).filter((n) => n.includes('.stale.') || n.endsWith('.lock')), [])
  })

  it('a live pid is never robbed because its lock is old', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    const lock = `${folderTrustStorePath()}.lock`
    writeFileSync(lock, `${process.ppid}\nlive-token\n${Date.now()}\n`)
    const old = new Date(Date.now() - 3600_000)
    utimesSync(lock, old, old)
    let done = false
    const p = trust(cwd).then((r) => { done = true; return r })
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(done, false)
    rmSync(lock)
    assert.equal((await p).ok, true)
  })

  it('release removes only a lock that still holds its own token', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    mkdirSync(process.env.CHROXY_CONFIG_DIR, { recursive: true })
    const lock = `${folderTrustStorePath()}.lock`
    const { withInterprocessLock } = await import('../src/folder-trust.js')
    await withInterprocessLock(folderTrustStorePath(), async () => {
      // someone else took over the file while we were working
      rmSync(lock)
      writeFileSync(lock, `${process.pid}\nsomeone-elses-token\n${Date.now()}\n`)
    })
    assert.equal(existsSync(lock), true, 'not ours: left alone')
    assert.ok(readFileSync(lock, 'utf8').includes('someone-elses-token'))
  })
})

describe('readTrustedProjectSettings also needs the folder trusted', () => {
  it('a file whose hash matches is NOT returned once the folder is no longer trusted overall (another file changed)', async () => {
    write(join(cwd, '.claude', 'settings.json'), { statusLine: { type: 'command', command: 'a.sh' } })
    await trust(cwd)
    assert.ok(readTrustedProjectSettings(cwd))
    // Another covered file appears: the folder's digest changes, the settings file is untouched.
    write(join(cwd, '.claude', 'agents', 'new.md'), 'x')
    invalidateFolderTrustCache() // the cache window is up to 2 s; the check itself is what is tested
    assert.equal(readTrustedProjectSettings(cwd), null)
  })

  it('a record whose digest no longer matches the folder is not enough even with a matching file hash', async () => {
    write(join(cwd, '.claude', 'settings.json'), { statusLine: { type: 'command', command: 'a.sh' } })
    await trust(cwd)
    const [rec] = loadFolderTrustRecords()
    // hand-edit the record's digest and files consistently, dropping the digest match with the folder
    const files = [...rec.files, { path: join(cwd, 'phantom'), sha256: 'e'.repeat(64) }]
    const digest = createHash('sha256').update(canonicalJson(files.sort((a, b) => (a.path < b.path ? -1 : 1)))).digest('hex')
    writeFileSync(folderTrustStorePath(), JSON.stringify({ records: [{ ...rec, files, digest }] }))
    invalidateFolderTrustCache()
    assert.equal(readTrustedProjectSettings(cwd), null)
  })
})

describe('caching', () => {
  it('a launch-time scan feeds the cache for display callers, but never reads it', async () => {
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    isFolderTrusted(cwd) // launch decision: uncached
    write(join(cwd, '.mcp.json'), { mcpServers: { x: { command: 'y' } } })
    // a cached display call sees the scan the launch made (stale by one edit)...
    const cached = getFolderTrustState(cwd, { cached: true })
    // ...while a launch decision sees the edit
    const fresh = getFolderTrustState(cwd)
    assert.notEqual(cached.digest, fresh.digest)
  })
})
