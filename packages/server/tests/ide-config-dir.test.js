import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { searchContent, findReferences } from '../src/ide/search.js'
import { collectWorkspaceSymbols, getWorkspaceSymbolIndex, invalidateWorkspaceSymbolIndex } from '../src/ide/symbols.js'
import { makeConfigDirFilter, isConfigRootOrDirectChild, isConfigDirOrDirectChild } from '../src/ws-file-ops/common.js'

// Files directly in the daemon's config directory are daemon-managed state, so the opt-in IDE
// surface (find-in-project, find-references, the symbol table) treats them the way the file
// viewer and generic writes do (read-file-config-dir.test.js, write-file-config-dir.test.js):
// they contribute nothing. Subtrees such as <configDir>/worktrees/<id> are ordinary project
// files and keep matching. Two layouts reach a config-dir file: the session cwd IS the config
// dir, or the cwd is an ancestor of a relocated, non-hidden config dir (the walk skips hidden
// directories, which is why the default `~/.chroxy` is not reached from `$HOME`).
// Everything runs in a temp tree with CHROXY_CONFIG_DIR pointed into it.

const NEEDLE = 'zq-needle-4417'
const CFG_SYMBOL = 'cfgOnlySymbolQ'
const ORDINARY_SYMBOL = 'ordinarySymbolQ'
const SUB_SYMBOL = 'subtreeSymbolQ'

describe('IDE search and symbols skip files directly in the config directory', () => {
  let root, savedEnv

  const put = (abs, text) => {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
  const configFiles = (dir) => {
    put(join(dir, 'state.js'), `export function ${CFG_SYMBOL}() { return '${NEEDLE}' }\n`)
    put(join(dir, 'state.json'), `{ "note": "${NEEDLE}" }\n`)
    put(join(dir, 'notes.md'), `# ${NEEDLE}\n`)
    put(join(dir, 'worktrees', 'w1', 'sub.js'), `export function ${SUB_SYMBOL}() { return '${NEEDLE}' }\n`)
  }
  const files = (rows) => [...new Set(rows.map((r) => r.file))].sort()
  const names = (rows) => rows.map((r) => r.name).sort()

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-ide-cfg-')))
    savedEnv = process.env.CHROXY_CONFIG_DIR
    invalidateWorkspaceSymbolIndex()
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = savedEnv
    invalidateWorkspaceSymbolIndex()
    rmSync(root, { recursive: true, force: true })
  })

  describe('a session whose cwd IS the config dir', () => {
    let cfg
    beforeEach(() => {
      cfg = join(root, 'chroxy-state')
      process.env.CHROXY_CONFIG_DIR = cfg
      configFiles(cfg)
    })

    it('search_content returns nothing from the top-level files; a worktree subtree still matches', async () => {
      const { results } = await searchContent(cfg, NEEDLE)
      assert.deepEqual(files(results), ['worktrees/w1/sub.js'])
    })

    it('find_references returns nothing from the top-level files; a worktree subtree still matches', async () => {
      const { results } = await findReferences(cfg, SUB_SYMBOL)
      assert.deepEqual(files(results), ['worktrees/w1/sub.js'])
      const { results: cfgRefs } = await findReferences(cfg, CFG_SYMBOL)
      assert.deepEqual(cfgRefs, [])
    })

    it('list_symbols (whole-workspace walk and the cached index) returns nothing from the top-level files', async () => {
      const walked = await collectWorkspaceSymbols(cfg)
      assert.deepEqual(names(walked.symbols), [SUB_SYMBOL])
      const indexed = await getWorkspaceSymbolIndex(cfg)
      assert.deepEqual(names(indexed.symbols), [SUB_SYMBOL])
    })

    it('scoping the request to one top-level file returns nothing either', async () => {
      assert.deepEqual((await searchContent(cfg, NEEDLE, { path: 'state.js' })).results, [])
      assert.deepEqual((await findReferences(cfg, CFG_SYMBOL, { path: 'state.js' })).results, [])
      assert.deepEqual((await collectWorkspaceSymbols(cfg, { path: 'state.js' })).symbols, [])
      assert.deepEqual((await searchContent(cfg, NEEDLE, { path: 'worktrees/w1/sub.js' })).results.map((r) => r.file), ['worktrees/w1/sub.js'])
    })
  })

  describe('a session whose cwd is an ANCESTOR of a relocated, non-hidden config dir', () => {
    let proj, cfg
    beforeEach(() => {
      proj = join(root, 'proj')
      cfg = join(proj, 'state', 'chroxy')
      process.env.CHROXY_CONFIG_DIR = cfg
      configFiles(cfg)
      put(join(proj, 'app.js'), `export function ${ORDINARY_SYMBOL}() { return '${NEEDLE}' }\n`)
      put(join(proj, 'state', 'beside.js'), `export function besideSymbolQ() { return '${NEEDLE}' }\n`)
    })

    it('search_content skips the config dir\'s top-level files; ordinary files, a sibling and the worktree subtree still match', async () => {
      const { results } = await searchContent(proj, NEEDLE)
      assert.deepEqual(files(results), ['app.js', 'state/beside.js', 'state/chroxy/worktrees/w1/sub.js'])
    })

    it('find_references skips them too', async () => {
      assert.deepEqual((await findReferences(proj, CFG_SYMBOL)).results, [])
      assert.deepEqual(files((await findReferences(proj, ORDINARY_SYMBOL)).results), ['app.js'])
      assert.deepEqual(files((await findReferences(proj, SUB_SYMBOL)).results), ['state/chroxy/worktrees/w1/sub.js'])
    })

    it('list_symbols skips them too (walk and cached index)', async () => {
      const expected = ['besideSymbolQ', ORDINARY_SYMBOL, SUB_SYMBOL].sort()
      assert.deepEqual(names((await collectWorkspaceSymbols(proj)).symbols), expected)
      assert.deepEqual(names((await getWorkspaceSymbolIndex(proj)).symbols), expected)
    })

    it('CONTROL: with the config dir elsewhere, the same files are ordinary project files and match', async () => {
      process.env.CHROXY_CONFIG_DIR = join(root, 'elsewhere')
      const { results } = await searchContent(proj, NEEDLE)
      assert.deepEqual(files(results), [
        'app.js', 'state/beside.js', 'state/chroxy/notes.md', 'state/chroxy/state.js', 'state/chroxy/state.json', 'state/chroxy/worktrees/w1/sub.js',
      ])
      assert.deepEqual(names((await collectWorkspaceSymbols(proj)).symbols),
        ['besideSymbolQ', CFG_SYMBOL, ORDINARY_SYMBOL, SUB_SYMBOL].sort())
    })

    it('FAILS CLOSED: a config root that cannot be resolved contributes no file from the walk', async () => {
      // A path through a regular file cannot be resolved (ENOTDIR), so no file can be shown to be outside it.
      process.env.CHROXY_CONFIG_DIR = join(proj, 'app.js', 'not-a-dir')
      assert.deepEqual((await searchContent(proj, NEEDLE)).results, [])
      assert.deepEqual((await collectWorkspaceSymbols(proj)).symbols, [])
    })
  })
})

