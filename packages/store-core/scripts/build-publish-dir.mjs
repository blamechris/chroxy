#!/usr/bin/env node
// build-publish-dir.mjs — assemble the publishable form of @chroxy/store-core.
//
// Why a staging directory instead of publishing the package in place.
//
// This package is consumed two different ways and they want different manifests:
//
//   - In the monorepo, `exports["."]` points at `src/index.ts`. 148 files across
//     packages/app and packages/dashboard import the root that way, and their
//     bundlers (Metro, Vite) resolve TypeScript directly. Keeping source
//     resolution is what makes editing store-core show up in those apps without
//     a rebuild.
//   - On npm, `src/index.ts` is useless: Node refuses to strip types under
//     node_modules ("Stripping types is currently unsupported for files under
//     node_modules"), so a published root export pointing at .ts cannot load.
//     The published manifest has to point at dist.
//
// The published 0.10.0 was built with exactly that transform, but the process
// lived outside the repo, so when it was lost the packaging silently regressed:
// `npm pack` fell back to .gitignore rules and shipped 59 raw *.test.ts files
// with a root export no Node consumer could import.
//
// The obvious fix — a prepack script that rewrites package.json and a postpack
// that restores it — leaves the working tree mutated if anything between them
// fails. Assembling a separate directory has no such failure mode: the source
// manifest is never touched, and the thing that gets published is exactly the
// thing this script wrote.
//
// Usage:  npm run build:publish -w @chroxy/store-core
//         npm publish packages/store-core/publish --access public

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

// The source imports siblings without a file extension (`from './types'`), which
// tsconfig's `moduleResolution: "bundler"` allows and Metro/Vite resolve happily.
// tsc never rewrites specifiers, so that style survives into dist — where Node's
// ESM loader rejects it (`ERR_UNSUPPORTED_DIR_IMPORT` / missing extension),
// making the published root export unimportable.
//
// The published 0.10.0 emits `from './types.js'`, so this rewrite existed then
// and was lost with the rest of the publish process. Without it the package
// installs fine and fails on first import — which is how the regression stayed
// invisible.
function addExtensions(dir) {
  const SPEC = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]*)\2/g
  let rewritten = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(js|d\.ts)$/.test(e.name)) continue
      const src = readFileSync(p, 'utf8')
      const out = src.replace(SPEC, (whole, kw, q, spec) => {
        if (/\.(js|json|mjs|cjs)$/.test(spec)) return whole // already explicit
        const base = resolve(dirname(p), spec)
        let fixed
        if (existsSync(`${base}.js`)) fixed = `${spec}.js`
        else if (existsSync(join(base, 'index.js'))) fixed = `${spec}/index.js`
        else return whole // leave bare specifiers and unresolvable paths alone
        rewritten++
        return `${kw}${q}${fixed}${q}`
      })
      if (out !== src) writeFileSync(p, out)
    }
  }
  walk(dir)
  return rewritten
}

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(pkgDir, 'publish')
const run = (cmd, args) => execFileSync(cmd, args, { cwd: pkgDir, stdio: 'inherit' })

// 1. Build dist from source, excluding tests. `postbuild-crypto` MUST run after
//    tsc: tsc re-emits dist/crypto.js with a named tweetnacl-util import that is
//    undefined at runtime, and the postbuild rewrites it back to a default
//    import. Skipping it is how dist/crypto.js "corrupts" — the file the server
//    actually imports.
run('npx', ['tsc', '-p', 'tsconfig.build.json'])
run('node', ['scripts/postbuild-crypto.mjs'])

const distIndex = join(pkgDir, 'dist', 'index.js')
const distCrypto = join(pkgDir, 'dist', 'crypto.js')
for (const f of [distIndex, distCrypto]) {
  if (!existsSync(f)) throw new Error(`build did not produce ${f}`)
}
if (!readFileSync(distCrypto, 'utf8').includes("import naclUtil from 'tweetnacl-util'")) {
  throw new Error('dist/crypto.js is missing the postbuild rewrite — it would fail at runtime')
}

// 2. Assemble the staging dir: dist + README + a dist-pointing manifest.
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
cpSync(join(pkgDir, 'dist'), join(outDir, 'dist'), { recursive: true })

// Rewrite specifiers in the STAGED copy, never in packages/store-core/dist —
// that tree holds the committed dist/crypto.js the monorepo builds against.
const rewrites = addExtensions(join(outDir, 'dist'))
console.log(`rewrote ${rewrites} extensionless relative specifier(s) for Node ESM`)
for (const f of ['README.md', 'LICENSE']) {
  if (existsSync(join(pkgDir, f))) cpSync(join(pkgDir, f), join(outDir, f))
}

