/**
 * #7085 — the outbound (server → client) schema registry, DERIVED not declared.
 *
 * The 243-field wire-cap audit found 8 "store-legal / wire-illegal" fields: the
 * server held a value its outbound schema rejects, so a client's `safeParse` of the
 * whole snapshot failed and a panel rendered nothing while N live items existed.
 * Every one of them would have been caught by validating outbound messages. The
 * server does not: `ws-server.js`'s only `safeParse` calls are INBOUND, and
 * `event-normalizer.js` says outright that outgoing messages are not validated.
 *
 * A gate needs to know which schema governs a given message. There is no union to
 * ask — despite the name, `ServerMessageSchema` is the schema for a single
 * `type: 'message'` frame, and no discriminated union over server messages exists.
 *
 * So the registry is built by INTROSPECTION: every `Server*Schema` export whose
 * shape carries a `type: z.literal(...)` registers itself under that literal. This
 * is deliberate rather than a convenience — a hand-maintained 153-entry map is
 * exactly the kind of parallel list this codebase has repeatedly watched drift out
 * of sync with its source of truth (see the BASE_SESSION_OPT_KEYS lint, the
 * protocol handler-coverage lint, and the `clampWire` caps that were retyped in
 * three loaders). A derived map cannot drift, and a frame with no schema is
 * detectable by ABSENCE rather than by someone remembering to add an arm.
 *
 * Schemas WITHOUT a `type` literal are correctly excluded: they are sub-objects
 * (`ServerSessionListEntrySchema`, `ServerPermissionAuditEntrySchema`, …) reached
 * through a parent frame, not frames in their own right.
 *
 * A type may map to MORE THAN ONE schema. `type: 'error'` is claimed by both
 * `ServerErrorEnvelopeSchema` and `ServerSkillTrustGrantInvalidAuthorSchema`, so the
 * registry stores a list per type and a message is valid if ANY arm accepts it.
 * Keying one-schema-per-type would silently validate half the `error` frames against
 * the wrong shape.
 */

import * as protocol from '@chroxy/protocol'

/** Zod object shape, whichever way this version exposes it. */
function shapeOf(schema) {
  const shape = schema?.shape ?? schema?._def?.shape
  // A shape can be lazily defined as a getter/thunk.
  return typeof shape === 'function' ? shape() : shape
}

/** The union arms of a schema, or null when it is not a union. */
function unionArmsOf(schema) {
  const def = schema?._def
  const kind = def?.type ?? def?.typeName
  if (kind !== 'union' && kind !== 'discriminatedUnion' && kind !== 'ZodUnion' && kind !== 'ZodDiscriminatedUnion') return null
  const options = def?.options ?? schema?.options
  return options ? [...options] : null
}

/**
 * Every `type` literal a schema can produce.
 *
 * Returns a Set because a UNION is still one frame schema but reaches the
 * registry through each arm's literal. Missing this is not a cosmetic gap: a
 * union-shaped frame schema has no top-level `.shape`, so a naive
 * `shape.type.value` lookup drops it SILENTLY and the frame then looks
 * schema-less. That is exactly what happened to `evaluate_draft_result`
 * (ServerEvaluateDraftResultSchema) and `permission_input`
 * (ServerPermissionInputSchema) — both real frames, both briefly recorded as
 * uncovered because of it.
 *
 * @param {object} schema
 * @returns {Set<string>}
 */
export function typeLiteralsOf(schema) {
  const out = new Set()
  const arms = unionArmsOf(schema)
  if (arms) {
    for (const arm of arms) for (const t of typeLiteralsOf(arm)) out.add(t)
    return out
  }
  const type = shapeOf(schema)?.type
  if (!type) return out
  // `values` FIRST, deliberately. On a multi-value literal (`z.literal(['a','b'])`)
  // reading `.value` THROWS — and this runs inside a top-level buildRegistry(), so
  // that would be a module-load crash, not a silent miss. `_def.values` is populated
  // for the single-value case too (`z.literal('a')._def.values === ['a']`), so
  // values-first covers both and `.value` is only a fallback for older shapes.
  const values = type?._def?.values ?? type?.options
  if (values) {
    for (const v of values) if (typeof v === 'string') out.add(v)
    if (out.size > 0) return out
  }
  try {
    if (typeof type.value === 'string') out.add(type.value)
  } catch {
    // A throwing accessor means we could not read it — leave `out` empty so the
    // caller files this under UNREADABLE rather than treating it as a non-frame.
  }
  return out
}

/**
 * True when a schema is a sub-object rather than a frame.
 *
 * A frame is discriminated by a `type` LITERAL. A schema whose `type` is ordinary
 * data — `ServerPermissionAuditEntrySchema.type` is `z.string()`, naming the audited
 * tool — is not a frame, and neither is one with no `type` at all.
 *
 * Classifying on "has a type field" instead of "has a type LITERAL" is too crude and
 * flagged that audit-entry schema as unreadable. The distinction that matters is
 * between a legitimate exclusion and a SILENT DROP, so the rule is: no literal to
 * read is fine; a literal we failed to read is not.
 */
