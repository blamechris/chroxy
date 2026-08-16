// export-targets.test.mjs — the coverage #7220 is about.
//
// `build-publish-dir.mjs`'s export derivation went through four consecutive PRs
// (#7197, #7210, #7212, #7225), each fixing a "reports success without actually
// checking" defect in the same twenty lines, and every one was caught by hand in
// a PR description rather than by a test. The script is otherwise exercised only
// by release.yml's verify-artifacts job on a `v*` tag push — i.e. the first time
// a bad shape is hit for real is during an actual release.
//
// So these tests target the shapes rather than the happy path: the null that
// must NOT throw, the empty object that MUST, and the escape that must be
// refused. A test that only asserted "./dist/index.js works" would have passed
// on every one of those four broken versions.

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  declaredTargets,
  exportTargets,
  needsJsonAttribute,
  resolveExportTarget,
} from '../lib/export-targets.mjs'

describe('exportTargets', () => {
  it('reads a bare string target', () => {
    expect(exportTargets('./dist/index.js')).toEqual(['./dist/index.js'])
  })

  // The manifest build-publish-dir actually generates.
  it('collects both leaves of a flat condition object', () => {
    expect(exportTargets({ import: './dist/index.js', require: './dist/index.cjs' }))
      .toEqual(['./dist/index.js', './dist/index.cjs'])
  })

  // #7210: reading only `.import` meant a require-only entry contributed no
  // targets and was silently dropped from the check.
  it('collects a require-only entry', () => {
    expect(exportTargets({ require: './dist/index.cjs' })).toEqual(['./dist/index.cjs'])
  })

  // #7212: condition maps nest arbitrarily, and a walker that stopped at depth
  // one reported success having verified nothing below it.
  it('descends nested condition objects to arbitrary depth', () => {
    expect(exportTargets({
      node: { import: './dist/node.js', require: './dist/node.cjs' },
      default: './dist/browser.js',
    })).toEqual(['./dist/node.js', './dist/node.cjs', './dist/browser.js'])

    expect(exportTargets({ a: { b: { c: { d: './deep.js' } } } })).toEqual(['./deep.js'])
  })

  it('collects every entry of a fallback array', () => {
    expect(exportTargets(['./a.js', './b.js'])).toEqual(['./a.js', './b.js'])
  })

  it('skips type-only conditions, which Node never resolves at runtime', () => {
    expect(exportTargets({ types: './dist/index.d.ts', import: './dist/index.js' }))
      .toEqual(['./dist/index.js'])
    expect(exportTargets({ typings: './dist/index.d.ts', import: './dist/index.js' }))
      .toEqual(['./dist/index.js'])
  })

  // The negative control for the case above: `types` must be filtered because
  // it is type-only, not because the walker happens to drop the first key.
  it('yields nothing for a types-only spec', () => {
    expect(exportTargets({ types: './dist/index.d.ts' })).toEqual([])
  })

  it('yields nothing for null or a non-target scalar', () => {
    expect(exportTargets(null)).toEqual([])
    expect(exportTargets(undefined)).toEqual([])
    expect(exportTargets(42)).toEqual([])
  })
})

describe('declaredTargets', () => {
  it('pairs every target with the subpath that declared it', () => {
    expect(declaredTargets({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './crypto': { types: './dist/crypto.d.ts', import: './dist/crypto.js' },
    })).toEqual([
      ['.', './dist/index.js'],
      ['./crypto', './dist/crypto.js'],
    ])
  })

  // `null` blocks a subpath — Node's documented mechanism, not a shape we
  // failed to read. Throwing here would fail the build on a VALID manifest,
  // and build:publish runs on every v* tag, so that blocks a release.
  it('treats a null subpath as blocked, not as an error', () => {
    expect(declaredTargets({ '.': './dist/index.js', './internal': null }))
      .toEqual([['.', './dist/index.js']])
  })

  it('deduplicates a target declared under several conditions', () => {
    expect(declaredTargets({ '.': { import: './dist/index.js', default: './dist/index.js' } }))
      .toEqual([['.', './dist/index.js']])
  })

  // The load-bearing one. "Cannot verify this export" and "there is nothing to
  // verify" are different answers, and conflating them is how the original bug
  // read as success — the build exited 0 having never mentioned the export.
  it('throws on a shape with no resolvable target, naming the shape', () => {
    expect(() => declaredTargets({ '.': { types: './dist/index.d.ts' } }))
      .toThrow(/no resolvable target.*index\.d\.ts/s)
    expect(() => declaredTargets({ '.': {} })).toThrow(/no resolvable target/)
    expect(() => declaredTargets({ '.': [] })).toThrow(/no resolvable target/)
  })
})

