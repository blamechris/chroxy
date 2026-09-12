import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Registers the real provider classes so getRegistryForProvider('codex')
// resolves its own registry. Without this the reload emits no codex payload at
// all and every assertion below would be checking an empty list.
import '../src/providers.js'
import {
  reloadModelsOverlay,
  _resetModelsOverlayForTests,
  _resetProviderRegistryCacheForTests,
} from '../src/models.js'
import { buildModelsOverlayReloadCallback } from '../src/server-cli.js'

/**
 * #7722 (MC-0) — the overlay hot-reload ROUTES each provider-tagged roster to
 * the clients on that provider's sessions, instead of broadcasting the Claude
 * roster to everyone tagged `claude-sdk`.
 *
 * Routing is the half that makes this a fix rather than a lateral move, so it
 * gets its own assertions. Clients keep ONE `availableModels` slot, overwritten
 * unconditionally, so an unfiltered fan-out of two rosters is last-write-wins on
 * every connected client: Claude last leaves the codex picker exactly as broken
 * as before, and codex last hides the picker on every Claude session instead.
 * What must therefore be proven is not that two messages were CONSTRUCTED — the
 * sibling suite covers that — but that each one is addressed, and that the
 * predicate says NO to the other provider's clients.
 *
 * The callback is driven from a REAL `reloadModelsOverlay` result over a real
 * temp overlay file. A hand-built result object would leave the whole models.js
 * half of the change unreached, so a mutation there could not be observed here.
 */

let dir
function overlayPath() {
  if (!dir) dir = mkdtempSync(join(tmpdir(), 'overlay-routing-'))
  return join(dir, 'models.json')
}

beforeEach(() => {
  _resetProviderRegistryCacheForTests()
  _resetModelsOverlayForTests()
})
afterEach(() => {
  _resetProviderRegistryCacheForTests()
  _resetModelsOverlayForTests()
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null }
})

/** A fake wsServer that records the (message, filter) pair of every send. */
function fakeWsServer() {
  const sent = []
  return {
    sent,
    broadcastFiltered(message, filter) { sent.push({ message, filter }) },
    // Present so a mutation that swaps broadcastFiltered for the unfiltered
    // broadcast is recorded rather than throwing — the test must fail on a
    // missing FILTER, which is a legible assertion, not on a TypeError.
    broadcast(message) { sent.push({ message, filter: undefined }) },
  }
}

const SESSIONS = {
  's-codex': { provider: 'codex' },
  's-tui': { provider: 'claude-tui' },
  's-sdk': { provider: 'claude-sdk' },
  's-gemini': { provider: 'gemini' },
}
const fakeSessionManager = { getSession: (id) => SESSIONS[id] }
const silentLog = { info() {}, warn() {}, debug() {} }

function routeOverlay(overlay) {
  const path = overlayPath()
  writeFileSync(path, JSON.stringify(overlay))
  const result = reloadModelsOverlay(path)
  assert.equal(result.reloaded, true, 'precondition: the overlay reloaded')
  const wsServer = fakeWsServer()
  buildModelsOverlayReloadCallback({ wsServer, sessionManager: fakeSessionManager, log: silentLog })(result)
  return wsServer.sent
}

/** Which recipients does the payload tagged `provider` accept? */
function recipients(sent, provider) {
  const entry = sent.find((s) => s.message.provider === provider)
  assert.ok(entry, `a ${provider}-tagged message was sent`)
  // RED under: broadcastFiltered(...) -> broadcast(message). The filter is then
  // undefined and every routing assertion below becomes unaskable — which is
  // the point: an unaddressed message is the bug, not a detail.
  assert.equal(typeof entry.filter, 'function', `the ${provider} message is ADDRESSED, not fanned out`)
  return (activeSessionId) => entry.filter({ activeSessionId })
}

