import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PermissionManager } from '../src/permission-manager.js'
import { evaluateHookFloorRequest } from '../src/ws-permissions.js'
import { collectChangeTargets, effectiveSearchRoot } from '../src/permission-floor.js'

/**
 * A search call is judged from the directory it really searches (`path`, else the
 * session cwd), and a patch call needs a complete change list. Temp fixtures only.
 */

const silentLog = { info() {}, warn() {} }
let sandbox, home, project, sessionsDir, savedEnv

before(() => {
  sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'floor-effective-root-')))
  home = join(sandbox, 'home')
  project = join(home, 'work', 'project')
  sessionsDir = join(home, '.claude', 'sessions')
  mkdirSync(project, { recursive: true })
  mkdirSync(sessionsDir, { recursive: true })
})
after(() => rmSync(sandbox, { recursive: true, force: true }))
beforeEach(() => {
  savedEnv = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  delete process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = home
  process.env.USERPROFILE = home
})
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

async function prompts(tool, input, mode, cwd) {
  const pm = new PermissionManager({ log: silentLog, cwd })
  const events = []
  pm.on('permission_request', (d) => events.push(d))
  const p = pm.handlePermission(tool, input, null, mode)
  const prompted = events.length === 1
  if (prompted) pm.respondToPermission(events[0].requestId, 'deny')
  await p
  pm.destroy()
  return prompted
}
const hookFloors = (tool, input, cwd) => evaluateHookFloorRequest({ tool_name: tool, tool_input: input }, cwd).floor
async function assertBoth(tool, input, expected, label, cwd = project) {
  for (const mode of ['auto', 'acceptEdits']) {
    assert.equal(await prompts(tool, input, mode, cwd), expected, `${label}: ${tool} in-process ${mode}`)
  }
  assert.equal(hookFloors(tool, input, cwd), expected, `${label}: ${tool} hook`)
}

describe('search calls are judged from their effective root', () => {
  it('effectiveSearchRoot is `path`, else the cwd marker, else unusable', () => {
    assert.equal(effectiveSearchRoot({ path: 'src', file_path: 'x' }), 'src')
    assert.equal(effectiveSearchRoot({ file_path: 'x' }), '.')
    assert.equal(effectiveSearchRoot({ path: null }), '.')
    assert.equal(effectiveSearchRoot({ path: '' }), null)
    assert.equal(effectiveSearchRoot({ path: 5 }), null)
  })

  for (const tool of ['Grep', 'Glob']) {
    it(`${tool}: a decoy file_path does not replace the cwd as the search root`, async () => {
      // cwd IS the sessions directory; the call has no path, so it searches there
      await assertBoth(tool, { pattern: 'x' }, true, 'no decoy', sessionsDir)
      await assertBoth(tool, { pattern: 'x', file_path: 'benign.txt' }, true, 'decoy', sessionsDir)
      await assertBoth(tool, { pattern: 'x', notebook_path: 'benign.ipynb' }, true, 'notebook decoy', sessionsDir)
    })

    it(`${tool}: a plain call and a benign decoy in an ordinary project are not floored (control)`, async () => {
      await assertBoth(tool, { pattern: 'x' }, false, 'plain')
      await assertBoth(tool, { pattern: 'x', file_path: 'benign.txt' }, false, 'decoy')
      await assertBoth(tool, { pattern: 'x', path: 'src' }, false, 'explicit path')
    })

    it(`${tool}: an unusable path floors`, async () => {
      await assertBoth(tool, { pattern: 'x', path: 5 }, true, 'non-string path')
    })
  }
})

describe('apply_patch needs a complete change list', () => {
  const change = (extra = {}) => ({ path: 'src/a.txt', kind: { type: 'update', move_path: null }, diff: '', ...extra })

  it('floors a missing, non-array, empty or malformed change list', async () => {
    await assertBoth('apply_patch', { file_path: project, changes: null }, true, 'null')
    await assertBoth('apply_patch', { file_path: project }, true, 'missing')
    await assertBoth('apply_patch', { file_path: project, changes: 'diff --git a b' }, true, 'string')
    await assertBoth('apply_patch', { file_path: project, changes: [] }, true, 'empty')
    await assertBoth('apply_patch', { file_path: project, changes: [change(), {}] }, true, 'empty member')
    await assertBoth('apply_patch', { file_path: project, changes: [change({ kind: { type: 'update', move_path: 5 } })] }, true, 'bad rename')
  })

  it('does not floor a complete list of ordinary paths (control)', async () => {
    await assertBoth('apply_patch', { file_path: project, changes: [change()] }, false, 'valid')
    await assertBoth('apply_patch', { file_path: project, changes: [change({ kind: 'add' })] }, false, 'legacy string kind')
  })
})

describe('collectChangeTargets validates the change kind', () => {
  const ok = (kind) => collectChangeTargets([{ path: 'a', kind, diff: '' }]).complete
  it('accepts the supported string and object forms', () => {
    for (const k of ['add', 'update', 'delete']) {
      assert.equal(ok(k), true, k)
      assert.equal(ok({ type: k }), true, `{type:${k}}`)
      assert.equal(ok({ type: k, move_path: null }), true)
    }
    assert.equal(ok({ type: 'update', move_path: 'b' }), true)
  })
  it('rejects a missing, unknown or malformed kind', () => {
    assert.equal(collectChangeTargets([{ path: 'a' }]).complete, false, 'missing')
    for (const k of [null, 'rename', '', 5, {}, { type: 'rename' }, { type: 5 }, { move_path: 'b' }]) {
      assert.equal(ok(k), false, JSON.stringify(k))
    }
  })
})
