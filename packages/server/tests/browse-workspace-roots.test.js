import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createBrowserOps } from '../src/ws-file-ops/browser.js'
import { resolveSessionCwd, validatePathWithinCwd } from '../src/ws-file-ops/common.js'
import { warnIfDefaultCwdDisallowed, validateCwdAllowed } from '../src/handler-utils.js'

// #8303 — Browse must apply the same cwd policy as Create.
describe('Browse honours workspaceRoots and the default cwd (#8303)', () => {
  let root // realpath'd temp dir, outside $HOME on every supported host
  let fakeHome

  function list(requestedPath, policy) {
    const sent = []
    const ops = createBrowserOps(
      (_ws, msg) => sent.push(msg),
      (cwd) => resolveSessionCwd(cwd, new Map(), 60_000),
      (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000),
      policy,
    )
    return ops.listDirectory(null, requestedPath).then(() => {
      assert.equal(sent.length, 1)
      return sent[0]
    })
  }

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-8303-')))
    fakeHome = join(root, 'home')
    mkdirSync(join(fakeHome, '.ssh'), { recursive: true })
    mkdirSync(join(root, 'ws', 'proj-a'), { recursive: true })
    mkdirSync(join(root, 'elsewhere', 'inner'), { recursive: true })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('lists a workspace root outside $HOME and its subdirectories', async () => {
    const config = { workspaceRoots: [join(root, 'ws')] }
    const top = await list(join(root, 'ws'), { getConfig: () => config })
    assert.equal(top.error, null)
    assert.deepEqual(top.entries.map(e => e.name), ['proj-a'])
    const sub = await list(join(root, 'ws', 'proj-a'), { getConfig: () => config })
    assert.equal(sub.error, null)
  })

  // Browse canonicalises with the native realpath (case + 8.3 short names on
  // Windows, case on macOS); the roots and $HOME must be canonicalised the
  // same way or no real path ever matches (Windows runner, #8303). A root
  // spelled in a different case only differs under a case-insensitive FS.
  it('matches a root spelled with different case to the canonical listing path', async (t) => {
    if (!existsSync(join(root, 'WS'))) return t.skip('case-sensitive filesystem')
    const config = { workspaceRoots: [join(root, 'WS')] }
    assert.equal(validateCwdAllowed(join(root, 'ws', 'proj-a'), config), null)
    const sub = await list(join(root, 'ws', 'proj-a'), { getConfig: () => config })
    assert.equal(sub.error, null)
  })

  it('still refuses a directory outside every root and outside $HOME', async () => {
    const config = { workspaceRoots: [join(root, 'ws')] }
    const r = await list(join(root, 'elsewhere'), { getConfig: () => config })
    assert.ok(r.error && /workspace root/.test(r.error), r.error)
    assert.deepEqual(r.entries, [])
  })

  it('lists the default cwd and its subdirectories when it passes the create policy', async () => {
    // Default cwd inside the (home) allowlist: Create accepts it, so Browse must too.
    mkdirSync(join(fakeHome, 'proj', 'sub'), { recursive: true })
    const config = { homeOverride: fakeHome }
    assert.equal(validateCwdAllowed(join(fakeHome, 'proj'), config), null)
    const top = await list(join(fakeHome, 'proj'), { getConfig: () => config })
    assert.equal(top.error, null)
    assert.deepEqual(top.entries.map(e => e.name), ['sub'])
  })

  it('refuses a default cwd that fails the create policy (outside the roots)', async () => {
    const config = { workspaceRoots: [join(root, 'ws')] }
    assert.ok(validateCwdAllowed(join(root, 'elsewhere'), config))
    assert.ok((await list(join(root, 'elsewhere'), { getConfig: () => config })).error)
  })

  it('applies the credential-dir deny-list even inside a workspace root', async () => {
    const config = { homeOverride: fakeHome, workspaceRoots: [root] }
    const r = await list(join(fakeHome, '.ssh'), { getConfig: () => config })
    assert.ok(r.error && /credential/.test(r.error), r.error)
  })

  it('applies the credential-dir deny-list under the home fallback (no roots)', async () => {
    const config = { homeOverride: fakeHome }
    const r = await list(join(fakeHome, '.ssh'), { getConfig: () => config })
    assert.ok(r.error && /credential/.test(r.error), r.error)
  })

  it('refuses a symlink inside a root that points outside every root and $HOME', async () => {
    symlinkSync(join(root, 'elsewhere'), join(root, 'ws', 'escape'))
    const config = { homeOverride: fakeHome, workspaceRoots: [join(root, 'ws')] }
    const r = await list(join(root, 'ws', 'escape'), { getConfig: () => config })
    assert.ok(r.error && /workspace root/.test(r.error), r.error)
    assert.deepEqual(r.entries, [])
  })

  it('answers "not found" for a missing path under a root, a denial for one outside every root', async () => {
    const config = { homeOverride: fakeHome, workspaceRoots: [join(root, 'ws')] }
    const inside = await list(join(root, 'ws', 'missing'), { getConfig: () => config })
    assert.equal(inside.error, 'Directory not found')
    const outside = await list(join(root, 'elsewhere', 'missing'), { getConfig: () => config })
    assert.ok(outside.error && /workspace root/.test(outside.error), outside.error)
  })

  it('an unresolvable path names the workspace roots, not the home directory, when roots are set', async () => {
    writeFileSync(join(root, 'elsewhere', 'file.txt'), 'x')
    const config = { homeOverride: fakeHome, workspaceRoots: [join(root, 'ws')] }
    const r = await list(join(root, 'elsewhere', 'file.txt', 'sub'), { getConfig: () => config })
    assert.ok(r.error && /workspace roots/.test(r.error) && !/home directory/.test(r.error), r.error)
  })

  it('a blank or ~ request with roots excluding $HOME lists the first usable root', async () => {
    const config = { homeOverride: fakeHome, workspaceRoots: [join(root, 'gone'), join(root, 'ws')] }
    for (const req of ['', '~', null]) {
      const r = await list(req, { getConfig: () => config })
      assert.equal(r.error, null, `request ${JSON.stringify(req)}`)
      assert.equal(r.path, join(root, 'ws'))
      assert.deepEqual(r.entries.map(e => e.name), ['proj-a'])
    }
  })

  it('an explicit $HOME request is still refused when roots exclude it', async () => {
    const config = { homeOverride: fakeHome, workspaceRoots: [join(root, 'ws')] }
    const r = await list(realpathSync(homedir()), { getConfig: () => config })
    assert.ok(r.error && /workspace root/.test(r.error), r.error)
    assert.deepEqual(r.entries, [])
  })
})

