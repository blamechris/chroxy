import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isFlooredTarget } from '../src/permission-floor.js'
import { PermissionManager } from '../src/permission-manager.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
import { SKIP_NO_HARDLINK } from './helpers/hardlink-support.js'

/**
 * #8741 — Claude Code's own worktrees live INSIDE the protected `.claude/` dir.
 *
 * `EnterWorktree` / `claude --worktree <name>` check a worktree out at
 * `<repo>/.claude/worktrees/<name>/`. The floor matched `.claude` at any depth
 * below the session cwd, so every Edit/Write inside such a worktree was forced to
 * a prompt; under Auto nobody answers it and each one cost the 300 s timeout
 * (harness trial run A2c). The #6794/#6806 carve-out covered only a worktree used
 * AS the cwd, never one below it.
 *
 * The fix treats `<cwd>/.claude/worktrees/<name>/` as a workspace root: the
 * `.claude` and `worktrees` segments above it are not counted, and everything
 * from `<name>` down gets the full scan. These tests pin both halves on a REAL
 * on-disk fixture, because whether a directory is a worktree root is now a
 * filesystem question (a symlinked root is not one):
 *   - ordinary files inside the worktree are NOT floored (red before the fix);
 *   - every name the floor protects stays protected — the real `.claude/`, the
 *     same names inside the worktree, a path that only LOOKS like a worktree
 *     (symlinked, `..`-escaping, missing, or a name that is itself a traversal).
 */

const silentLog = { info() {}, warn() {}, debug() {}, error() {} }

let root
let repo

function mkdir(rel) { mkdirSync(join(repo, rel), { recursive: true }) }
function touch(rel) { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), 'x') }

before(() => {
  // realpath: macOS tmpdir sits behind /var -> /private/var.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-floor-wt-')))
  repo = join(root, 'repo')
  mkdir('.git')
  touch('.claude/settings.json')
  mkdir('.claude/commands')
  // The worktree from trial run A2c, with its own checked-in agent config.
  touch('.claude/worktrees/a2c/.git') // a worktree's .git is a gitlink FILE
  touch('.claude/worktrees/a2c/packages/server/tests/models.test.js')
  mkdir('.claude/worktrees/a2c/.claude/commands')
  // A second worktree; one named `feature/auth`, whose directory Claude Code
  // writes as `feature+auth`; and one whose name starts with `_`.
  mkdir('.claude/worktrees/b2/src')
  mkdir('.claude/worktrees/feature+auth/src')
  mkdir('.claude/worktrees/_wip/src')
  mkdir('.claude/worktrees/Feature-X/src')
  mkdir('.claude/worktrees/-wip/src')
  // `<dir>/worktrees/<x>/` shapes that are not Claude Code worktrees: the anchor
  // is `.claude/worktrees`, both parts of it.
  mkdir('.claude/skills/foo')
  mkdir('.claude/agents/team')
  mkdir('.git/worktrees/x')
  mkdir('.vscode/worktrees/x')
  // Directories under worktrees/ that are NOT worktree roots by name.
  mkdir('.claude/worktrees/.hidden/src')
  mkdir('.claude/worktrees/+wip/src')
  mkdir('.claude/worktrees/.claude')
  touch('.claude/worktrees/afile')
  // A root whose own name is secret-shaped: the scan still covers `<name>`.
  mkdir('.claude/worktrees/deploy.key/src')
  // On POSIX `\` is an ordinary name character: this is ONE directory directly
  // in worktrees/, not a `b` inside the worktree `a2c`.
  if (process.platform !== 'win32') mkdir('.claude/worktrees/a2c\\b/src')
  // A nested repo's .claude/worktrees: the carve-out is at the cwd root only.
  mkdir('sub/.claude/worktrees/a2c/src')
  // One file reachable under two names.
  touch('.claude/worktrees/a2c/src/orig.js')
  if (!SKIP_NO_HARDLINK) linkSync(join(repo, '.claude/worktrees/a2c/src/orig.js'), join(repo, '.claude/worktrees/a2c/src/twin.js'))
})

