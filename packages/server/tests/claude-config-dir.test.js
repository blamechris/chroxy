// #8270 — every claude-data lookup honours CLAUDE_CONFIG_DIR.
//
// claude writes sessions/, projects/, commands/, agents/ and CLAUDE.md under
// $CLAUDE_CONFIG_DIR when it is set. These tests pin that the resolver and each
// read path that used to join homedir()/.claude follow it, that the fallback is
// still ~/.claude, and that odd values cannot move a containment root somewhere
// dangerous.

import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, sep, parse } from 'node:path'
import { claudeConfigDir, claudeProjectsDir, resolveClaudeConfigDirOverride, sanitizeClaudeConfigDirEnv, warnIfClaudeConfigDirUnusable, isFilesystemRoot } from '../src/utils/claude-config-dir.js'
import { buildSpawnEnv, buildClaudeLaunchEnv } from '../src/utils/spawn-env.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
import { resolveJsonlPath, resolveClaudeProjectsDir, encodeProjectPath } from '../src/jsonl-reader.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { CliSession } from '../src/cli-session.js'
import { SdkSession } from '../src/sdk-session.js'
import { transcriptPathForSessionFile } from '../src/transcript-tasks.js'
import { scanConversations, clearScanCache } from '../src/conversation-scanner.js'
import { searchConversations } from '../src/conversation-search.js'
import { resolveTranscriptSource } from '../src/transcript-sources.js'

const REAL_DEFAULT = join(homedir(), '.claude')

let root
let savedEnv

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'claude-config-dir-')))
  savedEnv = process.env.CLAUDE_CONFIG_DIR
  delete process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedEnv
  rmSync(root, { recursive: true, force: true })
})

describe('claudeConfigDir resolver (#8270)', () => {
  it('returns ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
    assert.equal(claudeConfigDir({}), REAL_DEFAULT)
    assert.equal(claudeConfigDir(), REAL_DEFAULT)
  })

  it('returns the override when it is an absolute path', () => {
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: root }), root)
    assert.equal(claudeProjectsDir({ CLAUDE_CONFIG_DIR: root }), join(root, 'projects'))
  })

  it('reads process.env by default', () => {
    process.env.CLAUDE_CONFIG_DIR = root
    assert.equal(claudeConfigDir(), root)
  })

  it('normalises trailing slashes and dot segments', () => {
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: `${root}${sep}` }), root)
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: join(root, 'a', '..', 'b') }), join(root, 'b'))
  })

  for (const [label, value] of [
    ['empty', ''],
    ['whitespace', '   '],
    ['relative', 'claude-config'],
    ['dot', '.'],
    ['tilde (unexpanded)', '~/claude'],
    ['filesystem root', '/'],
    ['root with dot segments', '/a/..'],
    ['NUL byte', `${'/tmp'}/x\0y`],
    ['non-string', 42],
  ]) {
    it(`falls back to ~/.claude for ${label}`, () => {
      assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: value }), REAL_DEFAULT)
    })
  }

  it('falls back when env itself is missing', () => {
    assert.equal(claudeConfigDir(null), REAL_DEFAULT)
    assert.equal(claudeConfigDir(undefined), REAL_DEFAULT)
  })
})

