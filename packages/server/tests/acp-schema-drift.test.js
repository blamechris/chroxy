/**
 * Drift guard for `@agentclientprotocol/sdk` (#7318, part of #7306).
 *
 * We depend on the SDK's default v1 entry point only — `experimental/*` is a
 * draft whose wire protocol and API "may change incompatibly in any SDK
 * release" per the SDK's own README. That ban is enforced separately, by
 * `scripts/lint-acp-imports.mjs` (a repo-tree walk, not a `node:test` file —
 * see `tests/lint-acp-imports.test.js` for its own committed proof).
 *
 * This file proves two DIFFERENT things stay true, and they compose:
 *
 * 1. The installed SDK version IS what this repo vendored a snapshot against.
 *    `packages/server/package.json` pins `@agentclientprotocol/sdk` EXACT (no
 *    caret) precisely so this is a fact about `npm install`, not a range that
 *    could silently resolve upward. The first test below asserts the
 *    RESOLVED, installed package's own `version` — not just the manifest
 *    string — equals `vendor/acp-schema.snapshot.json`'s `_meta.sdkVersion`.
 *    Without this, every comparison below it is comparing the vendored
 *    snapshot against SOME installed SDK, never provably the right one — a
 *    `node_modules` version mismatch (a bad `npm i`, a hand-edited lockfile)
 *    would sail through silently. This is the tripwire; everything else is a
 *    diagnostic aid once it holds.
 * 2. Given that version match, the installed SDK's method surface and schema
 *    STRUCTURE match the vendored snapshot. "Structure", not full content: a
 *    full deep-equal of `schema.json` fails on every upstream prose edit (a
 *    reworded `description`, a `title` typo fix) exactly as loudly as it
 *    fails on a real wire change, burying a renamed method or an added
 *    required field in a regeneration diff nobody reads closely. The digest
 *    logic — what counts as "structural" and what does not — lives in
 *    `scripts/lib/acp-schema-digest.mjs`, imported here AND by
 *    `scripts/regen-acp-snapshot.mjs`, so there is exactly one implementation
 *    rather than a live copy and a stale copy embedded in a comment.
 *
 * To regenerate the vendored snapshot after a DELIBERATE SDK version bump:
 *
 *   cd packages/server
 *   npm install @agentclientprotocol/sdk@<exact-version>
 *   node scripts/regen-acp-snapshot.mjs
 *
 * then review the diff before committing — the whole point of vendoring is
 * that the change is visible and deliberate rather than a silent float.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as acp from '@agentclientprotocol/sdk'
import { buildDefsDigest, buildRootAnyOfDigest } from '../scripts/lib/acp-schema-digest.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const VENDOR_SNAPSHOT_PATH = resolve(__dirname, '..', 'vendor', 'acp-schema.snapshot.json')
const SERVER_PACKAGE_JSON_PATH = resolve(__dirname, '..', 'package.json')

// Built by concatenation, not spelled as one contiguous literal, so this file
// does not fail scripts/lint-acp-imports.mjs's own scan of tests/ — see that
// file's "A note on this file's own text" for the same technique.
const ZED_PREDECESSOR = '@zed-industries' + '/agent-client-protocol'

function loadSnapshot() {
  return JSON.parse(readFileSync(VENDOR_SNAPSHOT_PATH, 'utf8'))
}

// Resolved through the SDK's own `exports` map (only `./schema/schema.json` is
// exported alongside the default entry point), so this reads whatever is
// actually installed rather than assuming a fixed node_modules layout.
function resolveInstalledSchemaPath() {
  return require.resolve('@agentclientprotocol/sdk/schema/schema.json')
}

function loadInstalledSchema() {
  return JSON.parse(readFileSync(resolveInstalledSchemaPath(), 'utf8'))
}

// The SDK's exports map does not expose "./package.json" (only the entry
// points it intends to be imported are listed), so the installed package's
// OWN version is read by walking up from the schema path instead — the same
// technique scripts/regen-acp-snapshot.mjs uses, so the two agree on what
// "the installed version" means.
function loadInstalledSdkPackageJson() {
  const schemaPath = resolveInstalledSchemaPath()
  const pkgRoot = dirname(dirname(schemaPath))
  return JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
}

describe('@agentclientprotocol/sdk schema drift guard (#7318)', () => {
  it('packages/server/package.json pins @agentclientprotocol/sdk exactly to the vendored snapshot version, in dependencies, not the stale @zed-industries predecessor', () => {
    const snapshot = loadSnapshot()
    const pkgJson = JSON.parse(readFileSync(SERVER_PACKAGE_JSON_PATH, 'utf8'))
    const deps = pkgJson.dependencies || {}
    const devDeps = pkgJson.devDependencies || {}

    // dependencies, not devDependencies: #7319 landed `src/acp-session.js`,
    // which does a static top-level `import * as acp from
    // '@agentclientprotocol/sdk'` and is reached from `server-cli.js` — the
    // `chroxy start` entry point — whether or not `providers.acp` is
    // configured. A devDependency is exactly what `npm ci --omit=dev`
    // strips: the global install (`npm install -g @chroxy/server` /
    // `npx chroxy`), `Dockerfile`'s `npm ci --workspace=@chroxy/server
    // --omit=dev`, and packages/desktop/scripts/bundle-server.sh's
    // `npm install --omit=dev` into the Tauri-bundled, Apple-notarized app
    // would all install without it, and the daemon would die on
    // `ERR_MODULE_NOT_FOUND` at module load — before any provider-specific
    // code even runs. The premise this assertion originally encoded ("nothing
    // outside tests/ imports the SDK") no longer holds; asserting the
    // opposite of what actually ships is worse than asserting nothing, so
    // this flips with the dependency move rather than being deleted.
    assert.ok(
      '@agentclientprotocol/sdk' in deps,
      'packages/server/package.json must list @agentclientprotocol/sdk in dependencies — src/acp-session.js imports it at runtime from the chroxy start entry point (server-cli.js), so it has to ship in every install path (npm ci --omit=dev, the Docker image, the Tauri bundle). Move it out of devDependencies.',
    )
    assert.ok(
      !('@agentclientprotocol/sdk' in devDeps),
      'packages/server/package.json must not ALSO list @agentclientprotocol/sdk in devDependencies — a dependency listed in both is redundant and invites the two copies to drift on the next version bump.',
    )
    // Pinned EXACT (no ^, no ~): an upgrade is then always a deliberate
    // `npm install @agentclientprotocol/sdk@<version>` edit, never a caret
    // silently floating to a version this snapshot was never captured
    // against. The expected value is DERIVED from the snapshot's own
    // _meta.sdkVersion rather than a second hardcoded literal here — the
    // exact shape docs/false-safety-guards.md warns about, a hardcoded copy
    // beside a value that legitimately changes over time.
    assert.equal(
      deps['@agentclientprotocol/sdk'],
      snapshot._meta?.sdkVersion,
      `packages/server/package.json's dependencies["@agentclientprotocol/sdk"] must be pinned EXACTLY to the vendored snapshot's sdkVersion (${snapshot._meta?.sdkVersion}), with no ^ or ~ range operator.`,
    )
    assert.ok(
      !(ZED_PREDECESSOR in deps) && !(ZED_PREDECESSOR in devDeps),
      `packages/server/package.json must not depend on the stale ${ZED_PREDECESSOR} predecessor`,
    )
  })

  it('the INSTALLED @agentclientprotocol/sdk resolves to the version the vendored snapshot was captured against', () => {
    // This is the tripwire the rest of this file leans on. Without it, every
    // comparison below is only ever proven against SOME installed SDK, never
    // provably the one the snapshot describes — a node_modules mismatch
    // (a bad install, a hand-edited lockfile, a stale global link) would
    // pass every other test here silently.
    const snapshot = loadSnapshot()
    const installedPkg = loadInstalledSdkPackageJson()
    assert.equal(
      installedPkg.name,
      '@agentclientprotocol/sdk',
      `resolved node_modules package is "${installedPkg.name}", not @agentclientprotocol/sdk`,
    )
    assert.equal(
      installedPkg.version,
      snapshot._meta?.sdkVersion,
      `installed @agentclientprotocol/sdk resolves to version ${installedPkg.version}, but the vendored snapshot (packages/server/vendor/acp-schema.snapshot.json) was captured against ${snapshot._meta?.sdkVersion}. If this is a deliberate bump, regenerate the snapshot — see this file's header comment. Otherwise node_modules has the wrong version installed regardless of what package.json declares.`,
    )
  })

  it('installed PROTOCOL_VERSION matches the vendored snapshot', () => {
    const snapshot = loadSnapshot()
    assert.equal(
      acp.PROTOCOL_VERSION,
      snapshot.protocolVersion,
      `installed @agentclientprotocol/sdk PROTOCOL_VERSION (${acp.PROTOCOL_VERSION}) no longer matches the vendored snapshot (${snapshot.protocolVersion}). See this file's header comment to regenerate after a deliberate SDK bump.`,
    )
  })

  it('installed CLIENT_METHODS matches the vendored snapshot', () => {
    const snapshot = loadSnapshot()
    assert.deepEqual(
      acp.CLIENT_METHODS,
      snapshot.clientMethods,
      "installed @agentclientprotocol/sdk CLIENT_METHODS diverged from the vendored snapshot — see this file's header comment to regenerate after a deliberate SDK bump.",
    )
  })

  it('installed AGENT_METHODS matches the vendored snapshot', () => {
    const snapshot = loadSnapshot()
    assert.deepEqual(
      acp.AGENT_METHODS,
      snapshot.agentMethods,
      "installed @agentclientprotocol/sdk AGENT_METHODS diverged from the vendored snapshot — see this file's header comment to regenerate after a deliberate SDK bump.",
    )
  })

  it('installed PROTOCOL_METHODS matches the vendored snapshot', () => {
    const snapshot = loadSnapshot()
    assert.deepEqual(
      acp.PROTOCOL_METHODS,
      snapshot.protocolMethods,
      "installed @agentclientprotocol/sdk PROTOCOL_METHODS diverged from the vendored snapshot — see this file's header comment to regenerate after a deliberate SDK bump.",
    )
  })

  it('installed runtime export names match the vendored snapshot', () => {
    const snapshot = loadSnapshot()
    const installedExportNames = Object.keys(acp).sort()
    assert.deepEqual(
      installedExportNames,
      snapshot.exportNames,
      "installed @agentclientprotocol/sdk's runtime export names diverged from the vendored snapshot (something was renamed, added, or removed) — see this file's header comment to regenerate after a deliberate SDK bump.",
    )
  })

  it('installed schema/schema.json structural surface (defKeys + per-def digest) matches the vendored snapshot', () => {
    const snapshot = loadSnapshot()
    const installedSchema = loadInstalledSchema()
    const installed = buildDefsDigest(installedSchema)
    assert.deepEqual(
      installed.defKeys,
      snapshot.defKeys,
      "installed @agentclientprotocol/sdk schema.json's set of $defs type names diverged from the vendored snapshot — a type was added or removed. See this file's header comment to regenerate after a deliberate SDK bump.",
    )
    assert.deepEqual(
      installed.defs,
      snapshot.defs,
      "installed @agentclientprotocol/sdk schema.json's per-type digest (required fields, typed properties, const/enum members, discriminator) diverged from the vendored snapshot — see this file's header comment to regenerate after a deliberate SDK bump.",
    )
  })

  it("installed schema/schema.json's root anyOf union matches the vendored snapshot", () => {
    const snapshot = loadSnapshot()
    const installedSchema = loadInstalledSchema()
    const installedRootAnyOf = buildRootAnyOfDigest(installedSchema)
    assert.deepEqual(
      installedRootAnyOf,
      snapshot.rootAnyOf,
      "installed @agentclientprotocol/sdk schema.json's root anyOf (the request/response/notification union) diverged from the vendored snapshot — see this file's header comment to regenerate after a deliberate SDK bump.",
    )
  })
})
