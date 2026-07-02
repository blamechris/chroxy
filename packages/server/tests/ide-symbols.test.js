import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSymbols, collectWorkspaceSymbols, resolveSymbol } from '../src/ide/symbols.js'

/**
 * Unit tests for the self-contained IDE symbol parser (#6471, epic #6469).
 * Pure-function coverage for parseSymbols + filesystem coverage for
 * collectWorkspaceSymbols against a real temp workspace (acceptance: verified
 * against real files, not an in-memory fixture only).
 */

describe('parseSymbols — JS/TS', () => {
  it('captures top-level function / class declarations with line + exported', () => {
    const src = [
      'export function alpha() {}',      // 1
      'function beta() {}',              // 2
      'export default class Gamma {}',   // 3
      'class Delta {}',                  // 4
    ].join('\n')
    const syms = parseSymbols(src, 'a.js')
    assert.deepEqual(syms, [
      { name: 'alpha', kind: 'function', file: 'a.js', line: 1, exported: true },
      { name: 'beta', kind: 'function', file: 'a.js', line: 2, exported: false },
      { name: 'Gamma', kind: 'class', file: 'a.js', line: 3, exported: true },
      { name: 'Delta', kind: 'class', file: 'a.js', line: 4, exported: false },
    ])
  })

  it('classifies const arrow/function as function, plain const as const, let/var as variable', () => {
    const src = [
      'export const handler = () => {}',
      'const helper = async (x) => x',
      'export const fn2 = function () {}',
      'const TABLE = { a: 1 }',
      'let counter = 0',
      'var legacy = 1',
    ].join('\n')
    const syms = parseSymbols(src, 'b.ts')
    assert.deepEqual(
      syms.map((s) => [s.name, s.kind, s.exported]),
      [
        ['handler', 'function', true],
        ['helper', 'function', false],
        ['fn2', 'function', true],
        ['TABLE', 'const', false],
        ['counter', 'variable', false],
        ['legacy', 'variable', false],
      ],
    )
  })

  it('captures interface / type / enum (TS)', () => {
    const src = [
      'export interface Foo { a: number }',
      'type Bar = string | number',
      'export enum Color { Red, Green }',
      'export const enum Mode { On, Off }',
    ].join('\n')
    const syms = parseSymbols(src, 'c.ts')
    assert.deepEqual(
      syms.map((s) => [s.name, s.kind, s.exported]),
      [
        ['Foo', 'interface', true],
        ['Bar', 'type', false],
        ['Color', 'enum', true],
        ['Mode', 'enum', true],
      ],
    )
  })

  it('does not match an equality comparison as a const declaration', () => {
    // `const x ==` is not a thing, but guard the `=([^=]...)` lookahead: a
    // declaration assigned from a comparison expression must still parse, and a
    // bare `if (a === b)` must not be mistaken for a declaration.
    const src = [
      'if (a === b) doThing()',
      'const ok = a === b',
    ].join('\n')
    const syms = parseSymbols(src, 'd.js')
    assert.deepEqual(syms.map((s) => s.name), ['ok'])
    assert.equal(syms[0].kind, 'const')
  })

  it('skips comment-only and blank lines', () => {
    const src = [
      '// export function ghost() {}',
      ' * function alsoGhost() {}',
      '',
      '# not js',
      'export function real() {}',
    ].join('\n')
    const syms = parseSymbols(src, 'e.js')
    assert.deepEqual(syms.map((s) => s.name), ['real'])
  })
})

describe('parseSymbols — Python', () => {
  it('captures def/class, marks indented def as method, underscore as not exported', () => {
    const src = [
      'def top():',          // 1 function, exported
      'class Widget:',       // 2 class, exported
      '    def method(self):', // 3 method
      'def _private():',     // 4 function, not exported
    ].join('\n')
    const syms = parseSymbols(src, 'f.py')
    assert.deepEqual(syms, [
      { name: 'top', kind: 'function', file: 'f.py', line: 1, exported: true },
      { name: 'Widget', kind: 'class', file: 'f.py', line: 2, exported: true },
      { name: 'method', kind: 'method', file: 'f.py', line: 3, exported: false },
      { name: '_private', kind: 'function', file: 'f.py', line: 4, exported: false },
    ])
  })
})

describe('parseSymbols — guards', () => {
  it('returns [] for unknown extensions and empty/non-string input', () => {
    assert.deepEqual(parseSymbols('export function x() {}', 'readme.md'), [])
    assert.deepEqual(parseSymbols('', 'a.js'), [])
    assert.deepEqual(parseSymbols(null, 'a.js'), [])
  })
})

