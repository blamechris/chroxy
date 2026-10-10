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
        `documented in the ws-server.js roster but NO PRODUCER CANDIDATE found (no server code spells a { type: '<t>' } frame): ${phantoms.join(', ')}. ` +
        '(Green means a candidate exists, not that the send is reachable.) ' +
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

  describe('#7107 roster field lists are pinned to the schemas', () => {
    // The roster is hand-written prose, so nothing stopped a line naming a field no
    // producer sends (`git_status_result` documented `status`, `diff_result` documented
    // `diff`, `git_branches_result` documented `current`, `web_feature_status` documented
    // `features`) or omitting one it does (`session_context` documented `cwd` while sending
    // `gitBranch`). The comparison runs BOTH ways against the registered schema, because the
    // drift ran both ways: a roster naming more than the schema, and a schema missing what a
    // producer really sends.
    //
    // `sessionId` is excluded on both sides: `_broadcastToSession` stamps it on every
    // session-scoped frame downstream of the producer, so most schemas rightly omit it
    // (#7108 decided it is a transport tag, not a producer field). `type` is the key.

    /** Fields a producer sends and the roster names, that the schema does not declare yet. */
    const ROSTER_FIELDS_SCHEMA_LACKS = new Map([
      ['auth_ok', {
        fields: ['defaultCwd', 'webFeatures', 'features'],
        why: 'ws-history.js sends all three in auth_ok; ServerAuthOkSchema declares none, so a parse strips them',
      }],
      ['tool_result', {
        fields: ['images'],
        why: 'event-normalizer.js attaches `images` when the tool returned any; ServerToolResultSchema lacks it',
      }],
      ['server_error', {
        fields: ['correlationId'],
        why: 'ws-server.js _handleMessage\'s catch path sends it; ServerErrorSchema lacks it',
      }],
      ['host_status_snapshot', {
        fields: ['requestId'],
        why: 'control-room-handlers.js echoes the request id; ServerHostStatusSnapshotSchema lacks it (the sibling snapshots declare it)',
      }],
    ])

    /** Everything up to the Encrypted-envelope marker: the Server -> Client section proper. */
    function rosterSectionText() {
      const lines = readFileSync(WS_SERVER, 'utf8').split('\n')
      const start = lines.findIndex((l) => l.includes('Server -> Client:'))
      assert.ok(start > 0, 'the Server -> Client roster must exist in ws-server.js')
      const body = []
      let closed = false
      for (const line of lines.slice(start + 1)) {
        if (!line.trimStart().startsWith('*')) break
        if (line.includes('Encrypted envelope')) { closed = true; break }
        body.push(line.replace(/^\s*\*\s?/, ''))
      }
      assert.ok(closed, 'the roster section must end at the "Encrypted envelope" marker — did it move?')
      return body.join('\n')
    }

    /**
     * Parse every `{ type: '<t>', field, field?, ... }` head in `text`. Fails LOUD on a head it
     * cannot close or a field it cannot name, so an unparsed line cannot read as "no fields".
     */
    function parseRosterEntries(text) {
      const entries = []
      for (const m of text.matchAll(/\{\s*type:\s*'([a-z0-9_]+)'/g)) {
        let depth = 0
        let end = -1
        for (let i = m.index; i < text.length; i++) {
          const c = text[i]
          if (c === '{' || c === '[' || c === '(') depth++
          else if (c === '}' || c === ']' || c === ')') {
            depth--
            if (depth === 0) { end = i; break }
          }
        }
        assert.ok(end > 0, `roster head for '${m[1]}' never closes`)
        const inner = text.slice(m.index + 1, end)
        const parts = []
        let cur = ''
        let d = 0
        for (const c of inner) {
          if ('{[('.includes(c)) d++
          else if ('}])'.includes(c)) d--
          if (c === ',' && d === 0) { parts.push(cur); cur = '' } else cur += c
        }
        parts.push(cur)
        const fields = []
        for (const raw of parts.slice(1).map((x) => x.trim()).filter(Boolean)) {
          if (raw.startsWith('...')) { fields.push({ name: '...', optional: false }); continue }
          const f = /^([A-Za-z_][A-Za-z0-9_]*)(\?)?/.exec(raw)
          assert.ok(f, `roster '${m[1]}': cannot name the field "${raw.slice(0, 30)}"`)
          fields.push({ name: f[1], optional: f[2] === '?' })
        }
        entries.push({ type: m[1], fields })
      }
      return entries
    }

    /**
     * name -> { optional } over every object arm of the schemas registered for `type`. A field is
     * optional when ANY arm omits it or declares it optional, i.e. a valid frame can lack it.
     * Returns null when nothing is registered (the type is unpinned).
     */
    function schemaFieldsFor(type) {
      const schemas = outboundSchemasForType(type)
      if (schemas.length === 0) return null
      const objects = []
      const collect = (schema) => {
        const options = schema?._def?.options
        if (options) { for (const o of options) collect(o); return }
        assert.ok(schema?.shape, `${type}: cannot read the shape of an arm — the pin would pass vacuously`)
        objects.push(schema)
      }
      for (const { schema } of schemas) collect(schema)
      const names = new Set(objects.flatMap((o) => Object.keys(o.shape)))
      const out = new Map()
      for (const name of names) {
        const optional = objects.some((o) => !(name in o.shape) || o.shape[name].isOptional())
        out.set(name, { optional })
      }
      return out
    }

    /** The disagreements between one roster line and its schema. Empty means pinned. */
    function rosterLineProblems(entry, schemaFields, lacks = []) {
      const problems = []
      const named = new Map(entry.fields.map((f) => [f.name, f]))
      for (const [name, f] of named) {
        if (name === 'sessionId') continue
        if (name === '...') { problems.push('uses `...`, which hides fields from the pin: list them'); continue }
        const declared = schemaFields.get(name)
        if (!declared) {
          if (!lacks.includes(name)) problems.push(`names \`${name}\`, which the schema does not declare`)
          continue
        }
        // One-sided on purpose: a roster `?` on a field the schema requires is a contradiction, but a
        // roster-REQUIRED field the schema marks optional is allowed — the schemas are lenient on parse
        // while the roster states what the producer always sends (#7107 review, N2).
        if (f.optional && !declared.optional) problems.push(`marks \`${name}?\` optional but the schema requires it`)
      }
      for (const name of schemaFields.keys()) {
        if (name === 'type' || name === 'sessionId') continue
        if (!named.has(name)) problems.push(`omits schema field \`${name}\``)
      }
      return problems
    }

    const ENTRIES = parseRosterEntries(rosterSectionText())

    /**
     * Every `type: '<name>'` the section spells, by a LOOSER pattern than the parser's (quotes of any
     * kind, optional quotes round the key, any spacing). A head the parser's strict pattern cannot
     * read — `{type:"pong", serverTs?}` — leaves the pin silently, and nothing downstream notices
     * a line that is simply absent from ENTRIES; this is the independent count that does.
     */
    function looseTypeMentions(text) {
      return [...text.matchAll(/["']?\btype\b["']?\s*:\s*['"`]([A-Za-z0-9_]+)['"`]/g)].map((m) => m[1])
    }

    it('every `type: \'<name>\'` the section spells is parsed into an entry', () => {
      const text = rosterSectionText()
      assert.deepEqual(
        ENTRIES.map((e) => e.type).sort(), looseTypeMentions(text).sort(),
        'a roster head the parser cannot read (double quotes, no space after the brace, …) is dropped from the pin: write it as `{ type: \'<name>\', … }`',
      )
    })

    it('CONTROL: the loose count sees a head the strict parser misses', () => {
      const text = `{ type: 'a_frame', x }\n{type:"b_frame", y?}\n`
      assert.deepEqual(parseRosterEntries(text).map((e) => e.type), ['a_frame'])
      assert.deepEqual(looseTypeMentions(text), ['a_frame', 'b_frame'])
    })

    it('CONTROL: the roster section parses to a duplicate-free list', () => {
      // No size floor here: the parse is held to an independent count above, and the registry to the
      // roster below (every registered type must be listed), so an empty parse fails there already.
      const seen = new Set()
      const dupes = ENTRIES.filter((e) => seen.has(e.type) || !seen.add(e.type)).map((e) => e.type)
      assert.deepEqual(dupes, [], 'a type listed twice would let one line dodge the pin')
    })

    it('every schema-backed roster line names exactly the schema fields', () => {
      let pinned = 0
      const problems = []
      for (const entry of ENTRIES) {
        const schemaFields = schemaFieldsFor(entry.type)
        if (!schemaFields) continue
        pinned++
        const lacks = ROSTER_FIELDS_SCHEMA_LACKS.get(entry.type)?.fields ?? []
        for (const p of rosterLineProblems(entry, schemaFields, lacks)) problems.push(`${entry.type}: ${p}`)
      }
      assert.ok(pinned > 0, 'no roster line was pinned')
      assert.deepEqual(problems, [], 'roster line(s) disagree with their Server*Schema (edit the roster line; a producer-side field the schema lacks goes in ROSTER_FIELDS_SCHEMA_LACKS)')
    })

    /** Registered frame types that genuinely should not have a roster line. Empty today; entries are stale-checked. */
    const ROSTER_EXEMPT_SCHEMA_TYPES = new Map()

    function schemaTypesMissingFromRoster(listed, registered = SCHEMA_BACKED_OUTBOUND_TYPES, exempt = ROSTER_EXEMPT_SCHEMA_TYPES) {
      return registered.filter((t) => !listed.has(t) && !exempt.has(t))
    }

    it('every registered Server*Schema frame type has a roster line (the reverse direction)', () => {
      const listed = new Set(ENTRIES.map((e) => e.type))
      assert.deepEqual(
        schemaTypesMissingFromRoster(listed), [],
        'a frame with a schema and no roster line is documented nowhere: add `{ type: \'<t>\', … }` to the Server -> Client roster',
      )
      // The registry is large by construction; a near-empty one would make the line above vacuous.
      assert.ok(SCHEMA_BACKED_OUTBOUND_TYPES.length >= 150, 'registry undercounts')
    })

    it('a roster-exempt schema type is only valid while it is registered and still unlisted', () => {
      const listed = new Set(ENTRIES.map((e) => e.type))
      for (const [type, why] of ROSTER_EXEMPT_SCHEMA_TYPES) {
        assert.ok(why.length > 20, `'${type}' needs a stated reason`)
        assert.ok(SCHEMA_BACKED_OUTBOUND_TYPES.includes(type), `'${type}' is exempted but has no schema (stale)`)
        assert.equal(listed.has(type), false, `'${type}' now has a roster line — drop its exemption`)
      }
    })

    it('CONTROL: a registered type missing from the roster is reported, unless exempted', () => {
      const listed = new Set(['a', 'b'])
      assert.deepEqual(schemaTypesMissingFromRoster(listed, ['a', 'b', 'c'], new Map()), ['c'])
      assert.deepEqual(schemaTypesMissingFromRoster(listed, ['a', 'b', 'c'], new Map([['c', 'a stated reason that is long enough']])), [])
    })

    it('the unpinned lines are exactly the types with no schema', () => {
      const unpinned = ENTRIES.filter((e) => !schemaFieldsFor(e.type)).map((e) => e.type).sort()
      assert.deepEqual(unpinned, [...UNSCHEMAD].sort(), 'the lines the pin cannot see must be the UNSCHEMAD allowlist, no more and no fewer')
    })

    it('a schema-gap exemption is only valid while the roster names the field and the schema still lacks it', () => {
      for (const [type, { fields, why }] of ROSTER_FIELDS_SCHEMA_LACKS) {
        assert.ok(why.length > 20, `'${type}' needs a stated reason`)
        const entry = ENTRIES.find((e) => e.type === type)
        const schemaFields = schemaFieldsFor(type)
        assert.ok(entry && schemaFields, `'${type}' is exempted but is not a schema-backed roster line (stale)`)
        for (const f of fields) {
          assert.ok(entry.fields.some((x) => x.name === f), `'${type}.${f}' is exempted but the roster no longer names it (stale)`)
          assert.equal(schemaFields.has(f), false, `'${type}.${f}' now HAS a schema field — drop its exemption`)
        }
      }
    })

    it('CONTROL: a roster line that omits a schema field is reported', () => {
      const schema = new Map([['type', { optional: false }], ['a', { optional: false }], ['b', { optional: true }]])
      assert.deepEqual(rosterLineProblems({ type: 'x', fields: [{ name: 'a', optional: false }] }, schema), ['omits schema field `b`'])
    })

    it('CONTROL: a roster line that names a field the schema lacks is reported, unless exempted', () => {
      const schema = new Map([['type', { optional: false }], ['a', { optional: false }]])
      const entry = { type: 'x', fields: [{ name: 'a', optional: false }, { name: 'ghost', optional: false }] }
      assert.deepEqual(rosterLineProblems(entry, schema), ['names `ghost`, which the schema does not declare'])
      assert.deepEqual(rosterLineProblems(entry, schema, ['ghost']), [])
    })

    it('CONTROL: `?` on a field the schema requires is reported; sessionId is ignored both ways', () => {
      const schema = new Map([['type', { optional: false }], ['a', { optional: false }]])
      const entry = { type: 'x', fields: [{ name: 'a', optional: true }, { name: 'sessionId', optional: false }] }
      assert.deepEqual(rosterLineProblems(entry, schema), ['marks `a?` optional but the schema requires it'])
      const withSid = new Map([...schema, ['sessionId', { optional: false }]])
      assert.deepEqual(rosterLineProblems({ type: 'x', fields: [{ name: 'a', optional: false }] }, withSid), [])
    })

    it('CONTROL: `...` is not a way around the pin', () => {
      const schema = new Map([['type', { optional: false }], ['a', { optional: false }]])
      const problems = rosterLineProblems({ type: 'x', fields: [{ name: '...', optional: false }] }, schema)
      assert.equal(problems.length, 2, `expected the \`...\` and the omitted field, got ${problems.join(' | ')}`)
    })

    it('CONTROL: the parser reads multi-line heads, [] and |null suffixes, nested braces and optionals', () => {
      const text = [
        "{ type: 'a_frame', one, two?, list[], name|null,",
        "  nested: { x, y } | null, tail: [ { p, q } ] }  — prose with { braces } and, commas",
        "{ type: 'b_frame' }",
      ].join('\n')
      const [a, b] = parseRosterEntries(text)
      assert.deepEqual(a.fields.map((f) => f.name + (f.optional ? '?' : '')), ['one', 'two?', 'list', 'name', 'nested', 'tail'])
      assert.deepEqual(b.fields, [])
    })

    it('CONTROL: the parser fails loud on a head it cannot close', () => {
      assert.throws(() => parseRosterEntries("{ type: 'c_frame', a, b"), /never closes/)
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
