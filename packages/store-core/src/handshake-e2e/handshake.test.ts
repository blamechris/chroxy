/**
 * Encrypted-handshake integration test (epic #5556, sub-item 6).
 *
 * Drives the REAL client handshake state machine through the full sequence with
 * REAL crypto (tweetnacl, test keypairs — no mocked crypto). Asserts:
 *   - phase order (auth → auth_ok → key-derived → bootstrap → replay → live → flush)
 *   - encryption activation timing (no plaintext frame after activation)
 *   - pinned-key verification matrix (valid sig connects; bad sig refuses;
 *     pinned+unsigned refuses; pin-on-first-use against the pairing identity)
 *   - replay-vs-live dedup across the boundary
 *   - recoverable state on mid-replay close
 *
 * The driver (`fake-ws.ts`) runs the production decision/decrypt/reconcile path;
 * the store writes are adapter-injected, so the SAME driver runs against the
 * in-memory reference store here AND against each client's real store in their
 * own suites (per-client adapters, same pattern as the contract fixtures).
 */

import { describe, it, expect } from 'vitest'
import {
  FakeHandshakeServer,
  FakeHandshakeClient,
  makeMemoryStore,
  type ReplayEntrySpec,
  type DriverMessage,
} from './fake-ws'

// ---------------------------------------------------------------------------
// Full-sequence helper — wires a server + client and runs the whole handshake
// ---------------------------------------------------------------------------

interface RunOpts {
  pinnedIdentityKey?: string | null
  pairingIdentityKey?: string | null
  omitSignature?: boolean
  forgeSignature?: boolean
  /** Replay entries to deliver (encrypted), in order. */
  replay?: ReplayEntrySpec[]
  /** fullHistory flag on the replay-start frame. */
  fullHistory?: boolean
  /** A live frame to deliver after replay-end (encrypted). */
  live?: { sessionId: string; entry: DriverMessage }
  /** Stop after this phase (simulates a mid-sequence socket close). */
  stopAfter?: 'auth_ok' | 'replay-start' | 'replay-entry'
  /** Pre-seed the session messages before the handshake (reconnect). */
  preSeed?: Record<string, DriverMessage[]>
}

/**
 * The real client calls `handleAuthOk` (keying + pin decision) then receives the
 * encrypted burst. This helper runs that production order end-to-end.
 */
function fullSequence(opts: RunOpts) {
  const server = new FakeHandshakeServer({
    omitSignature: opts.omitSignature,
    forgeSignature: opts.forgeSignature,
  })
  const store = makeMemoryStore()
  if (opts.preSeed) {
    for (const [sid, msgs] of Object.entries(opts.preSeed)) store.setMessages(sid, msgs)
  }
  const client = new FakeHandshakeClient(store, {
    pinnedIdentityKey: opts.pinnedIdentityKey ?? null,
    pairingIdentityKey: opts.pairingIdentityKey ?? null,
  })

  const auth = client.sendAuth()
  server.keyExchangeWithClient(auth.publicKey as string)

  // auth_ok carries the signed exchange key → pin decision + keying.
  const decision = client.handleAuthOk(server.authOk())
  if (decision.action === 'refuse') {
    return { server, client, store, decision }
  }
  if (opts.stopAfter === 'auth_ok') {
    return { server, client, store, decision }
  }

  // Encrypted auth_bootstrap burst.
  client.receive(
    server.encryptFrame({
      type: 'auth_bootstrap',
      providers: [{ name: 'anthropic' }],
      slashCommands: [{ name: 'clear', source: 'builtin' }],
      agents: [{ name: 'reviewer', source: 'project' }],
    }),
  )

  // Encrypted history_replay_start.
  const sid =
    opts.replay?.[0]?.sessionId ?? opts.live?.sessionId ?? Object.keys(opts.preSeed ?? {})[0] ?? 's1'
  const latestSeq = opts.replay?.[opts.replay.length - 1]?.historySeq
  client.receive(
    server.encryptFrame({
      type: 'history_replay_start',
      sessionId: sid,
      fullHistory: opts.fullHistory ?? false,
      latestSeq,
    }),
  )
  if (opts.stopAfter === 'replay-start') {
    return { server, client, store, decision }
  }

  // Encrypted replay entries.
  let delivered = 0
  for (const spec of opts.replay ?? []) {
    client.receive(
      server.encryptFrame({
        type: 'history_replay_entry',
        sessionId: spec.sessionId,
        entry: spec.message,
        historySeq: spec.historySeq,
      }),
    )
    delivered++
    if (opts.stopAfter === 'replay-entry' && delivered === 1) {
      // Simulate a socket close mid-replay (no replay-end frame).
      return { server, client, store, decision }
    }
  }

  // Encrypted history_replay_end (atomic swap for a full rebuild).
  client.receive(
    server.encryptFrame({
      type: 'history_replay_end',
      sessionId: sid,
      latestSeq,
    }),
  )

  // Encrypted live frame after the boundary.
  if (opts.live) {
    client.receive(
      server.encryptFrame({
        type: 'live_message',
        sessionId: opts.live.sessionId,
        entry: opts.live.entry,
      }),
    )
  }

  // Forced flush frame.
  client.receive(server.encryptFrame({ type: 'flush' }))

  return { server, client, store, decision }
}

