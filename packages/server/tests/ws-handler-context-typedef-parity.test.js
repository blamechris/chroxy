/**
 * The `WsHandler*` typedefs must match `CTX_NAMESPACES`, field for field (#7403).
 *
 * `ws-handler-context.js` declares itself the single source of truth for the
 * handler-ctx shape: "the JSDoc typedef below, the `CTX_NAMESPACES` list, and
 * `assertCtxShape()` are all derived from the same five buckets". Only two of
 * those three were ever coupled — `nsCtx`'s `FIELD_TO_NS` and `assertCtxShape`
 * both read `CTX_NAMESPACES`, while the typedef was decorative.
 *
 * It had drifted in both directions: `services` carried seven fields the
 * typedef never mentioned (`shellApprovalStore`, `repoEventStore`,
 * `webhookPayloadUrl`, `repoWebhookDeliveries`, `setWebhookSecretCache`,
 * `orchestrationManager`, `schedulerEngine`), and `tokenManager` sat in the
 * typedef and on the PRODUCTION ctx while being absent from the roster — so
 * `assertCtxShape({deep: true})` never required it and `nsCtx()` never routed
 * it.
 *
 * That direction matters: the typedef is what editors surface for `@type`
 * hints in the handler modules, so drift makes the hints wrong in the direction
 * of "this field does not exist" — the worst kind, because it reads as
 * authoritative.
 *
 * BOTH SIDES ARE DERIVED. The typedef name comes from the namespace key, and
 * the field lists come from the parsed source and the exported roster. There is
 * no hardcoded list of fields anywhere in this file; adding a namespace or a
 * field requires no edit here.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { CTX_NAMESPACES, CTX_NAMESPACE_NAMES } from '../src/ws-handler-context.js'

const SRC_PATH = new URL('../src/ws-handler-context.js', import.meta.url)
const SRC = readFileSync(SRC_PATH, 'utf8')

/** `services` → `WsHandlerServices`. Derived, so a new namespace needs no edit. */
function typedefNameFor(ns) {
  return `WsHandler${ns[0].toUpperCase()}${ns.slice(1)}`
}

/**
 * The text of one `@typedef {Object} <name>` block, up to the next `@typedef`.
 *
 * THROWS rather than returning null when the block is absent. The
 * "every namespace resolves to a real typedef block" control below covers the
 * same ground, but `node --test` can run an individual test in isolation
 * (`--test-name-pattern`), so that control does not gate the parity tests. Left
 * returning null, a renamed typedef would surface as
 * `TypeError: Cannot read properties of null` from inside the regex helper —
 * true, useless, and pointing at the wrong file.
 */
function typedefBlock(name) {
  // Word-boundary matched, NOT `indexOf`. A plain substring search for
  // `@typedef {Object} WsHandlerServices` also matches
  // `@typedef {Object} WsHandlerServicesRenamed`, so renaming a typedef left
  // this test green — measured, 13/13, with the block it was supposed to be
  // pinning gone. Prefix-matching an identifier is the same class as a
  // substring standing in for a token match (#7290/#7291).
  const match = new RegExp(`@typedef \\{Object\\} ${name}\\b`).exec(SRC)
  const start = match ? match.index : -1
  assert.ok(
    start !== -1,
    `no '@typedef {Object} ${name}' block found in ws-handler-context.js — ` +
      'the typedef was renamed or removed, or the WsHandler<Namespace> naming convention changed. ' +
      'Both sides of this test derive from that convention.',
  )
  const rest = SRC.slice(start)
  const next = rest.indexOf('@typedef', 1)
  return next === -1 ? rest : rest.slice(0, next)
}

/**
 * `@property` names in a block.
 *
 * The type brace-group is matched with one level of nesting allowed, because
 * several properties carry inline object types — e.g.
 * `@property {(a: string) => {changed: boolean}} claimPrimary`. A naive
 * `\{[^}]*\}` stops at the inner `}` and captures a fragment of the type as the
 * field name; the `propertyNames parser` test below is the control for that.
 * A leading `[name]` (optional property) is unwrapped.
 */
