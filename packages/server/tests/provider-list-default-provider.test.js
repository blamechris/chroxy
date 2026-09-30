/**
 * #8151 (C3) — two server-side pieces of the dashboard-default-provider fix:
 *
 *  1. `provider_list` (and, by the same derivation, `auth_bootstrap`) carries
 *     the daemon's OWN resolved default provider (`resolveDaemonDefaultProvider`),
 *     so a client can override its baked-in `DEFAULT_PROVIDER` constant
 *     (claude-tui) with what THIS server actually runs by default — e.g. a
 *     Docker image's `ENV CHROXY_PROVIDER=claude-sdk`.
 *
 *  2. `listProviders()` marks `claude-tui` unavailable (`auth.ready: false`,
 *     with an actionable hint) when node-pty cannot load, so a client greys
 *     it out instead of letting a user pick a provider that will fail the
 *     moment a session is created with it.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { listProviders } from '../src/providers.js'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { resetNodePtyProbeForTest, cachedNodePtyAvailable, probeNodePtyAvailable } from '../src/utils/node-pty-probe.js'
import { DEFAULT_PROVIDER } from '@chroxy/protocol'

describe('listProviders() marks claude-tui unavailable when node-pty cannot load (#8151 C3)', () => {
  it('nodePtyAvailable: false → claude-tui auth.ready is false with an actionable hint', () => {
    const providers = listProviders({ nodePtyAvailable: false })
    const claudeTui = providers.find((p) => p.name === 'claude-tui')
    assert.ok(claudeTui, 'expected claude-tui in the provider list')
    assert.equal(claudeTui.auth.ready, false)
    assert.match(claudeTui.auth.hint, /not supported in this environment/)
    assert.match(claudeTui.auth.hint, /node-pty unavailable/)
    assert.match(claudeTui.auth.hint, /use claude-sdk/)
  })

  it('nodePtyAvailable: true → claude-tui auth is whatever resolveAuth() itself says (unaffected)', () => {
    const withPty = listProviders({ nodePtyAvailable: true })
    const withoutInjection = listProviders({}) // cache is null in this test process → treated as available
    const a = withPty.find((p) => p.name === 'claude-tui').auth
    const b = withoutInjection.find((p) => p.name === 'claude-tui').auth
    assert.deepEqual(a, b, 'an explicit true should match the "no probe yet" default (both = available)')
  })

  it('other providers are never touched by the node-pty override', () => {
    const unavailable = listProviders({ nodePtyAvailable: false })
    const available = listProviders({ nodePtyAvailable: true })
    for (const name of ['claude-sdk', 'claude-cli', 'codex']) {
      const a = unavailable.find((p) => p.name === name)
      const b = available.find((p) => p.name === name)
      assert.ok(a && b, `expected ${name} in both lists`)
      assert.deepEqual(a.auth, b.auth, `${name}'s auth must not change with the claude-tui-only override`)
    }
  })

  it('mutant proof: deleting the name === "claude-tui" guard would also grey out claude-sdk — the guard is provider-specific, not blanket', () => {
    // Not a literal mutant harness (this file has no source copy to mutate) —
    // this assertion IS the thing that goes red if the guard's name check is
    // ever dropped or widened: claude-sdk has no PTY dependency at all, so its
    // `ready` must stay true regardless of nodePtyAvailable.
    const providers = listProviders({ nodePtyAvailable: false })
    const sdk = providers.find((p) => p.name === 'claude-sdk')
    assert.equal(sdk.auth.ready, true)
  })
})

describe('node-pty-probe.js — probe once and cache (#8151 C3)', () => {
  beforeEach(() => {
    resetNodePtyProbeForTest()
  })

  it('cachedNodePtyAvailable() is null before the first probe', () => {
    assert.equal(cachedNodePtyAvailable(), null)
  })

  it('probeNodePtyAvailable() resolves to a boolean and caches it', async () => {
    const result = await probeNodePtyAvailable()
    assert.equal(typeof result, 'boolean')
    assert.equal(cachedNodePtyAvailable(), result)
  })

  it('a second call returns the cached value without re-probing (no throw, same value both times)', async () => {
    const first = await probeNodePtyAvailable()
    const second = await probeNodePtyAvailable()
    assert.equal(first, second)
  })
})

describe('provider_list carries the daemon\'s resolved default provider (#8151 C3)', () => {
  function makeCtx(config) {
    const sent = []
    return {
      ctx: {
        transport: { send: (ws, msg) => sent.push(msg) },
        services: { config },
      },
      sent,
    }
  }

  it('defaultProvider reflects config.provider when set (the Docker image\'s CHROXY_PROVIDER=claude-sdk case)', () => {
    const { ctx, sent } = makeCtx({ provider: 'claude-sdk' })
    settingsHandlers.list_providers({}, {}, {}, ctx)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'provider_list')
    assert.equal(sent[0].defaultProvider, 'claude-sdk')
  })

  it('defaultProvider falls back to the shared DEFAULT_PROVIDER constant when config has no provider set — proves this is a REAL resolution, not a hardcoded echo of one value', () => {
    const { ctx, sent } = makeCtx({})
    settingsHandlers.list_providers({}, {}, {}, ctx)
    assert.equal(sent[0].defaultProvider, DEFAULT_PROVIDER)
  })

  it('a DIFFERENT configured provider (not claude-sdk) round-trips too — not a two-value special case', () => {
    const { ctx, sent } = makeCtx({ provider: 'gemini' })
    settingsHandlers.list_providers({}, {}, {}, ctx)
    assert.equal(sent[0].defaultProvider, 'gemini')
  })
})