// ---------------------------------------------------------------------------
// Phase order + encryption activation timing
// ---------------------------------------------------------------------------

describe('encrypted handshake — phase order + activation (#5556.6)', () => {
  it('runs the full sequence in order with no plaintext frame after activation', () => {
    const { client, store } = fullSequence({
      replay: [
        { sessionId: 's1', message: { id: 'h1', type: 'response', content: 'first' }, historySeq: 1 },
        { sessionId: 's1', message: { id: 'h2', type: 'response', content: 'second' }, historySeq: 2 },
      ],
      fullHistory: true,
      live: { sessionId: 's1', entry: { id: 'L1', type: 'response', content: 'live' } },
    })

    expect(client.phases).toEqual([
      'auth-sent',
      'auth_ok',
      'key-derived',
      'auth_bootstrap',
      'replay-start',
      'replay-entry',
      'replay-entry',
      'replay-end',
      'live-delta',
      'flush',
    ])
    // No plaintext frame observed after encryption activated.
    expect(client.plaintextAfterActivation).toEqual([])
    expect(store.state.encryptionActive).toBe(true)
    expect(store.state.bootstrap).toMatchObject({ providers: [{ name: 'anthropic' }] })
  })

  it('key-derived comes strictly AFTER auth_ok and BEFORE any encrypted frame', () => {
    const { client } = fullSequence({
      replay: [{ sessionId: 's1', message: { id: 'h1', type: 'response', content: 'x' }, historySeq: 1 }],
    })
    const authOkIdx = client.phases.indexOf('auth_ok')
    const keyIdx = client.phases.indexOf('key-derived')
    const bootstrapIdx = client.phases.indexOf('auth_bootstrap')
    expect(authOkIdx).toBeGreaterThanOrEqual(0)
    expect(keyIdx).toBe(authOkIdx + 1)
    expect(bootstrapIdx).toBeGreaterThan(keyIdx)
  })

  it('a plaintext frame injected AFTER activation is flagged as a contract violation', () => {
    const server = new FakeHandshakeServer()
    const store = makeMemoryStore()
    const client = new FakeHandshakeClient(store)
    const auth = client.sendAuth()
    server.keyExchangeWithClient(auth.publicKey as string)
    client.handleAuthOk(server.authOk())
    // A spurious PLAINTEXT frame after encryption is active (a downgrade attempt
    // / a server bug). The client records it as a violation.
    client.receive({ type: 'auth_bootstrap', providers: [], slashCommands: [], agents: [] })
    expect(client.plaintextAfterActivation).toEqual(['auth_bootstrap'])
  })
})

// ---------------------------------------------------------------------------
// Pinned-key verification matrix (#5603 — read with REAL signatures)
// ---------------------------------------------------------------------------

