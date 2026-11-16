/**
 * Guard: every place the daemon announces `permission_resolved` says WHO or WHAT resolved it
 * (docs/security/agent-principals.md section 9; #9119, S4 of #9112).
 *
 * The sites are enumerated from the syntax tree (tests/helpers/permission-resolved-sites.js),
 * so a new emit site written without `resolvedBy` goes red here instead of shipping a frame
 * a consumer cannot attribute. The roster below is checked in BOTH directions: a site that is
 * not listed fails, and a listed site that no longer exists fails (a roster that silently
 * shrinks is a guard that checks nothing).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanPermissionResolvedSites, scanUnclassifiedMentions } from './helpers/permission-resolved-sites.js'
import { EventNormalizer } from '../src/event-normalizer.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// The oracle, spelled out: where `permission_resolved` is announced today.
const EXPECTED = {
  // 13 manager resolutions: abort, timeout, question abort, question timeout, superseded, user,
  // question answered, MCP-trust auto-mode deny, auto-mode allow, clearAll (request + question),
  // explicit-consent finish, MCP-trust timeout
  'permission-manager.js': { 'emit-literal': 13, 'emit-relay': 1 },
  // the legacy (hook-routed) answer, announced for both the WS and the HTTP transport
  'permission-resolver.js': { 'frame-literal': 1 },
  // the unified pipeline's two wire frames: the prompt variant and the superseded question
  'event-normalizer.js': { 'frame-literal': 2 },
  // the dev-preview consent prompt's own manager, sent straight to its requester
  'dev-preview.js': { 'frame-literal': 1 },
  // a BYOK subagent's event, relayed to the parent's agent_event channel unchanged
  'byok-session.js': { 'emit-relay': 1 },
}

// Every OTHER place the string appears, with why it is not an announcement. A mention outside
// this list (a new comparison, list, key or constant) fails: it may be a shape the scanner does
// not understand, so a person has to look and either add a reason here or make it a site.
const ALLOWED_MENTIONS = {
  'agent-control/client.js': { count: 4, reason: 'the MCP adapter READS the frame (a buffered-type set and comparisons)' },
  'agent-control/events.js': { count: 1, reason: 'the event-log allowlist of forwarded broadcast types' },
  'base-session.js': { count: 1, reason: 'the list of events a session forwards upward' },
  'byok-session.js': { count: 1, reason: 'a comparison on a relayed child event type' },
  'event-normalizer.js': { count: 3, reason: 'the nested-payload type test, the agent_event registration compare, and the EVENT_MAP key' },
  'outgoing-policy.js': { count: 1, reason: 'the bound-client delivery roster' },
  'principal-policy.js': { count: 1, reason: 'the principal delivery denylist' },
  'session-manager.js': { count: 4, reason: 'the transient-event list and the permission-outcome history mapping, which read the event' },
  'ws-server.js': { count: 1, reason: 'a filter comparing the event name' },
}

function tally(sites) {
  const out = {}
  for (const s of sites) {
    out[s.file] ??= {}
    out[s.file][s.shape] = (out[s.file][s.shape] ?? 0) + 1
  }
  return out
}

describe('permission_resolved emit sites (#9119)', () => {
  const sites = scanPermissionResolvedSites(SRC)

  it('finds sites at all, and exactly the rostered ones, in both directions', () => {
    assert.ok(sites.length > 0, 'the scan found nothing: the guard is not looking')
    assert.deepEqual(tally(sites), EXPECTED)
  })

  it('every other mention of the string is accounted for, in both directions', () => {
    const found = {}
    for (const m of scanUnclassifiedMentions(SRC)) found[m.file] = (found[m.file] ?? 0) + 1
    assert.deepEqual(found, Object.fromEntries(Object.entries(ALLOWED_MENTIONS).map(([f, v]) => [f, v.count])))
  })

  it('every literal emit and every wire frame names resolvedBy', () => {
    const missing = sites
      .filter((s) => s.shape !== 'emit-relay' && !s.hasResolvedBy)
      .map((s) => `${s.file}:${s.line} (${s.shape})`)
    assert.deepEqual(missing, [], 'these announce permission_resolved without resolvedBy')
  })

  it('the BYOK relay path (an emit-relay site) is normalized on its way to the wire', () => {
    // A relayed child event reaches clients inside an `agent_event` payload. Whatever the child
    // put on `resolvedBy` must be rebuilt there, because the relay site itself cannot be.
    assert.ok(sites.some((s) => s.file === 'byok-session.js' && s.shape === 'emit-relay'), 'precondition: the relay exists')
    const poisoned = { kind: 'user', clientId: 'client-1', deviceName: "Chris's iPhone", token: 'tok-secret' }
    const payload = { requestId: 'r1', decision: 'allow', reason: 'user', resolvedBy: poisoned }
    const normalizer = new EventNormalizer()
    try {
      const result = normalizer.normalize('agent_event', { parentToolUseId: 'toolu_1', type: 'permission_resolved', payload }, { sessionId: 's1', mode: 'multi', getSessionEntry: () => null })
      const wire = result.messages[0].msg.payload
      assert.deepEqual(wire.resolvedBy, { kind: 'user' })
      assert.equal(JSON.stringify(result.messages).includes('client-1'), false)
      assert.deepEqual(payload.resolvedBy, poisoned, "the producer's own object is not mutated")
      // other relayed events stay verbatim
      const other = normalizer.normalize('agent_event', { parentToolUseId: 'toolu_1', type: 'tool_start', payload: { toolUseId: 'x', extra: { a: 1 } } }, { sessionId: 's1', mode: 'multi', getSessionEntry: () => null })
      assert.deepEqual(other.messages[0].msg.payload, { toolUseId: 'x', extra: { a: 1 } })
    } finally { normalizer.destroy() }
  })

  describe('the scan can fail (positive control on a synthetic source tree)', () => {
    function scanSource(text) {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-sites-'))
      try {
        mkdirSync(join(dir, 'nested'))
        writeFileSync(join(dir, 'nested', 'x.js'), text)
        return scanPermissionResolvedSites(dir)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    it('reports a literal emit with no resolvedBy', () => {
      const found = scanSource("export const f = (m) => m.emit('permission_resolved', { requestId: 'r', decision: 'deny' })\n")
      assert.deepEqual(found.map((s) => [s.file, s.shape, s.hasResolvedBy]), [['nested/x.js', 'emit-literal', false]])
    })

    it('reports a wire frame with no resolvedBy, and accepts both spellings that name it', () => {
      const bad = scanSource("export const f = (d) => ({ type: 'permission_resolved', requestId: 'r', ...d })\n")
      assert.equal(bad[0].shape, 'frame-literal')
      assert.equal(bad[0].hasResolvedBy, false, 'a bare spread of the event is not naming resolvedBy')
      const direct = scanSource("export const f = () => ({ type: 'permission_resolved', resolvedBy: RESOLVED_BY.user })\n")
      assert.equal(direct[0].hasResolvedBy, true)
      const helper = scanSource("export const f = (d) => ({ type: 'permission_resolved', ...resolvedByField(d.resolvedBy) })\n")
      assert.equal(helper[0].hasResolvedBy, true)
    })

    it('sees through every spelling of the name (each was invisible to the first scanner)', () => {
      const shapes = {
        'a const identifier': "const T = 'permission_resolved'\nexport const f = (m) => m.emit(T, { requestId: 'r' })\n",
        'a template literal': "export const f = (m) => m.emit(`permission_resolved`, { requestId: 'r' })\n",
        'a concatenation': "export const f = () => ({ type: 'permission_' + 'resolved' })\n",
        'a computed key': "export const f = () => ({ ['type']: 'permission_resolved' })\n",
        'a const concatenation': "const A = 'permission_'\nconst T = A + 'resolved'\nexport const f = (m) => m.emit(T, { a: 1 })\n",
      }
      for (const [name, text] of Object.entries(shapes)) {
        const found = scanSource(text)
        assert.equal(found.length, 1, name)
        assert.equal(found[0].hasResolvedBy, false, name)
      }
    })

    it('does not accept a resolvedBy that is only present, or that is not a vetted producer', () => {
      const frame = (value) => `export const f = (x) => ({ type: 'permission_resolved', resolvedBy: ${value} })\n`
      for (const bad of ['undefined', "{ kind: 'user', clientId: x }", 'x', "{ kind: 'user' }", 'RESOLVED_BY[x]', 'someOther(x)']) {
        assert.equal(scanSource(frame(bad))[0].hasResolvedBy, false, bad)
      }
      for (const good of ['RESOLVED_BY.user', 'resolvedByForReason(x)', 'normalizeResolvedBy(x)', 'normalizeResolvedBy(x) ?? RESOLVED_BY.cleared']) {
        assert.equal(scanSource(frame(good))[0].hasResolvedBy, true, good)
      }
    })

    it('judges the EFFECTIVE resolvedBy: a member that does not exist, or a later override, is not vetted', () => {
      const emit = (body) => `export const f = (m) => m.emit('permission_resolved', { requestId: 'r', ${body} })\n`
      const bad = [
        'resolvedBy: RESOLVED_BY.noSuchKind',
        'resolvedBy: RESOLVED_BY.timeout, resolvedBy: undefined',
        "resolvedBy: RESOLVED_BY.timeout, ...{ resolvedBy: { kind: 'user', clientId: 'x' } }",
        'resolvedBy: RESOLVED_BY.timeout, ...x',
        'resolvedBy: RESOLVED_BY.timeout, ...makeExtras()',
        "resolvedBy: RESOLVED_BY.timeout, ...(c ? { resolvedBy: undefined } : {})",
        '...(c && resolvedByField(y))',
        '...(c && { resolvedBy: RESOLVED_BY.user })',
        '...(c || resolvedByField(y))',
        'resolvedBy: RESOLVED_BY.user, ...(x || {})',
        'resolvedBy: RESOLVED_BY.user, ...(x ?? {})',
        'resolvedBy: RESOLVED_BY.user, ...(x || { a: 1 })',
        'resolvedBy: RESOLVED_BY.user, ...({ resolvedBy: undefined } || {})',
      ]
      for (const body of bad) assert.equal(scanSource(emit(body))[0].hasResolvedBy, false, body)
      const good = [
        'resolvedBy: RESOLVED_BY.timeout',
        'resolvedBy: RESOLVED_BY.cleared, ...(c ? { scope: 1 } : {}), ...stoppedToolUseField(a, b)',
        'resolvedBy: RESOLVED_BY.user, ...(c && { unrelated: 1 })',
        'resolvedBy: RESOLVED_BY.user, ...({ a: 1 } || { b: 2 })',
        '...x, resolvedBy: RESOLVED_BY.user',
        '...x, ...resolvedByField(y)',
        "resolvedBy: undefined, ...{ resolvedBy: RESOLVED_BY.abort }",
      ]
      for (const body of good) assert.equal(scanSource(emit(body))[0].hasResolvedBy, true, body)
    })

    it('finds a name assembled from fragments in a file that never contains the whole word', () => {
      const found = scanSource("export const f = (m) => m.emit('permis' + 'sion_' + 'reso' + 'lved', {})\n")
      assert.deepEqual(found.map((x) => [x.shape, x.hasResolvedBy]), [['emit-literal', false]])
    })

    it('the cross-check reports a mention the scanner does not classify', () => {
      const mentions = (text) => {
        const dir = mkdtempSync(join(tmpdir(), 'chroxy-mentions-'))
        try {
          writeFileSync(join(dir, 'x.js'), text)
          return scanUnclassifiedMentions(dir)
        } finally { rmSync(dir, { recursive: true, force: true }) }
      }
      assert.equal(mentions("export const is = (t) => t === 'permission_resolved'\n").length, 1)
      assert.equal(mentions("export const L = ['permission_resolved']\n").length, 1)
      assert.equal(mentions("export const h = { permission_resolved: () => {} }\n").length, 1)
      assert.equal(mentions("export const T = 'permission_' + 'resolved'\n").length, 1)
      assert.equal(mentions("export const h = (m) => m.on('permission_resolved', () => {})\n").length, 0, 'a listener registration is classified')
      assert.equal(mentions("export const h = (m) => m.emit('permission_resolved', {})\n").length, 0, 'a site is classified (and checked elsewhere)')
    })

    it('does not count a listener registration, a comment or a string', () => {
      const found = scanSource("// m.emit('permission_resolved', {})\nconst s = \"permission_resolved\"\nm.on('permission_resolved', () => {})\n")
      assert.deepEqual(found, [])
    })

    it('reports a relay as a relay (so a new one has to be rostered)', () => {
      const found = scanSource("export const f = (m, d) => m.emit('permission_resolved', d)\n")
      assert.deepEqual(found.map((s) => s.shape), ['emit-relay'])
    })
  })
})
