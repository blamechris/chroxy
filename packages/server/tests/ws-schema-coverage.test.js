import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registeredMessageTypes } from '../src/ws-message-handlers.js'
import { ClientMessageSchema } from '@chroxy/protocol'

/**
 * Schema coverage test for WS protocol (issue #2705).
 *
 * Every message type registered in the server's handler registry must have a
 * corresponding Zod schema in @chroxy/protocol's ClientMessageSchema
 * discriminated union.
 *
 * If a handler type intentionally has no client schema (e.g. it is an internal
 * or legacy type that predates the protocol package), add it to SCHEMA_EXEMPT
 * with a justification comment rather than silently skipping it.
 */

// ---------------------------------------------------------------------------
// Types intentionally exempt from schema coverage.
// Each entry MUST have an inline justification — no silent allowlist additions.
// ---------------------------------------------------------------------------
const SCHEMA_EXEMPT = new Set([
  // (empty — all current handler types have schemas)
])

describe('WS protocol schema coverage', () => {
  // Extract the set of type literals covered by ClientMessageSchema.
  // ClientMessageSchema is a discriminated union; each option's type field
  // has a .value property that holds the literal string.
  const schemaTypes = new Set(
    ClientMessageSchema.options.map((schema) => schema.shape.type.value),
  )

  it('registeredMessageTypes is a non-empty array of strings', () => {
    assert.ok(Array.isArray(registeredMessageTypes), 'registeredMessageTypes should be an array')
    assert.ok(registeredMessageTypes.length > 0, 'registeredMessageTypes should not be empty')
    for (const type of registeredMessageTypes) {
      assert.equal(typeof type, 'string', `Entry should be a string, got: ${JSON.stringify(type)}`)
    }
  })

  it('every registered handler type has a schema in @chroxy/protocol ClientMessageSchema', () => {
    const missing = []

    for (const type of registeredMessageTypes) {
      if (SCHEMA_EXEMPT.has(type)) continue
      if (!schemaTypes.has(type)) {
        missing.push(type)
      }
    }

    assert.equal(
      missing.length,
      0,
      `The following registered handler types have no Zod schema in @chroxy/protocol:\n` +
      missing.map((t) => `  - ${t}`).join('\n') +
      `\n\nFor each type either:\n` +
      `  1. Add a schema to packages/protocol/src/schemas/client.ts, OR\n` +
      `  2. Add the type to SCHEMA_EXEMPT in this test with a justification comment.`,
    )
  })

  it('SCHEMA_EXEMPT entries are actual registered handler types', () => {
    const stale = []
    const allRegistered = new Set(registeredMessageTypes)

    for (const type of SCHEMA_EXEMPT) {
      if (!allRegistered.has(type)) {
        stale.push(type)
      }
    }

    assert.equal(
      stale.length,
      0,
      `SCHEMA_EXEMPT contains types that are not registered handlers:\n` +
      stale.map((t) => `  - ${t}`).join('\n') +
      `\n\nRemove stale entries from SCHEMA_EXEMPT.`,
    )
  })

  it('ClientMessageSchema covers no undeclared extra types beyond what is registered or exempt', () => {
    // This is an informational reverse-check: schema types that have no
    // corresponding handler. These are NOT failures (schemas can document
    // auth-layer messages handled before the registry), but unexpected extras
    // should prompt a review.
    const handlerTypes = new Set([...registeredMessageTypes, ...SCHEMA_EXEMPT])
    const schemaOnly = [...schemaTypes].filter((t) => !handlerTypes.has(t))

    // These are known schema-only types handled at the connection/auth layer
    // (ws-server.js) before messages reach the handler registry.
    const KNOWN_PRE_REGISTRY = new Set([
      'auth',          // handled in ws-auth.js before registry dispatch
      'pair',          // pairing flow, handled at connection layer
      'key_exchange',  // E2E encryption handshake, handled before dispatch
      'ping',          // keepalive, handled at connection layer
      'encrypted',     // envelope unwrapped before dispatch
    ])

    const unexplained = schemaOnly.filter((t) => !KNOWN_PRE_REGISTRY.has(t))

    assert.equal(
      unexplained.length,
      0,
      `ClientMessageSchema contains types with no registered handler and not in KNOWN_PRE_REGISTRY:\n` +
      unexplained.map((t) => `  - ${t}`).join('\n') +
      `\n\nEither:\n` +
      `  1. Add a handler for the type in the appropriate handler file, OR\n` +
      `  2. Add the type to KNOWN_PRE_REGISTRY in this test with a justification comment.`,
    )
  })
})
