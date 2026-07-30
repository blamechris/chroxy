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
 * is deliberate rather than a convenience — a hand-maintained 151-entry map is
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

/** Pull the `type` literal out of a Zod object schema, or null if it has none. */
function typeLiteralOf(schema) {
  // Zod exposes `.shape` on object schemas; older/inner forms keep it on `_def`.
  const shape = schema?.shape ?? schema?._def?.shape
  const value = shape?.type?.value
  return typeof value === 'string' ? value : null
}

function buildRegistry() {
  /** @type {Map<string, Array<{ name: string, schema: object }>>} */
  const byType = new Map()
  const nonFrame = []
  for (const [name, schema] of Object.entries(protocol)) {
    if (!name.startsWith('Server') || !name.endsWith('Schema')) continue
    const type = typeLiteralOf(schema)
    if (type === null) {
      nonFrame.push(name)
      continue
    }
    if (!byType.has(type)) byType.set(type, [])
    byType.get(type).push({ name, schema })
  }
  return { byType, nonFrame }
}

const { byType: REGISTRY, nonFrame: NON_FRAME_SCHEMAS } = buildRegistry()

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