function propertyNames(block) {
  return [...block.matchAll(/@property \{[^{}]*(?:\{[^{}]*\}[^{}]*)*\} \[?([A-Za-z_$][\w$]*)\]?/g)].map(
    (m) => m[1],
  )
}

describe('WsHandler typedefs match CTX_NAMESPACES (#7403)', () => {
  it('POSITIVE CONTROL: the property parser handles inline object types', () => {
    // If this regex silently mis-parses, every set-equality below compares two
    // wrong sets and can agree for the wrong reason. `claimPrimary`'s return
    // type contains braces and is the real case that breaks a naive pattern.
    const sample = [
      ' * @property {(ws: any, msg: object) => void} send - one.',
      ' * @property {(a: string, b: string, opts?: {force?: boolean}) => {changed: boolean, rejected?: boolean}} claimPrimary - nested.',
      ' * @property {object|null} maybe - two.',
      ' * @property {string} [optionalOne] - bracketed.',
    ].join('\n')
    assert.deepEqual(propertyNames(sample), ['send', 'claimPrimary', 'maybe', 'optionalOne'])
  })

  it('POSITIVE CONTROL: every namespace resolves to a real typedef block', () => {
    // Without this, a renamed typedef would make `propertyNames` return [] and
    // the parity test would fail confusingly — or, if the roster were also
    // empty, pass vacuously.
    for (const ns of CTX_NAMESPACE_NAMES) {
      const name = typedefNameFor(ns)
      // typedefBlock() itself asserts the block exists, so this reads as
      // "does not throw" — the explicit length check below is what makes it a
      // control rather than a restatement.
      const block = typedefBlock(name)
      assert.ok(
        propertyNames(block).length > 0,
        `'${name}' parsed to zero properties — the parser or the typedef is broken`,
      )
    }
  })

  for (const ns of CTX_NAMESPACE_NAMES) {
    it(`${ns}: typedef and CTX_NAMESPACES carry exactly the same fields`, () => {
      const name = typedefNameFor(ns)
      const documented = propertyNames(typedefBlock(name))
      const roster = CTX_NAMESPACES[ns]

      const missing = roster.filter((k) => !documented.includes(k))
      const stale = documented.filter((k) => !roster.includes(k))

      assert.deepEqual(
        { missing, stale },
        { missing: [], stale: [] },
        `${name} has drifted from CTX_NAMESPACES.${ns}.\n` +
          (missing.length ? `  In the roster but NOT documented: ${missing.join(', ')}\n` : '') +
          (stale.length ? `  Documented but NOT in the roster: ${stale.join(', ')}\n` : '') +
          '  Both sides live in src/ws-handler-context.js. If a field is genuinely gone, ' +
          'remove it from BOTH; if it is real, add it to both (and check ws-server.js provides it).',
      )
    })

    it(`${ns}: no field is documented twice`, () => {
      const documented = propertyNames(typedefBlock(typedefNameFor(ns)))
      const dupes = documented.filter((k, i) => documented.indexOf(k) !== i)
      assert.deepEqual(dupes, [], `duplicate @property entries in ${typedefNameFor(ns)}`)
    })
  }

  it('the WsHandlerContext typedef documents exactly the five namespaces', () => {
    // The top-level typedef is the other half of the same roster, and it drifts
    // the same way. `correlationId` is spread on at dispatch time in
    // ws-server.js rather than being a namespace, so it is excluded by name.
    const documented = propertyNames(typedefBlock('WsHandlerContext')).filter(
      (k) => k !== 'correlationId',
    )
    assert.deepEqual(
      [...documented].sort(),
      [...CTX_NAMESPACE_NAMES].sort(),
      'WsHandlerContext must document exactly the namespaces in CTX_NAMESPACES',
    )
  })
})