const src = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const out = {
  name: src.name,
  version: src.version,
  description: src.description,
  license: src.license,
  type: src.type,
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    './crypto': { types: './dist/crypto.d.ts', import: './dist/crypto.js' },
  },
  dependencies: src.dependencies,
  peerDependencies: src.peerDependencies,
  engines: src.engines,
  repository: src.repository,
}
for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]

// The staging dir IS the package, so no `files` allowlist is needed — and none
// is wanted: a stray `files` here would be one more thing to keep in sync.
writeFileSync(join(outDir, 'package.json'), JSON.stringify(out, null, 2) + '\n')

// 3. Prove every entry point the generated manifest DECLARES actually loads
//    under Node before anyone publishes. This is the check whose absence let
//    0.11.0's packaging break silently: the tarball installed fine and only
//    failed on first import.
//
//    The targets are read back OUT of the manifest just written, not listed
//    here. A hardcoded literal list would import the known-good file directly
//    and print ✓ even when `exports` points somewhere wrong — so a typo or a
//    stale path after a refactor would sail through this check and fail only
//    for the npm consumer, who resolves through `exports` (#7197). Reading the
//    manifest also means a newly-added export is covered automatically instead
//    of silently falling outside the check.
const manifest = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'))
// Collect EVERY string leaf under an export's condition object, not just
// `.import`. A condition map can nest arbitrarily ({ node: { import: … },
// default: … }), and reading one known key meant a `require`-only or nested
// entry contributed no targets and was quietly dropped from `declared` — the
// same silent-skip this check exists to prevent, one level down (#7210).
//
// Not reachable with the manifest this script generates today, which only
// emits { types, import }. It is guarded anyway because the failure mode is
// invisible: the build exits 0 and simply never mentions the export.
// `types` is skipped deliberately: it is a TypeScript-only condition that Node
// never resolves at runtime. Importing a .d.ts "succeeds" and yields zero
// exports, so checking it would add a ✓ that means nothing — and a genuinely
// broken .d.ts would still pass it. Runtime conditions only.
const TYPE_ONLY_CONDITIONS = new Set(['types', 'typings'])

function exportTargets(spec) {
  if (typeof spec === 'string') return [spec]
  if (spec && typeof spec === 'object') {
    return Object.entries(spec)
      .filter(([condition]) => !TYPE_ONLY_CONDITIONS.has(condition))
      .flatMap(([, value]) => exportTargets(value))
  }
  return []
}

const declared = Object.entries(manifest.exports).flatMap(([label, spec]) => {
  // `null` is Node's documented way to BLOCK a subpath, not a shape we failed
  // to read. npm accepts the manifest and Node refuses the path at resolution
  // (ERR_PACKAGE_PATH_NOT_EXPORTED), so there is genuinely nothing to import
  // and nothing is wrong. Throwing here would fail the build on a valid
  // manifest — and `build:publish` runs in release.yml's verify-artifacts job
  // on every v* tag, so that would block a release rather than catch a bug.
  if (spec === null) return []

  const targets = [...new Set(exportTargets(spec))]
  // An export that yields no target at all is a shape this script cannot
  // check. Throw rather than filter it away — being unable to verify an
  // export is not the same as there being nothing to verify, and conflating
  // them is how the original bug read as success.
  if (!targets.length) {
    throw new Error(
      `manifest exports "${label}" in a shape with no resolvable target ` +
      `(${JSON.stringify(spec)}) — build-publish-dir cannot verify it`,
    )
  }
  return targets.map((target) => [label, target])
})

if (!declared.length) throw new Error('generated manifest declares no exports — nothing to verify')

for (const [label, target] of declared) {
  // `target` is manifest-relative ('./dist/index.js'), resolved against the
  // staging dir — the same base a consumer resolves it against. pathToFileURL
  // rather than a `file://` template: the template mangles Windows paths (drive
  // letters, backslashes) and anything needing percent-encoding, and this repo
  // runs Windows CI.
  const file = new URL(target, pathToFileURL(join(outDir, '/')))
  if (!existsSync(file)) {
    throw new Error(`manifest exports "${label}" -> ${target}, which does not exist in the package`)
  }
  try {
    await import(file.href)
    console.log(`  ✓ "${label}" -> ${target} imports under Node`)
  } catch (err) {
    throw new Error(`published "${label}" entry (${target}) fails to import: ${err.message}`)
  }
}

console.log(`built ${out.name}@${out.version} -> ${outDir}`)
console.log(`publish with: npm publish ${outDir} --access public`)