describe('collectWorkspaceSymbols', () => {
  let root
  let outside
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-ide-symbols-'))
    writeFileSync(join(root, 'top.js'), 'export function top() {}\n')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'util.ts'), 'export const helper = () => {}\nexport class Svc {}\n')
    // Ignored dirs must not be scanned.
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'export function shouldNotAppear() {}\n')
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'hook.js'), 'export function gitGhost() {}\n')
    // Non-source file ignored.
    writeFileSync(join(root, 'data.json'), '{"function":"nope"}\n')
    // A sibling tree OUTSIDE the workspace, reachable only via symlinks planted
    // inside it — the arbitrary-file-read vector the confinement must block.
    outside = mkdtempSync(join(tmpdir(), 'chroxy-ide-outside-'))
    writeFileSync(join(outside, 'secret.js'), 'export function TOP_SECRET() {}\n')
    mkdirSync(join(outside, 'sub'))
    writeFileSync(join(outside, 'sub', 'deep.js'), 'export function DEEP_SECRET() {}\n')
    symlinkSync(join(outside, 'secret.js'), join(root, 'linkfile.js'))
    symlinkSync(outside, join(root, 'linkdir'))
  })
  after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('aggregates symbols across the tree with workspace-relative POSIX paths', async () => {
    const { symbols, truncated } = await collectWorkspaceSymbols(root)
    assert.equal(truncated, false)
    const names = symbols.map((s) => s.name).sort()
    assert.deepEqual(names, ['Svc', 'helper', 'top'])
    const files = new Set(symbols.map((s) => s.file))
    assert.ok(files.has('top.js'))
    assert.ok(files.has('src/util.ts'), 'uses forward slashes')
  })

  it('skips node_modules and .git', async () => {
    const { symbols } = await collectWorkspaceSymbols(root)
    const names = symbols.map((s) => s.name)
    assert.ok(!names.includes('shouldNotAppear'))
    assert.ok(!names.includes('gitGhost'))
  })

  it('scopes to a single file when path is given', async () => {
    const { symbols } = await collectWorkspaceSymbols(root, { path: 'src/util.ts' })
    assert.deepEqual(symbols.map((s) => s.name).sort(), ['Svc', 'helper'])
  })

  it('refuses a path that escapes the workspace root', async () => {
    const { symbols, truncated } = await collectWorkspaceSymbols(root, { path: '../../../etc' })
    assert.deepEqual(symbols, [])
    assert.equal(truncated, false)
  })

  // Regression: the confinement must resolve the REAL path (symlinks), not just
  // lexically normalize `..` — a symlink inside the workspace that points out
  // would otherwise leak arbitrary host files over the WS surface.
  it('refuses a symlinked FILE whose real target is outside the workspace', async () => {
    const { symbols } = await collectWorkspaceSymbols(root, { path: 'linkfile.js' })
    assert.deepEqual(symbols, [])
  })

  it('refuses a symlinked DIRECTORY whose real target is outside the workspace', async () => {
    const { symbols } = await collectWorkspaceSymbols(root, { path: 'linkdir' })
    assert.deepEqual(symbols, [])
  })

  it('refuses traversal THROUGH an in-workspace symlink to an outside file', async () => {
    const { symbols } = await collectWorkspaceSymbols(root, { path: 'linkdir/sub/deep.js' })
    assert.deepEqual(symbols, [])
  })

  it('refuses scoping into an ignored dir (parity with the full scan)', async () => {
    assert.deepEqual((await collectWorkspaceSymbols(root, { path: 'node_modules/pkg' })).symbols, [])
    assert.deepEqual((await collectWorkspaceSymbols(root, { path: '.git' })).symbols, [])
  })

  it('sets truncated when the symbol cap is hit', async () => {
    const { symbols, truncated } = await collectWorkspaceSymbols(root, { maxSymbols: 1 })
    assert.equal(symbols.length, 1)
    assert.equal(truncated, true)
  })
})

describe('resolveSymbol — go-to-definition (#6475)', () => {
  let root
  let outside
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-ide-resolve-'))
    // An exported declaration in one file...
    writeFileSync(join(root, 'mod.ts'), 'export const widget = () => {}\n')
    // ...and a same-named LOCAL (non-exported) declaration in another.
    writeFileSync(join(root, 'local.ts'), 'const widget = 1\nexport function only() {}\n')
    // Two same-named non-exported decls, to exercise the fromFile tiebreak.
    writeFileSync(join(root, 'a.ts'), 'const dup = 1\n')
    writeFileSync(join(root, 'b.ts'), 'const dup = 2\n')
    // A symbol reachable only via an in-workspace symlink pointing OUTSIDE —
    // the whole-tree walk skips symlinks, so it must never resolve.
    outside = mkdtempSync(join(tmpdir(), 'chroxy-ide-resolve-out-'))
    writeFileSync(join(outside, 'secret.js'), 'export function TOP_SECRET() {}\n')
    symlinkSync(join(outside, 'secret.js'), join(root, 'linkfile.js'))
  })
  after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('resolves a unique symbol to its declaration file + 1-indexed line', async () => {
    assert.deepEqual(await resolveSymbol(root, 'only'), { file: 'local.ts', line: 2 })
  })

  it('prefers the EXPORTED declaration when the same name is declared twice', async () => {
    // widget is exported in mod.ts (+2) and a local const in local.ts (+0).
    assert.deepEqual(await resolveSymbol(root, 'widget'), { file: 'mod.ts', line: 1 })
  })

  it('breaks a tie toward the originating file (fromFile)', async () => {
    // dup is a non-exported const in both a.ts and b.ts; fromFile decides.
    assert.deepEqual(await resolveSymbol(root, 'dup', { fromFile: 'b.ts' }), { file: 'b.ts', line: 1 })
    // Without a fromFile hint, walk-order (a before b) wins deterministically.
    assert.deepEqual(await resolveSymbol(root, 'dup'), { file: 'a.ts', line: 1 })
  })

  it('returns null for a name with no declaration (graceful not-found)', async () => {
    assert.equal(await resolveSymbol(root, 'doesNotExist'), null)
  })

  it('returns null for an empty / whitespace / non-string name', async () => {
    assert.equal(await resolveSymbol(root, ''), null)
    assert.equal(await resolveSymbol(root, '   '), null)
    assert.equal(await resolveSymbol(root, null), null)
  })

  it('never resolves a symbol reachable only through an out-of-workspace symlink', async () => {
    assert.equal(await resolveSymbol(root, 'TOP_SECRET'), null)
  })
})
