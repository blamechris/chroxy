#!/usr/bin/env node
/**
 * strip-server-package-json.mjs — rewrite a STAGED copy of
 * packages/server/package.json into the form the desktop bundle installs from.
 *
 * ONE IMPLEMENTATION, TWO CALLERS (#7985)
 * ---------------------------------------
 * bundle-server.sh (the release artifact) and check-derived-lockfile.sh (the
 * PR-time `npm ci` acceptance check) both call this. The strip used to be an
 * inline `node -e` inside bundle-server.sh; a check that re-typed it would be
 * a second hand-written reading of what ships and would drift from it
 * (docs/false-safety-guards.md: "testing the source tree when the artifact is
 * what ships").
 *
 * What is stripped, and why:
 *   - `@chroxy/*` dependencies: workspace packages, copied in manually after
 *     `npm ci` (the derived lockfile never contains them).
 *   - `devDependencies`: `npm ci` validates them against the lockfile even
 *     with --omit=dev, and the derived lockfile covers only the production
 *     closure (#7324).
 *   - `scripts.postinstall`: fix-node-pty-helper.js lives under
 *     packages/server/scripts/, which is not staged; build.rs handles the
 *     node-pty chmod + codesign at bundle time (#3902).
 *
 * CLI: node strip-server-package-json.mjs <path/to/staged/package.json>
 *      (rewrites the file in place; exits non-zero on any failure)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { isEntryPoint } from '../../../scripts/lib/is-entry-point.mjs'

export function stripServerPackageJson(pkg) {
  for (const key of Object.keys(pkg.dependencies || {})) {
    if (key.startsWith('@chroxy/')) delete pkg.dependencies[key]
  }
  delete pkg.devDependencies
  if (pkg.scripts) delete pkg.scripts.postinstall
  return pkg
}

function main() {
  const file = process.argv[2]
  if (!file || process.argv.length !== 3) {
    console.error('Usage: strip-server-package-json.mjs <staged package.json>')
    process.exit(2)
  }
  const pkg = stripServerPackageJson(JSON.parse(readFileSync(file, 'utf8')))
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
}

if (isEntryPoint(import.meta.url)) main()
