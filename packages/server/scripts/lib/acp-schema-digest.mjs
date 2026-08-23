// acp-schema-digest.mjs — the ONE place that turns an ACP `schema.json` +
// the SDK's runtime exports into a structural (prose-free) digest.
//
// Both `regen-acp-snapshot.mjs` (writes the vendored snapshot) and
// `tests/acp-schema-drift.test.js` (recomputes the SAME digest from whatever
// is currently installed, to compare against the vendored one) import this
// module rather than each carrying their own copy. Before this file existed,
// the extraction logic was duplicated between the test's live code and a
// 90-line heredoc in a comment, with nothing checking the two agreed — the
// exact "hardcoded copy beside a set that grows" shape docs/false-safety-guards.md
// exists to name (#7318 review). The repo already solved this shape once for
// entry-point detection: `scripts/lib/entry-point-guard-copies.mjs` is the
// single list two otherwise-independent gates both import (#7222). This is
// the same move for the ACP digest.
//
// ## What "structural" means here
//
// A full deep-equal of `schema.json` fails on every upstream prose edit (a
// reworded `description`, a `title` typo fix) exactly as loudly as it fails on
// a real wire change. This module captures only what a wire-compatible client
// or agent actually depends on:
//
//   - the sorted set of `$defs` type names (`defKeys`) — a type appearing or
//     disappearing
//   - per non-trivial `$def`: its `required` fields, its `properties` (each
//     tagged with a type/`$ref`/`const` signature, not just its name — an
//     array property additionally carries its element's type/`$ref`, one hop
//     into `items`, e.g. `array<ref:PermissionOption>`), any `const`/enum
//     member set, and its `discriminator` — a renamed/retyped property
//     (including an array's ELEMENT type retargeting, not just the property
//     itself), a required field moving, an enum member added or removed, or
//     a discriminator renamed
//   - one level of `oneOf`/`anyOf` branch recursion, including one hop through
//     a branch's own `$ref` (bare or `allOf: [{ $ref }]`) into the referenced
//     def's OWN top-level surface — deliberately not chased further. Needed
//     because several real ACP types put their only structural content
//     there: `CreateElicitationResponse` has an empty top-level `required`
//     even though all four of its `anyOf` branches require `action`, and
//     `SetSessionConfigOptionRequest`'s `value`/`type` fields exist only
//     inside its `anyOf` branches.
//   - the schema's root `anyOf` (the request/response/notification union),
//     fingerprinted by title + every `$ref` reachable inside each branch
//   - `PROTOCOL_VERSION`, `CLIENT_METHODS`/`AGENT_METHODS`/`PROTOCOL_METHODS`
//     in full (keys AND values), and the sorted runtime export names — handled
//     by the caller, not this module, since they come off the SDK's JS module
//     rather than the JSON schema
//
// `description`, `title`, `x-method`/`x-side` (redundant with the method maps,
// which are already compared in full) and anything else with no wire meaning
// are not captured, and changes to them will NOT fail a comparison built on
// this digest. That is deliberate.
//
// ## required: union vs intersection, and why both appear
//
// A property required by EVERY branch of a `oneOf`/`anyOf` is required no
// matter which branch is actually selected on the wire — that is a true,
// unconditional fact about the type, so branch-level required sets are
// INTERSECTED. The def's own top-level `required` (fields the type demands
// regardless of which branch applies) is then UNIONED into that intersection,
// since both are simultaneously true. Only intersecting within a branch's own
// required, or only unioning across branches, would misstate the type in
// opposite directions: the former loses "value" for
// `SetSessionConfigOptionRequest` (required in every anyOf branch), the latter
// would falsely claim `type` is always required (it is required in only one
// of that type's two branches).
//
// ## Known residual gaps
//
// - A `oneOf`/`anyOf` whose branches are plain type unions with no
//   `properties` and no branch-level `const` (`RequestId`'s `anyOf` of
//   string/number/null, for instance) contributes nothing beyond its own
//   existence in `defKeys`. Capturing primitive-type unions themselves was
//   not asked for and is left as a known, narrow gap rather than guessed at.
// - An array property's element type is captured one hop into `items`
//   (`array<ref:X>`, `array<string>`, ...), but `itemSignature` does not
//   recurse into a combinator (`oneOf`/`anyOf`) INSIDE `items`, or handle
//   JSON Schema's tuple-validation form (`items` as an array of schemas) —
//   both fall back to the bare `array` signature. Neither shape appears in
//   the schema this was written against; if one appears later, the fallback
//   fails safe (it under-captures, same as before this fix, rather than
//   throwing), but it will not detect a change confined entirely inside that
//   combinator or tuple.

