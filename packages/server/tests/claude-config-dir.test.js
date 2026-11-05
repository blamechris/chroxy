// #8270 — every claude-data lookup honours CLAUDE_CONFIG_DIR.
//
// claude writes sessions/, projects/, commands/, agents/ and CLAUDE.md under
// $CLAUDE_CONFIG_DIR when it is set. These tests pin that the resolver and each
// read path that used to join homedir()/.claude follow it, that the fallback is
// still ~/.claude, and that odd values cannot move a containment root somewhere
// dangerous.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, sep } from 'node:path'
import { claudeConfigDir, claudeProjectsDir } from '../src/utils/claude-config-dir.js'
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-config-dir-')))
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
    writeFileSync(join(root, 'secret.jsonl'), 'x')
    const sources = [{ provider: 'claude', projectsDir: claudeProjectsDir({ CLAUDE_CONFIG_DIR: root }) }]
    const id = 'aaaaaaaa-1111-2222-3333-444444444444'
    writeFileSync(join(projects, 'p', `${id}.jsonl`), '{}\n')
    const ok = resolveTranscriptSource({ provider: 'claude', conversationId: id, sourceLocator: `p/${id}.jsonl`, sources })
    assert.equal(ok.ok, true)
    for (const bad of ['../secret', `../${id}.jsonl`, `../../${id}.jsonl`, `p/../${id}.jsonl`]) {
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

describe('memory_read honours CLAUDE_CONFIG_DIR (#8270)', () => {
  it('reads the global CLAUDE.md and MEMORY.md from the override and never returns a credentials file there', async () => {
    const { createFileOps } = await import('../src/ws-file-ops/index.js')
    const cfg = join(root, 'cfg')
    const cwd = join(root, 'work')
    mkdirSync(cfg, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cfg, 'CLAUDE.md'), 'global-from-override')
    writeFileSync(join(cfg, '.credentials.json'), '{"token":"s3cret"}')
    const memDir = join(cfg, 'projects', encodeProjectPath(realpathSync(cwd)), 'memory')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'MEMORY.md'), 'memory-from-override')
    writeFileSync(join(cwd, 'CLAUDE.md'), '@' + join(cfg, '.credentials.json'))
    process.env.CLAUDE_CONFIG_DIR = cfg
    const out = []
    await createFileOps((_ws, msg) => out.push(msg)).readMemory({}, cwd)
    const res = out[0]
    assert.equal(res.error, null)
    const global = res.entries.find((e) => e.scope === 'global')
    assert.equal(global.content, 'global-from-override')
    assert.equal(res.memoryFile.content, 'memory-from-override')
    assert.ok(!JSON.stringify(res).includes('s3cret'), 'credentials file under the override is never returned')
  })
})
