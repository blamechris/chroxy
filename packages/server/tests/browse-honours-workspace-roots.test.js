import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { fileHandlers } from '../src/handlers/file-handlers.js'
import { validateCwdAllowed, defaultCwdAdvisory } from '../src/handler-utils.js'
import { GIT } from '../src/git.js'

/**
 * #8303 — Browse (`list_directory`, `check_git_repo`) and New Session's cwd check
 * must answer from one rule. HOME is a scratch directory so nothing reads the
 * developer's real home; the workspace root lives in a different scratch
 * directory outside it.
 */
describe('Browse honours workspaceRoots (#8303)', () => {
  let scratch, home, root, outside, savedHome, savedCfg

  async function run(handlerName, msg, { config, bound = false } = {}) {
    const sent = []
    const fileOps = createFileOps((_ws, m) => sent.push(m))
    const ctx = { services: { fileOps, config } }
    const client = bound ? { id: 'c', boundSessionId: 'sess-1' } : { id: 'c', boundSessionId: null }
    fileHandlers[handlerName]({}, client, msg, ctx)
    // the handlers fire-and-forget the async op; wait for the single reply
    for (let i = 0; i < 300 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(sent.length, 1, 'exactly one reply')
    return sent[0]
  }
  const list = (path, opts) => run('list_directory', { path }, opts)
  const probe = (path, opts) => run('check_git_repo', { path, requestId: 'r' }, opts)

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-8303-')))
    home = join(scratch, 'home')
    root = join(scratch, 'root')
    outside = join(scratch, 'outside')
    for (const d of [home, join(home, 'proj'), join(root, 'sub', 'deep'), join(root, 'repo'), outside, join(outside, 'x')]) {
      mkdirSync(d, { recursive: true })
    }
    execFileSync(GIT, ['init', '-q', join(root, 'repo')])
    execFileSync(GIT, ['init', '-q', join(outside, 'x')])
    savedHome = process.env.HOME
    savedCfg = process.env.CHROXY_CONFIG_DIR
    process.env.HOME = home
    delete process.env.CHROXY_CONFIG_DIR
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedCfg === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = savedCfg
    rmSync(scratch, { recursive: true, force: true })
  })

  describe('with workspaceRoots configured', () => {
    const cfg = () => ({ workspaceRoots: [root] })

    it('lists a root and its subdirectories', async () => {
      const top = await list(root, { config: cfg() })
      assert.equal(top.error, null)
      assert.deepEqual(top.entries.map((e) => e.name), ['repo', 'sub'])
      const deep = await list(join(root, 'sub'), { config: cfg() })
      assert.equal(deep.error, null)
      assert.deepEqual(deep.entries.map((e) => e.name), ['deep'])
    })

    it('still refuses a directory outside every root and outside home', async () => {
      const reply = await list(outside, { config: cfg() })
      assert.match(reply.error, /^Access denied/)
      assert.deepEqual(reply.entries, [])
    })

    it('still lists home (unchanged)', async () => {
      const reply = await list(home, { config: cfg() })
      assert.equal(reply.error, null)
      assert.deepEqual(reply.entries.map((e) => e.name), ['proj'])
    })

    it('agrees with validateCwdAllowed for every directory outside home (one rule)', async () => {
      for (const p of [root, join(root, 'sub'), join(root, 'sub', 'deep'), outside, join(outside, 'x'), scratch]) {
        const accepted = validateCwdAllowed(p, cfg()) === null
        const reply = await list(p, { config: cfg() })
        assert.equal(reply.error === null, accepted, `${p}: Browse and Create disagree`)
      }
    })

    it('a credential/config directory inside a root stays refused', async () => {
      const cfgDir = join(root, 'cfg')
      mkdirSync(cfgDir)
      process.env.CHROXY_CONFIG_DIR = cfgDir
      assert.notEqual(validateCwdAllowed(cfgDir, cfg()), null, 'precondition: Create refuses it')
      const reply = await list(cfgDir, { config: cfg() })
      assert.match(reply.error, /^Access denied/)
      assert.deepEqual(reply.entries, [])
    })

    it('a session-bound client gets no widening: roots are not browsable to it', async () => {
      const reply = await list(root, { config: cfg(), bound: true })
      assert.match(reply.error, /restricted to the home directory$/)
      assert.deepEqual(reply.entries, [])
    })

    it('a missing path inside a root is refused, not "not found" (no oracle)', async () => {
      const reply = await list(join(root, 'nope'), { config: cfg() })
      assert.match(reply.error, /^Access denied/)
    })

    it('check_git_repo judges a root directory and answers null outside it', async () => {
      assert.equal((await probe(join(root, 'repo'), { config: cfg() })).isGitRepo, true)
      assert.equal((await probe(join(outside, 'x'), { config: cfg() })).isGitRepo, null)
    })
  })

  describe('with no workspaceRoots (behaviour unchanged)', () => {
    it('refuses outside home and lists inside it', async () => {
      for (const config of [undefined, {}, { workspaceRoots: [] }]) {
        assert.match((await list(outside, { config })).error, /^Access denied.*home directory$/)
        assert.equal((await list(home, { config })).error, null)
      }
    })

    it('check_git_repo outside home stays null', async () => {
      assert.equal((await probe(join(outside, 'x'), { config: {} })).isGitRepo, null)
    })

    it('roots that all fail to resolve fall back to home, like Create', async () => {
      const config = { workspaceRoots: [join(scratch, 'gone')] }
      assert.notEqual(validateCwdAllowed(outside, config), null)
      assert.match((await list(outside, { config })).error, /^Access denied/)
      assert.equal((await list(home, { config })).error, null)
    })
  })

  describe('default cwd advisory', () => {
    it('is silent when the directory passes the New Session check', () => {
      assert.equal(defaultCwdAdvisory(join(home, 'proj'), {}), null)
      assert.equal(defaultCwdAdvisory(join(root, 'sub'), { workspaceRoots: [root] }), null)
    })

    it('warns when a blank cwd would inherit a directory Create refuses', () => {
      const w = defaultCwdAdvisory(outside, {})
      assert.match(w, /Default working directory .* fails the same check/)
      assert.match(w, /home directory/)
      assert.match(defaultCwdAdvisory(outside, { workspaceRoots: [root] }), /workspace root/)
    })
  })
})
