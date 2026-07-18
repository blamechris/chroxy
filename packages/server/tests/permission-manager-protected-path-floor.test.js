import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionManager, isProtectedPathTarget } from '../src/permission-manager.js'

/**
 * #6794 — hardcoded protected-path floor.
 *
 * Chroxy's in-process permission engine scoped auto-approve by tool NAME only,
 * so a broad `allow Write` rule / acceptEdits / auto mode would silently write
 * to .git/, .claude/, .vscode/, .config/git/, or .env*. The floor mirrors
 * Claude Code's "always ask" floor: a path-carrying tool aimed at a protected
 * path skips every auto-approve short-circuit and falls through to the normal
 * interactive prompt (a floor, NOT a hard deny — a `deny` rule still denies).
 *
 * These tests exercise handlePermission (the shared entry every in-process
 * provider — SDK / BYOK / Codex — routes through) and the exported pure
 * matcher directly. Paths are synthetic (string ops only — no fs), so a fixed
 * cwd needs no on-disk directory.
 */

const silentLog = { info() {}, warn() {} }
const CWD = '/work/project'

function createManager(opts = {}) {
  return new PermissionManager({ log: silentLog, cwd: CWD, ...opts })
}

describe('protected-path floor (#6794)', () => {
  let pm

  beforeEach(() => {
    pm = createManager()
  })

  afterEach(() => {
    pm.destroy()
  })

  // -- Acceptance criteria: broad settings must NOT auto-approve protected paths --

  describe('does not auto-approve protected paths under lenient settings', () => {
    it('(a) allow Write rule + write to .git/config falls through to the prompt', async () => {
      const events = []
      pm.on('permission_request', (d) => events.push(d))
      pm.setRules([{ tool: 'Write', decision: 'allow' }])

      const promise = pm.handlePermission('Write', { file_path: '.git/config' }, null, 'approve')
      assert.equal(events.length, 1, 'protected write must emit a prompt, not auto-allow')
      assert.equal(events[0].tool, 'Write')

      // Resolve so the pending promise/timer drains for a clean teardown.
      pm.respondToPermission(events[0].requestId, 'deny')
      const result = await promise
      assert.equal(result.behavior, 'deny')
    })

    it('(b) acceptEdits + Edit to .claude/settings.local.json falls through to the prompt', async () => {
      const events = []
      pm.on('permission_request', (d) => events.push(d))

      const promise = pm.handlePermission(
        'Edit',
        { file_path: '.claude/settings.local.json' },
        null,
        'acceptEdits',
      )
      assert.equal(events.length, 1, 'protected edit must prompt even in acceptEdits')

      pm.respondToPermission(events[0].requestId, 'deny')
      await promise
    })

    it('(c) auto mode + Write to .env falls through to the prompt', async () => {
      const events = []
      pm.on('permission_request', (d) => events.push(d))

      const promise = pm.handlePermission('Write', { file_path: '.env' }, null, 'auto')
      assert.equal(events.length, 1, 'protected write must prompt even in auto/bypass mode')

      pm.respondToPermission(events[0].requestId, 'deny')
      await promise
    })
  })

  // -- Negative controls: benign paths keep short-circuiting --

  describe('still auto-approves non-protected paths', () => {
    it('(d) allow Write rule + write to src/foo.js is auto-approved (no prompt)', async () => {
      const events = []
      pm.on('permission_request', (d) => events.push(d))
      pm.setRules([{ tool: 'Write', decision: 'allow' }])

      const result = await pm.handlePermission('Write', { file_path: 'src/foo.js' }, null, 'approve')
      assert.equal(result.behavior, 'allow')
      assert.equal(events.length, 0, 'benign write must not prompt')
    })

    it('(d) .github/workflows/x.yml must NOT match .git/ (auto-approved)', async () => {
      const events = []
      pm.on('permission_request', (d) => events.push(d))
      pm.setRules([{ tool: 'Write', decision: 'allow' }])

      const result = await pm.handlePermission(
        'Write',
        { file_path: '.github/workflows/x.yml' },
        null,
        'approve',
      )
      assert.equal(result.behavior, 'allow', '.github must not be confused with .git')
      assert.equal(events.length, 0)
    })

    it('acceptEdits still auto-approves a benign Edit', async () => {
      const result = await pm.handlePermission('Edit', { file_path: 'src/app/main.js' }, null, 'acceptEdits')
      assert.equal(result.behavior, 'allow')
    })

    it('auto mode still auto-approves a benign Write', async () => {
      const result = await pm.handlePermission('Write', { file_path: 'docs/readme.md' }, null, 'auto')
      assert.equal(result.behavior, 'allow')
    })
  })

  // -- Traversal + absolute paths --

  describe('normalization / traversal', () => {
    it('(e) sub/../.git/config is floored (traversal collapses to .git/config)', async () => {
      const events = []
      pm.on('permission_request', (d) => events.push(d))
      pm.setRules([{ tool: 'Write', decision: 'allow' }])

      const promise = pm.handlePermission('Write', { file_path: 'sub/../.git/config' }, null, 'approve')
      assert.equal(events.length, 1, 'traversal into .git must be floored')

      pm.respondToPermission(events[0].requestId, 'deny')
      await promise
    })

    it('a leading ./ into .claude is floored', async () => {
      const events = []
      pm.on('permission_request', (d) => events.push(d))

      const promise = pm.handlePermission('Write', { file_path: './.claude/x.json' }, null, 'auto')
      assert.equal(events.length, 1)
      pm.respondToPermission(events[0].requestId, 'deny')
      await promise
    })

    it('an absolute path INSIDE cwd targeting .claude is floored', async () => {
      const events = []
      pm.on('permission_request', (d) => events.push(d))

      const promise = pm.handlePermission(
        'Write',
        { file_path: `${CWD}/.claude/settings.local.json` },
        null,
        'auto',
      )
      assert.equal(events.length, 1)
      pm.respondToPermission(events[0].requestId, 'deny')
      await promise
    })
  })

  // -- deny rules still deny (the floor never widens access) --

  it('a deny rule on a protected path still denies (floor does not turn deny into a prompt)', async () => {
    const events = []
    pm.on('permission_request', (d) => events.push(d))
    pm.setRules([{ tool: 'Write', decision: 'deny' }])

    const result = await pm.handlePermission('Write', { file_path: '.git/config' }, null, 'approve')
    assert.equal(result.behavior, 'deny')
    assert.equal(result.message, 'Denied by session rule')
    assert.equal(events.length, 0, 'a deny rule short-circuits without a prompt')
  })

  // -- NotebookEdit (notebook_path) + generic path-field coverage --

  it('NotebookEdit targeting .git via notebook_path is floored', async () => {
    const events = []
    pm.on('permission_request', (d) => events.push(d))

    const promise = pm.handlePermission('NotebookEdit', { notebook_path: '.git/nb.ipynb' }, null, 'acceptEdits')
    assert.equal(events.length, 1)
    pm.respondToPermission(events[0].requestId, 'deny')
    await promise
  })

  it('a read of .env (auto-read secret parity) is floored under acceptEdits', async () => {
    const events = []
    pm.on('permission_request', (d) => events.push(d))

    const promise = pm.handlePermission('Read', { file_path: '.env.production' }, null, 'acceptEdits')
    assert.equal(events.length, 1, '.env.production read must prompt, not auto-approve')
    pm.respondToPermission(events[0].requestId, 'deny')
    await promise
  })

  // -- The worktree false-positive guard (relative-to-cwd matching) --

  it('a session whose OWN cwd lives under a .claude/ dir does not false-match benign writes', async () => {
    // e.g. an agent git worktree at /home/me/.claude/worktrees/agent-x — a
    // write to packages/server/foo.js must NOT be floored just because the
    // session's cwd contains a `.claude` segment (matched relative to cwd).
    const worktreePm = createManager({ cwd: '/home/me/.claude/worktrees/agent-x' })
    try {
      const result = await worktreePm.handlePermission(
        'Write',
        { file_path: 'packages/server/foo.js' },
        null,
        'auto',
      )
      assert.equal(result.behavior, 'allow', 'cwd-internal .claude must not floor a benign write')
    } finally {
      worktreePm.destroy()
    }
  })
})