describe('resolveExportTarget', () => {
  const outDir = join(sep === '\\' ? 'C:\\repo' : '/repo', 'pkg', 'publish')

  it('resolves a manifest-relative target inside the staging dir', () => {
    const url = resolveExportTarget(outDir, '.', './dist/index.js')
    expect(fileURLToPath(url)).toBe(join(outDir, 'dist', 'index.js'))
  })

  // #7230 item 2. `join(outDir, '/')` is idempotent, `startsWith(outDir + sep)`
  // was not — so the two halves of one guard disagreed about outDir's shape and
  // a trailing separator made the check reject a correctly-resolved target.
  it('accepts the same target whether or not outDir has a trailing separator', () => {
    const withSep = resolveExportTarget(outDir + sep, '.', './dist/index.js')
    expect(fileURLToPath(withSep)).toBe(join(outDir, 'dist', 'index.js'))
  })

  // #7225's guarantee, and the reason the base URL keeps its trailing slash.
  // Without it every target resolves one level up, into packages/store-core/dist
  // — a real directory of real files, so an existence check is satisfied and the
  // verification proceeds against the wrong tree entirely.
  it('refuses a target that escapes the staging dir', () => {
    expect(() => resolveExportTarget(outDir, '.', '../dist/index.js'))
      .toThrow(/OUTSIDE the staging dir/)
    expect(() => resolveExportTarget(outDir, '.', '../../etc/passwd'))
      .toThrow(/OUTSIDE the staging dir/)
  })

  it('refuses a target that resolves to the staging dir itself', () => {
    expect(() => resolveExportTarget(outDir, '.', '.')).toThrow(/OUTSIDE the staging dir/)
  })

  // #7230 item 1. These used to reach fileURLToPath and die there with a bare
  // Node TypeError and a stack trace — ERR_INVALID_URL_SCHEME /
  // ERR_INVALID_FILE_URL_HOST. The exit code was right either way; the loss was
  // the diagnosis, so assert on the message, not just that it throws.
  it('gives its own error for an absolute non-file: target', () => {
    expect(() => resolveExportTarget(outDir, '.', 'https://evil.example/x.js'))
      .toThrow(/does not resolve to a file path/)
  })

  it('gives its own error for a protocol-relative target', () => {
    expect(() => resolveExportTarget(outDir, '.', '//host/x.js'))
      .toThrow(/does not resolve to a file path/)
  })

  it('does not leak a raw Node TypeError for either shape', () => {
    for (const target of ['https://evil.example/x.js', '//host/x.js']) {
      let caught
      try {
        resolveExportTarget(outDir, '.', target)
      } catch (err) {
        caught = err
      }
      expect(caught, `${target} should throw`).toBeDefined()
      expect(caught.code, `${target} leaked a Node error code`).toBeUndefined()
      expect(caught.message).toContain('manifest exports')
    }
  })
})

describe('needsJsonAttribute', () => {
  // #7220 item 2. `"./package.json": "./package.json"` is a common npm idiom
  // for version detection. It is not in store-core's manifest today, but if it
  // were, the derivation would produce it as a target and a plain dynamic
  // import would throw — reporting a broken entry point for a valid one.
  it('is true for a .json target', () => {
    expect(needsJsonAttribute('./package.json')).toBe(true)
  })

  it('is false for JS targets', () => {
    expect(needsJsonAttribute('./dist/index.js')).toBe(false)
    expect(needsJsonAttribute('./dist/index.cjs')).toBe(false)
    expect(needsJsonAttribute('./dist/index.mjs')).toBe(false)
  })

  // The behaviour that motivates the flag. If a future Node makes the attribute
  // optional this goes red and the special case can be dropped; until then it
  // pins WHY the branch exists rather than merely that it does.
  //
  // It has to run in a REAL node process. Vitest resolves dynamic imports
  // through Vite's pipeline, which handles JSON natively and does not require
  // the attribute at all — asserting in-process measured the test runner's
  // loader and reported that the import succeeded, which is the opposite of
  // what build-publish-dir hits when node runs it for real.
  it('a .json import without the attribute really does throw, under node (control)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-json-'))
    try {
      const file = join(dir, 'data.json')
      writeFileSync(file, '{"ok":true}\n')
      const href = pathToFileURL(file).href
      const probe = (attributes) => spawnSync(
        process.execPath,
        ['--input-type=module', '-e',
          `try { const m = await import(${JSON.stringify(href)}${attributes}); ` +
          "console.log('OK:' + JSON.stringify(m.default)) } catch (e) { console.log('THREW:' + e.message) }"],
        { encoding: 'utf8' },
      ).stdout.trim()

      expect(probe('')).toMatch(/^THREW:.*import attribute/)
      expect(probe(", { with: { type: 'json' } }")).toBe('OK:{"ok":true}')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// The whole point of the extraction: prove the real generated manifest still
// flows through the derivation unchanged. Everything above tests shapes that
// cannot occur today; this one tests the shape that does, so a refactor that
// broke the common case could not hide behind green edge-case tests.
describe('the manifest build-publish-dir actually generates', () => {
  it('derives exactly the two dist entry points', () => {
    const generated = {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './crypto': { types: './dist/crypto.d.ts', import: './dist/crypto.js' },
    }
    const declared = declaredTargets(generated)
    expect(declared).toEqual([
      ['.', './dist/index.js'],
      ['./crypto', './dist/crypto.js'],
    ])

    const staging = mkdtempSync(join(tmpdir(), 'chroxy-publish-'))
    try {
      mkdirSync(join(staging, 'dist'), { recursive: true })
      for (const [label, target] of declared) {
        const url = resolveExportTarget(staging, label, target)
        expect(fileURLToPath(url).startsWith(staging)).toBe(true)
        expect(needsJsonAttribute(target)).toBe(false)
      }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  })
})
