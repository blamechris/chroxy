import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import * as protocol from '@chroxy/protocol'
import {
  SCHEMA_BACKED_OUTBOUND_TYPES,
  typeLiteralsOf,
  looksLikeNonFrameForTests,
  NON_FRAME_SCHEMA_NAMES,
  UNREADABLE_FRAME_SCHEMA_NAMES,
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

/**
 * Frames excluded from the coverage requirement because they are TRANSPORT rather than
 * semantic frames — and the exclusion is CHECKED, not merely asserted in prose.
 *
 * `encrypted` is the E2E envelope. It DOES have a schema (`EncryptedEnvelopeSchema`),
 * just under a name the registry's `Server*` filter cannot see — so it was sitting in
 * UNSCHEMAD where the shrink guard could never fire for it: permanent rot in exactly
 * the form that assertion is blind to.
 */
const TRANSPORT_FRAMES = new Map([['encrypted', 'EncryptedEnvelopeSchema']])

// The frames the server documents sending that have no outbound schema, measured
// against the roster in ws-server.js. Delete entries as schemas land — the test
// below fails if you forget.
const UNSCHEMAD = new Set([
  'agent_list',
  'available_permission_modes',
  'confirm_permission_mode',
  'dev_preview',
  'dev_preview_stopped',
  'file_list',
  'file_listing',
  'history_replay_end',
  'history_replay_start',
  'log_entry',
  'pairing_refreshed',
  'permission_rules_updated',
  'primary_changed',
  'server_mode',
  'server_status',
  'session_context',
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

const SERVER_SRC = join(HERE, '..', 'src')
const REPO_ROOT = join(HERE, '..', '..', '..')

/**
 * #7109 — the roster is hand-written prose, so nothing stops it documenting a frame
 * the server never sends. `discovered_sessions` and `session_created` both sat in it
 * (and in UNSCHEMAD) for years as phantoms: documented, allowlisted, and never emitted.
 *
 * The first sweep missed `session_created` because it matched the BARE STRING, and the
 * string is everywhere — as a `SessionManager` EventEmitter event, which is not a wire
 * frame. A bare-string match cannot tell the two apart. A wire frame is built as an
 * object with a `type:` key, so that is the form this matches.
 */

/** Drop whole-line comments, so a type named only in prose (the roster itself included) is not a producer. */
function stripCommentLines(text) {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trimStart()
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
    })
    .join('\n')
}

/** All of packages/server/src as code: no comments, so the roster and prose are not producers. */
function serverSourceCode() {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.js')) out.push(stripCommentLines(readFileSync(p, 'utf8')))
    }
  }
  walk(SERVER_SRC)
  return out.join('\n')
}

/**
 * True when `code` builds a wire frame of `type`: an object with `type: '<t>'`, or a
 * `broadcastType: '<t>'` (per-session-settings.js builds three frames from that field).
 * An EventEmitter `emit('<t>')` or a `.on('<t>')` deliberately does NOT match.
 */
function buildsWireFrame(code, type) {
  return new RegExp(`\\b(?:type|broadcastType)\\s*:\\s*['"\`]${type}['"\`]`).test(code)
}

/**
 * Roster types the server source does not spell as a `type:` literal, each for a stated
 * reason and each CHECKED: every anchor must still match, so an exemption cannot outlive
 * the code it points at.
 */