describe('read paths follow CLAUDE_CONFIG_DIR (#8270)', () => {
  it('resolveJsonlPath / resolveClaudeProjectsDir', () => {
    const env = { CLAUDE_CONFIG_DIR: root }
    assert.equal(resolveClaudeProjectsDir(env), join(root, 'projects'))
    assert.equal(
      resolveJsonlPath('/work/repo', 'abc-123', env),
      join(root, 'projects', encodeProjectPath('/work/repo'), 'abc-123.jsonl'),
    )
  })

  it('resolveJsonlPath uses process.env and falls back to ~/.claude', () => {
    assert.equal(resolveJsonlPath('/work/repo', 'abc'), join(REAL_DEFAULT, 'projects', encodeProjectPath('/work/repo'), 'abc.jsonl'))
    process.env.CLAUDE_CONFIG_DIR = root
    assert.ok(resolveJsonlPath('/work/repo', 'abc').startsWith(join(root, 'projects') + sep))
  })

  it('provider dataDir getters follow it (feeds conversation scan + transcript sources)', () => {
    for (const P of [ClaudeTuiSession, CliSession, SdkSession]) {
      assert.equal(P.dataDir, REAL_DEFAULT, `${P.name} default`)
    }
    process.env.CLAUDE_CONFIG_DIR = root
    for (const P of [ClaudeTuiSession, CliSession, SdkSession]) {
      assert.equal(P.dataDir, root, `${P.name} override`)
    }
  })

  it('ClaudeTuiSession.sessionFilePath / resolveSessionFile read <dir>/sessions', () => {
    const env = { CLAUDE_CONFIG_DIR: root }
    assert.equal(ClaudeTuiSession.sessionFilePath(4242, env), join(root, 'sessions', '4242.json'))
    mkdirSync(join(root, 'sessions'), { recursive: true })
    const fast = join(root, 'sessions', '4242.json')
    writeFileSync(fast, JSON.stringify({ sessionId: 'sid-fast', cwd: '/w' }))
    const scan = join(root, 'sessions', '999.json')
    writeFileSync(scan, JSON.stringify({ sessionId: 'sid-scan', cwd: '/w' }))
    assert.equal(ClaudeTuiSession.resolveSessionFile('sid-fast', 4242, { env }), fast)
    assert.equal(ClaudeTuiSession.resolveSessionFile('sid-scan', 1, { env }), scan)
    assert.equal(ClaudeTuiSession.resolveSessionFile('sid-scan', 1, { env, allowDirScan: false }), null)
    // a different (default) config dir must not see them
    assert.equal(ClaudeTuiSession.resolveSessionFile('sid-scan', 1, { env: { CLAUDE_CONFIG_DIR: join(root, 'other') } }), null)
  })

  it('transcriptPathForSessionFile derives the transcript under the same dir', () => {
    const sess = join(root, 'sess.json')
    writeFileSync(sess, JSON.stringify({ sessionId: 'sid-1', cwd: '/work/repo' }))
    assert.equal(
      transcriptPathForSessionFile(sess, { CLAUDE_CONFIG_DIR: root }),
      join(root, 'projects', encodeProjectPath('/work/repo'), 'sid-1.jsonl'),
    )
    assert.equal(
      transcriptPathForSessionFile(sess, {}),
      join(REAL_DEFAULT, 'projects', encodeProjectPath('/work/repo'), 'sid-1.jsonl'),
    )
  })

  it('the TUI session resolves its transcript from its own child env', () => {
    const session = new ClaudeTuiSession({ cwd: root, connectionChildEnv: { CLAUDE_CONFIG_DIR: root } })
    assert.equal(session._claudeEnv().CLAUDE_CONFIG_DIR, root)
    const plain = new ClaudeTuiSession({ cwd: root })
    assert.equal(plain._claudeEnv(), process.env)
  })

  it('conversation scanner and search default to <dir>/projects', async () => {
    const proj = join(root, 'projects', '-tmp-fake-proj')
    mkdirSync(proj, { recursive: true })
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'needle-8270 ' + 'x'.repeat(200) }, cwd: '/tmp/fake-proj', timestamp: '2026-01-01T00:00:00Z' })
    writeFileSync(join(proj, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'), (line + '\n').repeat(3))
    process.env.CLAUDE_CONFIG_DIR = root
    clearScanCache()
    const scanned = await scanConversations({})
    assert.ok(scanned.some((c) => c.conversationId === 'aaaaaaaa-1111-2222-3333-444444444444'), 'scanner found the transcript under CLAUDE_CONFIG_DIR')
    const found = await searchConversations('needle-8270')
    assert.ok(JSON.stringify(found).includes('aaaaaaaa-1111-2222-3333-444444444444'), 'search found it too')
  })
})

describe('containment still holds under an override (#8270)', () => {
  it('a sourceLocator cannot escape the CLAUDE_CONFIG_DIR projects root', () => {
    const projects = join(root, 'projects')
    mkdirSync(join(projects, 'p'), { recursive: true })
    writeFileSync(join(root, 'outside.jsonl'), 'x')
    const sources = [{ provider: 'claude', projectsDir: claudeProjectsDir({ CLAUDE_CONFIG_DIR: root }) }]
    const id = 'aaaaaaaa-1111-2222-3333-444444444444'
    writeFileSync(join(projects, 'p', `${id}.jsonl`), '{}\n')
    const ok = resolveTranscriptSource({ provider: 'claude', conversationId: id, sourceLocator: `p/${id}.jsonl`, sources })
    assert.equal(ok.ok, true)
    for (const bad of ['../outside', `../${id}.jsonl`, `../../${id}.jsonl`, `p/../${id}.jsonl`]) {
      const r = resolveTranscriptSource({ provider: 'claude', conversationId: id, sourceLocator: bad, sources })
      assert.equal(r.ok, false, `refused ${bad}`)
    }
  })

  it('a hostile override cannot root the projects dir at the filesystem root', () => {
    for (const v of ['/', '', '..', '../..']) {
      const dir = claudeProjectsDir({ CLAUDE_CONFIG_DIR: v })
      assert.equal(dir, join(REAL_DEFAULT, 'projects'), `value ${JSON.stringify(v)}`)
    }
  })
})