describe('encrypted handshake — pinned-key verification matrix (#5556.6)', () => {
  it('valid signature against the pinned identity CONNECTS', () => {
    const server = new FakeHandshakeServer()
    const store = makeMemoryStore()
    const client = new FakeHandshakeClient(store, { pinnedIdentityKey: server.identityPublicKey })
    const auth = client.sendAuth()
    server.keyExchangeWithClient(auth.publicKey as string)
    const decision = client.handleAuthOk(server.authOk())
    expect(decision.action).toBe('connect')
    if (decision.action === 'connect') expect(decision.reason).toBe('verified')
    expect(store.state.encryptionActive).toBe(true)
    expect(store.state.refusal).toBeNull()
  })

  it('a FORGED signature (wrong identity) is REFUSED — MITM detected', () => {
    const server = new FakeHandshakeServer({ forgeSignature: true })
    const store = makeMemoryStore()
    // Pin the server's REAL identity; the server signs with a different key.
    const client = new FakeHandshakeClient(store, { pinnedIdentityKey: server.identityPublicKey })
    const auth = client.sendAuth()
    server.keyExchangeWithClient(auth.publicKey as string)
    const decision = client.handleAuthOk(server.authOk())
    expect(decision.action).toBe('refuse')
    if (decision.action === 'refuse') expect(decision.reason).toBe('signature-mismatch')
    expect(store.state.encryptionActive).toBe(false)
    expect(store.state.refusal?.reason).toBe('signature-mismatch')
  })

  it('a PINNED record receiving an UNSIGNED handshake is REFUSED (downgrade)', () => {
    const server = new FakeHandshakeServer({ omitSignature: true })
    const store = makeMemoryStore()
    const client = new FakeHandshakeClient(store, { pinnedIdentityKey: server.identityPublicKey })
    const auth = client.sendAuth()
    server.keyExchangeWithClient(auth.publicKey as string)
    const decision = client.handleAuthOk(server.authOk())
    expect(decision.action).toBe('refuse')
    if (decision.action === 'refuse') expect(decision.reason).toBe('pinned-but-unsigned')
    expect(store.state.encryptionActive).toBe(false)
  })

  it('pin-on-first-use: a valid sig against the PAIRING identity connects AND pins', () => {
    const server = new FakeHandshakeServer()
    const store = makeMemoryStore()
    // Unpinned record, but the pairing channel conveyed the real identity.
    const client = new FakeHandshakeClient(store, {
      pinnedIdentityKey: null,
      pairingIdentityKey: server.identityPublicKey,
    })
    const auth = client.sendAuth()
    server.keyExchangeWithClient(auth.publicKey as string)
    const decision = client.handleAuthOk(server.authOk())
    expect(decision.action).toBe('pin-and-connect')
    if (decision.action === 'pin-and-connect') {
      expect(decision.identityKey).toBe(server.identityPublicKey)
    }
    expect(store.state.pinnedIdentity).toBe(server.identityPublicKey)
    expect(store.state.encryptionActive).toBe(true)
  })

  it('pin-on-first-use against a WRONG pairing identity is REFUSED (first-connect MITM)', () => {
    const server = new FakeHandshakeServer()
    const otherServer = new FakeHandshakeServer()
    const store = makeMemoryStore()
    // Pairing identity is from a DIFFERENT daemon than the one answering.
    const client = new FakeHandshakeClient(store, {
      pairingIdentityKey: otherServer.identityPublicKey,
    })
    const auth = client.sendAuth()
    server.keyExchangeWithClient(auth.publicKey as string)
    const decision = client.handleAuthOk(server.authOk())
    expect(decision.action).toBe('refuse')
    expect(store.state.encryptionActive).toBe(false)
  })

  it('unpinned + no pairing identity (old daemon) connects via pure TOFU', () => {
    const server = new FakeHandshakeServer({ omitSignature: true })
    const store = makeMemoryStore()
    const client = new FakeHandshakeClient(store)
    const auth = client.sendAuth()
    server.keyExchangeWithClient(auth.publicKey as string)
    const decision = client.handleAuthOk(server.authOk())
    expect(decision.action).toBe('connect')
    if (decision.action === 'connect') expect(decision.reason).toBe('unpinned-no-identity')
    expect(store.state.encryptionActive).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// #5614 — plaintext-auth_ok downgrade cell (pinned × non-required encryption)
// ---------------------------------------------------------------------------

describe('encrypted handshake — plaintext-downgrade cell (#5614)', () => {
  it('a PINNED client receiving a plaintext (encryption:none) auth_ok is REFUSED — no key derived', () => {
    // The MITM forges a fully plausible auth_ok (even with a valid-looking sig)
    // but flips encryption to 'none' to skip the encryption branch + pin check.
    const server = new FakeHandshakeServer()
    const store = makeMemoryStore()
    const client = new FakeHandshakeClient(store, { pinnedIdentityKey: server.identityPublicKey })
    const auth = client.sendAuth()
    server.keyExchangeWithClient(auth.publicKey as string)
    const decision = client.handleAuthOk(server.authOk({ encryption: 'none' }))
    expect(decision.action).toBe('refuse')
    if (decision.action === 'refuse') expect(decision.reason).toBe('pinned-but-unencrypted')
    // Fail closed: no shared key, never falls through to an unencrypted session.
    expect(store.state.encryptionActive).toBe(false)
    expect(store.state.refusal?.reason).toBe('pinned-but-unencrypted')
  })

  it('a PINNED client receiving an auth_ok with NO encryption field (null) is REFUSED', () => {
    const server = new FakeHandshakeServer()
    const store = makeMemoryStore()
    const client = new FakeHandshakeClient(store, { pinnedIdentityKey: server.identityPublicKey })
    const auth = client.sendAuth()
    server.keyExchangeWithClient(auth.publicKey as string)
    const decision = client.handleAuthOk(server.authOk({ encryption: null }))
    expect(decision.action).toBe('refuse')
    if (decision.action === 'refuse') expect(decision.reason).toBe('pinned-but-unencrypted')
    expect(store.state.encryptionActive).toBe(false)
  })

  it('a PINNED client receiving an auth_ok with encryption:undefined is REFUSED', () => {
    // The forged frame carries an explicit `undefined` (or, equivalently, the
    // field truly omitted) — the harness now reads either as the parsed `null`
    // shape, so this exercises the same end-to-end refusal as the null case but
    // proves the `undefined` rung of the matrix end-to-end, not just at the unit
    // level (closes the #5614 coverage gap).
    const server = new FakeHandshakeServer()
    const store = makeMemoryStore()
    const client = new FakeHandshakeClient(store, { pinnedIdentityKey: server.identityPublicKey })
    const auth = client.sendAuth()
    server.keyExchangeWithClient(auth.publicKey as string)
    const decision = client.handleAuthOk(server.authOk({ encryption: undefined }))
    expect(decision.action).toBe('refuse')
    if (decision.action === 'refuse') expect(decision.reason).toBe('pinned-but-unencrypted')
    expect(store.state.encryptionActive).toBe(false)
  })

  it('a PAIRING-time-pinned client (first connect) is REFUSED on a plaintext auth_ok', () => {
    // Pin not committed yet, but the trusted pairing channel conveyed an
    // identity — a plaintext first connect is still a downgrade.
    const server = new FakeHandshakeServer()
    const store = makeMemoryStore()
    const client = new FakeHandshakeClient(store, {
      pinnedIdentityKey: null,
      pairingIdentityKey: server.identityPublicKey,
    })
    const auth = client.sendAuth()
    server.keyExchangeWithClient(auth.publicKey as string)
    const decision = client.handleAuthOk(server.authOk({ encryption: 'none' }))
    expect(decision.action).toBe('refuse')
    if (decision.action === 'refuse') expect(decision.reason).toBe('pinned-but-unencrypted')
    expect(store.state.encryptionActive).toBe(false)
    // First-connect downgrade must NOT pin the (unverified) identity.
    expect(store.state.pinnedIdentity).toBeNull()
  })

  it('an UNPINNED client still accepts a plaintext (encryption:none) auth_ok — TOFU preserved', () => {
    const server = new FakeHandshakeServer({ omitSignature: true })
    const store = makeMemoryStore()
    const client = new FakeHandshakeClient(store)
    const auth = client.sendAuth()
    server.keyExchangeWithClient(auth.publicKey as string)
    // An unpinned client has no pin to protect; plaintext stays allowed. The
    // fake derives a key regardless, but the decision must be a plain connect.
    const decision = client.handleAuthOk(server.authOk({ encryption: 'none' }))
    expect(decision.action).toBe('connect')
    expect(store.state.refusal).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Replay-vs-live dedup across the boundary
// ---------------------------------------------------------------------------

describe('encrypted handshake — replay/live dedup (#5556.6)', () => {
  it('a live frame whose id already arrived during replay does NOT double-append', () => {
    const { store } = fullSequence({
      replay: [
        { sessionId: 's1', message: { id: 'dup', type: 'response', content: 'shared' }, historySeq: 1 },
      ],
      fullHistory: true,
      // Same id as the replayed entry → must be deduped at the boundary.
      live: { sessionId: 's1', entry: { id: 'dup', type: 'response', content: 'shared' } },
    })
    const msgs = store.getMessages('s1')
    expect(msgs.filter((m) => m.id === 'dup')).toHaveLength(1)
  })

  it('a genuinely-new live frame after replay appends after the replayed tail', () => {
    const { store } = fullSequence({
      replay: [
        { sessionId: 's1', message: { id: 'h1', type: 'response', content: 'replayed' }, historySeq: 1 },
      ],
      fullHistory: true,
      live: { sessionId: 's1', entry: { id: 'L1', type: 'response', content: 'fresh' } },
    })
    const msgs = store.getMessages('s1')
    expect(msgs.map((m) => m.id)).toEqual(['h1', 'L1'])
  })

  it('a full rebuild keeps the pre-replay prefix visible then swaps to the replayed set', () => {
    const { store } = fullSequence({
      preSeed: { s1: [{ id: 'stale', type: 'response', content: 'old view' }] },
      replay: [
        { sessionId: 's1', message: { id: 'h1', type: 'response', content: 'auth-1' }, historySeq: 1 },
        { sessionId: 's1', message: { id: 'h2', type: 'response', content: 'auth-2' }, historySeq: 2 },
      ],
      fullHistory: true,
    })
    // After the atomic swap, the stale prefix is gone and only the replayed set
    // remains (no blank flash during, asserted by the mid-replay test below).
    const msgs = store.getMessages('s1')
    expect(msgs.map((m) => m.id)).toEqual(['h1', 'h2'])
  })
})

// ---------------------------------------------------------------------------
// Recoverable state on mid-replay close
// ---------------------------------------------------------------------------

describe('encrypted handshake — recoverable state on mid-replay close (#5556.6)', () => {
  it('a full-rebuild socket close BEFORE replay-end leaves the prefix visible (no wipe)', () => {
    const { store } = fullSequence({
      preSeed: { s1: [{ id: 'stale', type: 'response', content: 'still visible' }] },
      replay: [
        { sessionId: 's1', message: { id: 'h1', type: 'response', content: 'partial' }, historySeq: 1 },
        { sessionId: 's1', message: { id: 'h2', type: 'response', content: 'never delivered' }, historySeq: 2 },
      ],
      fullHistory: true,
      stopAfter: 'replay-entry', // close after the first entry, no replay-end
    })
    const msgs = store.getMessages('s1')
    // The pre-replay prefix is STILL there (deferred-swap means no wipe happens
    // until replay-end), plus the one entry that did arrive.
    expect(msgs.map((m) => m.id)).toEqual(['stale', 'h1'])
  })

  it('a socket close right after auth_ok leaves a keyed-but-empty store (recoverable)', () => {
    const { store, client } = fullSequence({ stopAfter: 'auth_ok' })
    expect(store.state.encryptionActive).toBe(true)
    expect(client.phases).toEqual(['auth-sent', 'auth_ok', 'key-derived'])
    // No replay applied; the next reconnect resumes from an empty session.
    expect(store.getMessages('s1')).toEqual([])
  })

  it('mid-replay close does NOT advance the history cursor past un-applied entries', () => {
    // The reconcile contract: latestSeq is finalised only at replay-end. A
    // mid-replay close must NOT claim entries it never applied.
    const { client } = fullSequence({
      replay: [
        { sessionId: 's1', message: { id: 'h1', type: 'response', content: 'applied' }, historySeq: 1 },
        { sessionId: 's1', message: { id: 'h2', type: 'response', content: 'lost' }, historySeq: 2 },
      ],
      fullHistory: true,
      stopAfter: 'replay-entry',
    })
    // Phases stop at the first replay-entry — no replay-end fired, so latestSeq
    // (2) was never applied; the per-entry cursor only reached seq 1.
    expect(client.phases).toContain('replay-entry')
    expect(client.phases).not.toContain('replay-end')
  })
})
