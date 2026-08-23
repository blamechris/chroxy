/**
 * Drift guard for `@agentclientprotocol/sdk` (#7318, part of #7306).
 *
 * We depend on the SDK's default v1 entry point only — `experimental/*` is a
 * draft whose wire protocol and API "may change incompatibly in any SDK
 * release" per the SDK's own README, so it is out of bounds (last test below).
 * We also lean on the SDK's shipped `schema/schema.json` + `PROTOCOL_VERSION` +
 * `CLIENT_METHODS` / `AGENT_METHODS` constants instead of hand-rolling wire
 * types ourselves — which means the installed SDK IS the source of truth this
 * repo coded against, and a routine `npm update` could silently change its
 * shape underneath us with nothing else here noticing. That is the
 * "hardcoded copy beside a set that grows" shape from docs/false-safety-guards.md
 * (#7192, #7197), inverted: here the growing set is the dependency itself.
 *
 * This file compares the *installed* SDK's method surface + schema STRUCTURE
 * against a vendored snapshot (`../vendor/acp-schema.snapshot.json`) captured
 * at v1.4.0. A mismatch means either an unintentional SDK version drifted in,
 * or a deliberate bump that needs the snapshot regenerated — either way,
 * someone should look, not have it silently pass.
 *
 * The snapshot is deliberately NOT a full deep-equal of schema.json. The SDK
 * ships roughly monthly, and a full-content compare fails on every upstream
 * prose edit (a reworded `description`, a typo fix in `title`) exactly as
 * loudly as it fails on a real wire change — burying the signal (a renamed
 * method, an added required field) in noise nobody reads before approving a
 * 10,000-line regeneration diff. So the vendored snapshot instead captures
 * only what carries wire meaning:
 *
 *   - PROTOCOL_VERSION
 *   - CLIENT_METHODS / AGENT_METHODS, in full (keys AND values — a renamed
 *     wire method fails)
 *   - the sorted set of `$defs` type names (`defKeys`) — a type being added
 *     or removed fails
 *   - per non-trivial `$def`, its sorted `required` array and sorted
 *     property-name list (`defs`) — a renamed/added/removed property, or a
 *     property moving in or out of `required`, fails
 *
 * A `$def` with neither `properties` nor `required` (a `oneOf`/`anyOf` union
 * or a bare type alias — 58 of 265 in the schema this was captured against)
 * is omitted from `defs`; its continued existence is already covered by
 * `defKeys`, so an empty entry would carry no information. Anything else —
 * `description`, `title`, `x-method`/`x-side` annotations (redundant with the
 * method maps above), enum members, `oneOf`/`anyOf` branch shapes — is not
 * captured, and changes to it will NOT fail this test. That is deliberate.
 *
 * To regenerate after a DELIBERATE SDK version bump, run from packages/server/
 * (after `npm install`ing the new version there):
 *
 *   node --input-type=module <<'EOF'
 *   import { createRequire } from 'node:module'
 *   import { readFileSync, writeFileSync } from 'node:fs'
 *   import { dirname, join } from 'node:path'
 *   import * as acp from '@agentclientprotocol/sdk'
 *
 *   const require = createRequire(import.meta.url)
 *   const schemaPath = require.resolve('@agentclientprotocol/sdk/schema/schema.json')
 *   const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
 *   const pkgRoot = dirname(dirname(schemaPath))
 *   const sdkPkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
 *
 *   function sortedRequired(def) {
 *     return Array.isArray(def.required) ? [...def.required].sort() : []
 *   }
 *   function sortedPropertyNames(def) {
 *     return def.properties && typeof def.properties === 'object'
 *       ? Object.keys(def.properties).sort()
 *       : []
 *   }
 *   function buildDefsDigest(fullSchema) {
 *     const defs = fullSchema.$defs || {}
 *     const defKeys = Object.keys(defs).sort()
 *     const digest = {}
 *     for (const key of defKeys) {
 *       const required = sortedRequired(defs[key])
 *       const properties = sortedPropertyNames(defs[key])
 *       if (required.length === 0 && properties.length === 0) continue
 *       digest[key] = { required, properties }
 *     }
 *     return { defKeys, defs: digest }
 *   }
 *
 *   const { defKeys, defs } = buildDefsDigest(schema)
 *
 *   writeFileSync('vendor/acp-schema.snapshot.json', JSON.stringify({
 *     _meta: {
 *       note: "Structural surface snapshot of @agentclientprotocol/sdk, used by tests/acp-schema-drift.test.js (#7318) to detect drift between the installed SDK and what this repo coded against. Deliberately excludes prose (description/title/etc) so upstream doc-only edits don't fail this test -- only PROTOCOL_VERSION, the method maps, the set of $defs type names (defKeys), and each non-trivial type's required/property-name surface (defs) are captured. A $def with no properties and no required fields (a union or type alias) is omitted from `defs` -- its presence is already covered by `defKeys`. Regenerate ONLY when deliberately bumping the SDK version -- see the header comment in that test file for the regeneration command.",
 *       sdkVersion: sdkPkg.version,
 *     },
 *     protocolVersion: acp.PROTOCOL_VERSION,
 *     clientMethods: acp.CLIENT_METHODS,
 *     agentMethods: acp.AGENT_METHODS,
 *     defKeys,
 *     defs,
 *   }, null, 2) + '\n', 'utf8')
 *   EOF
 *
 * then review the diff before committing — the whole point of vendoring is that
 * the change is visible and deliberate rather than a silent `npm update`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as acp from '@agentclientprotocol/sdk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const VENDOR_SNAPSHOT_PATH = resolve(__dirname, '..', 'vendor', 'acp-schema.snapshot.json')
const SRC_DIR = resolve(__dirname, '..', 'src')
const SERVER_PACKAGE_JSON_PATH = resolve(__dirname, '..', 'package.json')

function loadSnapshot() {
  return JSON.parse(readFileSync(VENDOR_SNAPSHOT_PATH, 'utf8'))
}

// Resolved through the SDK's own `exports` map (only `./schema/schema.json` is
// exported alongside the default entry point), so this reads whatever is
// actually installed rather than assuming a fixed node_modules layout.
function loadInstalledSchema() {
  const schemaPath = require.resolve('@agentclientprotocol/sdk/schema/schema.json')
  return JSON.parse(readFileSync(schemaPath, 'utf8'))
}

function sortedRequired(def) {
  return Array.isArray(def.required) ? [...def.required].sort() : []
}

function sortedPropertyNames(def) {
  return def.properties && typeof def.properties === 'object'
    ? Object.keys(def.properties).sort()
    : []
}

// Mirrors the generator documented in this file's header comment. Kept as a
// standalone function (rather than importing anything from vendor/) so the
// test computes its own digest from whatever is actually installed, and
// compares that INDEPENDENTLY-COMPUTED digest against the vendored one —
// not, say, re-reading the vendored file's own shape back at itself.
function buildDefsDigest(schema) {
  const defs = schema.$defs || {}
  const defKeys = Object.keys(defs).sort()
  const digest = {}
  for (const key of defKeys) {
    const required = sortedRequired(defs[key])
    const properties = sortedPropertyNames(defs[key])
    if (required.length === 0 && properties.length === 0) continue
    digest[key] = { required, properties }
  }
  return { defKeys, defs: digest }
}

// Recursively collects source files under `dir`. There's no build output or
// vendored code under packages/server/src today, but the skip keeps this safe
// if that changes.
function collectSourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full))
    } else if (/\.(m?js|jsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe('@agentclientprotocol/sdk schema drift guard (#7318)', () => {
  it('packages/server/package.json depends on @agentclientprotocol/sdk, not the stale @zed-industries predecessor', () => {
    const pkgJson = JSON.parse(readFileSync(SERVER_PACKAGE_JSON_PATH, 'utf8'))
    const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies }
    assert.equal(
      allDeps['@agentclientprotocol/sdk'],
      '^1.4.0',
      'packages/server/package.json must depend on @agentclientprotocol/sdk@^1.4.0',
    )
    assert.ok(
      !('@zed-industries/agent-client-protocol' in allDeps),
      'packages/server/package.json must not depend on the stale @zed-industries/agent-client-protocol predecessor',
    )
  })

  it('installed PROTOCOL_VERSION matches the vendored snapshot', () => {
    const snapshot = loadSnapshot()
    assert.equal(
      acp.PROTOCOL_VERSION,
      snapshot.protocolVersion,
      `installed @agentclientprotocol/sdk PROTOCOL_VERSION (${acp.PROTOCOL_VERSION}) no longer matches the vendored snapshot (${snapshot.protocolVersion}, captured at sdk@${snapshot._meta.sdkVersion}). If this is a deliberate SDK bump, regenerate packages/server/vendor/acp-schema.snapshot.json — see this file's header comment. Otherwise an unexpected SDK version was installed.`,
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

  it('installed schema/schema.json structural surface (defKeys + per-def required/properties) matches the vendored snapshot', () => {
    const snapshot = loadSnapshot()
    const installedSchema = loadInstalledSchema()
    const installedDigest = buildDefsDigest(installedSchema)
    assert.deepEqual(
      installedDigest.defKeys,
      snapshot.defKeys,
      "installed @agentclientprotocol/sdk schema.json's set of $defs type names diverged from the vendored snapshot — a type was added or removed. See this file's header comment to regenerate after a deliberate SDK bump.",
    )
    assert.deepEqual(
      installedDigest.defs,
      snapshot.defs,
      "installed @agentclientprotocol/sdk schema.json's per-type required/property surface diverged from the vendored snapshot — see this file's header comment to regenerate after a deliberate SDK bump.",
    )
  })

  it('never imports an experimental/* ACP entry point or the stale @zed-industries predecessor', () => {
    const offenders = []
    for (const file of collectSourceFiles(SRC_DIR)) {
      const content = readFileSync(file, 'utf8')
      if (content.includes('@zed-industries/agent-client-protocol')) {
        offenders.push(`${file}: references the stale @zed-industries/agent-client-protocol package`)
      }
      if (/@agentclientprotocol\/sdk\/experimental/.test(content)) {
        offenders.push(`${file}: imports an experimental/* ACP entry point`)
      }
    }
    assert.deepEqual(offenders, [], `forbidden ACP reference(s) found:\n${offenders.join('\n')}`)
  })
})