// The walks resolve the config root once and then compare resolved paths, because resolving it
// per file doubled a 2000-file walk. The pieces must agree with isConfigDirOrDirectChild, which
// the file viewer and writes use.
describe('makeConfigDirFilter (the once-per-walk form of isConfigDirOrDirectChild)', () => {
  let root, savedEnv
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-cfgfilter-')))
    savedEnv = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = join(root, 'cfg')
    mkdirSync(join(root, 'cfg', 'worktrees', 'w1'), { recursive: true })
    mkdirSync(join(root, 'cfg-other'), { recursive: true })
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = savedEnv
    rmSync(root, { recursive: true, force: true })
  })

  it('agrees with isConfigDirOrDirectChild for existing files: the root, a direct child, a subtree, a name-prefix sibling', async () => {
    const files = {
      direct: join(root, 'cfg', 'state.json'),
      subtree: join(root, 'cfg', 'worktrees', 'w1', 'a.js'),
      prefixSibling: join(root, 'cfg-other', 'x.js'),
      ordinary: join(root, 'app.js'),
    }
    for (const f of Object.values(files)) writeFileSync(f, '')
    const filter = await makeConfigDirFilter()
    const cases = [
      [join(root, 'cfg'), true],
      [files.direct, true],
      [files.subtree, false],
      [files.prefixSibling, false],
      [files.ordinary, false],
    ]
    for (const [path, expected] of cases) {
      assert.equal(filter(path), expected, `filter: ${path}`)
      assert.equal(isConfigRootOrDirectChild(path, join(root, 'cfg')), expected, `predicate: ${path}`)
      assert.equal(await isConfigDirOrDirectChild(path), expected, `helper: ${path}`)
    }
  })

  it('resolves the config root when it is created, not per file: a later relocation does not change a filter already in hand', async () => {
    const filter = await makeConfigDirFilter()
    process.env.CHROXY_CONFIG_DIR = join(root, 'cfg-other')
    assert.equal(filter(join(root, 'cfg', 'state.json')), true)
    assert.equal((await makeConfigDirFilter())(join(root, 'cfg', 'state.json')), false, 'a new filter follows the relocation')
  })

  it('FAILS CLOSED: when the config root cannot be resolved, every path is reported as protected', async () => {
    writeFileSync(join(root, 'plain'), '')
    process.env.CHROXY_CONFIG_DIR = join(root, 'plain', 'not-a-dir')
    const filter = await makeConfigDirFilter()
    assert.equal(filter(join(root, 'app.js')), true)
    assert.equal(filter(join(root, 'anything', 'at', 'all.js')), true)
  })
})