describe('#7722 overlay reload routing', () => {
  it('the codex roster goes ONLY to clients whose active session is codex', () => {
    const sent = routeOverlay({
      'codex-route-9': { provider: 'codex', label: 'Codex Route 9' },
      'claude-route-9': { label: 'Claude Route 9' },
    })
    const accepts = recipients(sent, 'codex')

    assert.equal(accepts('s-codex'), true, 'a codex session receives the codex roster')
    // RED under: the non-default branch `provider === message.provider` -> `true`.
    // This is THE assertion that proves the clobber is prevented: without it a
    // Claude session receives the codex roster and hides its own picker.
    assert.equal(accepts('s-tui'), false, 'a claude-tui session must NOT receive the codex roster')
    assert.equal(accepts('s-sdk'), false, 'a claude-sdk session must NOT receive the codex roster')
    assert.equal(accepts('s-gemini'), false, 'a gemini session must NOT receive the codex roster')
    assert.equal(accepts(null), false, 'an unbound client must NOT receive a provider-specific roster')
  })

  it('the default roster reaches every Claude-family session AND unbound clients', () => {
    const sent = routeOverlay({
      'codex-route-9': { provider: 'codex', label: 'Codex Route 9' },
      'claude-route-9': { label: 'Claude Route 9' },
    })
    const accepts = recipients(sent, 'claude-sdk')

    assert.equal(accepts('s-sdk'), true, 'claude-sdk receives the default roster')
    // RED under: the default branch `(p == null || isClaudeProvider(p))` ->
    // `p === 'claude-sdk'`. claude-tui / claude-cli sessions share the default
    // registry, so a literal compare would starve them of overlay updates.
    assert.equal(accepts('s-tui'), true, 'claude-tui shares the default registry, so it receives it too')
    assert.equal(accepts(null), true, 'an unbound host-level client still gets a roster (pre-#7722 behaviour)')
    assert.equal(accepts('s-codex'), false, 'a codex session must NOT receive the Claude roster')
  })

  it('every client matches AT MOST ONE message — the property that removes the race', () => {
    const sent = routeOverlay({
      'codex-route-9': { provider: 'codex', label: 'Codex Route 9' },
      'claude-route-9': { label: 'Claude Route 9' },
    })
    assert.ok(sent.length >= 2, 'precondition: more than one roster was sent')
    for (const activeSessionId of [...Object.keys(SESSIONS), null]) {
      const matched = sent.filter((s) => {
        assert.equal(typeof s.filter, 'function', 'every message is addressed')
        return s.filter({ activeSessionId })
      })
      assert.ok(
        matched.length <= 1,
        `client on ${activeSessionId ?? 'no session'} matched ${matched.length} messages — a second one would overwrite the first`,
      )
    }
  })

  it('a filter is resilient to a client whose session has already been destroyed', () => {
    // getSession returns undefined mid-teardown. The predicate must resolve to
    // "no provider" and fall to the default roster rather than throwing — a
    // throwing filter is isolated by WsBroadcaster, but it would silently drop
    // that client's update.
    const sent = routeOverlay({ 'claude-route-9': { label: 'Claude Route 9' } })
    const accepts = recipients(sent, 'claude-sdk')
    assert.equal(accepts('s-vanished'), true, 'an unknown session id falls back to the default roster')
  })

  it('the reload is logged with the reloaded ids, so a silent watcher is distinguishable', () => {
    // The dogfood step's positive control: absence of this line means the
    // watcher never fired, which otherwise looks identical to a working reload
    // that changed nothing.
    const lines = []
    const path = overlayPath()
    writeFileSync(path, JSON.stringify({ 'claude-route-9': { label: 'Claude Route 9' } }))
    const result = reloadModelsOverlay(path)
    buildModelsOverlayReloadCallback({
      wsServer: fakeWsServer(),
      sessionManager: fakeSessionManager,
      log: { ...silentLog, info: (m) => lines.push(m) },
    })(result)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^Models overlay reloaded: /)
    // The log prints SHORT ids, and the Claude registry's deriveId strips the
    // `claude-` prefix — so the row written as `claude-route-9` is logged as
    // `route-9`. The literal is derived from that rule rather than read back off
    // the result, so this cannot pass by comparing the subject to itself.
    assert.ok(lines[0].includes('route-9'), 'the log names the ids that were loaded')
  })
})
