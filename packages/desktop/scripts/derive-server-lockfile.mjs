#!/usr/bin/env node
/**
 * derive-server-lockfile.mjs — build a standalone, `npm ci`-able lockfile for
 * packages/server's PRODUCTION dependency closure, computed from the repo's
 * root package-lock.json.
 *
 * WHY THIS EXISTS (#7324)
 * -----------------------
 * packages/server/package-lock.json used to be a committed, hand-maintained
 * copy that npm never regenerates inside an npm-workspaces monorepo (`npm
 * install` always writes the ROOT lockfile). It silently drifted — missing
 * ~55 transitive entries, `npm ci` failed against it outright — and because
 * it ships inside the desktop app bundle (packages/desktop/scripts/bundle-server.sh),
 * security bumps landing in the root lockfile never reached the release
 * artifact. See the issue for the full incident history.
 *
 * The fix: delete the committed file and derive it at build time from the
 * root lockfile, which Renovate and `npm install` actually keep fresh.
 *
 * ALGORITHM
 * ---------
 * 1. Start from the staged package.json's `dependencies` +
 *    `optionalDependencies` (the caller has already stripped `@chroxy/*` and
 *    `devDependencies` — see bundle-server.sh). Resolve each name with real
 *    Node module resolution semantics, walking up from `--workspace` through
 *    the root lockfile's flat `packages` map.
 * 2. BFS the transitive closure over `dependencies`, `optionalDependencies`,
 *    and non-optional `peerDependencies` of every instance found. A missing
 *    required dependency throws (with the chain); a missing optional one is
 *    skipped.
 * 3. Place the closure into a NEW tree rooted at the staging directory.
 *    Because a package can be nested under `packages/server/node_modules/X`
 *    in the root lockfile specifically to avoid conflicting with a
 *    DIFFERENT version hoisted to the monorepo's real root, naively
 *    stripping the `packages/server/` prefix can collide two unrelated
 *    instances onto the same new key. Placement is therefore redone from
 *    scratch: greedy, shallow-first (BFS by requirer depth), each edge
 *    hoisted as high as it can go without colliding with an
 *    already-placed different instance, and never allowed to shadow an
 *    already-placed descendant's own (already-satisfied) resolution.
 * 4. The result is independently VERIFIED by re-resolving every edge in the
 *    new tree and asserting it lands on the intended instance
 *    (version + resolved + integrity). Any mismatch throws — this script
 *    fails loudly rather than emit a lockfile `npm ci` would silently
 *    misinstall from.
 *
 * A workspace package (`@chroxy/protocol`, `@chroxy/store-core`, …) must
 * never appear in the output: the caller strips `@chroxy/*` from the staged
 * package.json before calling this, and if resolution ever DOES land on a
 * workspace (via a `link: true` entry, or directly), this throws rather than
 * silently including it.
 *
 * CLI:
 *   node derive-server-lockfile.mjs \
 *     --root-lock <repo>/package-lock.json \
 *     --package-json <staged>/package.json \
 *     --workspace packages/server \
 *     --out <staged>/package-lock.json
 *
 * The core algorithm is also exported as `deriveServerLockfile` for tests.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { isEntryPoint } from '../../../scripts/lib/is-entry-point.mjs'

const NM = 'node_modules/'

/**
 * Split a lockfile location key into the location one level up (`parent`)
 * and the package `name` installed at this level, using the LAST
 * `node_modules/` segment as the boundary.
 *
 *   "packages/server/node_modules/x"        -> { parent: "packages/server", name: "x" }
 *   "node_modules/a/node_modules/b"         -> { parent: "node_modules/a", name: "b" }
 *   "node_modules/x"                        -> { parent: "", name: "x" }
 *   "packages/server" | ""                  -> null (no node_modules segment)
 */
function splitLocation(loc) {
  const idx = loc.lastIndexOf(NM)
  if (idx === -1) return null
  const parent = idx === 0 ? '' : loc.slice(0, idx - 1)
  const name = loc.slice(idx + NM.length)
  return { parent, name }
}

/**
 * The ordered list of locations Node module resolution would check for a
 * dependency required from `loc`, nearest first, root (`""`) last. Mirrors
 * `NODE_MODULES_PATHS` restricted to the node_modules-boundary shape every
 * npm-managed lockfile location actually has (see the issue: "walk the key
 * path").
 */
