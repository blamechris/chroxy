import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBrowserOps } from '../src/ws-file-ops/browser.js'
import { browseBoundaries, resolveCwdPolicyHome, resolveWorkspaceRoots, credentialDirDenialReason, validateCwdAllowed } from '../src/handler-utils.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
import { resolveSessionCwd, validatePathWithinCwd } from '../src/ws-file-ops/common.js'

/**
 * Issue 8303 — Browse (`list_directory`) used to be $HOME-only while Create
 * honoured `workspaceRoots`, so a directory Create accepts could answer
 * "Access denied" in Browse. Browse now lists
 *   $HOME  UNION  each configured workspace root  UNION  the daemon's default
 *   cwd (only when it passes validateCwdAllowed),
 * with the SAME credential-dir / config-dir deny-list Create applies.
 *
 * Every directory here is a temp dir and $HOME is a fake one (the
 * `homeOverride` pattern), so nothing touches the real ~/.ssh or ~/.chroxy.
 */
describe('list_directory honours workspaceRoots and the default cwd (issue 8303)', () => {
  let base
  let fakeHome
  let rootA
  let outside
  let configDirEnvBefore

  function makeOps(config, defaultCwd, extra = {}) {
    const sent = []
    const ops = createBrowserOps(
      (_ws, msg) => sent.push(msg),
      (cwd) => resolveSessionCwd(cwd, new Map(), 60_000),
      (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000),
      { getConfig: () => config, getDefaultCwd: () => defaultCwd, ...extra },
    )
    return {
      sent,
      list: async (p) => {
        await ops.listDirectory(null, p)
        assert.equal(sent.length, 1, 'exactly one directory_listing reply')
        return sent.pop()
      },
    }
  }

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-test-8303-')))
    fakeHome = join(base, 'home')
    rootA = join(base, 'rootA')
    outside = join(base, 'outside')
    for (const d of [fakeHome, rootA, join(rootA, 'sub'), join(rootA, 'sub', 'deep'), outside, join(outside, 'child')]) {
      mkdirSync(d, { recursive: true })
    }
    mkdirSync(join(fakeHome, 'proj'))
    mkdirSync(join(fakeHome, '.ssh'))
    mkdirSync(join(fakeHome, 'safe'))
    configDirEnvBefore = process.env.CHROXY_CONFIG_DIR
    // Point the daemon config dir somewhere disposable, never ~/.chroxy.
    process.env.CHROXY_CONFIG_DIR = join(base, 'chroxy-config')
    mkdirSync(process.env.CHROXY_CONFIG_DIR)
  })

  afterEach(() => {
    if (configDirEnvBefore === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = configDirEnvBefore
    rmSync(base, { recursive: true, force: true })
  })

  describe('workspaceRoots', () => {
    it('lists a configured root that lives outside $HOME', async () => {
      const { list } = makeOps({ homeOverride: fakeHome, workspaceRoots: [rootA] })
      const reply = await list(rootA)
      assert.equal(reply.error, null)
      assert.deepEqual(reply.entries.map((e) => e.name), ['sub'])
    })

    it('lists a subdirectory of a configured root', async () => {
      const { list } = makeOps({ homeOverride: fakeHome, workspaceRoots: [rootA] })
      const reply = await list(join(rootA, 'sub'))
      assert.equal(reply.error, null)
      assert.deepEqual(reply.entries.map((e) => e.name), ['deep'])
    })

    it('lists a MISSING path under a configured root as "Directory not found", not a denial', async () => {
      const { list } = makeOps({ homeOverride: fakeHome, workspaceRoots: [rootA] })
      const reply = await list(join(rootA, 'no-such-dir'))
      assert.equal(reply.error, 'Directory not found')
    })

    it('refuses a directory outside every root and outside $HOME', async () => {
      const { list } = makeOps({ homeOverride: fakeHome, workspaceRoots: [rootA] })
      const reply = await list(outside)
      assert.match(reply.error, /^Access denied/)
      assert.deepEqual(reply.entries, [])
    })

    it('refuses a missing path outside every root (no existence oracle)', async () => {
      const { list } = makeOps({ homeOverride: fakeHome, workspaceRoots: [rootA] })
      const reply = await list(join(outside, 'no-such-dir'))
      assert.match(reply.error, /^Access denied/)
    })

    it('keeps $HOME browsable when roots are configured', async () => {
      const { list } = makeOps({ homeOverride: fakeHome, workspaceRoots: [rootA] })
      const reply = await list(fakeHome)
      assert.equal(reply.error, null)
      assert.ok(reply.entries.some((e) => e.name === 'proj'))
    })

    it('with no roots configured, a directory outside $HOME is still refused', async () => {
      const { list } = makeOps({ homeOverride: fakeHome })
      const reply = await list(rootA)
      assert.match(reply.error, /^Access denied/)
    })

    it('the denial text names the roots, not only the home directory', async () => {
      const { list } = makeOps({ homeOverride: fakeHome })
      const reply = await list(outside)
      assert.match(reply.error, /workspace roots/)
    })

    it('a configured root that does not resolve is ignored, not an allow-all', async () => {
      const { list } = makeOps({ homeOverride: fakeHome, workspaceRoots: [join(base, 'stale-root'), rootA] })
      assert.equal((await list(rootA)).error, null)
      assert.match((await list(outside)).error, /^Access denied/)
    })
  })

  describe('default cwd', () => {
    // NOTE: this proves the default cwd is not REFUSED, not that the default-cwd
    // boundary is what admitted it: a default cwd that passes validateCwdAllowed
    // is already inside $HOME or a root, so those admit it too. The boundary
    // entry itself is covered directly by the browseBoundaries cases below.
    it('a default cwd that passes validateCwdAllowed is listable', async () => {
      const { list } = makeOps({ homeOverride: fakeHome, workspaceRoots: [rootA] }, join(rootA, 'sub'))
      const reply = await list(join(rootA, 'sub'))
      assert.equal(reply.error, null)
    })

    it('is refused when outside $HOME and no roots are configured (validateCwdAllowed refuses it)', async () => {
      const { list } = makeOps({ homeOverride: fakeHome }, outside)
      const reply = await list(outside)
      assert.match(reply.error, /^Access denied/)
    })

    it('is refused when validateCwdAllowed refuses it (outside the configured roots)', async () => {
      const { list } = makeOps({ homeOverride: fakeHome, workspaceRoots: [rootA] }, outside)
      const reply = await list(outside)
      assert.match(reply.error, /^Access denied/)
      assert.deepEqual(reply.entries, [])
    })

    it('is refused when it is a credential directory, even though it is inside $HOME', async () => {
      const { list } = makeOps({ homeOverride: fakeHome }, join(fakeHome, '.ssh'))
      const reply = await list(join(fakeHome, '.ssh'))
      assert.match(reply.error, /^Access denied/)
    })
  })

  describe('credential-dir deny-list applies to Browse', () => {
    it('refuses ~/.ssh under the $HOME fallback', async () => {
      const { list } = makeOps({ homeOverride: fakeHome })
      const reply = await list(join(fakeHome, '.ssh'))
      assert.match(reply.error, /^Access denied/)
      assert.deepEqual(reply.entries, [])
    })

    it('refuses ~/.ssh even when a workspace root contains $HOME', async () => {
      const { list } = makeOps({ homeOverride: fakeHome, workspaceRoots: [base] })
      const reply = await list(join(fakeHome, '.ssh'))
      assert.match(reply.error, /^Access denied/)
    })

    it('refuses a MISSING path under a credential dir the same way (no existence oracle)', async () => {
      const { list } = makeOps({ homeOverride: fakeHome })
      const reply = await list(join(fakeHome, '.ssh', 'no-such-dir'))
      assert.match(reply.error, /^Access denied/)
    })

    it('refuses the chroxy config dir, even when a workspace root contains it', async () => {
      const { list } = makeOps({ homeOverride: fakeHome, workspaceRoots: [base] })
      const reply = await list(process.env.CHROXY_CONFIG_DIR)
      assert.match(reply.error, /^Access denied/)
    })

    it('still lists an ordinary directory under $HOME', async () => {
      const { list } = makeOps({ homeOverride: fakeHome })
      const reply = await list(join(fakeHome, 'safe'))
      assert.equal(reply.error, null)
    })
  })

  describe('an unresolvable path under a denied directory gives the same answer as a missing one', { skip: SKIP_NO_SYMLINK }, () => {
    // Existence oracle: `<denied>/<existing-file>/x` fails realpath with ENOTDIR
    // while `<denied>/<missing>/x` fails with ENOENT. Both must answer the plain
    // denial, including when the denied directory is only reachable through a
    // symlink (a symlinked $HOME, or a link inside home pointing into ~/.ssh).
    it('symlinked $HOME: ~/.ssh/<file>/x and ~/.ssh/<missing>/x answer identically', async () => {
      const realHome = join(base, 'real-home')
      mkdirSync(join(realHome, '.ssh'), { recursive: true })
      writeFileSync(join(realHome, '.ssh', 'id_ed25519'), 'k')
      const linkHome = join(base, 'home-link')
      symlinkSync(realHome, linkHome)
      const { list } = makeOps({ homeOverride: linkHome })
      const present = await list(join(linkHome, '.ssh', 'id_ed25519', 'x'))
      const absent = await list(join(linkHome, '.ssh', 'id_rsa', 'x'))
      assert.match(present.error, /^Access denied/)
      assert.equal(present.error, absent.error)
    })

    it('a link inside home pointing into ~/.ssh: <link>/<file>/x and <link>/<missing>/x answer identically', async () => {
      mkdirSync(join(fakeHome, '.ssh'), { recursive: true })
      writeFileSync(join(fakeHome, '.ssh', 'id_ed25519'), 'k')
      symlinkSync(join(fakeHome, '.ssh'), join(fakeHome, 'sneaky'))
      const { list } = makeOps({ homeOverride: fakeHome })
      const present = await list(join(fakeHome, 'sneaky', 'id_ed25519', 'x'))
      const absent = await list(join(fakeHome, 'sneaky', 'nope', 'x'))
      assert.match(present.error, /^Access denied/)
      assert.equal(present.error, absent.error)
    })

    // Windows reports ENOENT, not ENOTDIR, for `<file>/x`, so the specific reason this
    // contrasts against does not exist there.
    it('CONTRAST: the same unresolvable shape outside any denied directory keeps its specific reason', { skip: process.platform === 'win32' }, async () => {
      writeFileSync(join(fakeHome, 'plain-file'), 'x')
      const { list } = makeOps({ homeOverride: fakeHome })
      const reply = await list(join(fakeHome, 'plain-file', 'x'))
      assert.equal(reply.error, 'Not a directory')
    })
  })

  describe('browseBoundaries resolves the default cwd once', () => {
    it('validates and returns the exact path it resolved, even if the resolver would answer differently next time', () => {
      const inside = join(fakeHome, 'proj')
      const dc = join(fakeHome, 'proj-link')
      if (!SKIP_NO_SYMLINK) symlinkSync(inside, dc)
      const given = SKIP_NO_SYMLINK ? inside : dc
      let calls = 0
      const flipping = (p) => {
        if (p !== given) return realpathSync.native(p)
        calls++
        // First answer is the validated, in-home directory; any later answer
        // for the same input would be an unvalidated one outside it.
        return calls === 1 ? realpathSync.native(inside) : outside
      }
      const bounds = browseBoundaries({ homeOverride: fakeHome }, given, { realpath: flipping })
      assert.equal(calls, 1, 'the default cwd must be resolved exactly once')
      assert.ok(bounds.includes(realpathSync.native(inside)), 'the validated resolution is a boundary')
      assert.ok(!bounds.includes(outside), 'an unvalidated resolution must never become a boundary')
    })

    it('does not add a default cwd that validateCwdAllowed refuses', () => {
      const bounds = browseBoundaries({ homeOverride: fakeHome }, join(fakeHome, '.ssh'))
      assert.ok(!bounds.includes(join(fakeHome, '.ssh')))
    })

    it('adds a default cwd that validateCwdAllowed accepts', () => {
      const bounds = browseBoundaries({ homeOverride: fakeHome }, join(fakeHome, 'proj'))
      assert.ok(bounds.includes(join(fakeHome, 'proj')))
    })
  })

  describe('boundaries are resolved with the same resolver as the target', () => {
    // On Windows the async realpath (libuv) expands 8.3 short names such as
    // RUNNER~1 while the JS realpathSync leaves them as given, so a boundary
    // resolved the JS way never contains a target resolved the native way and
    // every listing was refused. Browse resolves both with the native resolver;
    // these cases prove the resolver is the one threaded through, whatever the
    // platform.
    function tagged() {
      const seen = []
      const fn = (p) => { seen.push(p); return realpathSync.native(p) }
      fn.seen = seen
      return fn
    }

    it('resolveCwdPolicyHome / resolveWorkspaceRoots / credentialDirDenialReason use the injected resolver', () => {
      const r = tagged()
      resolveCwdPolicyHome({ homeOverride: fakeHome }, r)
      resolveWorkspaceRoots({ workspaceRoots: [rootA] }, r)
      assert.deepEqual(r.seen, [fakeHome, rootA])
      const r2 = tagged()
      credentialDirDenialReason(join(fakeHome, 'safe'), realpathSync.native(fakeHome), r2)
      assert.deepEqual(r2.seen, [process.env.CHROXY_CONFIG_DIR], 'the config-dir block resolves the config dir with it too')
    })

    it('validateCwdAllowed uses the injected resolver for the path, home, roots and config dir', () => {
      const r = tagged()
      assert.equal(validateCwdAllowed(join(fakeHome, 'safe'), { homeOverride: fakeHome, workspaceRoots: [rootA] }, { realpath: r }), 'Directory is not within any configured workspace root (1 configured)')
      for (const p of [join(fakeHome, 'safe'), fakeHome, rootA, process.env.CHROXY_CONFIG_DIR]) {
        assert.ok(r.seen.includes(p), `resolved ${p} with the injected resolver`)
      }
    })

    it('Browse resolves home, roots and the default cwd with the injected resolver', async () => {
      const r = tagged()
      const { list } = makeOps({ homeOverride: fakeHome, workspaceRoots: [rootA] }, join(rootA, 'sub'), { realpath: r })
      const reply = await list(join(rootA, 'sub'))
      assert.equal(reply.error, null)
      for (const p of [fakeHome, rootA, join(rootA, 'sub')]) {
        assert.ok(r.seen.includes(p), `resolved ${p} with the injected resolver`)
      }
    })

    it('by default Browse resolves its boundaries with realpathSync.native (the resolver the listed path gets)', async () => {
      const nativeSpy = mock.method(realpathSync, 'native', realpathSync.native)
      try {
        const { list } = makeOps({ homeOverride: fakeHome, workspaceRoots: [rootA] })
        assert.equal((await list(join(rootA, 'sub'))).error, null)
        const resolved = nativeSpy.mock.calls.map((c) => c.arguments[0])
        assert.ok(resolved.includes(fakeHome), 'home was resolved natively')
        assert.ok(resolved.includes(rootA), 'the workspace root was resolved natively')
      } finally {
        nativeSpy.mock.restore()
      }
    })

    it('a boundary spelled differently from the target (as 8.3 short vs long names are) still admits it', async () => {
      // The injected resolver canonicalises a "short" spelling of the root to
      // its real path, exactly as libuv does for RUNNER~1 -> runneradmin. A
      // resolver that leaves the configured spelling alone would never match.
      const alias = join(base, 'ROOTA-SHORT')
      const canonical = (p) => (p === alias ? realpathSync.native(rootA) : realpathSync.native(p))
      const { list } = makeOps({ homeOverride: fakeHome, workspaceRoots: [alias] }, null, { realpath: canonical })
      const reply = await list(join(rootA, 'sub'))
      assert.equal(reply.error, null)
    })
  })
})
