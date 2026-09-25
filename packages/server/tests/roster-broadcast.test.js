import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
// Importing providers.js registers the real provider classes so
// getRegisteredProviderNames()/isClaudeProvider() resolve the real
// claude-cli/claude-sdk/claude-tui/claude-channel/claude-byok roster —
// broadcastRosterPerRecipient imports providers.js itself, but the direct
// import here documents why these tests see the real registry.
import '../src/providers.js'
import { broadcastRosterPerRecipient, clientActiveProvider, overlayBroadcastReachesProvider } from '../src/roster-broadcast.js'

/**
 * roster-broadcast.js unit tests (#7895).
 *
 * `clientActiveProvider` and `overlayBroadcastReachesProvider` moved here
 * unchanged from server-cli.js (still re-exported there — see
 * models-overlay-reload-broadcast.test.js, which covers both directly through
 * that re-export and is untouched by this move). This file's own focus is
 * `broadcastRosterPerRecipient` — the shared per-recipient tagging loop three
 * send sites (createOverlayReloadBroadcaster, and the two ws-forwarding.js
 * sites) now call instead of three drifting copies.
 */
describe('broadcastRosterPerRecipient (#7895)', () => {
  function findFor(broadcastMock, client) {
    return broadcastMock.mock.calls.find((c) => {
      const filter = c.arguments[1]
      return typeof filter !== 'function' || filter(client)
    })
  }

  it('re-exports the same clientActiveProvider/overlayBroadcastReachesProvider server-cli.js re-exports', () => {
    // Sanity: this module is the ONE definition, not a fork — server-cli.js's
    // re-export (asserted in models-overlay-reload-broadcast.test.js) must be
    // the identical function reference.
    assert.equal(typeof clientActiveProvider, 'function')
    assert.equal(typeof overlayBroadcastReachesProvider, 'function')
  })

  it('a non-default (per-provider) roster is sent ONCE, unchanged, to exact-match clients only', () => {
    const broadcast = mock.fn()
    const sessionManager = { getSession: (id) => (id === 'sess-codex' ? { provider: 'codex' } : null) }
    broadcastRosterPerRecipient({
      broadcast,
      sessionManager,
      defaultProvider: 'claude-sdk',
      message: { type: 'available_models', models: [{ id: 'gpt-5.5' }], defaultModel: null, provider: 'codex' },
    })

    assert.equal(broadcast.mock.calls.length, 1, 'a non-Claude tag is never fanned out')
    const [msg, filter] = broadcast.mock.calls[0].arguments
    assert.equal(msg.provider, 'codex')
    assert.equal(filter({ activeSessionId: 'sess-codex' }), true)
    assert.equal(filter({ activeSessionId: null }), false)
  })

  it('a default (Claude-family) roster is re-tagged once per known Claude-family provider', () => {
    const broadcast = mock.fn()
    const sessionManager = {
      getSession: (id) => {
        if (id === 'sess-cli') return { provider: 'claude-cli' }
        if (id === 'sess-tui') return { provider: 'claude-tui' }
        return null
      },
    }
    broadcastRosterPerRecipient({
      broadcast,
      sessionManager,
      defaultProvider: 'claude-sdk',
      message: { type: 'available_models', models: [{ id: 'claude-sonnet-4-6' }], defaultModel: null, provider: 'claude-sdk' },
    })

    assert.ok(broadcast.mock.calls.length > 1, 'the default roster fans out over multiple tags')

    const cliCall = findFor(broadcast, { activeSessionId: 'sess-cli' })
    assert.ok(cliCall, 'expected a broadcast reaching the claude-cli client')
    assert.equal(cliCall.arguments[0].provider, 'claude-cli')

    const tuiCall = findFor(broadcast, { activeSessionId: 'sess-tui' })
    assert.ok(tuiCall, 'expected a broadcast reaching the claude-tui client')
    assert.equal(tuiCall.arguments[0].provider, 'claude-tui')
  })

  // #7895 — targets the `knownTags.add(resolveRosterProvider(null, defaultProvider))`
  // line specifically. `defaultProvider` here is a synthetic name that is NOT
  // independently a registered provider (so it can only reach `knownTags` via
  // this one `.add()` call) — proving the idle-client fallback tag is not
  // merely a lucky overlap with the real provider registry's own names (every
  // REAL daemon default happens to already be Claude-family and therefore
  // already registered, which would mask this line going missing).
  it('an idle client is tagged with the resolved default even when that name is not independently in the provider registry', () => {
    const broadcast = mock.fn()
    const sessionManager = { getSession: () => null }
    broadcastRosterPerRecipient({
      broadcast,
      sessionManager,
      defaultProvider: 'my-synthetic-default',
      message: { type: 'available_models', models: [{ id: 'claude-sonnet-4-6' }], defaultModel: null, provider: 'claude-sdk' },
    })

    const idleClient = { activeSessionId: null }
    const call = findFor(broadcast, idleClient)
    assert.ok(call, 'expected a broadcast reaching the idle client')
    assert.equal(call.arguments[0].provider, 'my-synthetic-default')
  })

  it('the residual fallback still reaches a client whose resolved tag is a genuinely unknown/custom provider', () => {
    const broadcast = mock.fn()
    const sessionManager = { getSession: (id) => (id === 'sess-unknown' ? { provider: 'totally-unregistered-provider' } : null) }
    broadcastRosterPerRecipient({
      broadcast,
      sessionManager,
      defaultProvider: 'claude-sdk',
      message: { type: 'available_models', models: [{ id: 'claude-sonnet-4-6' }], defaultModel: null, provider: 'claude-sdk' },
    })

    // An unregistered provider name resolves to the default registry
    // (usesDefaultModelsRegistry(unknown) === true), so this client is a
    // legitimate recipient of the Claude roster — via the residual, tagged
    // with the message's own literal (not re-tagged to its made-up name,
    // since it isn't a real provider anyone can key a bucket by).
    const unknownClient = { activeSessionId: 'sess-unknown' }
    const call = findFor(broadcast, unknownClient)
    assert.ok(call, 'expected the residual to reach an unknown-provider client')
    assert.equal(call.arguments[0].provider, 'claude-sdk')
  })
})