function ancestors(loc) {
  const result = [loc]
  let cur = loc
  for (;;) {
    const split = splitLocation(cur)
    if (split === null) {
      if (cur !== '') result.push('')
      break
    }
    result.push(split.parent)
    cur = split.parent
  }
  return result
}

/** The lockfile `packages` key for `name` installed directly under `loc`. */
function keyFor(loc, name) {
  return loc === '' ? `${NM}${name}` : `${loc}/${NM}${name}`
}

/** True for a top-level workspace location ("packages/<name>"), never a node_modules path. */
function isWorkspaceKey(key) {
  return key !== '' && !key.includes(NM) && /^packages\/[^/]+$/.test(key)
}

/**
 * Resolve `name` from `loc` in the root lockfile's `packages` map, following
 * `link: true` entries to their real target. Returns `{ key, entry }` for
 * the REAL (non-link) entry, or `null` if nothing on the search path has it.
 * Throws if a link ever resolves to a workspace package — the closure must
 * never contain one.
 */
function resolveReal(packages, loc, name, chainForError) {
  let foundKey = null
  for (const cand of ancestors(loc)) {
    const key = keyFor(cand, name)
    if (Object.prototype.hasOwnProperty.call(packages, key)) {
      foundKey = key
      break
    }
  }
  if (foundKey === null) return null

  let realKey = foundKey
  let entry = packages[realKey]
  const seen = new Set()
  while (entry && entry.link === true) {
    if (seen.has(realKey)) {
      throw new Error(
        `circular "link" entries resolving "${name}" from "${loc}" (chain: ${chainForError.concat(name).join(' -> ')})`,
      )
    }
    seen.add(realKey)
    const target = entry.resolved
    if (typeof target !== 'string' || !Object.prototype.hasOwnProperty.call(packages, target)) {
      throw new Error(
        `"link" entry at "${realKey}" has no valid resolved target (needed by ${chainForError.concat(name).join(' -> ')})`,
      )
    }
    if (isWorkspaceKey(target)) {
      throw new Error(
        `dependency chain ${chainForError.concat(name).join(' -> ')} resolves to workspace package "${target}" — ` +
          'the derived server lockfile must never contain a workspace package',
      )
    }
    realKey = target
    entry = packages[realKey]
  }
  if (isWorkspaceKey(realKey)) {
    throw new Error(
      `dependency chain ${chainForError.concat(name).join(' -> ')} resolves to workspace package "${realKey}" — ` +
        'the derived server lockfile must never contain a workspace package',
    )
  }
  return { key: realKey, entry }
}

/**
 * The (name, optional) edges a lockfile entry declares: `dependencies`,
 * `optionalDependencies`, and non-optional `peerDependencies`
 * (`peerDependenciesMeta[name].optional === true` marks a peer optional).
 * A name declared both required and optional is treated as required.
 * Sorted by name for deterministic BFS/placement order.
 */
