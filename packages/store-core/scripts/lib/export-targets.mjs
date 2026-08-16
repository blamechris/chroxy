// export-targets.mjs — read a package manifest's `exports` and say which files
// a consumer could actually import.
//
// Extracted from build-publish-dir.mjs (#7220). That script runs `tsc` at module
// scope, so importing it to test this logic would rebuild the package as a side
// effect — which is why this derivation went four PRs (#7197, #7210, #7212,
// #7225) with no test coverage at all, verified only by hand in PR descriptions.
// Every one of those PRs fixed a "check reports success without actually
// checking" defect in these same twenty lines. They are here so they can be
// tested directly.
//
// The shapes are Node's, not ours: `exports` values may be strings, condition
// objects nested arbitrarily deep, fallback arrays, or `null`.

import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// `types` is skipped deliberately: it is a TypeScript-only condition that Node
// never resolves at runtime. Importing a .d.ts "succeeds" and yields zero
// exports, so checking it would add a ✓ that means nothing — and a genuinely
// broken .d.ts would still pass it. Runtime conditions only.
export const TYPE_ONLY_CONDITIONS = new Set(['types', 'typings'])

/**
 * Every string leaf under an export's spec, in declaration order.
 *
 * Collecting EVERY leaf rather than reading a known key is the #7210 fix: a
 * condition map can nest arbitrarily ({ node: { import: … }, default: … }), and
 * reading only `.import` meant a `require`-only or nested entry contributed no
 * targets and was quietly dropped — the same silent skip the self-check exists
 * to prevent, one level down.
 *
 * Arrays ARE valid here — Node treats them as a fallback list and resolves the
 * first entry whose conditions match. They fall through to the object branch via
 * Object.entries, which collects every string leaf.
 *
 * Known over-strictness: for a genuine fallback array Node needs only ONE entry
 * to resolve, whereas this collects all of them, so a caller that verifies each
 * would fail on a manifest Node accepts. Left as-is deliberately —
 * build-publish-dir GENERATES the manifest it checks and only ever emits
 * { types, import }, so an array cannot occur without someone editing the
 * generator, at which point an over-strict failure is a loud prompt to revisit
 * this rather than a silent wrong answer.
 */
export function exportTargets(spec) {
  if (typeof spec === 'string') return [spec]
  if (spec && typeof spec === 'object') {
    return Object.entries(spec)
      .filter(([condition]) => !TYPE_ONLY_CONDITIONS.has(condition))
      .flatMap(([, value]) => exportTargets(value))
  }
  return []
}

/**
 * `[label, target]` pairs for every importable entry point a manifest declares.
 *
 * @param {Record<string, unknown>} exportsMap - the manifest's `exports` field
 * @returns {Array<[string, string]>}
 */
export function declaredTargets(exportsMap) {
  return Object.entries(exportsMap).flatMap(([label, spec]) => {
    // `null` is Node's documented way to BLOCK a subpath, not a shape we failed
    // to read. npm accepts the manifest and Node refuses the path at resolution
    // (ERR_PACKAGE_PATH_NOT_EXPORTED), so there is genuinely nothing to import
    // and nothing is wrong. Throwing here would fail the build on a valid
    // manifest — and `build:publish` runs in release.yml's verify-artifacts job
    // on every v* tag, so that would block a release rather than catch a bug.
    if (spec === null) return []

    const targets = [...new Set(exportTargets(spec))]
    // An export that yields no target at all is a shape this cannot check.
    // Throw rather than filter it away — being unable to verify an export is
    // not the same as there being nothing to verify, and conflating them is how
    // the original bug read as success.
    if (!targets.length) {
      throw new Error(
        `manifest exports "${label}" in a shape with no resolvable target ` +
        `(${JSON.stringify(spec)}) — build-publish-dir cannot verify it`,
      )
    }
    return targets.map((target) => [label, target])
  })
}

/**
 * Resolve a manifest-relative target against the staging dir, as a consumer
 * would, and refuse anything that escapes it.
 *
 * The `join(outDir, '/')` is load-bearing, not decorative. WHATWG URL
 * resolution reads a base's trailing slash as the directory/file boundary: a
 * relative reference APPENDS to a base ending in '/', and REPLACES the last
 * segment otherwise. Drop it and every target resolves one level up:
 *
 *   base .../store-core/publish/  + ./dist/index.js -> .../publish/dist/index.js
 *   base .../store-core/publish   + ./dist/index.js -> .../store-core/dist/index.js
 *
 * That second path is packages/store-core/dist — a real directory of real
 * files, so an existence check is satisfied and the verification proceeds
 * against the wrong tree entirely (#7211). The containment check below turns
 * "someone simplified the base URL" from a silent wrong answer into a loud one
 * (#7225).
 *
 * pathToFileURL rather than a `file://` template: the template mangles Windows
 * paths (drive letters, backslashes) and anything needing percent-encoding, and
 * this repo runs Windows CI.
 *
 * @param {string} outDir - absolute path to the staging directory
 * @param {string} label - the manifest subpath, for error messages
 * @param {string} target - the manifest-relative target ('./dist/index.js')
 * @returns {URL}
 */
export function resolveExportTarget(outDir, label, target) {
  const file = new URL(target, pathToFileURL(join(outDir, '/')))

  // A target fileURLToPath cannot convert used to die there with a bare Node
  // TypeError and a stack trace (#7230). The exit code was right either way;
  // what was lost was the diagnosis, so this refuses it first — and checking
  // the PROTOCOL alone is not enough, because two different shapes get there:
  //
  //   'https://evil.example/x.js' -> https://evil.example/x.js -> ERR_INVALID_URL_SCHEME
  //   '//host/x.js'               -> file://host/x.js         -> ERR_INVALID_FILE_URL_HOST
  //
  // The second is a protocol-RELATIVE reference: it inherits the base's scheme,
  // so its protocol IS 'file:' and only the host distinguishes it. A local path
  // has an empty host; fileURLToPath additionally tolerates 'localhost'.
  const localHost = file.hostname === '' || file.hostname === 'localhost'
  if (file.protocol !== 'file:' || !localHost) {
    throw new Error(
      `manifest exports "${label}" -> ${target} does not resolve to a file path ` +
      `(${file.href}) — build-publish-dir can only verify local files`,
    )
  }

  const filePath = fileURLToPath(file)
  // `relative()` rather than `startsWith(outDir + sep)`. The two halves of this
  // guard have to agree about outDir's shape: `join(outDir, '/')` above is
  // idempotent — same base whether or not outDir already ends in a separator —
  // but `startsWith(outDir + sep)` is not, and rejected a correctly-resolved
  // target whenever outDir carried a trailing separator (#7230). This form
  // tolerates both, and is case-insensitive on win32 into the bargain.
  const rel = relative(outDir, filePath)
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error(
      `manifest exports "${label}" -> ${target} resolved to ${filePath}, which is OUTSIDE ` +
      `the staging dir (${outDir}). The base URL must keep its trailing separator, or the ` +
      'self-check verifies the wrong files.',
    )
  }
  return file
}

/**
 * True when a target must be imported with `{ with: { type: 'json' } }`.
 *
 * `"./package.json": "./package.json"` is a common npm idiom for version
 * detection. It is not in store-core's manifest today, but if it were added the
 * derivation above would happily produce it as a target and the plain
 * `await import()` in the self-check would throw
 * `TypeError: … needs an import attribute of "type: json"` — reporting a broken
 * entry point for a perfectly valid one (#7220).
 */
export function needsJsonAttribute(target) {
  return target.endsWith('.json')
}
