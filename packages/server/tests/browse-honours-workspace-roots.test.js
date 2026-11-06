import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
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

    // (Paths are built by string concatenation: path.join would collapse `..` itself.)
    // `..` is read as the kernel reads it (through links), the way Create reads
    // it, not collapsed textually. link -> <scratch>/root/sub/deep, so
    // link/.. is root/sub (inside the root) while the TEXTUAL collapse of
    // <scratch>/link/.. is <scratch> (outside every root and home).
    describe('`..` through a symlink', { skip: SKIP_NO_SYMLINK }, () => {
      let link
      beforeEach(() => {
        link = join(scratch, 'link')
        symlinkSync(join(root, 'sub', 'deep'), link)
      })

      it('link/.. resolves through the link: listed like Create accepts it', async () => {
        const p = `${link}/..`
        assert.equal(validateCwdAllowed(p, cfg()), null, 'precondition: Create accepts it')
        const reply = await list(p, { config: cfg() })
        assert.equal(reply.error, null)
        assert.deepEqual(reply.entries.map((e) => e.name), ['deep'])
        assert.equal((await probe(`${link}/../../repo`, { config: cfg() })).isGitRepo, true)
      })

      it('link/../../outside: textually inside nothing, really outside: refused like Create', async () => {
        // really: root/sub/deep -> .. root/sub -> .. root ; so link/../.. is root (accepted)
        // and link/../../.. is <scratch> (refused). Text collapse would give the opposite.
        const accepted = `${link}/../..`
        const refused = `${link}/../../..`
        assert.equal(validateCwdAllowed(accepted, cfg()), null)
        assert.notEqual(validateCwdAllowed(refused, cfg()), null)
        assert.equal((await list(accepted, { config: cfg() })).error, null)
        assert.match((await list(refused, { config: cfg() })).error, /^Access denied/)
      })

      it('a target that exists only under the textual collapse is not listed (Create calls it missing)', async () => {
        // <root>/lk -> <root>/sub/deep. Really: <root>/lk/../repo = <root>/sub/repo (missing).
        // Textually: <root>/repo, which exists and is inside the root.
        symlinkSync(join(root, 'sub', 'deep'), join(root, 'lk'))
        const p = `${root}/lk/../repo`
        assert.notEqual(validateCwdAllowed(p, cfg()), null, 'precondition: Create refuses it (missing)')
        const reply = await list(p, { config: cfg() })
        assert.notEqual(reply.error, null)
        assert.deepEqual(reply.entries, [])
        assert.equal((await probe(p, { config: cfg() })).isGitRepo, null)
      })
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

    it('second layer: if a bound client reached the op it would get no widening (production denies it before dispatch)', async () => {
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
      const denied = await list(outside, { config })
      assert.match(denied.error, /^Access denied/)
      // Roots are configured but none resolves: the wording must not promise them.
      assert.match(denied.error, /any usable workspace roots/)
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
