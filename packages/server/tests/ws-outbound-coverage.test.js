import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  SCHEMA_BACKED_OUTBOUND_TYPES,
  NON_FRAME_SCHEMA_NAMES,
  outboundSchemasForType,
  validateOutbound,
} from '../src/ws-outbound-schemas.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WS_SERVER = join(HERE, '..', 'src', 'ws-server.js')

/**
 * #7085 — outbound schema COVERAGE.
 *
 * The server does not validate what it sends, which is how 8 wire-illegal fields
 * reached main (the #7080-#7086 audit). Before a runtime gate can be switched on,
 * every frame the server sends needs a schema — otherwise the gate passes
 * vacuously on exactly the frames nothing describes.
 *
 * This suite does NOT gate sends. It pins coverage, so a NEW undocumented-by-schema
 * frame fails CI the day it is added rather than years later.
 *
 * UNSCHEMAD is a SHRINKING allowlist. Two assertions keep it honest:
 *   - a roster type that is neither schema-backed nor allowlisted FAILS (no growth)
 *   - an allowlisted type that HAS gained a schema FAILS until removed (no rot)
 * The second is the one that matters: without it the list would still be 30 entries
 * long after the schemas landed, and nobody would notice.
 */

// The 30 frames the server documents sending that have no outbound schema, measured
// against the roster in ws-server.js. Delete entries as schemas land — the test
// below fails if you forget.
const UNSCHEMAD = new Set([
  'agent_list',
  'available_permission_modes',
  'confirm_permission_mode',
  'dev_preview',
  'dev_preview_stopped',
  'discovered_sessions',
  'encrypted',
  'evaluate_draft_result',
  'file_list',
  'file_listing',
  'git_commit_result',
  'git_stage_result',
  'git_unstage_result',
  'history_replay_end',
  'history_replay_start',
  'log_entry',
  'pairing_refreshed',
  'permission_input',
  'permission_rules_updated',
  'primary_changed',
  'server_mode',
  'server_status',
  'session_context',
  'session_created',
  'session_destroyed',
  'session_role',
  'session_switched',
  'slash_commands',
  'status',
  'token_rotated',
])

/** Outbound types the server documents in ws-server.js's `Server -> Client:` roster. */
function rosterTypes() {
  const lines = readFileSync(WS_SERVER, 'utf8').split('\n')
  const start = lines.findIndex((l) => l.includes('Server -> Client:'))
  assert.ok(start > 0, 'the Server -> Client roster must exist in ws-server.js')
  const found = new Set()
  for (const line of lines.slice(start + 1)) {
    // The roster is one JSDoc block; the first non-`*` line ends it.
    if (!line.trimStart().startsWith('*')) break
    for (const m of line.matchAll(/\{\s*type:\s*'([a-z0-9_]+)'/g)) found.add(m[1])
  }
  return [...found].sort()
}

describe('#7085 outbound schema coverage', () => {
  it('CONTROL: the registry and the roster are both non-trivially populated', () => {
    // Guards against the whole suite passing because a parse silently yielded
    // nothing — every assertion below is vacuously true on an empty set.
    assert.ok(SCHEMA_BACKED_OUTBOUND_TYPES.length > 100, `registry looks empty: ${SCHEMA_BACKED_OUTBOUND_TYPES.length}`)
    assert.ok(rosterTypes().length > 100, `roster parse looks empty: ${rosterTypes().length}`)
  })

  it('every documented outbound type has a schema, or is a known gap', () => {
    const gaps = rosterTypes().filter((t) => !outboundSchemasForType(t).length && !UNSCHEMAD.has(t))
    assert.deepEqual(
      gaps, [],
      `new outbound frame(s) with no schema in @chroxy/protocol: ${gaps.join(', ')}. ` +
      'Add a Server<Name>Schema with a  literal (it registers itself), or — only ' +
      'if the frame genuinely cannot be described — add it to UNSCHEMAD with a reason.',
    )
  })

  it('the allowlist only shrinks: no entry may still be listed once it has a schema', () => {
    const fixed = [...UNSCHEMAD].filter((t) => outboundSchemasForType(t).length > 0)
    assert.deepEqual(
      fixed, [],
      `these now HAVE schemas and must be deleted from UNSCHEMAD: ${fixed.join(', ')}`,
    )
  })

  it('every allowlisted type is really one the server documents sending', () => {
    // Stops the list accumulating entries for frames that no longer exist.
    const roster = new Set(rosterTypes())
    const stale = [...UNSCHEMAD].filter((t) => !roster.has(t))
    assert.deepEqual(stale, [], `UNSCHEMAD entries not in the roster (stale): ${stale.join(', ')}`)
  })

  it('a type claimed by two schemas keeps BOTH arms', () => {
    // `error` is claimed by ServerErrorEnvelopeSchema and
    // ServerSkillTrustGrantInvalidAuthorSchema. Keying one-schema-per-type would
    // validate half the error frames against the wrong shape.
    const arms = outboundSchemasForType('error')
    assert.ok(arms.length >= 2, `expected >= 2 arms for 'error', got ${arms.map((a) => a.name).join(', ')}`)
  })

  it('sub-object schemas are excluded from the frame registry', () => {
    // These are reached THROUGH a frame, so registering them would invent frame
    // types that no sender ever emits.
    assert.ok(NON_FRAME_SCHEMA_NAMES.includes('ServerSessionListEntrySchema'))
    assert.equal(outboundSchemasForType('').length, 0)
  })

  describe('validateOutbound', () => {
    it('accepts a well-formed frame', () => {
      const r = validateOutbound({ type: 'available_models', models: [], defaultModel: 'm', provider: null })
      assert.equal(r.ok, true, `expected valid, got ${JSON.stringify(r)}`)
    })

    it('reports an unknown type as no-schema rather than valid', () => {
      // The vacuous-pass failure mode this whole exercise exists to prevent.
      const r = validateOutbound({ type: 'definitely_not_a_real_frame' })
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'no-schema')
    })

    it('reports a schema violation with the offending path', () => {
      const r = validateOutbound({ type: 'available_models', models: [], defaultModel: null })
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'invalid')
      assert.deepEqual(r.issue.path, ['defaultModel'], 'the caller needs the field, not just a boolean')
    })

    it('reports a message with no type at all', () => {
      assert.equal(validateOutbound({ nope: 1 }).reason, 'no-type')
      assert.equal(validateOutbound(null).reason, 'no-type')
    })
  })
})