/** "#/$defs/Foo" -> "Foo". Passes through anything that doesn't match. */
export function refName(ref) {
  const m = /^#\/\$defs\/(.+)$/.exec(ref || '')
  return m ? m[1] : ref
}

/**
 * One hop into an array property's `items` schema — the same "one hop, no
 * deeper" discipline `branchContributions` applies to `oneOf`/`anyOf`
 * branches. Returns `null` (not a string) when `items` carries nothing this
 * function knows how to fingerprint, so the caller can fall back to the bare
 * `array` signature rather than inventing one.
 *
 * Deliberately does NOT recurse into a combinator inside `items`
 * (`oneOf`/`anyOf`) or handle JSON Schema's tuple-validation form (`items` as
 * an array of schemas) — both fall through to `null`. Going further than one
 * hop is how the original review's "72% uncompared" hole got rationalised in
 * the first place.
 */
function itemSignature(items) {
  if (!items || typeof items !== 'object') return null
  if (items.const !== undefined) return `const:${JSON.stringify(items.const)}`
  if (typeof items.$ref === 'string') return `ref:${refName(items.$ref)}`
  if (Array.isArray(items.allOf) && items.allOf.length === 1
    && items.allOf[0] && typeof items.allOf[0].$ref === 'string') {
    return `ref:${refName(items.allOf[0].$ref)}`
  }
  if (items.type !== undefined) {
    return Array.isArray(items.type) ? [...items.type].sort().join('|') : String(items.type)
  }
  if (items.enum !== undefined) return 'enum'
  return null
}

/**
 * A short, deterministic fingerprint of a property's declared shape — enough
 * to catch a `string` -> `number` retype, a `$ref` target changing (at the
 * property's own top level OR one hop into an array's `items`), without
 * carrying the property's `description`.
 */
export function propertySignature(propSchema) {
  if (!propSchema || typeof propSchema !== 'object') return 'unknown'
  if (propSchema.const !== undefined) return `const:${JSON.stringify(propSchema.const)}`
  if (propSchema.type !== undefined) {
    const isArrayType = propSchema.type === 'array'
      || (Array.isArray(propSchema.type) && propSchema.type.includes('array'))
    const base = Array.isArray(propSchema.type) ? [...propSchema.type].sort().join('|') : String(propSchema.type)
    if (isArrayType) {
      const elementSig = itemSignature(propSchema.items)
      return elementSig ? `${base}<${elementSig}>` : base
    }
    return base
  }
  if (typeof propSchema.$ref === 'string') return `ref:${refName(propSchema.$ref)}`
  if (Array.isArray(propSchema.allOf) && propSchema.allOf.length === 1
    && propSchema.allOf[0] && typeof propSchema.allOf[0].$ref === 'string') {
    return `ref:${refName(propSchema.allOf[0].$ref)}`
  }
  if (propSchema.enum !== undefined) return 'enum'
  if (propSchema.oneOf || propSchema.anyOf) return 'union'
  if (propSchema.items !== undefined) {
    // No explicit `type: "array"`, but `items` is present — treat as array-ish.
    const elementSig = itemSignature(propSchema.items)
    return elementSig ? `array<${elementSig}>` : 'array'
  }
  return 'unknown'
}

/**
 * Several `oneOf`/`anyOf` branches can define the same property name with
 * different per-branch signatures (`action` is `const:"accept"` in one
 * `CreateElicitationResponse` branch and a bare `string` in another). Every
 * observed variant is kept, sorted and joined, rather than picking one
 * arbitrarily and silently discarding the rest.
 */
function mergeSignatures(sigs) {
  return [...new Set(sigs)].sort().join('|')
}

/** A branch's own const value, if it IS a const leaf rather than an object shape. */
function constValueOf(branch) {
  return branch && typeof branch === 'object' && branch.const !== undefined && !branch.properties
    ? branch.const
    : undefined
}

/**
 * What a single `oneOf`/`anyOf` branch contributes: its own inline
 * `properties`/`required`, plus — one hop only — whatever its own `$ref`
 * (bare, or wrapped as `allOf: [{ $ref }]`) points at.
 */