function looksLikeNonFrame(schema) {
  const arms = unionArmsOf(schema)
  if (arms) return arms.every((arm) => looksLikeNonFrame(arm))

  // FAIL LOUD BY DEFAULT. Only a plain object can be a legitimate sub-object. Any
  // other combinator — intersection, pipe, transform, catch, default, optional,
  // nullable, readonly, lazy — hides `.shape`, so keying "non-frame" off a missing
  // shape would file every one of them as legitimately excluded and the invariant
  // would defend the union case and nothing else. Reporting them instead means a
  // frame wrapped in a combinator surfaces as UNREADABLE rather than vanishing.
  const kind = schema?._def?.type ?? schema?._def?.typeName
  if (kind !== 'object' && kind !== 'ZodObject') return false

  const type = shapeOf(schema)?.type
  if (type === undefined) return true
  const typeKind = type?._def?.type ?? type?._def?.typeName
  // Only a literal (or an enum of literals) can discriminate a frame; a `type` that
  // is ordinary data (ServerPermissionAuditEntrySchema.type is z.string(), naming the
  // audited tool) does not make its owner a frame.
  return typeKind !== 'literal' && typeKind !== 'ZodLiteral' && typeKind !== 'enum' && typeKind !== 'ZodEnum'
}

function buildRegistry() {
  /** @type {Map<string, Array<{ name: string, schema: object }>>} */
  const byType = new Map()
  const nonFrame = []
  const unreadable = []
  for (const [name, schema] of Object.entries(protocol)) {
    if (!name.startsWith('Server') || !name.endsWith('Schema')) continue
    const types = typeLiteralsOf(schema)
    if (types.size === 0) {
      // No literal extracted. Either it genuinely has no `type` field (fine), or it
      // has one this code could not read (NOT fine — that is the silent drop).
      if (looksLikeNonFrame(schema)) nonFrame.push(name)
      else unreadable.push(name)
      continue
    }
    for (const type of types) {
      if (!byType.has(type)) byType.set(type, [])
      byType.get(type).push({ name, schema })
    }
  }
  return { byType, nonFrame, unreadable }
}

/** Exposed for the coverage test — the classifier's bias is the invariant's whole value. */
export const looksLikeNonFrameForTests = looksLikeNonFrame

const { byType: REGISTRY, nonFrame: NON_FRAME_SCHEMAS, unreadable: UNREADABLE_SCHEMAS } = buildRegistry()

/**
 * Schemas that DO carry a `type` field whose literal could not be extracted.
 *
 * Must always be empty. A non-empty list means the derivation silently dropped a
 * frame and the coverage numbers are understated — so the test asserts on it
 * rather than leaving it to be noticed.
 */
export const UNREADABLE_FRAME_SCHEMA_NAMES = Object.freeze([...UNREADABLE_SCHEMAS].sort())

/** Every outbound message `type` that has at least one schema. */
export const SCHEMA_BACKED_OUTBOUND_TYPES = Object.freeze([...REGISTRY.keys()].sort())

/** `Server*Schema` exports with no `type` literal — sub-objects, not frames. */
export const NON_FRAME_SCHEMA_NAMES = Object.freeze([...NON_FRAME_SCHEMAS].sort())

/**
 * Schemas governing a message `type`, or an empty array when the type is unknown
 * to the protocol package.
 *
 * An empty array is the signal a gate must NOT treat as "valid": it means nothing
 * describes this frame, which is the vacuous-pass failure mode.
 *
 * @param {string} type
 * @returns {Array<{ name: string, schema: object }>}
 */
export function outboundSchemasForType(type) {
  return REGISTRY.get(type) ?? []
}

/**
 * Validate an outbound message against its registered schema(s).
 *
 * @param {unknown} message
 * @returns {{ ok: true } | { ok: false, reason: 'no-type' | 'no-schema' | 'invalid', type?: string, schema?: string, issue?: object }}
 */
export function validateOutbound(message) {
  const type = message && typeof message === 'object' ? message.type : undefined
  if (typeof type !== 'string') return { ok: false, reason: 'no-type' }
  const arms = outboundSchemasForType(type)
  if (arms.length === 0) return { ok: false, reason: 'no-schema', type }
  let first = null
  for (const { name, schema } of arms) {
    const result = schema.safeParse(message)
    if (result.success) return { ok: true }
    // Report the FIRST arm's complaint. With multiple arms the others' errors are
    // noise — a message is meant to match exactly one shape.
    if (!first) first = { schema: name, issue: result.error.issues[0] }
  }
  return { ok: false, reason: 'invalid', type, ...first }
}