const NO_SERVER_TYPE_LITERAL = new Map([
  ['permission_request', {
    why: 'built by the protocol builder buildPermissionRequestMessage, which the event normalizer calls',
    anchors: [
      ['packages/protocol/src/schemas/server/stream.ts', /\btype:\s*'permission_request'/],
      ['packages/server/src/event-normalizer.js', /buildPermissionRequestMessage\(/],
    ],
  }],
  ['extension_message', {
    why: 'RESERVED, NEVER SENT: the outbound arm of the extension framework has a schema and is documented, but ' +
      'no session emits it today (the server only RECEIVES extension_message). Distinct from #7109\'s phantoms, ' +
      'which had no schema and no purpose; whether to delete it is its own decision.',
    anchors: [
      ['packages/protocol/src/schemas/server/billing.ts', /type:\s*z\.literal\('extension_message'\)/],
      ['packages/server/src/handlers/feature-handlers.js', /\bextension_message:\s*handleExtensionMessage/],
    ],
  }],
  ['web_feature_status', {
    why: 'CONSUMED, NEVER SENT: no server producer (its data ships as auth_ok.webFeatures) but both clients ' +
      'dispatch on it through store-core. Not a phantom — deleting it breaks working code.',
    anchors: [
      ['packages/store-core/src/dispatch-table.ts', /\bweb_feature_status:\s*dispatchWebFeatureStatus/],
      ['packages/server/src/ws-history.js', /\bwebFeatures:\s*webTaskManager\.getFeatureStatus\(\)/],
    ],
  }],
])

/** Roster types with no producer and no verified exemption. */
function phantomRosterTypes(roster, code, exempt = NO_SERVER_TYPE_LITERAL, transport = TRANSPORT_FRAMES) {
  return roster.filter((t) => !transport.has(t) && !exempt.has(t) && !buildsWireFrame(code, t))
}

describe('#7085 outbound schema coverage', () => {
  it('CONTROL: the registry and the roster are both non-trivially populated', () => {
    // Guards against the whole suite passing because a parse silently yielded
    // nothing — every assertion below is vacuously true on an empty set.
    // Floors are TIGHT on purpose. A loose `> 100` let a roster truncation losing 72 of
    // 177 types (41%) pass the whole suite green, and the incidental thing that saved it
    // (two allowlist entries near the block's end tripping the stale guard) disappears
    // precisely as UNSCHEMAD shrinks to zero — which is the plan. Raise these when the
    // real counts grow; never lower them.
    assert.ok(
      SCHEMA_BACKED_OUTBOUND_TYPES.length >= 150,
      `registry undercounts: ${SCHEMA_BACKED_OUTBOUND_TYPES.length} (expected >= 150)`,
    )
    assert.ok(
      rosterTypes().length >= 175,
      `roster parse undercounts: ${rosterTypes().length} (expected >= 175) — did the JSDoc block move or its quoting change?`,
    )
  })

  it('every documented outbound type has a schema, or is a known gap', () => {
    const gaps = rosterTypes().filter((t) => !outboundSchemasForType(t).length && !UNSCHEMAD.has(t) && !TRANSPORT_FRAMES.has(t))
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

  it('a UNION-shaped frame schema is registered under its arms\' literal', () => {
    // ServerEvaluateDraftResultSchema and ServerPermissionInputSchema are unions, so
    // they have no top-level `.shape` and a naive `shape.type.value` lookup dropped
    // them SILENTLY — both were briefly recorded as uncovered frames because of it.
    for (const type of ['evaluate_draft_result', 'permission_input']) {
      const arms = outboundSchemasForType(type)
      assert.ok(arms.length > 0, `union-shaped frame '${type}' must be registered, got none`)
    }
  })

  it('INVARIANT: no schema carries a type literal the derivation cannot read', () => {
    // The whole point of deriving rather than declaring: a schema that HAS a
    // discriminating literal but whose literal cannot be extracted is a SILENT DROP,
    // which understates coverage and lets a real frame look schema-less. This must
    // stay empty for any Zod version — if it fires, fix typeLiteralsOf, do not
    // suppress it.
    assert.deepEqual(
      UNREADABLE_FRAME_SCHEMA_NAMES, [],
      'these have a type literal that could not be read — the registry is understating coverage',
    )
  })

  it('a `type` field that is DATA, not a literal, is not mistaken for a frame', () => {
    // ServerPermissionAuditEntrySchema.type is z.string() (it names the audited tool).
    // Classifying on "has a type field" instead of "has a type LITERAL" wrongly
    // flagged it as an unreadable frame.
    assert.ok(NON_FRAME_SCHEMA_NAMES.includes('ServerPermissionAuditEntrySchema'))
    assert.equal(UNREADABLE_FRAME_SCHEMA_NAMES.includes('ServerPermissionAuditEntrySchema'), false)
  })

  it('a transport frame is excluded only because its schema really exists', () => {
    for (const [type, schemaName] of TRANSPORT_FRAMES) {
      assert.equal(typeof protocol[schemaName]?.safeParse, 'function', `${schemaName} must exist to justify excluding '${type}'`)
      assert.equal(UNSCHEMAD.has(type), false, `'${type}' has a schema and must not also be allowlisted`)
    }
  })

  it('a frame hidden behind a WRAPPER is reported, not silently excluded', () => {
    // The invariant defended unions and nothing else: every other combinator
    // (.optional/.nullable/.default/.catch/.pipe/.transform/.readonly/intersection/
    // z.lazy) hides `.shape`, so keying "non-frame" off a missing shape filed all of
    // them as legitimate sub-objects. Anything that is not a plain object and yields no
    // literal is now surfaced instead.
    const wrapped = z.object({ type: z.literal('a_wrapped_frame'), x: z.string() }).optional()
    assert.equal(typeLiteralsOf(wrapped).size, 0, 'precondition: the wrapper hides the literal')
    assert.equal(
      looksLikeNonFrameForTests(wrapped), false,
      'a wrapped schema must be reported as unreadable, not excluded as a sub-object',
    )
  })

  it('a multi-value literal does not crash the derivation', () => {
    // `z.literal(['a','b']).value` THROWS and the registry is built at module load, so
    // reading `.value` before `_def.values` would have been a module-load crash.
    const multi = z.object({ type: z.literal(['m_one', 'm_two']) })
    assert.deepEqual([...typeLiteralsOf(multi)].sort(), ['m_one', 'm_two'])
  })

  describe('#7109 no phantom frames in the roster', () => {
    it('every documented frame is built somewhere in the server source', () => {
      const phantoms = phantomRosterTypes(rosterTypes(), serverSourceCode())
      assert.deepEqual(
        phantoms, [],
        `documented in the ws-server.js roster but no server code builds a { type: '<t>' } frame: ${phantoms.join(', ')}. ` +
        'Delete the roster line (and any allowlist entry), or — if it is consumed but built by a ' +
        'helper — add a checked entry to NO_SERVER_TYPE_LITERAL.',
      )
    })

    it('CONTROL: an EventEmitter event of the same name is not mistaken for a frame', () => {
      // The exact false negative of the first sweep: `session_created` is emitted by
      // SessionManager, so the bare string is all over the tree. It must still be flagged.
      const code = "this.emit('session_created', { sessionId })\nmgr.on('session_created', () => {})\n"
      assert.deepEqual(phantomRosterTypes(['session_created'], code, new Map(), new Map()), ['session_created'])
      assert.deepEqual(
        phantomRosterTypes(['session_created'], code + "send({ type: 'session_created', sessionId })\n", new Map(), new Map()),
        [],
        'a real { type: ... } frame is a producer',
      )
      assert.deepEqual(
        phantomRosterTypes(['x_changed'], "def({ broadcastType: 'x_changed' })\n", new Map(), new Map()), [],
        'a broadcastType field builds a frame',
      )
    })

    it('CONTROL: prose naming a type is not a producer', () => {
      const code = stripCommentLines("/**\n * { type: 'ghost_frame', a } — documented\n */\n// type: 'ghost_frame'\nconst x = 1\n")
      assert.deepEqual(phantomRosterTypes(['ghost_frame'], code, new Map(), new Map()), ['ghost_frame'])
    })

    it('an exemption is only valid while every one of its anchors still matches', () => {
      for (const [type, { why, anchors }] of NO_SERVER_TYPE_LITERAL) {
        assert.ok(why.length > 20, `'${type}' needs a stated reason`)
        for (const [file, re] of anchors) {
          assert.ok(
            re.test(readFileSync(join(REPO_ROOT, file), 'utf8')),
            `exemption for '${type}': ${file} no longer matches ${re} — the exemption is stale`,
          )
        }
      }
    })

    it('an exemption is removed once the server does build the frame', () => {
      const code = serverSourceCode()
      const roster = new Set(rosterTypes())
      for (const type of NO_SERVER_TYPE_LITERAL.keys()) {
        assert.ok(roster.has(type), `'${type}' is exempted but not in the roster (stale)`)
        assert.equal(buildsWireFrame(code, type), false, `'${type}' is now built as a { type } literal — drop its exemption`)
      }
    })
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
      // Uses a value that is invalid for a TYPE reason, deliberately. The original
      // fixture here was `defaultModel: null` — which was the #7089 bug, i.e. this
      // test was pinned to a violation that was about to be fixed, and #7092 (making
      // the field nullable) turned it red. A fixture whose validity depends on an
      // open bug expires the moment the bug is closed.
      const r = validateOutbound({ type: 'available_models', models: [], defaultModel: 42 })
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