function branchContributions(branch, allDefs) {
  const contributions = []
  if (!branch || typeof branch !== 'object') return contributions
  if (branch.properties || branch.required) {
    contributions.push({ properties: branch.properties || {}, required: branch.required || [] })
  }
  const branchRef = typeof branch.$ref === 'string'
    ? branch.$ref
    : (Array.isArray(branch.allOf) && branch.allOf.length === 1 ? branch.allOf[0]?.$ref : undefined)
  if (typeof branchRef === 'string') {
    const target = allDefs[refName(branchRef)]
    if (target && (target.properties || target.required)) {
      contributions.push({ properties: target.properties || {}, required: target.required || [] })
    }
  }
  return contributions
}

/**
 * Structural digest for one `$def`. Returns `null` when there is nothing
 * beyond the def's bare existence (no `properties`, `required`, const/enum
 * members, or `discriminator` at any level considered) — existence alone is
 * already covered by `defKeys`, so an empty entry would carry no information.
 */
export function buildDefDigest(def, allDefs) {
  const propertySigs = new Map()
  const addProp = (name, schema) => {
    if (!propertySigs.has(name)) propertySigs.set(name, new Set())
    propertySigs.get(name).add(propertySignature(schema))
  }
  for (const [name, schema] of Object.entries(def.properties || {})) addProp(name, schema)

  const ownRequired = new Set(Array.isArray(def.required) ? def.required : [])
  const constValues = new Set()
  const branchRequiredSets = []

  const branches = def.oneOf || def.anyOf || []
  for (const branch of branches) {
    const cv = constValueOf(branch)
    if (cv !== undefined) {
      constValues.add(cv)
      continue
    }
    const contributions = branchContributions(branch, allDefs)
    if (!contributions.length) continue
    const branchRequired = new Set()
    for (const c of contributions) {
      for (const [name, schema] of Object.entries(c.properties)) addProp(name, schema)
      for (const r of c.required) branchRequired.add(r)
    }
    branchRequiredSets.push(branchRequired)
  }

  // Required-in-every-branch, intersected, then unioned with the def's own
  // top-level required (see header comment for why both directions apply).
  let branchIntersection = null
  for (const set of branchRequiredSets) {
    branchIntersection = branchIntersection === null
      ? new Set(set)
      : new Set([...branchIntersection].filter((x) => set.has(x)))
  }
  const finalRequired = new Set(ownRequired)
  if (branchIntersection) for (const r of branchIntersection) finalRequired.add(r)

  const properties = {}
  for (const name of [...propertySigs.keys()].sort()) {
    properties[name] = mergeSignatures([...propertySigs.get(name)])
  }

  const result = {}
  const required = [...finalRequired].sort()
  if (required.length) result.required = required
  if (Object.keys(properties).length) result.properties = properties
  if (constValues.size) result.constValues = [...constValues].sort()
  if (def.discriminator) result.discriminator = def.discriminator

  return Object.keys(result).length ? result : null
}

/** `{ defKeys, defs }` for the whole schema's `$defs`. */
export function buildDefsDigest(schema) {
  const allDefs = schema['$defs'] || {}
  const defKeys = Object.keys(allDefs).sort()
  const defs = {}
  for (const key of defKeys) {
    const digest = buildDefDigest(allDefs[key], allDefs)
    if (digest) defs[key] = digest
  }
  return { defKeys, defs }
}

/** Every `$ref` target reachable anywhere inside `node`, at any depth. */
export function collectRefs(node, out = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out)
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') out.add(refName(value))
      else collectRefs(value, out)
    }
  }
  return out
}

/**
 * Fingerprint of the schema's ROOT `anyOf` (the top-level request/response/
 * notification union) — title plus every `$ref` reachable inside each
 * branch, regardless of how deeply the branch nests `anyOf`/`allOf` to get
 * there. Emptying the root `anyOf` entirely yields `[]`, which a comparison
 * against a non-empty vendored value fails on.
 */
export function buildRootAnyOfDigest(schema) {
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : []
  return branches.map((branch) => ({
    title: branch && typeof branch === 'object' && typeof branch.title === 'string' ? branch.title : null,
    refs: [...collectRefs(branch)].sort(),
  }))
}

/**
 * The full structural payload compared by the drift test: `$defs` surface,
 * root union fingerprint, and the SDK's method/export surface. `acp` is the
 * SDK's namespace import (`import * as acp from '@agentclientprotocol/sdk'`).
 */
export function buildStructuralDigest(schema, acp) {
  return {
    ...buildDefsDigest(schema),
    rootAnyOf: buildRootAnyOfDigest(schema),
    protocolMethods: acp.PROTOCOL_METHODS,
    exportNames: Object.keys(acp).sort(),
  }
}