describe('startup warning for a disallowed configured cwd (#8303)', () => {
  let root
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-8303w-')))
    mkdirSync(join(root, 'ws'))
    mkdirSync(join(root, 'other'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('warns once when config.cwd fails validateCwdAllowed', () => {
    const warns = []
    const msg = warnIfDefaultCwdDisallowed(
      { cwd: join(root, 'other'), workspaceRoots: [join(root, 'ws')] },
      { warn: (m) => warns.push(m) },
    )
    assert.equal(warns.length, 1)
    assert.equal(warns[0], msg)
    assert.ok(warns[0].includes(join(root, 'other')))
  })

  it('is silent when config.cwd passes, or is unset', () => {
    const warns = []
    const logger = { warn: (m) => warns.push(m) }
    assert.equal(warnIfDefaultCwdDisallowed({ cwd: join(root, 'ws'), workspaceRoots: [join(root, 'ws')] }, logger), null)
    assert.equal(warnIfDefaultCwdDisallowed({}, logger), null)
    assert.equal(warns.length, 0)
  })

  it('is wired into daemon startup', () => {
    const src = readFileSync(new URL('../src/server-cli.js', import.meta.url), 'utf8')
    assert.ok(/warnIfDefaultCwdDisallowed\(config\)/.test(src), 'server-cli must call the warning')
  })
})