describe('canonical root and reader/child agreement (#8270 review)', () => {
  it('an alias that resolves to the filesystem root is not accepted', { skip: SKIP_NO_SYMLINK }, () => {
    const fsRoot = parse(root).root
    const alias = join(root, 'alias-to-root')
    symlinkSync(fsRoot, alias, 'dir')
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: alias }), REAL_DEFAULT)
    assert.equal(resolveClaudeConfigDirOverride(alias), null)
    assert.equal(resolveClaudeConfigDirOverride(join(alias, '.')), null)
  })

  it('a link whose target is missing is not accepted', { skip: SKIP_NO_SYMLINK }, () => {
    const missing = join(root, 'no-such-dir')
    const plain = join(root, 'plain-dangling')
    symlinkSync(join(missing, 'sub'), plain, 'dir')
    for (const link of [plain, join(plain, 'a', 'b')]) {
      assert.equal(resolveClaudeConfigDirOverride(link), null, link)
      assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: link }), REAL_DEFAULT)
    }
  })

  it('a link whose text is `<missing>/..` never yields a root or anything above its own directory', { skip: SKIP_NO_SYMLINK }, () => {
    const missing = join(root, 'no-such-dir')
    // Built by concatenation so path.join does not collapse the `..`.
    const dangling = join(root, 'dangling')
    symlinkSync(`${missing}${sep}..`, dangling, 'dir')
    const got = resolveClaudeConfigDirOverride(dangling)
    if (process.platform === 'win32') {
      // Windows resolves the text lexically: the link points at its own parent,
      // which exists. The safety property is what must hold there.
      assert.ok(got === null || (!isFilesystemRoot(got) && (got === root || got.startsWith(root + sep))), `got ${got}`)
    } else {
      assert.equal(got, null)
    }
  })

  it('canonicalises with the native realpath (the one the file-ops roots use)', { skip: SKIP_NO_SYMLINK }, () => {
    const real = join(root, 'parity-real')
    const link = join(root, 'parity-link')
    mkdirSync(real)
    symlinkSync(real, link, 'dir')
    const dir = join(link, 'sub')
    const expected = join(realpathSync.native(link), 'sub')
    assert.equal(resolveClaudeConfigDirOverride(dir), expected)
    // On POSIX the JS and native realpath agree for this input, so also pin the
    // call itself: a regression to the JS implementation (which does not expand
    // Windows 8.3 short names) never calls native.
    const spy = mock.method(realpathSync, 'native')
    try {
      resolveClaudeConfigDirOverride(dir)
      assert.ok(spy.mock.calls.length > 0, 'resolver used realpathSync.native')
    } finally {
      spy.mock.restore()
    }
  })

  it('a symlinked config dir is returned in canonical form', { skip: SKIP_NO_SYMLINK }, () => {
    const real = join(root, 'real-cfg')
    const link = join(root, 'link-cfg')
    mkdirSync(real)
    symlinkSync(real, link, 'dir')
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: link }), real)
  })

  it('an explicit unusable override in the extras wins over a valid parent value', () => {
    process.env.CLAUDE_CONFIG_DIR = root
    assert.equal(Object.hasOwn(buildSpawnEnv('claude', { CLAUDE_CONFIG_DIR: 'rel/cfg' }), 'CLAUDE_CONFIG_DIR'), false)
    assert.equal(buildSpawnEnv('claude', { CLAUDE_CONFIG_DIR: root }).CLAUDE_CONFIG_DIR, root)
    assert.equal(buildSpawnEnv('claude').CLAUDE_CONFIG_DIR, root)
  })

  it('the launch env used by resume and doctor applies the same rule', () => {
    assert.equal(Object.hasOwn(buildClaudeLaunchEnv({ CLAUDE_CONFIG_DIR: ` ${root}` }), 'CLAUDE_CONFIG_DIR'), false)
    assert.equal(buildClaudeLaunchEnv({ CLAUDE_CONFIG_DIR: root }).CLAUDE_CONFIG_DIR, root)
  })

  it('the startup check reports an unusable value and stays quiet for a usable or unset one', () => {
    assert.equal(warnIfClaudeConfigDirUnusable({}), false)
    assert.equal(warnIfClaudeConfigDirUnusable({ CLAUDE_CONFIG_DIR: root }), false)
    assert.equal(warnIfClaudeConfigDirUnusable({ CLAUDE_CONFIG_DIR: 'rel/cfg' }), true)
    const env = { CLAUDE_CONFIG_DIR: 'rel/cfg' }
    warnIfClaudeConfigDirUnusable(env)
    assert.equal(env.CLAUDE_CONFIG_DIR, 'rel/cfg', 'the check does not modify the env')
  })

  it('the child env and the reader agree on every spelling', () => {
    const cases = {
      valid: root,
      relative: 'rel/cfg',
      padded: ` ${root} `,
      root: parse(root).root,
    }
    for (const [label, value] of Object.entries(cases)) {
      const readerDir = claudeConfigDir({ CLAUDE_CONFIG_DIR: value })
      const child = sanitizeClaudeConfigDirEnv({ CLAUDE_CONFIG_DIR: value })
      // What claude would use: the child's variable when present, else ~/.claude.
      const childDir = child.CLAUDE_CONFIG_DIR ?? REAL_DEFAULT
      assert.equal(childDir, readerDir, `${label}: child and reader use the same dir`)
    }
    assert.equal(sanitizeClaudeConfigDirEnv({ CLAUDE_CONFIG_DIR: root }).CLAUDE_CONFIG_DIR, root)
    assert.equal(Object.hasOwn(sanitizeClaudeConfigDirEnv({ CLAUDE_CONFIG_DIR: 'rel/cfg' }), 'CLAUDE_CONFIG_DIR'), false)
  })

  it('buildSpawnEnv for the claude family applies the same rule', () => {
    process.env.CLAUDE_CONFIG_DIR = ` ${root}`
    assert.equal(Object.hasOwn(buildSpawnEnv('claude'), 'CLAUDE_CONFIG_DIR'), false)
    assert.equal(Object.hasOwn(buildSpawnEnv('claude-sdk'), 'CLAUDE_CONFIG_DIR'), false)
    process.env.CLAUDE_CONFIG_DIR = root
    assert.equal(buildSpawnEnv('claude').CLAUDE_CONFIG_DIR, root)
  })

  it('isFilesystemRoot recognises a root and nothing else', () => {
    assert.equal(isFilesystemRoot(parse(root).root), true)
    assert.equal(isFilesystemRoot(root), false)
    assert.equal(isFilesystemRoot(''), false)
    assert.equal(isFilesystemRoot(null), false)
  })

  it('the TUI pty env applies the same rule', () => {
    const bad = new ClaudeTuiSession({ cwd: root, connectionChildEnv: { CLAUDE_CONFIG_DIR: 'rel/cfg' } })
    assert.equal(Object.hasOwn(bad._buildPtyEnv(false), 'CLAUDE_CONFIG_DIR'), false)
    const good = new ClaudeTuiSession({ cwd: root, connectionChildEnv: { CLAUDE_CONFIG_DIR: root } })
    assert.equal(good._buildPtyEnv(false).CLAUDE_CONFIG_DIR, root)
  })
})

