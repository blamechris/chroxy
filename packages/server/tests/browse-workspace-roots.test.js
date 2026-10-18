import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBrowserOps } from '../src/ws-file-ops/browser.js'
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

  function makeOps(config, defaultCwd) {
    const sent = []
    const ops = createBrowserOps(
      (_ws, msg) => sent.push(msg),
      (cwd) => resolveSessionCwd(cwd, new Map(), 60_000),
      (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000),
      { getConfig: () => config, getDefaultCwd: () => defaultCwd },
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
    base = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-test-8303-')))
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
    it('is browsable when it passes validateCwdAllowed', async () => {
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
})
