import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchContent, findReferences } from '../src/ide/search.js'

/**
 * Unit tests for the IDE content-search backend (#6474, epic #6469). Grep
 * behaviour + the realpath confinement (mirrors ide-symbols.test.js) against a
 * real temp workspace — the symlink-escape cases are the security regression.
 */

describe('searchContent — grep behaviour', () => {
  let root
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-ide-search-'))
    writeFileSync(join(root, 'a.js'), 'const target = 1\nconst other = 2\nTARGET again\n')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'b.ts'), 'export const target = go()\n')
    writeFileSync(join(root, 'readme.md'), '# targeting the docs\n')
    // A dotfile — extname('.env') is '', so it must match via the basename allowlist.
    writeFileSync(join(root, '.env'), 'API_KEY=findme_env\n')
    // Ignored dirs must not be searched.
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'const target = "hidden"\n')
    // Non-text asset ignored.
    writeFileSync(join(root, 'logo.png'), 'target-not-searched-binary-ext\n')
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  it('finds a case-insensitive substring with file / 1-indexed line / 1-indexed column', async () => {
    const { results, truncated } = await searchContent(root, 'target')
    assert.equal(truncated, false)
    // a.js line 1 (col 7) + line 3 (col 1, "TARGET"), src/b.ts line 1, readme.md line 1.
    const keys = results.map((r) => `${r.file}:${r.line}:${r.column}`).sort()
    assert.deepEqual(keys, ['a.js:1:7', 'a.js:3:1', 'readme.md:1:3', 'src/b.ts:1:14'])
    const a1 = results.find((r) => r.file === 'a.js' && r.line === 1)
    assert.equal(a1.text, 'const target = 1')
  })

  it('greps dotfiles / extensionless files via the basename allowlist (#6505 review)', async () => {
    const { results } = await searchContent(root, 'findme_env')
    assert.equal(results.length, 1)
    assert.equal(results[0].file, '.env')
    assert.equal(results[0].line, 1)
  })

  it('uses forward-slash workspace-relative paths', async () => {
    const { results } = await searchContent(root, 'go()')
    assert.equal(results.length, 1)
    assert.equal(results[0].file, 'src/b.ts')
  })

  it('skips node_modules / ignored dirs and non-text extensions', async () => {
    const { results } = await searchContent(root, 'target')
    assert.ok(!results.some((r) => r.file.includes('node_modules')), 'node_modules excluded')
    assert.ok(!results.some((r) => r.file.endsWith('.png')), 'binary-ext asset excluded')
  })

  it('is a no-op for a query shorter than 2 chars', async () => {
    assert.deepEqual((await searchContent(root, 't')).results, [])
    assert.deepEqual((await searchContent(root, '')).results, [])
    assert.deepEqual((await searchContent(root, '  ')).results, [])
  })

  it('returns nothing for a needle with no match', async () => {
    assert.deepEqual((await searchContent(root, 'zzznomatch')).results, [])
  })

  it('sets truncated when the result cap is hit', async () => {
    const { results, truncated } = await searchContent(root, 'target', { maxResults: 1 })
    assert.equal(results.length, 1)
    assert.equal(truncated, true)
  })

  it('scopes to a sub-path when path is given', async () => {
    const { results } = await searchContent(root, 'target', { path: 'src' })
    assert.deepEqual(results.map((r) => r.file), ['src/b.ts'])
  })
})