describe('memory_read honours CLAUDE_CONFIG_DIR (#8270)', () => {
  it('the MEMORY.md read only follows a markdown target', { skip: SKIP_NO_SYMLINK }, async () => {
    const { createFileOps } = await import('../src/ws-file-ops/index.js')
    const cfg = join(root, 'cfg2')
    const cwd = join(root, 'work2')
    mkdirSync(cfg, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cfg, 'notes.txt'), 'plain-text-target')
    const memDir = join(cfg, 'projects', encodeProjectPath(realpathSync.native(cwd)), 'memory')
    mkdirSync(memDir, { recursive: true })
    symlinkSync(join(cfg, 'notes.txt'), join(memDir, 'MEMORY.md'), 'file')
    process.env.CLAUDE_CONFIG_DIR = cfg
    const out = []
    await createFileOps((_ws, msg) => out.push(msg)).readMemory({}, cwd)
    assert.equal(out[0].memoryFile.skipped, true)
    assert.equal(out[0].memoryFile.content, null)
    assert.ok(!JSON.stringify(out[0]).includes('plain-text-target'))
  })

  it('reads the global CLAUDE.md and MEMORY.md from the override and applies the markdown-only restriction to imports there', async () => {
    const { createFileOps } = await import('../src/ws-file-ops/index.js')
    const cfg = join(root, 'cfg')
    const cwd = join(root, 'work')
    mkdirSync(cfg, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cfg, 'CLAUDE.md'), 'global-from-override')
    writeFileSync(join(cfg, 'not-markdown.json'), '{"token":"non-markdown-body"}')
    const memDir = join(cfg, 'projects', encodeProjectPath(realpathSync.native(cwd)), 'memory')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'MEMORY.md'), 'memory-from-override')
    writeFileSync(join(cwd, 'CLAUDE.md'), '@' + join(cfg, 'not-markdown.json'))
    process.env.CLAUDE_CONFIG_DIR = cfg
    const out = []
    await createFileOps((_ws, msg) => out.push(msg)).readMemory({}, cwd)
    const res = out[0]
    assert.equal(res.error, null)
    const global = res.entries.find((e) => e.scope === 'global')
    assert.equal(global.content, 'global-from-override')
    assert.equal(res.memoryFile.content, 'memory-from-override')
    assert.ok(!JSON.stringify(res).includes('non-markdown-body'), 'non-markdown import under the override is not returned')
  })
})