// -- The exported pure matcher, exercised directly --

describe('isProtectedPathTarget (#6794)', () => {
  const cwd = '/work/project'

  const floored = [
    { file_path: '.git/config' },
    { file_path: 'sub/dir/.git/config' },
    { file_path: '.claude/settings.local.json' },
    { file_path: '.vscode/settings.json' },
    { file_path: '.config/git/config' },
    { file_path: '.env' },
    { file_path: '.env.local' },
    { file_path: '.env.production' },
    { file_path: 'sub/../.git/config' },
    { notebook_path: '.git/x.ipynb' },
    { path: '.claude/foo' },
    { file_path: `${cwd}/.git/HEAD` },
  ]
  for (const input of floored) {
    it(`floors ${JSON.stringify(input)}`, () => {
      assert.equal(isProtectedPathTarget(input, cwd), true)
    })
  }

  const notFloored = [
    { file_path: 'src/foo.js' },
    { file_path: '.github/workflows/ci.yml' }, // .github != .git
    { file_path: '.config/other/settings' }, // .config/git only, not all of .config
    { file_path: 'foo.env' }, // trailing .env is not a .env file
    { file_path: '.environment/config' }, // .env* prefix must be exactly .env or .env.
    { file_path: '.gitignore' }, // a file named .gitignore is not the .git dir
    { file_path: 'docs/readme.md' },
    { command: 'rm -rf /' }, // no path field → never floored (command-shaped)
    {}, // empty input
    null, // non-object
    { file_path: '' }, // empty path
  ]
  for (const input of notFloored) {
    it(`does not floor ${JSON.stringify(input)}`, () => {
      assert.equal(isProtectedPathTarget(input, cwd), false)
    })
  }

  it('resolves relative to the given cwd, not the process cwd', () => {
    // Same relative target; cwd only affects absolute-path resolution + the
    // relative-segment framing, so `.git/config` floors under any cwd.
    assert.equal(isProtectedPathTarget({ file_path: '.git/config' }, '/a/b'), true)
    assert.equal(isProtectedPathTarget({ file_path: '.git/config' }, '/x/y/z'), true)
  })

  it('a cwd that itself sits under a protected segment does not false-match', () => {
    // cwd = .../.claude/... ; a benign relative write stays unfloored.
    assert.equal(isProtectedPathTarget({ file_path: 'src/a.js' }, '/home/me/.claude/wt/agent'), false)
  })
})
