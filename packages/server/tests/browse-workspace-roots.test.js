import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-8303-')))
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

  it('denies the credential dir via the default cwd route too', async () => {
    const config = { homeOverride: fakeHome }
    const r = await list(join(fakeHome, '.ssh'), { getConfig: () => config, getDefaultCwd: () => fakeHome })
    assert.ok(r.error)
  })
})

describe('startup warning for a disallowed configured cwd (#8303)', () => {
  let root
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-8303w-')))
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