function ownEdgeNames(entry) {
  const optionalByName = new Map()
  const set = (name, optional) => {
    if (optionalByName.has(name)) {
      if (!optional) optionalByName.set(name, false)
    } else {
      optionalByName.set(name, optional)
    }
  }
  for (const name of Object.keys(entry.dependencies || {})) set(name, false)
  for (const name of Object.keys(entry.optionalDependencies || {})) set(name, true)
  const peerMeta = entry.peerDependenciesMeta || {}
  for (const name of Object.keys(entry.peerDependencies || {})) {
    set(name, peerMeta[name]?.optional === true)
  }
  return [...optionalByName.entries()]
    .map(([name, optional]) => ({ name, optional }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

const ROOT_ID = '\u0000root'

/**
 * Phase 1: resolve the full production dependency closure of `workspace`
 * against the root lockfile's `packages` map, using real node-resolution
 * semantics. Returns:
 *   - edgesByRequirer: Map<requirerId, Array<{name, key, optional}>>
 *       requirerId is ROOT_ID for the staged package.json itself, or a root
 *       lockfile key for every other instance in the closure.
 *   - instanceEntries: Map<key, entry> — the (deep-cloned) root lockfile
 *       entry for every instance key that appears as an edge target.
 *   - requiredReachable: Set<key> — instances reachable from root using
 *       only non-optional edges (everything else is optional-only).
 */
function resolveClosure(packages, workspace, packageJson) {
  const edgesByRequirer = new Map()
  const instanceEntries = new Map()
  const visited = new Set()
  const queue = []

  const rootEdges = []
  for (const { name, optional } of ownEdgeNames({
    dependencies: packageJson.dependencies,
    optionalDependencies: packageJson.optionalDependencies,
  })) {
    const resolved = resolveReal(packages, workspace, name, [ROOT_ID])
    if (resolved === null) {
      if (optional) continue
      throw new Error(
        `cannot resolve required dependency "${name}" of "${workspace}" in the root lockfile ` +
          `(chain: ${ROOT_ID} -> ${name})`,
      )
    }
    rootEdges.push({ name, key: resolved.key, optional })
    if (resolved.key.startsWith('@chroxy/') || (resolved.entry.name || '').startsWith('@chroxy/')) {
      throw new Error(`dependency "${name}" resolved to a @chroxy/* workspace package ("${resolved.key}")`)
    }
    if (!visited.has(resolved.key)) {
      visited.add(resolved.key)
      instanceEntries.set(resolved.key, resolved.entry)
      queue.push({ key: resolved.key, entry: resolved.entry, chain: [ROOT_ID, name] })
    }
  }
  edgesByRequirer.set(ROOT_ID, rootEdges)

  while (queue.length > 0) {
    const { key, entry, chain } = queue.shift()
    const edges = []
    for (const { name, optional } of ownEdgeNames(entry)) {
      const resolved = resolveReal(packages, key, name, chain)
      if (resolved === null) {
        if (optional) continue
        throw new Error(
          `cannot resolve required dependency "${name}" of "${key}" in the root lockfile ` +
            `(chain: ${chain.concat(name).join(' -> ')})`,
        )
      }
      edges.push({ name, key: resolved.key, optional })
      if (!visited.has(resolved.key)) {
        visited.add(resolved.key)
        instanceEntries.set(resolved.key, resolved.entry)
        queue.push({ key: resolved.key, entry: resolved.entry, chain: chain.concat(name) })
      }
    }
    edgesByRequirer.set(key, edges)
  }

  // A dependency is "optional" in the output only if EVERY path from root to
  // it passes through at least one optional edge — i.e. it is unreachable
  // using required edges alone.
  const requiredReachable = new Set()
  {
    const q2 = [ROOT_ID]
    const seen2 = new Set([ROOT_ID])
    while (q2.length > 0) {
      const cur = q2.shift()
      for (const edge of edgesByRequirer.get(cur) || []) {
        if (edge.optional) continue
        requiredReachable.add(edge.key)
        if (!seen2.has(edge.key)) {
          seen2.add(edge.key)
          q2.push(edge.key)
        }
      }
    }
  }

  return { edgesByRequirer, instanceEntries, requiredReachable }
}

/**
 * Phase 2: place the closure into a brand-new tree rooted at "" (the
 * staging directory), greedily and shallow-first. Returns:
 *   - newTree: Map<newKey, instanceKey> — every placed location.
 *   - requirerLocations: Map<requirerId, Set<newLocation>> — every location
 *       each requirer ended up at, in the SAME shape as a root-lockfile key
 *       ("" for the root package.json itself, "node_modules/x", …) — an
 *       instance's own location doubles as the loc from which its further
 *       dependencies resolve, exactly as in phase 1.
 */
function placeClosure(edgesByRequirer) {
  const newTree = new Map() // full "node_modules/..." key -> instanceKey
  const requirerLocations = new Map([[ROOT_ID, new Set([''])]])
  const locationOwner = new Map([['', ROOT_ID]])

  function currentResolutionLoc(desc, name) {
    for (const loc of ancestors(desc)) {
      if (newTree.has(keyFor(loc, name))) return loc
    }
    return null
  }

  // Would placing `name` at `candidateLoc` intercept an already-satisfied
  // resolution some already-placed descendant is currently relying on
  // (walking PAST candidateLoc, which was empty when it resolved, to a
  // DIFFERENT instance further up)? If so this placement would silently
  // change that descendant's dependency out from under it.
  function shadowsDescendant(candidateLoc, name, targetKey) {
    const allLocations = new Set(['', ...[...requirerLocations.values()].flatMap((s) => [...s])])
    for (const desc of allLocations) {
      if (desc === candidateLoc) continue
      const isDescendant =
        candidateLoc === '' ? desc !== '' : desc === candidateLoc || desc.startsWith(`${candidateLoc}/${NM}`)
      if (!isDescendant || desc === candidateLoc) continue
      const requirerId = locationOwner.get(desc)
      const edge = (edgesByRequirer.get(requirerId) || []).find((e) => e.name === name)
      if (!edge || edge.key === targetKey) continue
      const resolvedLoc = currentResolutionLoc(desc, name)
      if (resolvedLoc === null) continue // not yet resolved to anything — nothing to shadow
      const descChain = ancestors(desc)
      const candidateIdx = descChain.indexOf(candidateLoc)
      const resolvedIdx = descChain.indexOf(resolvedLoc)
      if (candidateIdx === -1 || resolvedIdx === -1) continue
      if (resolvedIdx >= candidateIdx) return true
    }
    return false
  }

  // Returns the full new key ("node_modules/..." — this doubles as the
  // instance's OWN location for resolving ITS further dependencies, exactly
  // as a root-lockfile key does in phase 1) it placed `name` at, or null if
  // an existing entry already satisfies this edge.
  function placeEdge(atLocation, name, targetKey) {
    const chain = ancestors(atLocation)
    let conflictIndex = -1
    for (let i = 0; i < chain.length; i++) {
      const slot = keyFor(chain[i], name)
      if (newTree.has(slot)) {
        if (newTree.get(slot) === targetKey) return null // already satisfied
        conflictIndex = i
        break
      }
    }
    let idx = conflictIndex === -1 ? chain.length - 1 : conflictIndex - 1
    if (idx < 0) {
      throw new Error(
        `cannot place "${name}" needed at "${atLocation}" — its own node_modules slot is already ` +
          'occupied by a different instance (corrupt or contradictory dependency graph)',
      )
    }
    while (shadowsDescendant(chain[idx], name, targetKey)) {
      idx -= 1
      if (idx < 0) {
        throw new Error(`cannot place "${name}" needed at "${atLocation}" without shadowing an existing resolution`)
      }
    }
    const slotKey = keyFor(chain[idx], name)
    newTree.set(slotKey, targetKey)
    return slotKey
  }

  const placementQueue = [{ requirerId: ROOT_ID, atLocation: '' }]
  while (placementQueue.length > 0) {
    const { requirerId, atLocation } = placementQueue.shift()
    const edges = edgesByRequirer.get(requirerId) || []
    for (const edge of edges) {
      const newLoc = placeEdge(atLocation, edge.name, edge.key)
      if (newLoc === null) continue
      if (!requirerLocations.has(edge.key)) requirerLocations.set(edge.key, new Set())
      const locs = requirerLocations.get(edge.key)
      if (!locs.has(newLoc)) {
        locs.add(newLoc)
        locationOwner.set(newLoc, edge.key)
        placementQueue.push({ requirerId: edge.key, atLocation: newLoc })
      }
    }
  }

  return { newTree, requirerLocations }
}

/**
 * Phase 3: verify every edge, from every location its requirer was placed
 * at, resolves in the new tree to the SAME instance (version + resolved +
 * integrity) that phase 1 intended. Throws on the first mismatch.
 */
function verifyClosure(edgesByRequirer, instanceEntries, newTree, requirerLocations) {
  function resolveInNewTree(loc, name) {
    for (const cand of ancestors(loc)) {
      const key = keyFor(cand, name)
      if (newTree.has(key)) return key
    }
    return null
  }

  for (const [requirerId, locations] of requirerLocations) {
    const edges = edgesByRequirer.get(requirerId) || []
    for (const loc of locations) {
      for (const edge of edges) {
        const foundKey = resolveInNewTree(loc, edge.name)
        if (foundKey === null) {
          throw new Error(
            `VERIFY FAILED: "${edge.name}" needed by "${requirerId}" at "${loc}" does not resolve in the derived tree`,
          )
        }
        const actualInstanceKey = newTree.get(foundKey)
        const actual = instanceEntries.get(actualInstanceKey)
        const expected = instanceEntries.get(edge.key)
        if (
          !actual ||
          !expected ||
          actual.version !== expected.version ||
          actual.resolved !== expected.resolved ||
          actual.integrity !== expected.integrity
        ) {
          throw new Error(
            `VERIFY FAILED: "${edge.name}" needed by "${requirerId}" at "${loc}" resolved to a different ` +
              `instance than intended (got "${actualInstanceKey}", wanted "${edge.key}")`,
          )
        }
      }
    }
  }
}

/**
 * Build the derived, standalone lockfile for `workspace`'s production
 * dependency closure.
 *
 * @param {object} params
 * @param {object} params.rootLock - parsed root package-lock.json (lockfileVersion 3)
 * @param {object} params.packageJson - parsed STAGED package.json (caller has
 *   already stripped `@chroxy/*` deps and `devDependencies`)
 * @param {string} params.workspace - the workspace's root-lockfile location, e.g. "packages/server"
 * @returns {object} a lockfileVersion 3 object ready to JSON.stringify
 */
export function deriveServerLockfile({ rootLock, packageJson, workspace }) {
  const packages = rootLock.packages || {}
  if (!Object.prototype.hasOwnProperty.call(packages, workspace)) {
    throw new Error(`root lockfile has no "packages" entry for workspace "${workspace}"`)
  }
  for (const name of Object.keys(packageJson.dependencies || {})) {
    if (name.startsWith('@chroxy/')) {
      throw new Error(`staged package.json still declares workspace dependency "${name}" — strip it before deriving`)
    }
  }

  const { edgesByRequirer, instanceEntries, requiredReachable } = resolveClosure(packages, workspace, packageJson)
  const { newTree, requirerLocations } = placeClosure(edgesByRequirer)
  verifyClosure(edgesByRequirer, instanceEntries, newTree, requirerLocations)

  const outPackages = {}
  outPackages[''] = {
    name: packageJson.name,
    version: packageJson.version,
    ...(packageJson.license !== undefined ? { license: packageJson.license } : {}),
    ...(packageJson.bin !== undefined ? { bin: packageJson.bin } : {}),
    ...(packageJson.engines !== undefined ? { engines: packageJson.engines } : {}),
    ...(packageJson.dependencies !== undefined ? { dependencies: packageJson.dependencies } : {}),
    ...(packageJson.optionalDependencies !== undefined
      ? { optionalDependencies: packageJson.optionalDependencies }
      : {}),
  }

  for (const [slotKey, instanceKey] of newTree) {
    const source = instanceEntries.get(instanceKey)
    if (!source) throw new Error(`internal error: no entry recorded for instance "${instanceKey}"`)
    const name = (source.name || '').startsWith('@chroxy/') ? source.name : undefined
    if (name || instanceKey.startsWith('@chroxy/') || slotKey.endsWith(`${NM}@chroxy`)) {
      throw new Error(`refusing to emit @chroxy/* entry "${slotKey}" into the derived lockfile`)
    }
    const cleaned = { ...source }
    delete cleaned.dev
    delete cleaned.devOptional
    delete cleaned.peer
    delete cleaned.link
    if (requiredReachable.has(instanceKey)) {
      delete cleaned.optional
    } else {
      cleaned.optional = true
    }
    outPackages[slotKey] = cleaned
  }

  const sortedPackages = {}
  for (const key of Object.keys(outPackages).sort()) {
    sortedPackages[key] = outPackages[key]
  }

  return {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: sortedPackages,
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument: ${arg}`)
    }
    const key = arg.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${key} requires a value`)
    }
    out[key] = value
    i += 1
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  for (const required of ['root-lock', 'package-json', 'workspace', 'out']) {
    if (!args[required]) {
      throw new Error(
        'Usage: derive-server-lockfile.mjs --root-lock <path> --package-json <path> --workspace <name> --out <path>',
      )
    }
  }
  const rootLock = JSON.parse(readFileSync(args['root-lock'], 'utf8'))
  const packageJson = JSON.parse(readFileSync(args['package-json'], 'utf8'))
  const lockfile = deriveServerLockfile({ rootLock, packageJson, workspace: args.workspace })
  writeFileSync(args.out, `${JSON.stringify(lockfile, null, 2)}\n`)
  console.log(`[derive-server-lockfile] wrote ${args.out} (${Object.keys(lockfile.packages).length} package entries)`)
}

if (isEntryPoint(import.meta.url)) {
  try {
    main()
  } catch (err) {
    console.error(`[derive-server-lockfile] ${err.message}`)
    process.exit(1)
  }
}