describe('searchContent — confinement (security)', () => {
  let root
  let outside
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-ide-search-conf-'))
    writeFileSync(join(root, 'in.js'), 'const inside = 1\n')
    // A sibling tree OUTSIDE the workspace, reachable only via symlinks planted
    // inside it — the arbitrary-file-read vector the confinement must block.
    outside = mkdtempSync(join(tmpdir(), 'chroxy-ide-search-out-'))
    writeFileSync(join(outside, 'secret.js'), 'const TOP_SECRET = 1\n')
    mkdirSync(join(outside, 'sub'))
    writeFileSync(join(outside, 'sub', 'deep.js'), 'const DEEP_SECRET = 1\n')
    symlinkSync(join(outside, 'secret.js'), join(root, 'linkfile.js'))
    symlinkSync(outside, join(root, 'linkdir'))
  })
  after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('never surfaces a symbol reachable only through an out-of-workspace symlink', async () => {
    // A full-tree search skips symlink dirents, so the secret never appears.
    assert.deepEqual((await searchContent(root, 'TOP_SECRET')).results, [])
    assert.deepEqual((await searchContent(root, 'DEEP_SECRET')).results, [])
  })

  it('refuses a path that escapes the workspace root', async () => {
    assert.deepEqual((await searchContent(root, 'anything', { path: '../../../etc' })).results, [])
  })

  it('refuses a symlinked FILE whose real target is outside the workspace', async () => {
    assert.deepEqual((await searchContent(root, 'TOP_SECRET', { path: 'linkfile.js' })).results, [])
  })

  it('refuses a symlinked DIRECTORY whose real target is outside the workspace', async () => {
    assert.deepEqual((await searchContent(root, 'DEEP_SECRET', { path: 'linkdir' })).results, [])
  })

  it('refuses traversal THROUGH an in-workspace symlink to an outside file', async () => {
    assert.deepEqual((await searchContent(root, 'DEEP_SECRET', { path: 'linkdir/sub/deep.js' })).results, [])
  })
})

describe('findReferences — word-boundary reverse lookup (#6477)', () => {
  let root
  let outside
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-ide-refs-'))
    writeFileSync(join(root, 'a.ts'), [
      'import { widget } from "./w"',   // 1 — reference
      'const x = widget()',             // 2 — reference
      'const y = widgetFactory()',      // 3 — NOT a ref (widgetFactory)
      'const z = superwidget',          // 4 — NOT a ref (superwidget)
      'widget; widget // twice',        // 5 — TWO references on one line
      'const Widget = 1',               // 6 — NOT a ref (case-sensitive)
    ].join('\n') + '\n')
    // Symbol reachable only via an out-of-workspace symlink — must never appear.
    outside = mkdtempSync(join(tmpdir(), 'chroxy-ide-refs-out-'))
    writeFileSync(join(outside, 'secret.js'), 'const widget = "SECRET"\n')
    symlinkSync(join(outside, 'secret.js'), join(root, 'linkfile.js'))
  })
  after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('matches whole-word references only (not substrings)', async () => {
    const { results } = await findReferences(root, 'widget')
    const lines = results.map((r) => r.line).sort((a, b) => a - b)
    // lines 1, 2, and two on 5 — NOT 3 (widgetFactory), 4 (superwidget), 6 (Widget).
    assert.deepEqual(lines, [1, 2, 5, 5])
  })

  it('is case-sensitive (an identifier reference is exact)', async () => {
    assert.deepEqual((await findReferences(root, 'Widget')).results.map((r) => r.line), [6])
  })

  it('returns every occurrence on a line with 1-indexed columns', async () => {
    const { results } = await findReferences(root, 'widget')
    const line5 = results.filter((r) => r.line === 5)
    assert.equal(line5.length, 2)
    assert.equal(line5[0].column, 1)      // "widget; widget" — first at col 1
    assert.equal(line5[1].column, 9)      // second at col 9
    assert.equal(line5[0].file, 'a.ts')
  })

  it('returns nothing for a non-identifier or empty name', async () => {
    assert.deepEqual((await findReferences(root, '')).results, [])
    assert.deepEqual((await findReferences(root, 'a b')).results, [])
    assert.deepEqual((await findReferences(root, '(){}')).results, [])
  })

  it('never surfaces a reference reachable only through an out-of-workspace symlink', async () => {
    assert.deepEqual((await findReferences(root, 'widget', { path: 'linkfile.js' })).results, [])
  })

  it('sets truncated when the result cap is hit', async () => {
    const { results, truncated } = await findReferences(root, 'widget', { maxResults: 1 })
    assert.equal(results.length, 1)
    assert.equal(truncated, true)
  })
})
