import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateCwdAllowed, defaultCwdStartupWarning } from '../src/handler-utils.js'
import { createBrowserOps } from '../src/ws-file-ops/browser.js'
import { resolveSessionCwd, validatePathWithinCwd } from '../src/ws-file-ops/common.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

/**
 * #8303 — Browse (list_directory) honours the same allowlist Create does:
 * $HOME (navigation, unchanged) + config.workspaceRoots + the daemon's
 * configured default cwd when it passes validateCwdAllowed, with the credential
 * deny-list applied on top. Hermetic: a throwaway home via config.homeOverride
 * and a throwaway "outside" tree, nothing under the real home.
 */
describe('list_directory honours workspaceRoots and the default cwd (#8303)', () => {
  let base, home, outside

  function list(requestedPath, config) {
    const sent = []
    const ops = createBrowserOps(
      (_ws, msg) => sent.push(msg),
      (cwd) => resolveSessionCwd(cwd, new Map(), 60_000),
      (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000),
    )
    return ops.listDirectory(null, requestedPath, { homeOverride: home, ...config }).then(() => {
      assert.equal(sent.length, 1, 'exactly one directory_listing reply')
      return sent[0]
    })
  }

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-8303-')))
    home = join(base, 'home')
    outside = join(base, 'outside')
    mkdirSync(join(home, 'proj'), { recursive: true })
    mkdirSync(join(home, '.ssh', 'keys'), { recursive: true })
    mkdirSync(join(outside, 'root', 'sub'), { recursive: true })
    mkdirSync(join(outside, 'root-evil', 'x'), { recursive: true })
    mkdirSync(join(outside, 'other'), { recursive: true })
  })

  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  it('lists $HOME as before, with no config', async () => {
    const r = await list(home, {})
    assert.equal(r.error, null)
    assert.deepEqual(r.entries.map(e => e.name), ['proj'])
  })

  it('lists a workspace root outside $HOME and its subdirectories', async () => {
    const config = { workspaceRoots: [join(outside, 'root')] }
    const top = await list(join(outside, 'root'), config)
    assert.equal(top.error, null)
    assert.deepEqual(top.entries.map(e => e.name), ['sub'])
    const sub = await list(join(outside, 'root', 'sub'), config)
    assert.equal(sub.error, null)
  })

  it('still refuses a directory outside every root and outside $HOME', async () => {
    const r = await list(join(outside, 'other'), { workspaceRoots: [join(outside, 'root')] })
    assert.ok(/^Access denied/.test(r.error), `expected a denial, got ${r.error}`)
    assert.deepEqual(r.entries, [])
  })

  it('refuses a sibling that merely shares the root as a string prefix', async () => {
    const r = await list(join(outside, 'root-evil'), { workspaceRoots: [join(outside, 'root')] })
    assert.ok(/^Access denied/.test(r.error), `sibling-prefix must be refused, got ${r.error}`)
  })

  it('refuses ".." escaping a workspace root', async () => {
    const r = await list(join(outside, 'root', '..', 'other'), { workspaceRoots: [join(outside, 'root')] })
    assert.ok(/^Access denied/.test(r.error), r.error)
  })

  it('refuses outside directories when no root is configured', async () => {
    const r = await list(join(outside, 'root'), {})
    assert.ok(/^Access denied/.test(r.error), r.error)
  })

  it('lists the configured default cwd (outside $HOME) when a root admits it', async () => {
    const config = { workspaceRoots: [join(outside, 'root')], cwd: join(outside, 'root', 'sub') }
    assert.equal(validateCwdAllowed(config.cwd, { homeOverride: home, ...config }), null)
    const r = await list(config.cwd, config)
    assert.equal(r.error, null)
  })

  it('lists the configured default cwd under $HOME', async () => {
    const r = await list(join(home, 'proj'), { cwd: join(home, 'proj') })
    assert.equal(r.error, null)
  })

  it('does not widen to a default cwd that Create would refuse', async () => {
    // Outside $HOME and no root admits it => validateCwdAllowed refuses => not browsable.
    const config = { cwd: join(outside, 'other') }
    assert.ok(validateCwdAllowed(config.cwd, { homeOverride: home, ...config }))
    const r = await list(join(outside, 'other'), config)
    assert.ok(/^Access denied/.test(r.error), r.error)
  })

  it('does not browse siblings of the default cwd', async () => {
    const r = await list(join(outside, 'root'), { cwd: join(outside, 'other') })
    assert.ok(/^Access denied/.test(r.error), r.error)
  })

  it('applies the credential deny-list to Browse: ~/.ssh is refused though under $HOME', async () => {
    const r = await list(join(home, '.ssh'), {})
    assert.ok(/^Access denied/.test(r.error), `~/.ssh must be refused, got ${r.error}`)
    const deep = await list(join(home, '.ssh', 'keys'), {})
    assert.ok(/^Access denied/.test(deep.error), deep.error)
  })

  it('applies the deny-list even when a workspace root contains the credential dir', async () => {
    const r = await list(join(home, '.ssh'), { workspaceRoots: [home] })
    assert.ok(/^Access denied/.test(r.error), r.error)
  })

  it('refuses a symlink under $HOME that points into a credential dir', { skip: SKIP_NO_SYMLINK }, async () => {
    symlinkSync(join(home, '.ssh'), join(home, 'innocent'))
    const r = await list(join(home, 'innocent'), {})
    assert.ok(/^Access denied/.test(r.error), r.error)
  })

  it('refuses a symlink inside a root that points outside every root', { skip: SKIP_NO_SYMLINK }, async () => {
    symlinkSync(join(outside, 'other'), join(outside, 'root', 'escape'))
    const r = await list(join(outside, 'root', 'escape'), { workspaceRoots: [join(outside, 'root')] })
    assert.ok(/^Access denied/.test(r.error), r.error)
  })
})

describe('defaultCwdStartupWarning (#8303)', () => {
  let base, home, outside
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-8303w-')))
    home = join(base, 'home')
    outside = join(base, 'outside')
    mkdirSync(join(home, 'proj'), { recursive: true })
    mkdirSync(outside, { recursive: true })
  })
  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  it('is null when cwd is unset or acceptable', () => {
    assert.equal(defaultCwdStartupWarning({ homeOverride: home }), null)
    assert.equal(defaultCwdStartupWarning({ homeOverride: home, cwd: join(home, 'proj') }), null)
  })

  it('names the directory and the reason when validateCwdAllowed refuses it', () => {
    const w = defaultCwdStartupWarning({ homeOverride: home, cwd: outside })
    assert.ok(typeof w === 'string' && w.includes(outside) && w.includes('home directory'), String(w))
  })

  it('warns for a credential directory default cwd', () => {
    mkdirSync(join(home, '.ssh'), { recursive: true })
    const w = defaultCwdStartupWarning({ homeOverride: home, cwd: join(home, '.ssh') })
    assert.ok(typeof w === 'string' && w.includes('credential'), String(w))
  })
})
