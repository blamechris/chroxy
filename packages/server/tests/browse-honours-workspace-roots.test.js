import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { isDirectoryListingDenial, DIRECTORY_LISTING_DENIED_PREFIX } from '@chroxy/protocol'
import { ListDirectorySchema, ServerDirectoryListingSchema } from '@chroxy/protocol/schemas'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { fileHandlers } from '../src/handlers/file-handlers.js'
import { validateCwdAllowed, defaultCwdAdvisory } from '../src/handler-utils.js'
import { GIT } from '../src/git.js'

// A path below a regular file is ENOTDIR on POSIX; Windows reports it as ENOENT.
const BELOW_A_FILE = process.platform === 'win32' ? /^(Not a directory|Directory not found)$/ : /^Not a directory$/

/**
 * #8303 — Browse (`list_directory`, `check_git_repo`) and New Session's cwd check
 * must answer from one rule. HOME is a scratch directory so nothing reads the
 * developer's real home; the workspace root lives in a different scratch
 * directory outside it.
 */
describe('Browse honours workspaceRoots (#8303)', () => {
  let scratch, home, root, outside, savedHome, savedProfile, savedCfg

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
    // .native expands Windows 8.3 short names (the CI runner's tmpdir uses them), like fs/promises realpath does
    scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-8303-')))
    home = join(scratch, 'home')
    root = join(scratch, 'root')
    outside = join(scratch, 'outside')
    for (const d of [home, join(home, 'proj'), join(root, 'sub', 'deep'), join(root, 'repo'), outside, join(outside, 'x')]) {
      mkdirSync(d, { recursive: true })
    }
    execFileSync(GIT, ['init', '-q', join(root, 'repo')])
    execFileSync(GIT, ['init', '-q', join(outside, 'x')])
    savedHome = process.env.HOME
    savedProfile = process.env.USERPROFILE
    savedCfg = process.env.CHROXY_CONFIG_DIR
    // os.homedir() reads HOME on POSIX but USERPROFILE on Windows; without the
    // latter the real profile is home and a tmpdir fixture is INSIDE it.
    process.env.HOME = home
    process.env.USERPROFILE = home
    delete process.env.CHROXY_CONFIG_DIR
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedProfile
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
    // `..` is read the way the platform reads it, which is also how Create reads it:
    // POSIX resolves it through the link before it, Win32 collapses it textually
    // before the filesystem sees the path. So the property asserted on every
    // platform is AGREEMENT with Create; the POSIX-only cells then pin the
    // through-the-link results. link -> <scratch>/root/sub/deep.
    describe('`..` through a symlink', { skip: SKIP_NO_SYMLINK }, () => {
      const POSIX = process.platform !== 'win32'
      let link

      /** Browse must answer what Create answers for `p` (inside-root targets: missing is "not found"). */
      async function assertAgreesWithCreate(p) {
        const create = validateCwdAllowed(p, cfg())
        const reply = await list(p, { config: cfg() })
        if (create === null) assert.equal(reply.error, null, `${p}: Create accepts, Browse says ${reply.error}`)
        else if (/does not exist/.test(create)) assert.equal(reply.error, 'Directory not found', `${p}: Create says missing`)
        else assert.match(reply.error, /^Access denied/, `${p}: Create refuses (${create})`)
        return { create, reply }
      }

      beforeEach(() => {
        link = join(scratch, 'link')
        symlinkSync(join(root, 'sub', 'deep'), link)
      })

      it('link/.. , link/../.. , link/../../..: Browse agrees with Create on every platform', async () => {
        for (const p of [`${link}/..`, `${link}/../..`, `${link}/../../..`]) await assertAgreesWithCreate(p)
        assert.equal((await probe(`${link}/../../repo`, { config: cfg() })).isGitRepo,
          validateCwdAllowed(`${link}/../../repo`, cfg()) === null ? true : null)
      })

      it('POSIX: link/.. resolves through the link (root/sub), link/../.. is root, link/../../.. is outside', { skip: !POSIX && 'Win32 collapses `..` textually; agreement is asserted above' }, async () => {
        const up1 = await list(`${link}/..`, { config: cfg() })
        assert.equal(up1.error, null)
        assert.deepEqual(up1.entries.map((e) => e.name), ['deep'])
        assert.equal((await list(`${link}/../..`, { config: cfg() })).error, null)
        assert.match((await list(`${link}/../../..`, { config: cfg() })).error, /^Access denied/)
      })

      it('a target that exists only under the textual collapse: Browse agrees with Create', async () => {
        // <root>/lk -> <root>/sub/deep. POSIX: <root>/lk/../repo = <root>/sub/repo (missing);
        // textually (and on Win32): <root>/repo, which exists inside the root.
        symlinkSync(join(root, 'sub', 'deep'), join(root, 'lk'))
        const p = `${root}/lk/../repo`
        const { create, reply } = await assertAgreesWithCreate(p)
        assert.deepEqual(reply.entries, []) // listed (an empty repo) or refused: never another directory's entries
        assert.equal((await probe(p, { config: cfg() })).isGitRepo, create === null ? true : null)
        if (POSIX) assert.notEqual(create, null, 'precondition: on POSIX Create calls it missing')
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

    it('a missing path inside a root is "not found" (nothing about an allowed area is hidden)', async () => {
      const reply = await list(join(root, 'nope'), { config: cfg() })
      assert.equal(reply.error, 'Directory not found')
      assert.deepEqual((await list(join(root, 'nope', 'deeper'), { config: cfg() })).error, 'Directory not found')
    })

    it('a missing path below a credential/config directory in a root stays denied', async () => {
      const cfgDir = join(root, 'cfg')
      mkdirSync(cfgDir)
      process.env.CHROXY_CONFIG_DIR = cfgDir
      assert.match((await list(join(cfgDir, 'missing'), { config: cfg() })).error, /^Access denied/)
    })

    it('a missing path outside every root is the same denial as an existing one', async () => {
      const a = await list(join(outside, 'nope'), { config: cfg() })
      const b = await list(join(outside, 'x'), { config: cfg() })
      assert.equal(a.error, b.error)
      assert.match(a.error, /^Access denied/)
    })

    it('check_git_repo judges a root directory and answers null outside it', async () => {
      assert.equal((await probe(join(root, 'repo'), { config: cfg() })).isGitRepo, true)
      assert.equal((await probe(join(outside, 'x'), { config: cfg() })).isGitRepo, null)
    })
  })

  describe('outside targets answer identically whether or not they exist (no oracle)', { skip: SKIP_NO_SYMLINK }, () => {
    const cfgs = [['no roots', () => undefined], ['roots elsewhere', () => ({ workspaceRoots: [root] })]]

    for (const [label, mk] of cfgs) {
      it(`${label}: link/../candidate, tilde forms, trailing slashes, a file as ancestor`, async () => {
        // home/link -> outside/deep ; outside/candidate exists, outside/absent does not
        mkdirSync(join(outside, 'deep'))
        mkdirSync(join(outside, 'candidate'))
        writeFileSync(join(outside, 'afile'), 'x')
        symlinkSync(join(outside, 'deep'), join(home, 'link'))
        const config = mk()
        // [present, absent, viaLink]. A path through the link is outside only where
        // `..` goes through links (POSIX); on Win32 it collapses to a path inside
        // home, where "not found" for both is the equal answer.
        const pairs = [
          [`${home}/link/../candidate`, `${home}/link/../absent`, true],
          [`~/link/../candidate`, `~/link/../absent`, true],
          [`~//link/../candidate/`, `~//link/../absent/`, true],
          [`${home}/link/../candidate/sub`, `${home}/link/../absent/sub`, true],
          [`${outside}/afile/x`, `${outside}/nofile/x`, false],
          [`${outside}/afile`, `${outside}/nofile`, false],
          [`${outside}/candidate//`, `${outside}/absent//`, false],
        ]
        for (const [present, absent, viaLink] of pairs) {
          const a = await list(present, { config })
          const b = await list(absent, { config })
          assert.equal(a.error, b.error, `${present} vs ${absent} differ`)
          assert.deepEqual(a.entries, [])
          if (viaLink && process.platform === 'win32') continue // collapses to an inside-home path
          assert.match(a.error, /^Access denied/, `${present}: ${a.error}`)
          assert.equal(a.parentPath, null)
        }
      })
    }

    it('inside home, a missing target (even through a link that stays inside) is still "not found"', async () => {
      mkdirSync(join(home, 'real'))
      symlinkSync(join(home, 'real'), join(home, 'inlink'))
      assert.equal((await list(`${home}/inlink/../absent`, {})).error, 'Directory not found')
      writeFileSync(join(home, 'afile'), 'x')
      assert.match((await list(`${home}/afile/x`, {})).error, BELOW_A_FILE)
    })
  })

  describe('listing identity and one tilde rule', () => {
    it('with a `..` the reply names the directory actually listed, and its parent navigates up', async () => {
      const cfg = { workspaceRoots: [root] }
      const reply = await list(`${root}/sub/deep/..`, { config: cfg })
      assert.equal(reply.error, null)
      assert.equal(reply.path, join(root, 'sub'))
      assert.equal(reply.parentPath, root)
      assert.deepEqual(reply.entries.map((e) => e.name), ['deep'])
      const up = await list(reply.parentPath, { config: cfg })
      assert.equal(up.error, null)
      assert.equal(up.path, root)
      assert.equal(up.parentPath, scratch)
    })

    it('a `..` through a symlink reports the directory actually listed (where Create accepts it)', { skip: SKIP_NO_SYMLINK }, async () => {
      // <scratch>/lk -> <root>/sub/deep. POSIX: lk/.. is <root>/sub. Win32 collapses it
      // textually to <scratch>, which Create refuses, so Browse must refuse it too.
      symlinkSync(join(root, 'sub', 'deep'), join(scratch, 'lk'))
      const p = `${scratch}/lk/..`
      const config = { workspaceRoots: [root] }
      const reply = await list(p, { config })
      if (validateCwdAllowed(p, config) === null) {
        assert.equal(reply.error, null)
        assert.equal(reply.path, join(root, 'sub'))
        assert.equal(reply.parentPath, root)
      } else {
        assert.match(reply.error, /^Access denied/)
      }
    })

    it('a file, or a path below one, inside a root is not mistaken for a path outside it', async () => {
      writeFileSync(join(root, 'afile'), 'x')
      const cfg = { workspaceRoots: [root] }
      assert.equal((await list(join(root, 'afile'), { config: cfg })).error, 'Not a directory')
      assert.match((await list(`${root}/afile/x`, { config: cfg })).error, BELOW_A_FILE)
    })

    it('a plain path echoes as typed and its parent is the lexical parent (home included)', async () => {
      const reply = await list(home, {})
      assert.equal(reply.path, home)
      assert.equal(reply.parentPath, scratch)
      assert.equal((await list(`~`, {})).path, home)
    })

    it('`~//x` means <home>/x for list_directory and check_git_repo alike', async () => {
      execFileSync(GIT, ['init', '-q', join(home, 'proj')])
      assert.equal((await list('~//proj', {})).error, null)
      assert.equal((await probe('~//proj', {})).isGitRepo, true)
      assert.equal((await probe('~/proj', {})).isGitRepo, true)
      assert.equal((await list('~///', {})).path, home)
    })

    it('with bound unset and a config present nothing outside home is listed (fails safe)', async () => {
      const sent = []
      const ops = createFileOps((_ws, m) => sent.push(m))
      await ops.listDirectory({}, root, { config: { workspaceRoots: [root] } })
      assert.match(sent[0].error, /^Access denied/)
      await ops.listDirectory({}, root, { config: { workspaceRoots: [root] }, bound: false })
      assert.equal(sent[1].error, null)
      await ops.listDirectory({}, root, { config: { workspaceRoots: [root] }, bound: true })
      assert.match(sent[2].error, /^Access denied/)
    })

    it('`~\\x` (a backslash after the tilde) is read by the same rule, for both operations', async () => {
      mkdirSync(join(home, 'bs'))
      execFileSync(GIT, ['init', '-q', join(home, 'bs')])
      assert.equal((await list('~\\bs', {})).error, null)
      assert.equal((await probe('~\\bs', {})).isGitRepo, true)
    })

    it('the server refusal text carries the shared protocol prefix', async () => {
      assert.ok((await list(outside, {})).error.startsWith(`${DIRECTORY_LISTING_DENIED_PREFIX}: `))
      assert.equal(isDirectoryListingDenial((await list(outside, {})).error), true)
      assert.equal(isDirectoryListingDenial('Directory not found'), false)
      assert.equal(isDirectoryListingDenial(null), false)
    })
  })

  describe('list_directory request id (#8303)', () => {
    function twoClients() {
      const sent = []
      const ops = createFileOps((ws, m) => sent.push({ to: ws.name, m }))
      return { sent, ops, a: { name: 'A' }, b: { name: 'B' } }
    }

    it('is echoed on every kind of reply, to the requester only', async () => {
      const { sent, ops, a, b } = twoClients()
      await ops.listDirectory(a, home, { requestId: 'rid-1' }) // listing
      await ops.listDirectory(a, outside, { requestId: 'rid-2' }) // refusal
      await ops.listDirectory(a, join(home, 'missing'), { requestId: 'rid-3' }) // not found
      await ops.listDirectory(b, home, {}) // another client, no id
      assert.deepEqual(sent.map((x) => [x.to, x.m.requestId]), [['A', 'rid-1'], ['A', 'rid-2'], ['A', 'rid-3'], ['B', undefined]])
      assert.equal(sent[0].m.error, null)
      assert.match(sent[1].m.error, /^Access denied/)
      assert.equal(sent[2].m.error, 'Directory not found')
    })

    it('without an id the reply is exactly as before (no requestId key)', async () => {
      const { sent, ops, a } = twoClients()
      await ops.listDirectory(a, home, {})
      await ops.listDirectory(a, outside, {})
      for (const { m } of sent) assert.equal('requestId' in m, false)
      assert.deepEqual(Object.keys(sent[0].m).sort(), ['entries', 'error', 'parentPath', 'path', 'type'])
    })

    it('a malformed id is never echoed', async () => {
      const { sent, ops, a } = twoClients()
      for (const bad of [42, {}, '', 'x'.repeat(129)]) await ops.listDirectory(a, home, { requestId: bad })
      for (const { m } of sent) assert.equal('requestId' in m, false)
    })

    it('the handler forwards the id from the message', async () => {
      const sent = []
      const fileOps = createFileOps((_ws, m) => sent.push(m))
      fileHandlers.list_directory({}, { id: 'c', boundSessionId: null }, { type: 'list_directory', path: home, requestId: 'h-1' }, { services: { fileOps, config: {} } })
      for (let i = 0; i < 300 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
      assert.equal(sent[0].requestId, 'h-1')
    })

    it('the schemas bound the id: over 128 characters or a non-string is refused', () => {
      assert.ok(ListDirectorySchema.safeParse({ type: 'list_directory', path: '/a', requestId: 'r'.repeat(128) }).success)
      assert.ok(!ListDirectorySchema.safeParse({ type: 'list_directory', path: '/a', requestId: 'r'.repeat(129) }).success)
      assert.ok(!ListDirectorySchema.safeParse({ type: 'list_directory', path: '/a', requestId: 7 }).success)
      assert.ok(ListDirectorySchema.safeParse({ type: 'list_directory', path: '/a' }).success)
      const reply = { type: 'directory_listing', path: '/a', parentPath: null, entries: [], error: null }
      assert.ok(ServerDirectoryListingSchema.safeParse(reply).success)
      assert.ok(ServerDirectoryListingSchema.safeParse({ ...reply, requestId: 'r' }).success)
      assert.ok(!ServerDirectoryListingSchema.safeParse({ ...reply, requestId: 'r'.repeat(129) }).success)
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