after(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

const floored = (tool, input, cwd = repo) => isFlooredTarget(tool, input, cwd)

describe('#8741 — ordinary files inside a Claude Code worktree are not floored', () => {
  it('the A2c repro: Edit <cwd>/.claude/worktrees/<name>/packages/server/tests/models.test.js', () => {
    assert.equal(floored('Edit', { file_path: '.claude/worktrees/a2c/packages/server/tests/models.test.js' }), false)
  })

  it('an absolute path, a not-yet-created file, and every write-shaped tool', () => {
    const abs = join(repo, '.claude/worktrees/a2c/src/new-file.js')
    assert.equal(floored('Write', { file_path: abs }), false)
    assert.equal(floored('Edit', { file_path: abs }), false)
    assert.equal(floored('MultiEdit', { file_path: abs }), false)
    assert.equal(floored('NotebookEdit', { notebook_path: '.claude/worktrees/a2c/nb/a.ipynb' }), false)
    assert.equal(floored('apply_patch', { file_path: repo, changes: [{ path: abs, kind: 'add', diff: '' }] }), false)
  })

  it('common source-tree names are plain names', () => {
    for (const rel of [
      'node_modules/@scope/pkg/index.js',
      'app/[id]/page.tsx',
      'app/(group)/layout.tsx',
      'routes/+page.svelte',
      'routes/$id.tsx',
      'docs/My Notes.md',
      'a-b_c.d.e.js',
    ]) {
      assert.equal(floored('Write', { file_path: `.claude/worktrees/a2c/${rel}` }), false, rel)
    }
  })

  it('other worktrees: a second one, `feature/auth` as Claude Code names it, and a leading `_`', () => {
    assert.equal(floored('Write', { file_path: '.claude/worktrees/b2/src/a.js' }), false)
    assert.equal(floored('Write', { file_path: '.claude/worktrees/feature+auth/src/a.js' }), false)
    assert.equal(floored('Write', { file_path: '.claude/worktrees/_wip/src/a.js' }), false)
    assert.equal(floored('Write', { file_path: '.claude/worktrees/Feature-X/src/a.js' }), false, 'names are case-insensitive')
    assert.equal(floored('Write', { file_path: '.claude/worktrees/-wip/src/a.js' }), false, 'a name may start with `-`')
    assert.equal(floored('Write', { file_path: '.claude/worktrees/feature+auth/.claude/settings.json' }), true)
    assert.equal(floored('Write', { file_path: '.claude/worktrees/feature+auth/.env' }), true)
  })

  it('end-to-end: auto and acceptEdits approve a worktree edit with no prompt', async () => {
    const pm = new PermissionManager({ log: silentLog, cwd: repo })
    const prompts = []
    pm.on('permission_request', (d) => { prompts.push(d); pm.respondToPermission(d.requestId, 'deny') })
    try {
      const input = { file_path: '.claude/worktrees/a2c/packages/server/tests/models.test.js', old_string: 'a', new_string: 'b' }
      for (const mode of ['auto', 'acceptEdits']) {
        const result = await pm.handlePermission('Edit', input, null, mode)
        assert.equal(result.behavior, 'allow', `${mode}: a worktree edit is auto-approved`)
      }
      assert.equal(prompts.length, 0, 'no prompt was raised')
    } finally {
      pm.destroy()
    }
  })
})

describe('#8741 — the real .claude/ stays floored', () => {
  for (const file_path of [
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/commands/x.md',
    '.claude/CLAUDE.md',
    // Directly under worktrees/ is not inside any worktree.
    '.claude/worktrees/CLAUDE.md',
    '.claude/worktrees/a2c', // the root itself
    '.claude/worktrees',
    // `<dir>/<x>/<real dir>/<file>` under the real config and repo-control dirs:
    // only `.claude/worktrees` anchors the carve-out.
    '.claude/skills/foo/SKILL.md',
    '.claude/agents/team/r.md',
    '.git/worktrees/x/config.worktree',
    '.vscode/worktrees/x/tasks.json',
    // The anchor is matched exactly as Claude Code spells it.
    '.CLAUDE/worktrees/a2c/src/a.js',
    '.claude/WORKTREES/a2c/src/a.js',
  ]) {
    it(`Write ${file_path} → floored`, () => {
      assert.equal(floored('Write', { file_path }), true)
    })
  }

  it('end-to-end: auto still prompts for the real agent config next to a worktree', async () => {
    const pm = new PermissionManager({ log: silentLog, cwd: repo })
    const prompts = []
    pm.on('permission_request', (d) => { prompts.push(d); pm.respondToPermission(d.requestId, 'deny') })
    try {
      const result = await pm.handlePermission('Write', { file_path: '.claude/settings.json', content: '{}' }, null, 'auto')
      assert.equal(prompts.length, 1, 'the floor forced a prompt')
      assert.equal(prompts[0].floored, true)
      assert.equal(result.behavior, 'deny', 'the answer was the user\'s deny')
    } finally {
      pm.destroy()
    }
  })
})

describe('#8741 — protected names INSIDE a worktree stay floored', () => {
  const W = '.claude/worktrees/a2c'
  for (const [tool, rel] of [
    ['Write', '.claude/settings.json'],
    ['Write', '.claude/settings.local.json'],
    ['Write', '.claude/commands/x.md'],
    ['Write', '.git'], // the gitlink file
    ['Write', '.git/config'],
    ['Write', '.vscode/tasks.json'],
    ['Write', '.config/git/config'],
    ['Write', '.env'],
    ['Write', 'deploy/id_ed25519'],
    ['Write', 'certs/server.pem'],
    // A worktree nested inside a worktree is not carved out (its `.claude` counts).
    ['Write', '.claude/worktrees/b/src/a.js'],
    // The read floor: secrets and credential-dense config.
    ['Read', '.env.local'],
    ['Read', '.claude/settings.local.json'],
    ['Read', '.git/config'],
  ]) {
    it(`${tool} ${W}/${rel} → floored`, () => {
      assert.equal(floored(tool, { file_path: `${W}/${rel}` }), true)
    })
  }

  it('apply_patch: one protected member floors the whole request', () => {
    const changes = [
      { path: join(repo, W, 'src/a.js'), kind: 'update', diff: '' },
      { path: join(repo, W, '.claude/settings.json'), kind: 'update', diff: '' },
    ]
    assert.equal(floored('apply_patch', { file_path: repo, changes }), true)
  })
})

describe('#8741 — a path that only looks like a worktree stays floored', () => {
  for (const file_path of [
    // Not a directory that exists: no worktree there yet.
    '.claude/worktrees/missing/src/a.js',
    // A FILE where the root would be.
    '.claude/worktrees/afile/x',
    // Names that are dotfiles, protected names or traversals.
    '.claude/worktrees/.hidden/src/a.js',
    '.claude/worktrees/+wip/src/a.js',
    '.claude/worktrees/.claude/settings.json',
    '.claude/worktrees/.git/config',
    '.claude/worktrees/../settings.json',
    '.claude/worktrees/../commands/x.md',
    // `..` out of a real worktree, back into the real config.
    '.claude/worktrees/a2c/../../settings.local.json',
    '.claude/worktrees/a2c/../../commands/x.md',
    '.claude/worktrees/a2c/../../../.git/config',
    // A backslash-spelled traversal: one literal name on POSIX, separators on
    // Windows. Either way it is not strictly inside a worktree.
    '.claude/worktrees/a2c\\..\\..\\settings.json',
    '.claude/worktrees/x\\..\\..\\commands\\y\\z.md',
    // The carve-out is at the session cwd's own root, not at any depth.
    'sub/.claude/worktrees/a2c/src/a.js',
    // Above the cwd the target is scanned as an absolute path.
    '../repo2/.claude/worktrees/a2c/src/a.js',
  ]) {
    it(`Write ${JSON.stringify(file_path)} → floored`, () => {
      assert.equal(floored('Write', { file_path }), true)
    })
  }

  it('a root whose name is itself secret-shaped stays floored (the scan starts AT <name>)', () => {
    assert.equal(floored('Write', { file_path: '.claude/worktrees/deploy.key/src/a.js' }), true)
  })

  it('a POSIX directory named `a2c\\b` in worktrees/ is not the worktree `a2c`', {
    skip: process.platform === 'win32' ? '`\\` is a path separator on win32, so the path really is inside a2c there' : false,
  }, () => {
    assert.equal(floored('Write', { file_path: '.claude/worktrees/a2c\\b/src/x.js' }), true)
  })

  for (const rel of ['notes~/a.js', 'café/a.js', 'a:b/c.js', 'dir./a.js', 'dir /a.js', 'a%b.js', 'caféx/a.js', 'a~1/b.js']) {
    it(`a name outside the plain set keeps the full scan: ${JSON.stringify(rel)}`, () => {
      assert.equal(floored('Write', { file_path: `.claude/worktrees/a2c/${rel}` }), true)
    })
  }

  it('a POSIX name holding `\\` below the root keeps the full scan', {
    skip: process.platform === 'win32' ? '`\\` is a path separator on win32' : false,
  }, () => {
    assert.equal(floored('Write', { file_path: '.claude/worktrees/a2c/x\\y/a.js' }), true)
  })

  it('a `..` anywhere in the target keeps the full scan', () => {
    assert.equal(floored('Write', { file_path: '.claude/worktrees/a2c/packages/../src/a.js' }), true)
    // An absolute spelling too (`join` would collapse the `..` before the floor saw it).
    assert.equal(floored('Write', { file_path: `${repo}/.claude/worktrees/a2c/src/../src/a.js` }), true)
  })

  it('a file with more than one hard link floors under the full floor', { skip: SKIP_NO_HARDLINK }, () => {
    assert.equal(floored('Write', { file_path: '.claude/worktrees/a2c/src/twin.js' }), true)
    assert.equal(floored('Write', { file_path: '.claude/worktrees/a2c/src/orig.js' }), true)
  })

  it('case variants of the real config stay floored', () => {
    assert.equal(floored('Write', { file_path: '.CLAUDE/settings.json' }), true)
    assert.equal(floored('Write', { file_path: '.claude/worktrees/A2C/.Claude/Settings.json' }), true)
  })
})

describe('#8741 — symlinks: a worktree root is a real directory, as Claude Code requires', { skip: SKIP_NO_SYMLINK }, () => {
  // Claude Code refuses to create a worktree when `.claude`, `.claude/worktrees`
  // or `.claude/worktrees/<name>` is a symlink, because a committed symlink there
  // could redirect it outside the repository. The floor applies the same rule.
  let alias
  let linkedStore

  before(() => {
    // <repo>/.claude/worktrees/evil -> <repo>/.claude (looks like a worktree, is the config dir)
    symlinkSync(join(repo, '.claude'), join(repo, '.claude/worktrees/evil'))
    // <repo>/.claude/worktrees/out -> a benign dir outside the repo
    mkdirSync(join(root, 'elsewhere'), { recursive: true })
    symlinkSync(join(root, 'elsewhere'), join(repo, '.claude/worktrees/out'))
    // Below a real root: links into the real config, into a sibling worktree, and to a file.
    symlinkSync(join(repo, '.claude'), join(repo, '.claude/worktrees/a2c/cfg'))
    symlinkSync(join(repo, '.claude/worktrees/b2/src'), join(repo, '.claude/worktrees/a2c/peer'))
    symlinkSync(join(repo, '.claude/worktrees/a2c/src/orig.js'), join(repo, '.claude/worktrees/a2c/alias.js'))
    symlinkSync(join(root, 'elsewhere'), join(repo, '.claude/worktrees/a2c/away'))
    symlinkSync(repo, join(repo, '.claude/worktrees/a2c/up'))
    // A cwd-level link INTO a worktree.
    symlinkSync(join(repo, '.claude/worktrees/a2c'), join(repo, 'wt'))

    // A repo whose .claude is itself a symlink to a dir NOT named .claude: the
    // name-based real-path pass cannot see that dir as config, so the lexical
    // spelling must keep flooring it.
    alias = join(root, 'alias-repo')
    mkdirSync(join(alias, '.claude-real/worktrees/a2c/src'), { recursive: true })
    writeFileSync(join(alias, '.claude-real/settings.json'), '{}')
    symlinkSync(join(alias, '.claude-real'), join(alias, '.claude'))
    symlinkSync(join(alias, '.claude-real'), join(alias, '.claude-real/worktrees/up'))

    // A repo whose .claude/worktrees is a symlink to a store elsewhere.
    linkedStore = join(root, 'linked-store-repo')
    mkdirSync(join(linkedStore, '.claude'), { recursive: true })
    mkdirSync(join(root, 'wt-store/a2c/src'), { recursive: true })
    symlinkSync(join(root, 'wt-store'), join(linkedStore, '.claude/worktrees'))
  })

  it('a symlinked <name> that points at the real .claude stays floored', () => {
    assert.equal(floored('Write', { file_path: '.claude/worktrees/evil/settings.json' }), true)
    assert.equal(floored('Write', { file_path: '.claude/worktrees/evil/commands/x.md' }), true)
    assert.equal(floored('Read', { file_path: '.claude/worktrees/evil/settings.json' }), true)
  })

  it('a symlinked <name> stays floored even when it points somewhere benign', () => {
    assert.equal(floored('Write', { file_path: '.claude/worktrees/out/a.js' }), true)
  })

  it('a symlinked .claude stays floored, including the config it really points at', () => {
    assert.equal(floored('Write', { file_path: '.claude/worktrees/a2c/src/a.js' }, alias), true)
    assert.equal(floored('Write', { file_path: '.claude/worktrees/up/settings.json' }, alias), true)
  })

  it('a symlinked .claude/worktrees stays floored', () => {
    assert.equal(floored('Write', { file_path: '.claude/worktrees/a2c/src/a.js' }, linkedStore), true)
  })

  it('a link below a real root that resolves into the real .claude stays floored', () => {
    assert.equal(floored('Write', { file_path: '.claude/worktrees/a2c/cfg/settings.json' }), true)
    assert.equal(floored('Write', { file_path: '.claude/worktrees/a2c/cfg/commands/x.md' }), true)
  })

  it('any symlink below a real root keeps the full scan, even one into another worktree', () => {
    assert.equal(floored('Write', { file_path: '.claude/worktrees/a2c/peer/a.js' }), true)
    assert.equal(floored('Write', { file_path: '.claude/worktrees/a2c/alias.js' }), true)
    // Also when it leads somewhere ordinary, outside .claude.
    assert.equal(floored('Write', { file_path: '.claude/worktrees/a2c/away/f.js' }), true)
    assert.equal(floored('Write', { file_path: '.claude/worktrees/a2c/up/src.js' }), true)
  })

  it('a path that reaches a worktree only through a cwd-level link keeps the full scan', () => {
    // The carve-out is decided on the path as written; `wt/…` is not spelled as
    // a worktree path, and its resolved path differs from it.
    assert.equal(floored('Write', { file_path: 'wt/src/a.js' }), true)
    assert.equal(floored('Write', { file_path: 'wt/.claude/settings.json' }), true)
  })
})
