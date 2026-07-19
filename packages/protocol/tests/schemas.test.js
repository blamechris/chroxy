import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('@chroxy/protocol schemas', () => {
  it('exports ClientMessageSchema from schemas entry point', async () => {
    const { ClientMessageSchema } = await import('../src/schemas/index.ts')
    assert.ok(ClientMessageSchema, 'ClientMessageSchema should be exported')

    // Validate a known message type
    const result = ClientMessageSchema.safeParse({ type: 'interrupt' })
    assert.ok(result.success, 'Should validate interrupt message')
  })

  it('exports ClientMessageSchema from main entry point', async () => {
    const { ClientMessageSchema } = await import('../src/index.ts')
    assert.ok(ClientMessageSchema, 'ClientMessageSchema should be re-exported from main')
  })

  it('validates input message with attachments', async () => {
    const { InputSchema } = await import('../src/schemas/client.ts')
    const result = InputSchema.safeParse({
      type: 'input',
      data: 'hello',
      attachments: [{ type: 'image', mediaType: 'image/png', data: 'base64data', name: 'screenshot.png' }],
    })
    assert.ok(result.success, 'Should validate input with image attachment')
  })

  it('rejects input with data exceeding max length', async () => {
    const { InputSchema } = await import('../src/schemas/client.ts')
    const result = InputSchema.safeParse({
      type: 'input',
      data: 'x'.repeat(100_001),
    })
    assert.ok(!result.success, 'Should reject data over 100k chars')
  })

  // Swarm-audit (W2): bound the client auth collections so an adversarial auth
  // can't DoS the server (capabilities is `new Set()`-iterated server-side).
  it('degrades an oversized / over-long capabilities array to [] (no DoS, no reject)', async () => {
    const { AuthSchema } = await import('../src/schemas/client.ts')
    const big = AuthSchema.safeParse({ type: 'auth', token: 't', capabilities: Array(5000).fill('x') })
    assert.ok(big.success, 'oversized capabilities must not reject the auth')
    assert.deepEqual(big.data.capabilities, [], 'oversized array degrades to [] via .catch')
    const longStr = AuthSchema.safeParse({ type: 'auth', token: 't', capabilities: ['x'.repeat(5000)] })
    assert.deepEqual(longStr.data.capabilities, [], 'over-long capability string degrades to []')
    const ok = AuthSchema.safeParse({ type: 'auth', token: 't', capabilities: ['voice', 'terminal'] })
    assert.deepEqual(ok.data.capabilities, ['voice', 'terminal'], 'a normal small list passes through')
  })

  it('rejects an oversized historyCursors map (>256) and an invalid cursor value (#5555.3)', async () => {
    const { AuthSchema } = await import('../src/schemas/client.ts')
    // Unlike capabilities (graceful .catch([])), historyCursors has NO .catch:
    // its established contract is to REJECT malformed input (#5555.3), and the
    // size cap rejects an abusive map rather than silently degrading it.
    const huge = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`s${i}`, i]))
    assert.equal(AuthSchema.safeParse({ type: 'auth', token: 't', historyCursors: huge }).success, false,
      'an oversized cursor map (>256) rejects the auth')
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 'x']) {
      assert.equal(AuthSchema.safeParse({ type: 'auth', token: 't', historyCursors: { s1: bad } }).success, false,
        `an invalid cursor value (${String(bad)}) rejects the auth (#5555.3 preserved)`)
    }
    const ok = AuthSchema.safeParse({ type: 'auth', token: 't', historyCursors: { s1: 5, s2: 10 } })
    assert.deepEqual(ok.data.historyCursors, { s1: 5, s2: 10 }, 'a normal small cursor map passes through')
  })

  // Pin the exact cap boundaries (review #6436) — these lines regress if someone
  // tweaks the cap without updating the test.
  it('bounds are exact: at-cap pass; capabilities coerce, historyCursors reject one-over', async () => {
    const { AuthSchema } = await import('../src/schemas/client.ts')
    const parse = (extra) => AuthSchema.safeParse({ type: 'auth', token: 't', ...extra }).data
    assert.equal(parse({ capabilities: Array(64).fill('c') }).capabilities.length, 64, '64 capabilities pass')
    assert.deepEqual(parse({ capabilities: Array(65).fill('c') }).capabilities, [], '65 coerce to []')
    assert.equal(parse({ capabilities: ['x'.repeat(256)] }).capabilities.length, 1, '256-char capability passes')
    assert.deepEqual(parse({ capabilities: ['x'.repeat(257)] }).capabilities, [], '257-char capability coerces to []')
    const mk = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, i]))
    // capabilities coerces (graceful .catch); historyCursors rejects (strict) — different by design.
    assert.equal(AuthSchema.safeParse({ type: 'auth', token: 't', historyCursors: mk(256) }).success, true, '256 cursors pass')
    assert.equal(AuthSchema.safeParse({ type: 'auth', token: 't', historyCursors: mk(257) }).success, false, '257 cursors reject')
  })

  // #5270 (Control Room Phase 2a): cancel_activity client→server message.
  it('validates cancel_activity with an activityId (sessionId optional)', async () => {
    const { CancelActivitySchema } = await import('../src/schemas/client.ts')
    const minimal = CancelActivitySchema.safeParse({ type: 'cancel_activity', activityId: 'tu-1' })
    assert.ok(minimal.success, 'Should validate with just activityId')
    const withSession = CancelActivitySchema.safeParse({ type: 'cancel_activity', activityId: 'tu-1', sessionId: 'sess-1' })
    assert.ok(withSession.success, 'Should validate with sessionId too')
  })

  it('rejects cancel_activity missing or with an empty activityId', async () => {
    const { CancelActivitySchema } = await import('../src/schemas/client.ts')
    assert.ok(!CancelActivitySchema.safeParse({ type: 'cancel_activity' }).success, 'missing activityId rejected')
    assert.ok(!CancelActivitySchema.safeParse({ type: 'cancel_activity', activityId: '' }).success, 'empty activityId rejected')
    assert.ok(!CancelActivitySchema.safeParse({ type: 'cancel_activity', activityId: 'x'.repeat(513) }).success, 'over-long activityId rejected')
    assert.ok(!CancelActivitySchema.safeParse({ type: 'cancel_activity', activityId: 'tu-1', sessionId: 'x'.repeat(257) }).success, 'over-long sessionId rejected')
  })

  it('resolves cancel_activity through the ClientMessageSchema union by discriminator', async () => {
    const { ClientMessageSchema } = await import('../src/schemas/client.ts')
    const result = ClientMessageSchema.safeParse({ type: 'cancel_activity', activityId: 'tu-1' })
    assert.ok(result.success, 'union should route cancel_activity to CancelActivitySchema')
    // The discriminated union must NOT collapse it to a different member.
    assert.equal(result.data.type, 'cancel_activity')
  })

  // #5943 (epic #5935): cancel_queued client→server message.
  it('validates cancel_queued with a clientMessageId (sessionId optional)', async () => {
    const { CancelQueuedSchema } = await import('../src/schemas/client.ts')
    const minimal = CancelQueuedSchema.safeParse({ type: 'cancel_queued', clientMessageId: 'uin-2' })
    assert.ok(minimal.success, 'Should validate with just clientMessageId')
    const withSession = CancelQueuedSchema.safeParse({ type: 'cancel_queued', clientMessageId: 'uin-2', sessionId: 'sess-1' })
    assert.ok(withSession.success, 'Should validate with sessionId too')
  })

  it('rejects cancel_queued missing or with an empty/over-long clientMessageId', async () => {
    const { CancelQueuedSchema } = await import('../src/schemas/client.ts')
    assert.ok(!CancelQueuedSchema.safeParse({ type: 'cancel_queued' }).success, 'missing clientMessageId rejected')
    assert.ok(!CancelQueuedSchema.safeParse({ type: 'cancel_queued', clientMessageId: '' }).success, 'empty clientMessageId rejected')
    assert.ok(!CancelQueuedSchema.safeParse({ type: 'cancel_queued', clientMessageId: 'x'.repeat(129) }).success, 'over-long clientMessageId rejected')
  })

  it('resolves cancel_queued through the ClientMessageSchema union by discriminator', async () => {
    const { ClientMessageSchema } = await import('../src/schemas/client.ts')
    const result = ClientMessageSchema.safeParse({ type: 'cancel_queued', clientMessageId: 'uin-2' })
    assert.ok(result.success, 'union should route cancel_queued to CancelQueuedSchema')
    assert.equal(result.data.type, 'cancel_queued')
  })

  // #5943: message_dequeued gains the 'cancelled' reason alongside flush/interrupted.
  it('validates message_dequeued reason enum incl. cancelled (#5943)', async () => {
    const { ServerMessageDequeuedSchema } = await import('../src/schemas/server.ts')
    for (const reason of ['flush', 'interrupted', 'cancelled']) {
      const r = ServerMessageDequeuedSchema.safeParse({ type: 'message_dequeued', sessionId: 's1', queueLength: 0, reason })
      assert.ok(r.success, `reason '${reason}' should validate`)
    }
    const bad = ServerMessageDequeuedSchema.safeParse({ type: 'message_dequeued', sessionId: 's1', queueLength: 0, reason: 'bogus' })
    assert.ok(!bad.success, 'unknown reason rejected')
  })

  it('validates server auth_ok message', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'client-1',
      serverMode: 'cli',
      serverVersion: '0.5.0',
      latestVersion: null,
      serverCommit: 'abc123',
      cwd: '/home/user',
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
    })
    assert.ok(result.success, 'Should validate auth_ok message')
  })

  // #3760/#3765: resultTimeoutMs is the server's effective inactivity timeout,
  // surfaced so clients can render the ActivityIndicator warning at the right
  // moment. Optional for back-compat with servers from before #3763.
  it('validates auth_ok with resultTimeoutMs (#3760)', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.7.18',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
      resultTimeoutMs: 20 * 60 * 1000,
    })
    assert.ok(result.success, 'Should validate auth_ok with resultTimeoutMs')
    assert.equal(result.data.resultTimeoutMs, 1_200_000)
  })

  it('accepts auth_ok without resultTimeoutMs (older servers)', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.7.16',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
    })
    assert.ok(result.success, 'Should accept auth_ok without resultTimeoutMs')
    assert.equal(result.data.resultTimeoutMs, undefined)
  })

  it('rejects auth_ok with invalid resultTimeoutMs (non-positive, non-integer, non-finite, or non-number)', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    for (const bad of [0, -1, 1.5, Infinity, NaN, '20']) {
      const result = ServerAuthOkSchema.safeParse({
        type: 'auth_ok',
        clientId: 'c',
        serverMode: 'cli',
        serverVersion: '0.7.18',
        latestVersion: null,
        serverCommit: 'abc',
        cwd: null,
        connectedClients: [],
        encryption: 'disabled',
        protocolVersion: 1,
        minProtocolVersion: 1,
        maxProtocolVersion: 1,
        resultTimeoutMs: bad,
      })
      assert.ok(!result.success, `Should reject bad resultTimeoutMs: ${String(bad)}`)
    }
  })

  // #3768: 24h ceiling — guards against env-var typos (e.g.
  // `CHROXY_RESULT_TIMEOUT_MS=999999999999999`) pushing a value onto
  // the wire that passes integer/positive/finite but overflows the
  // client's `Date.now() + ms` math.
  it('rejects auth_ok with resultTimeoutMs above 24h ceiling (#3768)', async () => {
    const { ServerAuthOkSchema, MAX_SANE_DURATION_MS: MAX } = await import('../src/schemas/server.ts')
    const base = {
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.7.18',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
    }
    assert.ok(ServerAuthOkSchema.safeParse({ ...base, resultTimeoutMs: MAX }).success, 'exactly 24h should pass')
    assert.ok(!ServerAuthOkSchema.safeParse({ ...base, resultTimeoutMs: MAX + 1 }).success, '24h + 1ms should reject')
    assert.ok(!ServerAuthOkSchema.safeParse({ ...base, resultTimeoutMs: 999_999_999_999_999 }).success, 'env-typo huge value should reject')
  })

  // #3905: hardTimeoutMs broadcast on auth_ok so clients can render
  // the check-in chip's "kill in Xh" countdown against the real
  // configured value instead of assuming the 2h default.
  it('validates auth_ok with hardTimeoutMs (#3905)', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.8.0',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
      resultTimeoutMs: 30 * 60 * 1000,
      hardTimeoutMs: 2 * 60 * 60 * 1000,
    })
    assert.ok(result.success, 'Should validate auth_ok with hardTimeoutMs')
    assert.equal(result.data.hardTimeoutMs, 7_200_000)
  })

  it('accepts auth_ok without hardTimeoutMs (older servers, pre-#3905)', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.7.18',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
      resultTimeoutMs: 30 * 60 * 1000,
    })
    assert.ok(result.success, 'Should accept auth_ok without hardTimeoutMs')
    assert.equal(result.data.hardTimeoutMs, undefined)
  })

  it('rejects auth_ok with invalid hardTimeoutMs (#3905)', async () => {
    const { ServerAuthOkSchema, MAX_SANE_DURATION_MS: MAX } = await import('../src/schemas/server.ts')
    const base = {
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.8.0',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
    }
    for (const bad of [0, -1, 1.5, Infinity, NaN, '120', MAX + 1]) {
      const result = ServerAuthOkSchema.safeParse({ ...base, hardTimeoutMs: bad })
      assert.ok(!result.success, `Should reject bad hardTimeoutMs: ${String(bad)}`)
    }
    assert.ok(ServerAuthOkSchema.safeParse({ ...base, hardTimeoutMs: MAX }).success, 'exactly 24h should pass')
  })

  // #4477: streamStallTimeoutMs is the server's stream-stall recovery window,
  // surfaced so the dashboard chip (#4476) can render copy with the real
  // configured value instead of hardcoding the 5-min default. Unlike
  // result/hardTimeoutMs, 0 is a meaningful value here — it means the
  // operator explicitly disabled stream-stall recovery, so the schema must
  // accept nonnegative ints (not just positive).
  it('validates auth_ok with streamStallTimeoutMs (#4477)', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.9.13',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
      streamStallTimeoutMs: 5 * 60 * 1000,
    })
    assert.ok(result.success, 'Should validate auth_ok with streamStallTimeoutMs')
    assert.equal(result.data.streamStallTimeoutMs, 300_000)
  })

  it('accepts auth_ok with streamStallTimeoutMs=0 (explicitly disabled)', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.9.13',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
      streamStallTimeoutMs: 0,
    })
    assert.ok(result.success, 'Should accept 0 as the "disabled" sentinel — base-session armResultTimeout skips the stall timer when _streamStallTimeoutMs === 0')
    assert.equal(result.data.streamStallTimeoutMs, 0)
  })

  it('accepts auth_ok without streamStallTimeoutMs (older servers, pre-#4477)', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.9.12',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
    })
    assert.ok(result.success, 'Should accept auth_ok without streamStallTimeoutMs')
    assert.equal(result.data.streamStallTimeoutMs, undefined)
  })

  // #4560 — `notificationPrefs` capability surfaced in auth_ok so dashboard /
  // mobile can gate the Notifications settings section on the server having a
  // `notification_prefs_get` handler (added in #4541). Older servers omit the
  // flag and clients fall through to the "not supported" branch.
  it('accepts auth_ok with notificationPrefs capability (#4560)', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.9.13',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
      capabilities: {
        skillTrustAccept: true,
        skillTrustGrant: true,
        notificationPrefs: true,
      },
    })
    assert.ok(result.success, 'Should validate auth_ok with notificationPrefs capability')
    assert.equal(result.data.capabilities.notificationPrefs, true)
  })

  it('accepts auth_ok without notificationPrefs capability (older servers, pre-#4541)', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.9.0',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
      capabilities: { skillTrustAccept: true },
    })
    assert.ok(result.success, 'Should accept auth_ok without notificationPrefs capability')
    assert.equal(result.data.capabilities.notificationPrefs, undefined)
  })

  it('rejects auth_ok with invalid streamStallTimeoutMs (#4477)', async () => {
    const { ServerAuthOkSchema, MAX_SANE_DURATION_MS: MAX } = await import('../src/schemas/server.ts')
    const base = {
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.9.13',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
    }
    for (const bad of [-1, 1.5, Infinity, NaN, '300000', MAX + 1]) {
      const result = ServerAuthOkSchema.safeParse({ ...base, streamStallTimeoutMs: bad })
      assert.ok(!result.success, `Should reject bad streamStallTimeoutMs: ${String(bad)}`)
    }
    assert.ok(ServerAuthOkSchema.safeParse({ ...base, streamStallTimeoutMs: MAX }).success, 'exactly 24h should pass')
  })

  // #3768: same ceiling applied to other ms-typed fields.
  it('rejects permission_request with remainingMs above 24h ceiling (#3768)', async () => {
    const { ServerPermissionRequestSchema, MAX_SANE_DURATION_MS: MAX } = await import('../src/schemas/server.ts')
    const base = { type: 'permission_request', requestId: 'r', tool: 't', input: {} }
    assert.ok(ServerPermissionRequestSchema.safeParse({ ...base, remainingMs: MAX }).success, 'exactly 24h should pass')
    assert.ok(ServerPermissionRequestSchema.safeParse({ ...base, remainingMs: 0 }).success, '0 should pass (request just expired)')
    assert.ok(!ServerPermissionRequestSchema.safeParse({ ...base, remainingMs: MAX + 1 }).success, '24h + 1ms should reject')
    assert.ok(!ServerPermissionRequestSchema.safeParse({ ...base, remainingMs: -1 }).success, 'negative should reject')
    assert.ok(!ServerPermissionRequestSchema.safeParse({ ...base, remainingMs: Infinity }).success, 'Infinity should reject')
    // #3785: ms duration must be a whole number — guards against accidental
    // fractional values from a future emitter (e.g. `Date.now() / 2`).
    assert.ok(!ServerPermissionRequestSchema.safeParse({ ...base, remainingMs: 100.5 }).success, 'fractional ms should reject')
  })

  it('rejects server_shutdown with restartEtaMs above 24h ceiling (#3768)', async () => {
    const { ServerShutdownSchema, MAX_SANE_DURATION_MS: MAX } = await import('../src/schemas/server.ts')
    const base = { type: 'server_shutdown', reason: 'restart' }
    assert.ok(ServerShutdownSchema.safeParse({ ...base, restartEtaMs: MAX }).success, 'exactly 24h should pass')
    assert.ok(ServerShutdownSchema.safeParse({ ...base, restartEtaMs: 0 }).success, '0 should pass (not coming back)')
    assert.ok(!ServerShutdownSchema.safeParse({ ...base, restartEtaMs: MAX + 1 }).success, '24h + 1ms should reject')
    assert.ok(!ServerShutdownSchema.safeParse({ ...base, restartEtaMs: -1 }).success, 'negative should reject')
    assert.ok(!ServerShutdownSchema.safeParse({ ...base, restartEtaMs: Infinity }).success, 'Infinity should reject')
    // #3785: ms duration must be a whole number.
    assert.ok(!ServerShutdownSchema.safeParse({ ...base, restartEtaMs: 100.5 }).success, 'fractional ms should reject')
  })

  // Wire-contract alignment surfaced by #3768 review:
  // server emits permission_request with sessionId, and server_shutdown
  // with reason='crash'. Schema must accept both.
  it('accepts permission_request with sessionId (#3773)', async () => {
    const { ServerPermissionRequestSchema } = await import('../src/schemas/server.ts')
    const result = ServerPermissionRequestSchema.safeParse({
      type: 'permission_request',
      requestId: 'r',
      tool: 't',
      input: {},
      sessionId: 'sess-abc',
    })
    assert.ok(result.success, 'Should accept permission_request with sessionId')
    assert.equal(result.data.sessionId, 'sess-abc')
  })

  it('accepts server_shutdown with reason=crash (#3773)', async () => {
    const { ServerShutdownSchema } = await import('../src/schemas/server.ts')
    const result = ServerShutdownSchema.safeParse({
      type: 'server_shutdown',
      reason: 'crash',
      restartEtaMs: 0,
    })
    assert.ok(result.success, 'Should accept reason=crash (emitted on uncaughtException)')
  })

  // #4756 — `session_stopped` is the user-initiated Stop confirmation
  // broadcast. Both the multi-session shape (sessionId + numeric code) and
  // the legacy-cli shape (no sessionId) must parse. Future provider
  // adoption (per the issue's #4 follow-up) may also omit `code` when the
  // provider doesn't have a child-process exit status to report.
  it('validates session_stopped with multi-session shape (#4756)', async () => {
    const { ServerSessionStoppedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSessionStoppedSchema.safeParse({
      type: 'session_stopped',
      sessionId: 'sess-abc',
      code: 0,
    })
    assert.ok(result.success, 'Should accept session_stopped with sessionId + code')
    assert.equal(result.data.sessionId, 'sess-abc')
    assert.equal(result.data.code, 0)
  })

  it('accepts session_stopped without sessionId (legacy-cli path)', async () => {
    const { ServerSessionStoppedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSessionStoppedSchema.safeParse({
      type: 'session_stopped',
      code: 143,
    })
    assert.ok(result.success, 'legacy-cli session_stopped omits sessionId')
    assert.equal(result.data.code, 143)
  })

  it('accepts session_stopped without code (future provider parity)', async () => {
    const { ServerSessionStoppedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSessionStoppedSchema.safeParse({
      type: 'session_stopped',
      sessionId: 'sess-abc',
    })
    assert.ok(result.success, 'code is optional for providers without an exit status')
  })

  it('rejects session_stopped with non-numeric code', async () => {
    const { ServerSessionStoppedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSessionStoppedSchema.safeParse({
      type: 'session_stopped',
      sessionId: 'sess-abc',
      code: 'not-a-number',
    })
    assert.equal(result.success, false, 'code must be a number when present')
  })

  // Distinct from the non-numeric case above: this asserts the `.int()`
  // constraint specifically. A float (1.5) is a number but not an integer,
  // so it should fail the integer-only schema and the normalizer's
  // `Number.isInteger` guard.
  it('rejects session_stopped with non-integer code (float)', async () => {
    const { ServerSessionStoppedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSessionStoppedSchema.safeParse({
      type: 'session_stopped',
      sessionId: 'sess-abc',
      code: 1.5,
    })
    assert.equal(result.success, false, 'code must be an integer when present (z.number().int())')
  })

  it('validates encrypted envelope', async () => {
    const { EncryptedEnvelopeSchema } = await import('../src/schemas/client.ts')
    const result = EncryptedEnvelopeSchema.safeParse({
      type: 'encrypted',
      d: 'ciphertext',
      n: 0,
    })
    assert.ok(result.success, 'Should validate encrypted envelope')
  })

  it('rejects encrypted envelope with negative nonce', async () => {
    const { EncryptedEnvelopeSchema } = await import('../src/schemas/client.ts')
    const result = EncryptedEnvelopeSchema.safeParse({
      type: 'encrypted',
      d: 'ciphertext',
      n: -1,
    })
    assert.ok(!result.success, 'Should reject negative nonce')
  })

  it('exports inferred TypeScript types', async () => {
    // Just verify the types are exported (they're used at compile time)
    const mod = await import('../src/schemas/client.ts')
    assert.ok('AuthSchema' in mod, 'Should export AuthSchema')
    assert.ok('ClientMessageSchema' in mod, 'Should export ClientMessageSchema')
    assert.ok('EncryptedEnvelopeSchema' in mod, 'Should export EncryptedEnvelopeSchema')
  })

  it('validates create_session with sandbox option', async () => {
    const { CreateSessionSchema } = await import('../src/schemas/client.ts')
    const result = CreateSessionSchema.safeParse({
      type: 'create_session',
      name: 'Test Session',
      cwd: '/tmp',
      sandbox: {
        network: { allowedDomains: ['example.com'] },
        filesystem: { allowedPaths: ['/tmp'], deniedPaths: ['/etc'] },
        bash: { allowedCommands: ['ls', 'cat'] },
        autoAllowBashIfSandboxed: true,
      },
    })
    assert.ok(result.success, 'Should validate create_session with sandbox')
    assert.deepEqual(result.data.sandbox, {
      network: { allowedDomains: ['example.com'] },
      filesystem: { allowedPaths: ['/tmp'], deniedPaths: ['/etc'] },
      bash: { allowedCommands: ['ls', 'cat'] },
      autoAllowBashIfSandboxed: true,
    })
  })

  it('validates create_session without sandbox option', async () => {
    const { CreateSessionSchema } = await import('../src/schemas/client.ts')
    const result = CreateSessionSchema.safeParse({
      type: 'create_session',
      name: 'Test Session',
    })
    assert.ok(result.success, 'Should validate create_session without sandbox')
    assert.equal(result.data.sandbox, undefined)
  })

  it('validates mailbox_status_request and its snapshot reply', async () => {
    const { MailboxStatusRequestSchema } = await import('../src/schemas/client.ts')
    const { ServerMailboxStatusSnapshotSchema } = await import('../src/schemas/server.ts')

    assert.ok(MailboxStatusRequestSchema.safeParse({ type: 'mailbox_status_request' }).success)
    assert.ok(MailboxStatusRequestSchema.safeParse({ type: 'mailbox_status_request', requestId: 'r1' }).success)

    const snap = ServerMailboxStatusSnapshotSchema.safeParse({
      type: 'mailbox_status_snapshot',
      requestId: null,
      generatedAt: '2026-06-16T07:00:00.000Z',
      registrations: [
        { agentCommId: 'coder', sessionId: 'sid-1', sessionName: 'Coder', isBusy: false, isTui: true },
      ],
      recentEvents: [
        { at: 1718521200000, to: 'coder', from: 'alice', unreadCount: 3, outcome: 'injected' },
        { at: 1718521100000, to: 'coder', from: 'unknown', unreadCount: null, outcome: 'busy' },
      ],
    })
    assert.ok(snap.success, 'full mailbox snapshot must validate')
    assert.equal(snap.data.registrations[0].agentCommId, 'coder')
    assert.equal(snap.data.recentEvents[1].unreadCount, null)

    // Empty arrays are the valid "no registrations / no traffic" state.
    assert.ok(
      ServerMailboxStatusSnapshotSchema.safeParse({
        type: 'mailbox_status_snapshot',
        generatedAt: '2026-06-16T07:00:00.000Z',
        registrations: [],
        recentEvents: [],
      }).success,
    )

    // An unknown outcome is rejected (the enum is the source of truth).
    assert.ok(
      !ServerMailboxStatusSnapshotSchema.safeParse({
        type: 'mailbox_status_snapshot',
        generatedAt: '2026-06-16T07:00:00.000Z',
        registrations: [],
        recentEvents: [{ at: 1, to: 'x', from: 'y', unreadCount: 0, outcome: 'bogus' }],
      }).success,
    )
  })

  it('validates create_session with an agentCommId (mailbox identity)', async () => {
    const { CreateSessionSchema } = await import('../src/schemas/client.ts')
    const ok = CreateSessionSchema.safeParse({
      type: 'create_session',
      name: 'Coder',
      agentCommId: 'coder',
    })
    assert.ok(ok.success, 'Should validate create_session with agentCommId')
    assert.equal(ok.data.agentCommId, 'coder')

    // Optional — omitted is valid and parses to undefined.
    const omitted = CreateSessionSchema.safeParse({ type: 'create_session', name: 'X' })
    assert.ok(omitted.success)
    assert.equal(omitted.data.agentCommId, undefined)

    // Bounded at 200 chars (matches the server-side id contract).
    const tooLong = CreateSessionSchema.safeParse({
      type: 'create_session',
      agentCommId: 'a'.repeat(201),
    })
    assert.ok(!tooLong.success, 'agentCommId over 200 chars must be rejected')
  })

  it('discriminatedUnion covers all expected message types', async () => {
    const { ClientMessageSchema } = await import('../src/schemas/client.ts')

    const expectedTypes = [
      'input', 'interrupt', 'set_model', 'set_permission_mode',
      'permission_response', 'list_sessions', 'switch_session', 'create_session',
      'destroy_session', 'rename_session', 'register_push_token',
      'user_question_response', 'list_directory', 'browse_files', 'read_file',
      'write_file', 'list_files', 'list_slash_commands', 'list_agents',
      'request_full_history', 'request_session_context',
      'get_diff', 'git_status', 'git_branches', 'git_stage', 'git_unstage', 'git_commit',
      'resume_budget', 'list_checkpoints', 'restore_checkpoint', 'create_checkpoint',
      'delete_checkpoint', 'close_dev_preview',
      'launch_web_task', 'list_web_tasks', 'teleport_web_task',
      'list_conversations', 'resume_conversation', 'search_conversations',
      'request_conversation_transcript',
      'request_cost_summary', 'subscribe_sessions', 'unsubscribe_sessions',
      'client_visible',
      'list_providers', 'list_repos', 'add_repo', 'remove_repo',
      'query_permission_audit',
    ]

    for (const type of expectedTypes) {
      const result = ClientMessageSchema.safeParse({ type })
      // Some types need required fields — just verify the type is recognized
      // (safeParse may fail on missing fields but the discriminator should match)
      if (!result.success) {
        const errors = result.error.issues || result.error.errors || []
        const hasTypeError = errors.some(e =>
          e.path?.includes('type') || e.message?.includes('type')
        )
        assert.ok(!hasTypeError,
          `Type '${type}' should be recognized by ClientMessageSchema discriminator`)
      }
    }
  })

  // #6874 review (Copilot): the transcript request must fail fast at the protocol
  // layer for a malformed conversationId, matching the server's CONVERSATION_ID_RE
  // gate exactly (no stricter, no looser) so a valid server id is never rejected.
  it('RequestConversationTranscriptSchema requires a UUID conversationId', async () => {
    const { RequestConversationTranscriptSchema } = await import('../src/schemas/client.ts')

    const base = { type: 'request_conversation_transcript' }

    // Rejected at the schema level: empty, whitespace, and non-UUID shapes.
    for (const bad of ['', '   ', 'not-a-uuid', '../../etc/passwd', '12345', '00000000-0000-0000-0000-00000000000']) {
      const r = RequestConversationTranscriptSchema.safeParse({ ...base, conversationId: bad })
      assert.equal(r.success, false, `conversationId '${bad}' must be rejected`)
    }

    // Accepted: canonical hex-group UUIDs, including the permissive server-style
    // ids that z.string().uuid() (RFC version nibble) would wrongly reject.
    for (const good of [
      '550e8400-e29b-41d4-a716-446655440000',
      '00000000-0000-0000-0000-0000000c0ffe',
      '11111111-2222-3333-4444-555555555555',
    ]) {
      const r = RequestConversationTranscriptSchema.safeParse({ ...base, conversationId: good })
      assert.equal(r.success, true, `conversationId '${good}' must be accepted`)
    }

    // The optional cwd hint still round-trips.
    const withCwd = RequestConversationTranscriptSchema.safeParse({
      ...base, conversationId: '550e8400-e29b-41d4-a716-446655440000', cwd: '/home/dev/repo',
    })
    assert.equal(withCwd.success, true)
  })

  it('accepts ServerMessageSchema with optional code field for structured errors', async () => {
    const { ServerMessageSchema } = await import('../src/schemas/server.ts')
    const result = ServerMessageSchema.safeParse({
      type: 'message',
      messageType: 'error',
      content: 'Docker is not running.',
      timestamp: Date.now(),
      code: 'docker_not_running',
    })
    assert.ok(result.success, 'Should validate message with code field')
    assert.equal(result.data.code, 'docker_not_running')
  })

  it('accepts ServerMessageSchema without code field (backward compatible)', async () => {
    const { ServerMessageSchema } = await import('../src/schemas/server.ts')
    const result = ServerMessageSchema.safeParse({
      type: 'message',
      messageType: 'assistant',
      content: 'hello',
      timestamp: Date.now(),
    })
    assert.ok(result.success, 'Should validate message without code field')
  })

  it('rejects ServerMessageSchema with code exceeding 64 chars', async () => {
    const { ServerMessageSchema } = await import('../src/schemas/server.ts')
    const result = ServerMessageSchema.safeParse({
      type: 'message',
      messageType: 'error',
      content: 'err',
      timestamp: Date.now(),
      code: 'x'.repeat(65),
    })
    assert.ok(!result.success, 'Should reject code longer than 64 chars')
  })

  it('validates ServerProviderListSchema with capabilities', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'provider_list',
      providers: [
        { name: 'claude', capabilities: { sandbox: true, push: false } },
        { name: 'codex', capabilities: {} },
      ],
    })
    assert.ok(result.success, 'Should validate provider_list with capabilities')
    assert.equal(result.data.providers.length, 2)
    assert.equal(result.data.providers[0].name, 'claude')
    assert.deepEqual(result.data.providers[0].capabilities, { sandbox: true, push: false })
  })

  it('validates ServerProviderListSchema without optional capabilities', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'provider_list',
      providers: [{ name: 'claude' }],
    })
    assert.ok(result.success, 'Should validate provider_list when capabilities is omitted')
    assert.equal(result.data.providers[0].capabilities, undefined)
  })

  it('validates ServerProviderListSchema with empty providers array', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'provider_list',
      providers: [],
    })
    assert.ok(result.success, 'Should validate provider_list with empty providers array')
  })

  it('rejects ServerProviderListSchema with wrong type literal', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'providers',
      providers: [{ name: 'claude' }],
    })
    assert.ok(!result.success, 'Should reject when type is not "provider_list"')
  })

  it('rejects ServerProviderListSchema missing providers field', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'provider_list',
    })
    assert.ok(!result.success, 'Should reject when providers field is missing')
  })

  it('rejects ServerProviderListSchema when provider entry missing name', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'provider_list',
      providers: [{ capabilities: { sandbox: true } }],
    })
    assert.ok(!result.success, 'Should reject provider entry without name')
  })

  it('rejects ServerProviderListSchema when capabilities values are not booleans', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'provider_list',
      providers: [{ name: 'claude', capabilities: { sandbox: 'yes' } }],
    })
    assert.ok(!result.success, 'Should reject non-boolean capability values')
  })

  it('accepts ServerProviderListSchema with auth.billingClass (#5630)', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'provider_list',
      providers: [{
        name: 'claude-cli',
        auth: {
          ready: true,
          source: 'oauth',
          envVar: null,
          envVars: [],
          hint: '',
          detail: 'Programmatic credit pool — monthly metered credits',
          billingClass: 'programmatic-credit',
        },
      }],
    })
    assert.ok(result.success, 'auth.billingClass should be accepted')
    assert.equal(result.data.providers[0].auth.billingClass, 'programmatic-credit')
  })

  it('accepts ServerProviderListSchema auth WITHOUT billingClass (optional, #5630)', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'provider_list',
      providers: [{
        name: 'claude-cli',
        auth: { ready: true, source: 'oauth', envVar: null, envVars: [], hint: '', detail: 'x' },
      }],
    })
    assert.ok(result.success, 'billingClass is optional — older servers omit it')
  })

  it('rejects ServerProviderListSchema with an unknown billingClass value (#5630)', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'provider_list',
      providers: [{
        name: 'claude-cli',
        auth: { ready: true, source: 'oauth', envVar: null, envVars: [], hint: '', detail: 'x', billingClass: 'bogus' },
      }],
    })
    assert.ok(!result.success, 'unknown billingClass enum value must be rejected')
  })

  it('ServerResultSchema accepts cost: null (#5630 0→null degradation)', async () => {
    const { ServerResultSchema } = await import('../src/schemas/server.ts')
    const nullCost = ServerResultSchema.safeParse({ type: 'result', cost: null })
    assert.ok(nullCost.success, 'cost: null should parse')
    const numCost = ServerResultSchema.safeParse({ type: 'result', cost: 0.012 })
    assert.ok(numCost.success, 'cost: <number> should still parse')
    const omitted = ServerResultSchema.safeParse({ type: 'result' })
    assert.ok(omitted.success, 'cost is optional')
  })

  it('ServerSessionListEntrySchema accepts billingClass (#5630)', async () => {
    const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
    const result = ServerSessionListEntrySchema.safeParse({
      sessionId: 's1', name: 'A', provider: 'claude-byok', billingClass: 'api-key',
    })
    assert.ok(result.success, 'per-session billingClass should be accepted')
    const omitted = ServerSessionListEntrySchema.safeParse({ sessionId: 's1', name: 'A' })
    assert.ok(omitted.success, 'per-session billingClass is optional')
  })

  it('validates ServerSkillsListSchema with description', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [
        { name: 'review', description: 'Review a pull request' },
        { name: 'commit', description: 'Create a git commit' },
      ],
    })
    assert.ok(result.success, 'Should validate skills_list with descriptions')
    assert.equal(result.data.skills.length, 2)
    assert.equal(result.data.skills[0].name, 'review')
    assert.equal(result.data.skills[0].description, 'Review a pull request')
  })

  it('validates ServerSkillsListSchema without optional description', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [{ name: 'commit' }],
    })
    assert.ok(result.success, 'Should validate skills_list when description is omitted')
    assert.equal(result.data.skills[0].description, undefined)
  })

  it('validates ServerSkillsListSchema with empty skills array', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [],
    })
    assert.ok(result.success, 'Should validate skills_list with empty skills array')
  })

  it('rejects ServerSkillsListSchema with wrong type literal', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills',
      skills: [{ name: 'commit' }],
    })
    assert.ok(!result.success, 'Should reject when type is not "skills_list"')
  })

  it('rejects ServerSkillsListSchema missing skills field', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
    })
    assert.ok(!result.success, 'Should reject when skills field is missing')
  })

  it('rejects ServerSkillsListSchema when skill entry missing name', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [{ description: 'No name' }],
    })
    assert.ok(!result.success, 'Should reject skill entry without name')
  })

  it('rejects ServerSkillsListSchema when description is not a string', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [{ name: 'commit', description: 42 }],
    })
    assert.ok(!result.success, 'Should reject non-string description')
  })

  it('validates ServerSkillsListSchema with ISO-8601 firstSeen / lastVerified (#3250)', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [{
        name: 'commit',
        firstSeen: '2026-03-18T10:00:00.000Z',
        lastVerified: '2026-05-03T12:34:56Z',
      }],
    })
    assert.ok(result.success, 'Should validate ISO-8601 datetimes')
  })

  it('rejects ServerSkillsListSchema with non-ISO firstSeen (#3250)', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [{ name: 'commit', firstSeen: '2026-03-18 10:00:00' }],
    })
    assert.ok(!result.success, 'Should reject space-separated date instead of ISO-8601')
  })

  it('rejects ServerSkillsListSchema with non-ISO lastVerified (#3250)', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [{ name: 'commit', lastVerified: 'Sun May 03 2026' }],
    })
    assert.ok(!result.success, 'Should reject Date.toString() form')
  })

  it('validates ServerWebTaskErrorSchema with generic-task-failure shape', async () => {
    const { ServerWebTaskErrorSchema } = await import('../src/schemas/server.ts')
    const result = ServerWebTaskErrorSchema.safeParse({
      type: 'web_task_error',
      taskId: 'task-1',
      message: 'Task prompt is required',
    })
    assert.ok(result.success, 'Should validate generic web_task_error without code/boundSession*')
  })

  it('validates ServerWebTaskErrorSchema with SESSION_TOKEN_MISMATCH four-field contract', async () => {
    const { ServerWebTaskErrorSchema } = await import('../src/schemas/server.ts')
    const result = ServerWebTaskErrorSchema.safeParse({
      type: 'web_task_error',
      taskId: null,
      message: 'Not authorized to access this session',
      code: 'SESSION_TOKEN_MISMATCH',
      boundSessionId: 'session-42',
      boundSessionName: 'My Project',
    })
    assert.ok(result.success, 'Should validate full SESSION_TOKEN_MISMATCH payload')
    assert.equal(result.data.code, 'SESSION_TOKEN_MISMATCH')
    assert.equal(result.data.boundSessionId, 'session-42')
    assert.equal(result.data.boundSessionName, 'My Project')
  })

  it('validates ServerWebTaskErrorSchema with null boundSessionId/boundSessionName', async () => {
    const { ServerWebTaskErrorSchema } = await import('../src/schemas/server.ts')
    const result = ServerWebTaskErrorSchema.safeParse({
      type: 'web_task_error',
      taskId: null,
      message: 'Not authorized to access this session',
      code: 'SESSION_TOKEN_MISMATCH',
      boundSessionId: null,
      boundSessionName: null,
    })
    assert.ok(result.success, 'Should validate SESSION_TOKEN_MISMATCH with null bound fields')
    assert.equal(result.data.boundSessionId, null)
    assert.equal(result.data.boundSessionName, null)
  })

  it('rejects ServerWebTaskErrorSchema when code exceeds 64 chars', async () => {
    const { ServerWebTaskErrorSchema } = await import('../src/schemas/server.ts')
    const result = ServerWebTaskErrorSchema.safeParse({
      type: 'web_task_error',
      taskId: 'task-1',
      message: 'oops',
      code: 'X'.repeat(65),
    })
    assert.ok(!result.success, 'Should reject web_task_error code longer than 64 chars')
  })

  // #3234: skill_changed event schema (server-broadcast trust mismatch).
  it('validates ServerSkillChangedSchema with warn mode + 8-char hash prefixes', async () => {
    const { ServerSkillChangedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillChangedSchema.safeParse({
      type: 'skill_changed',
      skillName: 'coding-style',
      sessionId: 'sess-42',
      oldHashPrefix: 'abcdef01',
      newHashPrefix: '01234567',
      mode: 'warn',
    })
    assert.ok(result.success, 'Should validate well-formed warn-mode skill_changed')
    assert.equal(result.data.skillName, 'coding-style')
    assert.equal(result.data.mode, 'warn')
  })

  it('validates ServerSkillChangedSchema with block mode + null sessionId (legacy single-CLI)', async () => {
    const { ServerSkillChangedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillChangedSchema.safeParse({
      type: 'skill_changed',
      skillName: 'coding-style',
      sessionId: null,
      oldHashPrefix: 'aaaaaaaa',
      newHashPrefix: 'bbbbbbbb',
      mode: 'block',
    })
    assert.ok(result.success, 'Should accept null sessionId for legacy single-CLI mode')
    assert.equal(result.data.sessionId, null)
    assert.equal(result.data.mode, 'block')
  })

  it('rejects ServerSkillChangedSchema with hash prefix shorter than 8 chars', async () => {
    const { ServerSkillChangedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillChangedSchema.safeParse({
      type: 'skill_changed',
      skillName: 'x',
      sessionId: null,
      oldHashPrefix: 'short',
      newHashPrefix: 'bbbbbbbb',
      mode: 'warn',
    })
    assert.ok(!result.success, 'Should reject hash prefix shorter than 8 chars')
  })

  it('rejects ServerSkillChangedSchema with non-hex hash prefix', async () => {
    const { ServerSkillChangedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillChangedSchema.safeParse({
      type: 'skill_changed',
      skillName: 'x',
      sessionId: null,
      oldHashPrefix: 'XYZGHIJK', // not lowercase hex
      newHashPrefix: 'bbbbbbbb',
      mode: 'warn',
    })
    assert.ok(!result.success, 'Should reject non-hex hash prefix')
  })

  it('rejects ServerSkillChangedSchema with unknown mode', async () => {
    const { ServerSkillChangedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillChangedSchema.safeParse({
      type: 'skill_changed',
      skillName: 'x',
      sessionId: null,
      oldHashPrefix: 'aaaaaaaa',
      newHashPrefix: 'bbbbbbbb',
      mode: 'banana',
    })
    assert.ok(!result.success, 'Should reject mode that is not warn or block')
  })

  it('rejects ServerSkillChangedSchema with wrong type literal', async () => {
    const { ServerSkillChangedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillChangedSchema.safeParse({
      type: 'skill_change', // missing 'd'
      skillName: 'x',
      sessionId: null,
      oldHashPrefix: 'aaaaaaaa',
      newHashPrefix: 'bbbbbbbb',
      mode: 'warn',
    })
    assert.ok(!result.success, 'Should reject when type is not "skill_changed"')
  })

  // #3100: ServerEvaluateDraftResultSchema gained an optional numeric `status`
  // on the error branch. Lock the wire contract here so a future regression
  // (e.g. someone widens the type to string, or drops the optional flag)
  // can't slip through with only server/dashboard tests staying green.
  describe('ServerEvaluateDraftResultSchema (#3100)', () => {
    it('validates the success branch (forward verdict)', async () => {
      const { ServerEvaluateDraftResultSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluateDraftResultSchema.safeParse({
        type: 'evaluate_draft_result',
        requestId: 'req-1',
        verdict: 'forward',
        rewritten: null,
        clarification: null,
        reasoning: 'Looks clear.',
      })
      assert.ok(result.success, 'Should validate forward verdict success payload')
    })

    it('validates the error branch with optional status (429)', async () => {
      const { ServerEvaluateDraftResultSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluateDraftResultSchema.safeParse({
        type: 'evaluate_draft_result',
        requestId: 'req-2',
        error: { code: 'EVALUATOR_API_ERROR', message: 'Evaluator rate limited', status: 429 },
      })
      assert.ok(result.success, 'Should validate error payload carrying numeric status')
      if (result.success && 'error' in result.data && result.data.error) {
        assert.equal(result.data.error.status, 429)
      }
    })

    it('validates the error branch when status is omitted (network error / NO_API_KEY)', async () => {
      const { ServerEvaluateDraftResultSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluateDraftResultSchema.safeParse({
        type: 'evaluate_draft_result',
        requestId: 'req-3',
        error: { code: 'EVALUATOR_NO_API_KEY', message: 'ANTHROPIC_API_KEY is not set' },
      })
      assert.ok(result.success, 'Should validate error payload without status')
      if (result.success && 'error' in result.data && result.data.error) {
        assert.equal(result.data.error.status, undefined)
      }
    })

    it('rejects a non-numeric status on the error branch', async () => {
      const { ServerEvaluateDraftResultSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluateDraftResultSchema.safeParse({
        type: 'evaluate_draft_result',
        requestId: 'req-4',
        error: { code: 'EVALUATOR_API_ERROR', message: 'rate limited', status: '429' },
      })
      assert.ok(!result.success, 'Should reject string status — wire contract is z.number().int()')
    })

    it('rejects a non-integer status on the error branch', async () => {
      const { ServerEvaluateDraftResultSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluateDraftResultSchema.safeParse({
        type: 'evaluate_draft_result',
        requestId: 'req-5',
        error: { code: 'EVALUATOR_API_ERROR', message: 'x', status: 429.5 },
      })
      assert.ok(!result.success, 'Should reject non-integer status — wire contract is z.number().int()')
    })

    it('rejects mixed payload (verdict + error)', async () => {
      const { ServerEvaluateDraftResultSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluateDraftResultSchema.safeParse({
        type: 'evaluate_draft_result',
        requestId: 'req-6',
        verdict: 'forward',
        reasoning: 'ok',
        error: { code: 'EVALUATOR_API_ERROR', message: 'no' },
      })
      assert.ok(!result.success, 'Discriminated union should reject mixed success+error')
    })
  })

  // #3538: skill_trust_grant INVALID_AUTHOR error must carry actualAuthor as
  // a structured field on the wire — clients must NOT regex-parse `message`.
  describe('ServerSkillTrustGrantInvalidAuthorSchema (#3538)', () => {
    it('validates a well-formed INVALID_AUTHOR payload with actualAuthor', async () => {
      const { ServerSkillTrustGrantInvalidAuthorSchema } = await import('../src/schemas/server.ts')
      const result = ServerSkillTrustGrantInvalidAuthorSchema.safeParse({
        type: 'error',
        requestId: 'req-1',
        code: 'INVALID_AUTHOR',
        message: "Community skill 'foo' is owned by 'alice', not 'bob'.",
        actualAuthor: 'alice',
      })
      assert.ok(result.success, 'Should validate INVALID_AUTHOR error carrying actualAuthor')
      if (result.success) {
        assert.equal(result.data.actualAuthor, 'alice')
      }
    })

    it('accepts null requestId', async () => {
      const { ServerSkillTrustGrantInvalidAuthorSchema } = await import('../src/schemas/server.ts')
      const result = ServerSkillTrustGrantInvalidAuthorSchema.safeParse({
        type: 'error',
        requestId: null,
        code: 'INVALID_AUTHOR',
        message: 'wrong author',
        actualAuthor: 'alice',
      })
      assert.ok(result.success, 'requestId must accept null')
    })

    it('rejects payload missing actualAuthor', async () => {
      const { ServerSkillTrustGrantInvalidAuthorSchema } = await import('../src/schemas/server.ts')
      const result = ServerSkillTrustGrantInvalidAuthorSchema.safeParse({
        type: 'error',
        requestId: 'req-2',
        code: 'INVALID_AUTHOR',
        message: 'wrong author',
      })
      assert.ok(!result.success, 'actualAuthor is required for the cross-author variants')
    })

    it('rejects wrong code literal', async () => {
      const { ServerSkillTrustGrantInvalidAuthorSchema } = await import('../src/schemas/server.ts')
      const result = ServerSkillTrustGrantInvalidAuthorSchema.safeParse({
        type: 'error',
        requestId: 'req-3',
        code: 'SKILL_NOT_FOUND',
        message: 'oops',
        actualAuthor: 'alice',
      })
      assert.ok(!result.success, 'Schema must lock code to literal INVALID_AUTHOR')
    })

    it('rejects wrong type literal', async () => {
      const { ServerSkillTrustGrantInvalidAuthorSchema } = await import('../src/schemas/server.ts')
      const result = ServerSkillTrustGrantInvalidAuthorSchema.safeParse({
        type: 'server_error',
        requestId: 'req-4',
        code: 'INVALID_AUTHOR',
        message: 'oops',
        actualAuthor: 'alice',
      })
      assert.ok(!result.success, 'Schema must lock type to literal "error"')
    })
  })

  // #3544: pin the wire contract for the cumulative stdin_dropped totals so a
  // server-side regression (e.g. dropping the `escalated` flag, widening
  // `bytes` to a string, forgetting the nullable `sessionId`) is caught here
  // before it reaches the dashboard schema-validation layer.
  describe('ServerStdinDroppedTotalsSchema (#3544)', () => {
    it('validates a multi-session payload', async () => {
      const { ServerStdinDroppedTotalsSchema } = await import('../src/schemas/server.ts')
      const result = ServerStdinDroppedTotalsSchema.safeParse({
        type: 'stdin_dropped_totals',
        sessionId: 'sess-1',
        bytes: 1048576,
        count: 4,
        reason: 'pre-dial-cap',
        escalated: true,
      })
      assert.ok(result.success, 'Should validate multi-session totals payload')
    })

    it('accepts null sessionId (legacy single-CLI mode)', async () => {
      const { ServerStdinDroppedTotalsSchema } = await import('../src/schemas/server.ts')
      const result = ServerStdinDroppedTotalsSchema.safeParse({
        type: 'stdin_dropped_totals',
        sessionId: null,
        bytes: 0,
        count: 0,
        reason: 'unknown',
        escalated: false,
      })
      assert.ok(result.success, 'Should validate null sessionId for legacy mode')
    })

    it('rejects negative bytes', async () => {
      const { ServerStdinDroppedTotalsSchema } = await import('../src/schemas/server.ts')
      const result = ServerStdinDroppedTotalsSchema.safeParse({
        type: 'stdin_dropped_totals',
        sessionId: 'sess-1',
        bytes: -1,
        count: 1,
        reason: 'pre-dial-cap',
        escalated: true,
      })
      assert.ok(!result.success, 'Should reject negative bytes — counters are nonnegative')
    })

    it('rejects non-integer count', async () => {
      const { ServerStdinDroppedTotalsSchema } = await import('../src/schemas/server.ts')
      const result = ServerStdinDroppedTotalsSchema.safeParse({
        type: 'stdin_dropped_totals',
        sessionId: 'sess-1',
        bytes: 100,
        count: 1.5,
        reason: 'pre-dial-cap',
        escalated: true,
      })
      assert.ok(!result.success, 'Should reject non-integer count')
    })

    it('rejects missing escalated flag', async () => {
      const { ServerStdinDroppedTotalsSchema } = await import('../src/schemas/server.ts')
      const result = ServerStdinDroppedTotalsSchema.safeParse({
        type: 'stdin_dropped_totals',
        sessionId: 'sess-1',
        bytes: 100,
        count: 1,
        reason: 'pre-dial-cap',
      })
      assert.ok(!result.success, 'escalated is required for the loud-signal UX')
    })

    it('rejects wrong type literal', async () => {
      const { ServerStdinDroppedTotalsSchema } = await import('../src/schemas/server.ts')
      const result = ServerStdinDroppedTotalsSchema.safeParse({
        type: 'wrong_type',
        sessionId: 'sess-1',
        bytes: 100,
        count: 1,
        reason: 'pre-dial-cap',
        escalated: true,
      })
      assert.ok(!result.success, 'type must be "stdin_dropped_totals"')
    })
  })

  // #3573: session_list entry shape now documents the cumulative
  // stdin_dropped totals so a reconnecting client can hydrate the live
  // counter from the handshake. The entry schema is `passthrough()` so
  // older clients ignore unknown fields and newer clients can rely on
  // the documented optional fields below.
  describe('ServerSessionListEntrySchema (#3573)', () => {
    it('validates an entry with stdinDroppedBytes and stdinDroppedCount', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-1',
        name: 'Session 1',
        cwd: '/tmp/project',
        model: 'claude-sonnet-4-6',
        permissionMode: 'approve',
        isBusy: false,
        stdinForwardingDisabled: false,
        stdinDroppedBytes: 4096,
        stdinDroppedCount: 3,
      })
      assert.ok(result.success, 'session_list entry must accept stdinDropped totals')
      assert.equal(result.data.stdinDroppedBytes, 4096)
      assert.equal(result.data.stdinDroppedCount, 3)
    })

    it('validates an entry with zeroed totals (non-SDK provider)', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-cli',
        name: 'Cli Session',
        cwd: '/tmp/cli',
        stdinDroppedBytes: 0,
        stdinDroppedCount: 0,
      })
      assert.ok(result.success, 'zero counters from non-SDK providers must validate')
    })

    it('rejects negative stdinDroppedBytes', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-1',
        name: 'Session 1',
        cwd: '/tmp/project',
        stdinDroppedBytes: -1,
        stdinDroppedCount: 0,
      })
      assert.ok(!result.success, 'byte counter must be non-negative')
    })

    it('rejects fractional stdinDroppedCount', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-1',
        name: 'Session 1',
        cwd: '/tmp/project',
        stdinDroppedBytes: 0,
        stdinDroppedCount: 1.5,
      })
      assert.ok(!result.success, 'drop count must be an integer')
    })

    it('treats stdinDroppedTotals as optional (older servers omit them)', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-1',
        name: 'Session 1',
        cwd: '/tmp/project',
      })
      assert.ok(result.success, 'older servers without #3573 fields must still validate')
    })

    it('passes through unknown fields for forward compat', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-1',
        name: 'Session 1',
        cwd: '/tmp/project',
        someFutureField: { foo: 'bar' },
      })
      assert.ok(result.success, 'passthrough() must allow unknown fields')
      assert.equal(result.data.someFutureField.foo, 'bar')
    })

    it('validates a full session_list payload through ServerSessionListSchema', async () => {
      const { ServerSessionListSchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListSchema.safeParse({
        type: 'session_list',
        sessions: [
          {
            sessionId: 'sess-1',
            name: 'Session 1',
            cwd: '/tmp/project',
            stdinDroppedBytes: 1024,
            stdinDroppedCount: 2,
          },
          {
            sessionId: 'sess-2',
            name: 'Session 2',
            cwd: '/tmp/project-2',
            stdinDroppedBytes: 0,
            stdinDroppedCount: 0,
          },
        ],
      })
      assert.ok(result.success, 'session_list with stdinDropped totals must validate end-to-end')
      assert.equal(result.data.sessions[0].stdinDroppedBytes, 1024)
      assert.equal(result.data.sessions[1].stdinDroppedCount, 0)
    })
  })

  // #3208: auto-evaluator broadcast events. Two transient events arriving without
  // a triggering client request, so the dashboard knows to render the
  // rewrite-explanation banner or the clarify-question modal.
  describe('ServerEvaluatorRewriteSchema (#3208)', () => {
    it('validates a well-formed evaluator_rewrite payload', async () => {
      const { ServerEvaluatorRewriteSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorRewriteSchema.safeParse({
        type: 'evaluator_rewrite',
        sessionId: 'sess-1',
        originalDraft: 'fix it',
        rewritten: 'Please fix the failing test in foo.js',
        reasoning: 'Original was too vague.',
        evaluatorIterationId: 'iter-abc-1',
      })
      assert.ok(result.success, 'Should validate well-formed evaluator_rewrite')
      assert.equal(result.data.sessionId, 'sess-1')
      assert.equal(result.data.evaluatorIterationId, 'iter-abc-1')
    })

    it('rejects evaluator_rewrite with wrong type literal', async () => {
      const { ServerEvaluatorRewriteSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorRewriteSchema.safeParse({
        type: 'rewrite',
        sessionId: 'sess-1',
        originalDraft: 'x',
        rewritten: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
      })
      assert.ok(!result.success, 'Should reject when type is not "evaluator_rewrite"')
    })

    it('rejects evaluator_rewrite missing rewritten field', async () => {
      const { ServerEvaluatorRewriteSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorRewriteSchema.safeParse({
        type: 'evaluator_rewrite',
        sessionId: 'sess-1',
        originalDraft: 'x',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
      })
      assert.ok(!result.success, 'rewritten is required for the rewrite verdict')
    })

    it('rejects evaluator_rewrite missing evaluatorIterationId', async () => {
      const { ServerEvaluatorRewriteSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorRewriteSchema.safeParse({
        type: 'evaluator_rewrite',
        sessionId: 'sess-1',
        originalDraft: 'x',
        rewritten: 'y',
        reasoning: 'z',
      })
      assert.ok(!result.success, 'evaluatorIterationId is required for dashboard dedup')
    })

    it('rejects evaluator_rewrite with non-string sessionId', async () => {
      const { ServerEvaluatorRewriteSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorRewriteSchema.safeParse({
        type: 'evaluator_rewrite',
        sessionId: 42,
        originalDraft: 'x',
        rewritten: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
      })
      assert.ok(!result.success, 'sessionId must be a string')
    })

    // #3627: pin the empty-string and extra-field policies so a future
    // tightening (z.string().min(1) or .strict()) is a deliberate decision
    // with a failing test, not a silent regression that breaks older
    // servers when newer fields land.
    it('accepts empty originalDraft / rewritten / reasoning (empty-string policy)', async () => {
      const { ServerEvaluatorRewriteSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorRewriteSchema.safeParse({
        type: 'evaluator_rewrite',
        sessionId: 'sess-1',
        originalDraft: '',
        rewritten: '',
        reasoning: '',
        evaluatorIterationId: 'iter-1',
      })
      assert.ok(result.success, 'empty strings must validate — auto-evaluator may produce empty reasoning under timeout fallback')
    })

    it('strips unknown fields for forward compat (Zod default behavior)', async () => {
      const { ServerEvaluatorRewriteSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorRewriteSchema.safeParse({
        type: 'evaluator_rewrite',
        sessionId: 'sess-1',
        originalDraft: 'x',
        rewritten: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        someFutureField: { nested: 'value' },
      })
      assert.ok(result.success, 'unknown fields must NOT reject — newer servers may emit fields older clients don\'t recognize')
      assert.equal(result.data.someFutureField, undefined, 'Zod default strips unknown fields from the parsed output')
    })
  })

  describe('ServerEvaluatorClarifySchema (#3208)', () => {
    it('validates a well-formed evaluator_clarify payload', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: 'fix it',
        clarification: 'Which file are you referring to?',
        reasoning: 'The draft does not specify a file.',
        evaluatorIterationId: 'iter-abc-2',
        evaluatorIteration: 1,
      })
      assert.ok(result.success, 'Should validate well-formed evaluator_clarify')
      assert.equal(result.data.evaluatorIteration, 1)
    })

    it('validates evaluator_clarify at max iteration (3)', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: 'x',
        clarification: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 3,
      })
      assert.ok(result.success, 'Should accept iteration 3 (max)')
    })

    it('rejects evaluator_clarify with iteration above sanity ceiling (11)', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: 'x',
        clarification: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 11,
      })
      assert.ok(!result.success, 'iteration must be capped at the wire-schema sanity ceiling (10)')
    })

    it('rejects evaluator_clarify with iteration 0', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: 'x',
        clarification: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 0,
      })
      assert.ok(!result.success, 'iteration counter is 1-based')
    })

    it('rejects evaluator_clarify with non-integer iteration', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: 'x',
        clarification: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 1.5,
      })
      assert.ok(!result.success, 'iteration must be an integer')
    })

    it('rejects evaluator_clarify missing clarification', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: 'x',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 1,
      })
      assert.ok(!result.success, 'clarification is required for the clarify verdict')
    })

    it('rejects evaluator_clarify with wrong type literal', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'clarify',
        sessionId: 'sess-1',
        originalDraft: 'x',
        clarification: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 1,
      })
      assert.ok(!result.success, 'Should reject when type is not "evaluator_clarify"')
    })

    // #3627: same empty-string + extra-field policies as the rewrite schema —
    // pin them so a future tightening is a deliberate decision.
    it('accepts empty originalDraft / clarification / reasoning (empty-string policy)', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: '',
        clarification: '',
        reasoning: '',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 1,
      })
      assert.ok(result.success, 'empty strings must validate — auto-evaluator may produce empty reasoning under timeout fallback')
    })

    it('strips unknown fields for forward compat (Zod default behavior)', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: 'x',
        clarification: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 1,
        someFutureField: { nested: 'value' },
      })
      assert.ok(result.success, 'unknown fields must NOT reject — newer servers may emit fields older clients don\'t recognize')
      assert.equal(result.data.someFutureField, undefined, 'Zod default strips unknown fields from the parsed output')
    })
  })

  describe('CumulativeUsage + session_usage + session_cost_threshold_crossed (#4091)', () => {
    it('CumulativeUsageSchema validates a full block', async () => {
      const { CumulativeUsageSchema } = await import('../src/schemas/server.ts')
      const result = CumulativeUsageSchema.safeParse({
        inputTokens: 1234,
        outputTokens: 567,
        cacheReadTokens: 8000,
        cacheCreationTokens: 200,
        costUsd: 0.0345,
        turnsBilled: 3,
      })
      assert.ok(result.success)
    })

    it('CumulativeUsageSchema rejects when a numeric field is missing', async () => {
      const { CumulativeUsageSchema } = await import('../src/schemas/server.ts')
      const result = CumulativeUsageSchema.safeParse({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        // costUsd intentionally missing
        turnsBilled: 0,
      })
      assert.ok(!result.success, 'all six fields are required by the schema')
    })

    it('ServerSessionUsageSchema validates with sessionId injected by broadcaster', async () => {
      const { ServerSessionUsageSchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionUsageSchema.safeParse({
        type: 'session_usage',
        sessionId: 'sess-1',
        cumulativeUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.001,
          turnsBilled: 1,
        },
      })
      assert.ok(result.success)
    })

    it('ServerSessionUsageSchema permits omitting sessionId (pre-broadcast shape)', async () => {
      // _broadcastToSession injects sessionId via spread; the EventNormalizer
      // emits without it. Schema must accept both shapes.
      const { ServerSessionUsageSchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionUsageSchema.safeParse({
        type: 'session_usage',
        cumulativeUsage: {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
          cacheCreationTokens: 0, costUsd: 0, turnsBilled: 0,
        },
      })
      assert.ok(result.success)
    })

    it('ServerMonthlyBudgetSchema validates the live event (with crossing flags) and the snapshot (#5665)', async () => {
      const { ServerMonthlyBudgetSchema } = await import('../src/schemas/server.ts')
      // Live event after a billed turn — includes the one-shot crossing flags.
      const live = ServerMonthlyBudgetSchema.safeParse({
        type: 'monthly_budget',
        month: '2026-06',
        spentUsd: 17,
        turnsBilled: 4,
        budgetUsd: 20,
        warningPercent: 80,
        percent: 85,
        warning: true,
        exceeded: false,
        justWarned: true,
        justExceeded: false,
      })
      assert.ok(live.success)
      // On-connect snapshot — crossing flags omitted.
      const snapshot = ServerMonthlyBudgetSchema.safeParse({
        type: 'monthly_budget',
        month: '2026-06',
        spentUsd: 0,
        turnsBilled: 0,
        budgetUsd: 20,
        warningPercent: 80,
        percent: 0,
        warning: false,
        exceeded: false,
      })
      assert.ok(snapshot.success)
    })

    it('ServerMonthlyBudgetSchema permits a null cap / percent when no tier is configured (#5665)', async () => {
      const { ServerMonthlyBudgetSchema } = await import('../src/schemas/server.ts')
      const result = ServerMonthlyBudgetSchema.safeParse({
        type: 'monthly_budget',
        month: '2026-06',
        spentUsd: 42,
        turnsBilled: 9,
        budgetUsd: null,
        warningPercent: 80,
        percent: null,
        warning: false,
        exceeded: false,
      })
      assert.ok(result.success)
    })

    it('ServerSessionCostThresholdCrossedSchema validates the threshold-crossed payload', async () => {
      const { ServerSessionCostThresholdCrossedSchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionCostThresholdCrossedSchema.safeParse({
        type: 'session_cost_threshold_crossed',
        sessionId: 'sess-1',
        costUsd: 5.23,
        thresholdUsd: 5.00,
      })
      assert.ok(result.success)
    })

    it('ServerSessionListEntrySchema accepts an entry with cumulativeUsage', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-1',
        name: 'Session 1',
        cumulativeUsage: {
          inputTokens: 100, outputTokens: 50, cacheReadTokens: 0,
          cacheCreationTokens: 0, costUsd: 0.001, turnsBilled: 1,
        },
      })
      assert.ok(result.success)
      assert.equal(result.data.cumulativeUsage?.costUsd, 0.001)
    })

    it('ServerSessionListEntrySchema accepts an entry without cumulativeUsage (older servers)', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-1',
        name: 'Session 1',
      })
      assert.ok(result.success)
      assert.equal(result.data.cumulativeUsage, undefined)
    })
  })

  // #4141: BYOK credentials status — dashboard previously raw-cast the payload.
  // The schema constrains status/source to enum values so a malformed server
  // can't store unknown strings into the store.
  describe('ServerByokCredentialsStatusSchema (#4141)', () => {
    it('accepts the full documented shape', async () => {
      const { ServerByokCredentialsStatusSchema } = await import('../src/schemas/server.ts')
      const r = ServerByokCredentialsStatusSchema.safeParse({
        type: 'byok_credentials_status',
        requestId: 'req-1',
        status: 'set',
        source: 'file',
        masked: 'sk-ant-***...xyz',
        fileExists: true,
      })
      assert.ok(r.success)
      assert.equal(r.data.status, 'set')
      assert.equal(r.data.source, 'file')
      assert.equal(r.data.masked, 'sk-ant-***...xyz')
      assert.equal(r.data.fileExists, true)
    })

    it('rejects unknown status values (enum constraint)', async () => {
      const { ServerByokCredentialsStatusSchema } = await import('../src/schemas/server.ts')
      const r = ServerByokCredentialsStatusSchema.safeParse({
        type: 'byok_credentials_status',
        status: 'unknown',
        source: 'file',
      })
      assert.equal(r.success, false)
    })

    it('rejects unknown source values (enum constraint)', async () => {
      const { ServerByokCredentialsStatusSchema } = await import('../src/schemas/server.ts')
      const r = ServerByokCredentialsStatusSchema.safeParse({
        type: 'byok_credentials_status',
        status: 'missing',
        source: 'magic',
      })
      assert.equal(r.success, false)
    })

    it('accepts minimal status without optional fields', async () => {
      const { ServerByokCredentialsStatusSchema } = await import('../src/schemas/server.ts')
      const r = ServerByokCredentialsStatusSchema.safeParse({
        type: 'byok_credentials_status',
        status: 'missing',
        source: 'none',
      })
      assert.ok(r.success)
      assert.equal(r.data.masked, undefined)
      assert.equal(r.data.fileExists, undefined)
    })
  })

  // #4192: ServerErrorEnvelopeMessage type alias — exported alongside the
  // schema so downstream consumers (mobile/dashboard/future tools) can write
  // `import type { ServerErrorEnvelopeMessage }` instead of re-running
  // `z.infer<typeof ServerErrorEnvelopeSchema>` at every call site. The
  // type itself is erased at runtime; these tests pin the schema shape that
  // the type represents so any future schema edit (renamed field, dropped
  // optional, narrowed enum) surfaces here before silently breaking typed
  // consumers.
  describe('ServerErrorEnvelopeMessage type alias (#4192)', () => {
    it('exports a type alias importable as TS-only re-export', async () => {
      // The export is type-only and erased at runtime, so we verify the
      // schema this alias is derived from is present and importable.
      // CI's Store Core Type Check / Dashboard Type Check perform the
      // actual type-level verification when consumers import the alias.
      const mod = await import('../src/schemas/server.ts')
      assert.ok(mod.ServerErrorEnvelopeSchema, 'ServerErrorEnvelopeSchema must remain exported')
    })

    it('schema shape accepts all fields the type alias surfaces', async () => {
      const { ServerErrorEnvelopeSchema } = await import('../src/schemas/server.ts')
      const result = ServerErrorEnvelopeSchema.safeParse({
        type: 'error',
        requestId: 'req-1',
        code: 'STREAM_ERROR',
        message: 'boom',
        fatal: false,
        correlationId: 'c-1',
        details: 'stack trace',
      })
      assert.ok(result.success, 'must accept the full documented envelope shape')
      // Pin the inferred shape — if any of these fields are dropped/renamed,
      // typed consumers break. Asserting at runtime catches the schema edit
      // before it reaches downstream type-checks.
      assert.equal(result.data.type, 'error')
      assert.equal(result.data.code, 'STREAM_ERROR')
      assert.equal(result.data.fatal, false)
      assert.equal(result.data.correlationId, 'c-1')
      assert.equal(result.data.details, 'stack trace')
    })

    it('schema preserves passthrough fields the type alias inherits', async () => {
      const { ServerErrorEnvelopeSchema } = await import('../src/schemas/server.ts')
      // .passthrough() lets code-specific extension fields (e.g.
      // actualAuthor on INVALID_AUTHOR, boundSessionId on SESSION_TOKEN_MISMATCH)
      // pass through the generic envelope. The type alias inherits this —
      // consumers can narrow on `code` and treat extras as `unknown`.
      const result = ServerErrorEnvelopeSchema.safeParse({
        type: 'error',
        message: 'mismatch',
        code: 'SESSION_TOKEN_MISMATCH',
        boundSessionId: 'sess-abc',
        actualAuthor: 'someone-else',
      })
      assert.ok(result.success)
      assert.equal(result.data.boundSessionId, 'sess-abc')
      assert.equal(result.data.actualAuthor, 'someone-else')
    })
  })

  describe('BYOK credential client messages (#4052)', () => {
    it('ByokGetCredentialsStatusSchema accepts type only', async () => {
      const { ByokGetCredentialsStatusSchema } = await import('../src/schemas/client.ts')
      assert.ok(ByokGetCredentialsStatusSchema.safeParse({ type: 'byok_get_credentials_status' }).success)
      assert.ok(ByokGetCredentialsStatusSchema.safeParse({ type: 'byok_get_credentials_status', requestId: 'r1' }).success)
    })

    it('ByokSetCredentialsSchema requires anthropicApiKey', async () => {
      const { ByokSetCredentialsSchema } = await import('../src/schemas/client.ts')
      assert.equal(ByokSetCredentialsSchema.safeParse({ type: 'byok_set_credentials' }).success, false)
      assert.equal(ByokSetCredentialsSchema.safeParse({ type: 'byok_set_credentials', anthropicApiKey: '' }).success, false)
      assert.ok(ByokSetCredentialsSchema.safeParse({ type: 'byok_set_credentials', anthropicApiKey: 'sk-ant-test' }).success)
    })

    it('ByokClearCredentialsSchema accepts type only', async () => {
      const { ByokClearCredentialsSchema } = await import('../src/schemas/client.ts')
      assert.ok(ByokClearCredentialsSchema.safeParse({ type: 'byok_clear_credentials' }).success)
    })
  })

  // #4735 — per-question answer wire format. Values may be either a
  // string (single-select / free-form) or string[] (multi-select). The
  // back-compat string-only shape must still validate; the new array
  // shape must validate too.
  describe('UserQuestionResponseSchema per-question answer values (#4735)', () => {
    it('accepts string answers (back-compat single-select / free-form)', async () => {
      const { UserQuestionResponseSchema } = await import('../src/schemas/client.ts')
      const result = UserQuestionResponseSchema.safeParse({
        type: 'user_question_response',
        answer: 'Patch',
        answers: { 'Which release strategy?': 'Patch', 'Confirm?': 'Yes' },
      })
      assert.ok(result.success, JSON.stringify(result))
    })

    it('accepts string[] answers (multi-select native array)', async () => {
      const { UserQuestionResponseSchema } = await import('../src/schemas/client.ts')
      const result = UserQuestionResponseSchema.safeParse({
        type: 'user_question_response',
        answer: 'App, Tests',
        answers: { 'Which targets?': ['App', 'Tests'] },
      })
      assert.ok(result.success, JSON.stringify(result))
    })

    it('accepts mixed string and string[] across questions', async () => {
      const { UserQuestionResponseSchema } = await import('../src/schemas/client.ts')
      const result = UserQuestionResponseSchema.safeParse({
        type: 'user_question_response',
        answer: 'summary',
        answers: {
          'Which release strategy?': 'Patch',
          'Which targets?': ['App', 'Tests'],
          'Confirm?': 'Yes',
        },
      })
      assert.ok(result.success, JSON.stringify(result))
    })

    it('rejects non-string array entries', async () => {
      const { UserQuestionResponseSchema } = await import('../src/schemas/client.ts')
      const result = UserQuestionResponseSchema.safeParse({
        type: 'user_question_response',
        answer: 'x',
        answers: { 'q?': [1, 2, 3] },
      })
      assert.ok(!result.success)
    })

    it('caps multi-select array length at 100', async () => {
      const { UserQuestionResponseSchema } = await import('../src/schemas/client.ts')
      const big = Array.from({ length: 101 }, (_, i) => `opt${i}`)
      const result = UserQuestionResponseSchema.safeParse({
        type: 'user_question_response',
        answer: 'x',
        answers: { 'q?': big },
      })
      assert.ok(!result.success)
    })

    it('caps individual array entries at 100k chars', async () => {
      const { UserQuestionResponseSchema } = await import('../src/schemas/client.ts')
      const huge = 'x'.repeat(100_001)
      const result = UserQuestionResponseSchema.safeParse({
        type: 'user_question_response',
        answer: 'x',
        answers: { 'q?': [huge] },
      })
      assert.ok(!result.success)
    })
  })

  describe('Control Room activity tree (#5161)', () => {
    const runningEntry = {
      id: 'act-1',
      kind: 'agent',
      label: 'Refactor auth module',
      status: 'running',
      startedAt: 1_700_000_000_000,
    }

    const terminalEntry = {
      id: 'act-2',
      kind: 'shell',
      label: 'npm test',
      status: 'done',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_005_000,
      parentId: 'act-1',
      outputRef: { kind: 'shell', id: 'brk57kt6pm' },
    }

    describe('ActivityEntrySchema', () => {
      it('validates a well-formed running entry (no endedAt)', async () => {
        const { ActivityEntrySchema } = await import('../src/schemas/server.ts')
        const result = ActivityEntrySchema.safeParse(runningEntry)
        assert.ok(result.success, JSON.stringify(result.error?.issues))
        assert.equal(result.data.kind, 'agent')
        assert.equal(result.data.endedAt, undefined)
      })

      it('validates a terminal entry with endedAt, parentId, outputRef', async () => {
        const { ActivityEntrySchema } = await import('../src/schemas/server.ts')
        const result = ActivityEntrySchema.safeParse(terminalEntry)
        assert.ok(result.success, JSON.stringify(result.error?.issues))
        assert.equal(result.data.parentId, 'act-1')
        assert.equal(result.data.outputRef.kind, 'shell')
      })

      it('accepts all three kinds', async () => {
        const { ActivityEntrySchema } = await import('../src/schemas/server.ts')
        for (const kind of ['agent', 'shell', 'tool']) {
          const result = ActivityEntrySchema.safeParse({ ...runningEntry, kind })
          assert.ok(result.success, `kind ${kind} should validate`)
        }
      })

      it('rejects an unknown kind', async () => {
        const { ActivityEntrySchema } = await import('../src/schemas/server.ts')
        const result = ActivityEntrySchema.safeParse({ ...runningEntry, kind: 'process' })
        assert.ok(!result.success, 'unknown kind must reject')
      })

      it('accepts all four statuses (with endedAt where terminal)', async () => {
        const { ActivityEntrySchema } = await import('../src/schemas/server.ts')
        assert.ok(ActivityEntrySchema.safeParse({ ...runningEntry, status: 'running' }).success)
        assert.ok(ActivityEntrySchema.safeParse({ ...runningEntry, status: 'blocked' }).success)
        assert.ok(ActivityEntrySchema.safeParse({ ...runningEntry, status: 'done', endedAt: 1_700_000_001_000 }).success)
        assert.ok(ActivityEntrySchema.safeParse({ ...runningEntry, status: 'failed', endedAt: 1_700_000_001_000 }).success)
      })

      it('rejects a done/failed entry without endedAt', async () => {
        const { ActivityEntrySchema } = await import('../src/schemas/server.ts')
        assert.ok(!ActivityEntrySchema.safeParse({ ...runningEntry, status: 'done' }).success, 'done requires endedAt')
        assert.ok(!ActivityEntrySchema.safeParse({ ...runningEntry, status: 'failed' }).success, 'failed requires endedAt')
      })

      it('rejects a running/blocked entry that carries endedAt', async () => {
        const { ActivityEntrySchema } = await import('../src/schemas/server.ts')
        const running = ActivityEntrySchema.safeParse({ ...runningEntry, status: 'running', endedAt: 1_700_000_001_000 })
        const blocked = ActivityEntrySchema.safeParse({ ...runningEntry, status: 'blocked', endedAt: 1_700_000_001_000 })
        assert.ok(!running.success, 'running must not carry endedAt')
        assert.ok(!blocked.success, 'blocked must not carry endedAt')
      })

      it('rejects endedAt earlier than startedAt', async () => {
        const { ActivityEntrySchema } = await import('../src/schemas/server.ts')
        const result = ActivityEntrySchema.safeParse({
          ...runningEntry,
          status: 'done',
          startedAt: 1_700_000_005_000,
          endedAt: 1_700_000_000_000,
        })
        assert.ok(!result.success, 'endedAt must be >= startedAt')
      })

      it('allows startedAt of 0 (clock-skew tolerance)', async () => {
        const { ActivityEntrySchema } = await import('../src/schemas/server.ts')
        const result = ActivityEntrySchema.safeParse({ ...runningEntry, startedAt: 0 })
        assert.ok(result.success, 'startedAt=0 must validate')
      })

      it('allows an empty label', async () => {
        const { ActivityEntrySchema } = await import('../src/schemas/server.ts')
        const result = ActivityEntrySchema.safeParse({ ...runningEntry, label: '' })
        assert.ok(result.success, 'empty label must validate (label not known yet)')
      })

      it('rejects an empty id', async () => {
        const { ActivityEntrySchema } = await import('../src/schemas/server.ts')
        const result = ActivityEntrySchema.safeParse({ ...runningEntry, id: '' })
        assert.ok(!result.success, 'id must be non-empty')
      })

      it('rejects a non-integer startedAt', async () => {
        const { ActivityEntrySchema } = await import('../src/schemas/server.ts')
        const result = ActivityEntrySchema.safeParse({ ...runningEntry, startedAt: 1.5 })
        assert.ok(!result.success, 'startedAt must be an integer ms epoch')
      })

      it('accepts a future/unknown outputRef kind (open string for forward compat)', async () => {
        // #5161 (Copilot review): outputRef.kind is an OPEN non-empty string,
        // not a closed enum — a newer server introducing a new channel kind
        // must NOT reject the whole message at an older client. The consumer
        // switches on the known kinds and degrades to "no drill-in" otherwise.
        const { ActivityEntrySchema } = await import('../src/schemas/server.ts')
        const result = ActivityEntrySchema.safeParse({
          ...runningEntry,
          outputRef: { kind: 'pty', id: 'x' },
        })
        assert.ok(result.success, 'unknown outputRef kind must parse (degrade gracefully, not reject)')
        assert.equal(result.data.outputRef.kind, 'pty')
      })

      it('accepts all three known outputRef kinds', async () => {
        const { ActivityEntrySchema, ACTIVITY_OUTPUT_REF_KINDS } = await import('../src/schemas/server.ts')
        assert.deepEqual([...ACTIVITY_OUTPUT_REF_KINDS], ['tool_use', 'shell', 'message'])
        for (const kind of ACTIVITY_OUTPUT_REF_KINDS) {
          const result = ActivityEntrySchema.safeParse({ ...runningEntry, outputRef: { kind, id: 'x' } })
          assert.ok(result.success, `known outputRef kind ${kind} should validate`)
        }
      })

      it('rejects an empty outputRef id', async () => {
        const { ActivityEntrySchema } = await import('../src/schemas/server.ts')
        const result = ActivityEntrySchema.safeParse({
          ...runningEntry,
          outputRef: { kind: 'shell', id: '' },
        })
        assert.ok(!result.success, 'outputRef.id must be non-empty')
      })

      it('strips unknown fields for forward compat', async () => {
        const { ActivityEntrySchema } = await import('../src/schemas/server.ts')
        const result = ActivityEntrySchema.safeParse({ ...runningEntry, futureField: { x: 1 } })
        assert.ok(result.success, 'unknown fields must not reject (newer server, older client)')
        assert.equal(result.data.futureField, undefined, 'Zod strips unknown fields')
      })
    })

    describe('ServerActivitySnapshotSchema', () => {
      it('validates a snapshot with entries', async () => {
        const { ServerActivitySnapshotSchema, ACTIVITY_SCHEMA_VERSION } = await import('../src/schemas/server.ts')
        const result = ServerActivitySnapshotSchema.safeParse({
          type: 'activity_snapshot',
          sessionId: 'sess-1',
          schemaVersion: ACTIVITY_SCHEMA_VERSION,
          entries: [runningEntry, terminalEntry],
        })
        assert.ok(result.success, JSON.stringify(result.error?.issues))
        assert.equal(result.data.entries.length, 2)
      })

      it('validates an empty-tree snapshot', async () => {
        const { ServerActivitySnapshotSchema } = await import('../src/schemas/server.ts')
        const result = ServerActivitySnapshotSchema.safeParse({
          type: 'activity_snapshot',
          sessionId: 'sess-1',
          schemaVersion: 1,
          entries: [],
        })
        assert.ok(result.success, 'empty entries is the valid no-activity state')
      })

      it('rejects a wrong type literal', async () => {
        const { ServerActivitySnapshotSchema } = await import('../src/schemas/server.ts')
        const result = ServerActivitySnapshotSchema.safeParse({
          type: 'activity', sessionId: 'sess-1', schemaVersion: 1, entries: [],
        })
        assert.ok(!result.success)
      })

      it('rejects a missing entries array', async () => {
        const { ServerActivitySnapshotSchema } = await import('../src/schemas/server.ts')
        const result = ServerActivitySnapshotSchema.safeParse({
          type: 'activity_snapshot', sessionId: 'sess-1', schemaVersion: 1,
        })
        assert.ok(!result.success, 'entries must never be omitted')
      })

      it('rejects a non-positive schemaVersion', async () => {
        const { ServerActivitySnapshotSchema } = await import('../src/schemas/server.ts')
        const result = ServerActivitySnapshotSchema.safeParse({
          type: 'activity_snapshot', sessionId: 'sess-1', schemaVersion: 0, entries: [],
        })
        assert.ok(!result.success, 'schemaVersion must be a positive int')
      })

      it('propagates entry-level refinements (terminal without endedAt)', async () => {
        const { ServerActivitySnapshotSchema } = await import('../src/schemas/server.ts')
        const result = ServerActivitySnapshotSchema.safeParse({
          type: 'activity_snapshot',
          sessionId: 'sess-1',
          schemaVersion: 1,
          entries: [{ ...runningEntry, status: 'done' }],
        })
        assert.ok(!result.success, 'invalid entry inside the array must reject the whole snapshot')
      })
    })

    describe('ServerActivityDeltaSchema', () => {
      it('validates a started delta', async () => {
        const { ServerActivityDeltaSchema } = await import('../src/schemas/server.ts')
        const result = ServerActivityDeltaSchema.safeParse({
          type: 'activity_delta', sessionId: 'sess-1', schemaVersion: 1, op: 'started', entry: runningEntry,
        })
        assert.ok(result.success, JSON.stringify(result.error?.issues))
        assert.equal(result.data.op, 'started')
      })

      it('validates an updated delta', async () => {
        const { ServerActivityDeltaSchema } = await import('../src/schemas/server.ts')
        const result = ServerActivityDeltaSchema.safeParse({
          type: 'activity_delta', sessionId: 'sess-1', schemaVersion: 1, op: 'updated',
          entry: { ...runningEntry, status: 'blocked' },
        })
        assert.ok(result.success, JSON.stringify(result.error?.issues))
      })

      it('validates an ended delta carrying a terminal entry', async () => {
        const { ServerActivityDeltaSchema } = await import('../src/schemas/server.ts')
        const result = ServerActivityDeltaSchema.safeParse({
          type: 'activity_delta', sessionId: 'sess-1', schemaVersion: 1, op: 'ended', entry: terminalEntry,
        })
        assert.ok(result.success, JSON.stringify(result.error?.issues))
      })

      it('rejects an ended delta whose entry is non-terminal', async () => {
        const { ServerActivityDeltaSchema } = await import('../src/schemas/server.ts')
        const result = ServerActivityDeltaSchema.safeParse({
          type: 'activity_delta', sessionId: 'sess-1', schemaVersion: 1, op: 'ended', entry: runningEntry,
        })
        assert.ok(!result.success, 'an ended op requires a done/failed entry')
      })

      it('rejects an unknown op', async () => {
        const { ServerActivityDeltaSchema } = await import('../src/schemas/server.ts')
        const result = ServerActivityDeltaSchema.safeParse({
          type: 'activity_delta', sessionId: 'sess-1', schemaVersion: 1, op: 'removed', entry: runningEntry,
        })
        assert.ok(!result.success, 'op must be started/updated/ended')
      })

      it('strips unknown top-level fields for forward compat', async () => {
        const { ServerActivityDeltaSchema } = await import('../src/schemas/server.ts')
        const result = ServerActivityDeltaSchema.safeParse({
          type: 'activity_delta', sessionId: 'sess-1', schemaVersion: 1, op: 'started',
          entry: runningEntry, futureField: 'x',
        })
        assert.ok(result.success)
        assert.equal(result.data.futureField, undefined)
      })
    })

    it('ACTIVITY_SCHEMA_VERSION is 1', async () => {
      const { ACTIVITY_SCHEMA_VERSION } = await import('../src/schemas/server.ts')
      assert.equal(ACTIVITY_SCHEMA_VERSION, 1)
    })
  })

  describe('Host/Repo Status Control Room (#5171)', () => {
    const cleanRepo = {
      name: 'chroxy',
      path: '/Users/dev/Projects/chroxy',
      branch: 'main',
      verdict: 'live',
      live: true,
      tree: { state: 'clean', untracked: 0, modified: 0, staged: 0 },
      worktrees: 2,
      ahead: 0,
      behind: 0,
      openPRs: 3,
      prChecks: { failing: 0, pending: 0, approved: 1, changesRequested: 0 },
      prsUrl: 'https://github.com/dev/chroxy/pulls',
      attribution: true,
      onboarding: 'fully onboarded',
      lastTouched: '2026-06-05T12:00:00.000Z',
    }

    const dirtyRepo = {
      name: 'old-experiment',
      path: '/Users/dev/Projects/old-experiment',
      branch: 'wip/spike',
      verdict: 'investigate',
      live: false,
      tree: { state: 'dirty', untracked: 4, modified: 2, staged: 1 },
      worktrees: 0,
      ahead: null,
      behind: null,
      openPRs: null,
      prChecks: null,
      prsUrl: null,
      attribution: null,
      onboarding: 'not onboarded',
      lastTouched: '2026-01-02T09:30:00.000Z',
      note: 'dirty tree, last touched 5 months ago',
    }

    describe('RepoVerdictSchema', () => {
      it('accepts every verdict', async () => {
        const { RepoVerdictSchema } = await import('../src/schemas/server.ts')
        for (const v of ['live', 'investigate', 'abandoned', 'recent', 'onboarded']) {
          assert.ok(RepoVerdictSchema.safeParse(v).success, `verdict ${v} should validate`)
        }
      })

      it('rejects an unknown verdict', async () => {
        const { RepoVerdictSchema } = await import('../src/schemas/server.ts')
        assert.ok(!RepoVerdictSchema.safeParse('archived').success, 'unknown verdict must reject')
      })
    })

    describe('RepoTreeSchema', () => {
      it('validates a clean tree', async () => {
        const { RepoTreeSchema } = await import('../src/schemas/server.ts')
        const result = RepoTreeSchema.safeParse({ state: 'clean', untracked: 0, modified: 0, staged: 0 })
        assert.ok(result.success, JSON.stringify(result.error?.issues))
      })

      it('validates a dirty tree with counts', async () => {
        const { RepoTreeSchema } = await import('../src/schemas/server.ts')
        const result = RepoTreeSchema.safeParse({ state: 'dirty', untracked: 4, modified: 2, staged: 1 })
        assert.ok(result.success, JSON.stringify(result.error?.issues))
      })

      it('rejects an unknown state', async () => {
        const { RepoTreeSchema } = await import('../src/schemas/server.ts')
        assert.ok(!RepoTreeSchema.safeParse({ state: 'conflicted', untracked: 0, modified: 0, staged: 0 }).success)
      })

      it('rejects negative counts', async () => {
        const { RepoTreeSchema } = await import('../src/schemas/server.ts')
        assert.ok(!RepoTreeSchema.safeParse({ state: 'dirty', untracked: -1, modified: 0, staged: 0 }).success)
      })

      it('rejects non-integer counts', async () => {
        const { RepoTreeSchema } = await import('../src/schemas/server.ts')
        assert.ok(!RepoTreeSchema.safeParse({ state: 'dirty', untracked: 1.5, modified: 0, staged: 0 }).success)
      })
    })

    describe('RepoStatusSchema', () => {
      it('validates a well-formed live repo', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        const result = RepoStatusSchema.safeParse(cleanRepo)
        assert.ok(result.success, JSON.stringify(result.error?.issues))
        assert.equal(result.data.verdict, 'live')
        assert.equal(result.data.note, undefined)
      })

      it('validates a repo with note and null openPRs/attribution', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        const result = RepoStatusSchema.safeParse(dirtyRepo)
        assert.ok(result.success, JSON.stringify(result.error?.issues))
        assert.equal(result.data.openPRs, null)
        assert.equal(result.data.attribution, null)
        assert.equal(result.data.note, 'dirty tree, last touched 5 months ago')
      })

      it('accepts openPRs as a non-negative integer or null', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        assert.ok(RepoStatusSchema.safeParse({ ...cleanRepo, openPRs: 0 }).success)
        assert.ok(RepoStatusSchema.safeParse({ ...cleanRepo, openPRs: null }).success)
      })

      it('rejects a negative openPRs', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        assert.ok(!RepoStatusSchema.safeParse({ ...cleanRepo, openPRs: -1 }).success)
      })

      it('#5216: accepts ahead/behind as a non-negative integer or null', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        assert.ok(RepoStatusSchema.safeParse({ ...cleanRepo, ahead: 5, behind: 2 }).success)
        assert.ok(RepoStatusSchema.safeParse({ ...cleanRepo, ahead: 0, behind: 0 }).success)
        assert.ok(RepoStatusSchema.safeParse({ ...cleanRepo, ahead: null, behind: null }).success)
      })

      it('#5216: rejects a negative or non-integer ahead/behind', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        assert.ok(!RepoStatusSchema.safeParse({ ...cleanRepo, ahead: -1 }).success)
        assert.ok(!RepoStatusSchema.safeParse({ ...cleanRepo, behind: 1.5 }).success)
      })

      it('#5216: requires ahead/behind to be present', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        const { ahead, behind, ...withoutAheadBehind } = cleanRepo
        void ahead; void behind
        assert.ok(!RepoStatusSchema.safeParse(withoutAheadBehind).success)
      })

      it('#5216: accepts prChecks as a counts object or null', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        assert.ok(RepoStatusSchema.safeParse({ ...cleanRepo, prChecks: { failing: 1, pending: 2, approved: 3, changesRequested: 0 } }).success)
        assert.ok(RepoStatusSchema.safeParse({ ...cleanRepo, prChecks: null }).success)
      })

      it('#5216: rejects a prChecks missing a count or with a negative count', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        assert.ok(!RepoStatusSchema.safeParse({ ...cleanRepo, prChecks: { failing: 1, pending: 0, approved: 0 } }).success)
        assert.ok(!RepoStatusSchema.safeParse({ ...cleanRepo, prChecks: { failing: -1, pending: 0, approved: 0, changesRequested: 0 } }).success)
      })

      it('#5216: requires prChecks to be present', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        const { prChecks, ...without } = cleanRepo
        void prChecks
        assert.ok(!RepoStatusSchema.safeParse(without).success)
      })

      it('#5216: accepts a GitHub pulls URL or null', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        assert.ok(RepoStatusSchema.safeParse({ ...cleanRepo, prsUrl: 'https://github.com/o/r/pulls' }).success)
        assert.ok(RepoStatusSchema.safeParse({ ...cleanRepo, prsUrl: null }).success)
      })

      it('#5216: rejects non-URL, non-GitHub, and dangerous-scheme prsUrl values', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        // prsUrl is rendered into an <a href>; it must be locked to the GitHub
        // pulls shape so a script URL can never slip through.
        for (const bad of [
          'not-a-url',
          'javascript:alert(1)',
          'https://github.com/o/r', // not the /pulls page
          'https://evil.com/o/r/pulls', // wrong host
          'http://github.com/o/r/pulls', // not https
          'https://github.com/o/r/pulls/extra',
        ]) {
          assert.ok(!RepoStatusSchema.safeParse({ ...cleanRepo, prsUrl: bad }).success, `should reject ${bad}`)
        }
      })

      it('#5216: requires prsUrl to be present', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        const { prsUrl, ...without } = cleanRepo
        void prsUrl
        assert.ok(!RepoStatusSchema.safeParse(without).success)
      })

      it('accepts attribution true / false / null', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        assert.ok(RepoStatusSchema.safeParse({ ...cleanRepo, attribution: true }).success)
        assert.ok(RepoStatusSchema.safeParse({ ...cleanRepo, attribution: false }).success)
        assert.ok(RepoStatusSchema.safeParse({ ...cleanRepo, attribution: null }).success)
      })

      it('rejects an unknown verdict', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        assert.ok(!RepoStatusSchema.safeParse({ ...cleanRepo, verdict: 'archived' }).success)
      })

      it('rejects a non-ISO lastTouched', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        assert.ok(!RepoStatusSchema.safeParse({ ...cleanRepo, lastTouched: 'yesterday' }).success)
      })

      it('rejects a non-boolean live', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        assert.ok(!RepoStatusSchema.safeParse({ ...cleanRepo, live: 'yes' }).success)
      })

      it('strips unknown fields for forward compat', async () => {
        const { RepoStatusSchema } = await import('../src/schemas/server.ts')
        const result = RepoStatusSchema.safeParse({ ...cleanRepo, futureField: 'x' })
        assert.ok(result.success)
        assert.equal(result.data.futureField, undefined)
      })
    })

    describe('ServerHostStatusSnapshotSchema', () => {
      const snapshot = {
        type: 'host_status_snapshot',
        generatedAt: '2026-06-05T12:00:00.000Z',
        root: '/Users/dev/Projects',
        summary: { live: 1, onboarded: 0, abandoned: 0, investigate: 1, recent: 0 },
        repos: [cleanRepo, dirtyRepo],
      }

      it('round-trips a full snapshot', async () => {
        const { ServerHostStatusSnapshotSchema } = await import('../src/schemas/server.ts')
        const result = ServerHostStatusSnapshotSchema.safeParse(snapshot)
        assert.ok(result.success, JSON.stringify(result.error?.issues))
        assert.equal(result.data.repos.length, 2)
        assert.equal(result.data.summary.investigate, 1)
      })

      it('accepts an empty repos array (no repos under root)', async () => {
        const { ServerHostStatusSnapshotSchema } = await import('../src/schemas/server.ts')
        const result = ServerHostStatusSnapshotSchema.safeParse({
          ...snapshot,
          repos: [],
          summary: { live: 0, onboarded: 0, abandoned: 0, investigate: 0, recent: 0 },
        })
        assert.ok(result.success, JSON.stringify(result.error?.issues))
      })

      it('rejects the wrong type literal', async () => {
        const { ServerHostStatusSnapshotSchema } = await import('../src/schemas/server.ts')
        assert.ok(!ServerHostStatusSnapshotSchema.safeParse({ ...snapshot, type: 'host_status' }).success)
      })

      it('rejects a non-ISO generatedAt', async () => {
        const { ServerHostStatusSnapshotSchema } = await import('../src/schemas/server.ts')
        assert.ok(!ServerHostStatusSnapshotSchema.safeParse({ ...snapshot, generatedAt: '2026' }).success)
      })

      it('rejects a missing summary bucket', async () => {
        const { ServerHostStatusSnapshotSchema } = await import('../src/schemas/server.ts')
        const result = ServerHostStatusSnapshotSchema.safeParse({
          ...snapshot,
          summary: { live: 1, onboarded: 0, abandoned: 0, investigate: 1 },
        })
        assert.ok(!result.success, 'summary must carry all five buckets')
      })

      it('rejects an invalid repo inside repos', async () => {
        const { ServerHostStatusSnapshotSchema } = await import('../src/schemas/server.ts')
        const result = ServerHostStatusSnapshotSchema.safeParse({
          ...snapshot,
          repos: [{ ...cleanRepo, verdict: 'archived' }],
        })
        assert.ok(!result.success, 'an invalid repo must fail the whole snapshot')
      })

      it('strips unknown top-level fields for forward compat', async () => {
        const { ServerHostStatusSnapshotSchema } = await import('../src/schemas/server.ts')
        const result = ServerHostStatusSnapshotSchema.safeParse({ ...snapshot, futureField: 'x' })
        assert.ok(result.success)
        assert.equal(result.data.futureField, undefined)
      })

      it('is re-exported from the schemas entry point', async () => {
        const mod = await import('../src/schemas/index.ts')
        assert.ok(mod.ServerHostStatusSnapshotSchema, 'snapshot schema should be exported')
        assert.ok(mod.RepoStatusSchema, 'RepoStatusSchema should be exported')
        assert.ok(mod.HostStatusRequestSchema, 'HostStatusRequestSchema should be exported')
      })
    })

    describe('HostStatusRequestSchema (client→server)', () => {
      it('validates a bare request', async () => {
        const { HostStatusRequestSchema } = await import('../src/schemas/client.ts')
        const result = HostStatusRequestSchema.safeParse({ type: 'host_status_request' })
        assert.ok(result.success, JSON.stringify(result.error?.issues))
      })

      it('validates a request with requestId', async () => {
        const { HostStatusRequestSchema } = await import('../src/schemas/client.ts')
        const result = HostStatusRequestSchema.safeParse({ type: 'host_status_request', requestId: 'abc' })
        assert.ok(result.success, JSON.stringify(result.error?.issues))
        assert.equal(result.data.requestId, 'abc')
      })

      it('rejects the wrong type literal', async () => {
        const { HostStatusRequestSchema } = await import('../src/schemas/client.ts')
        assert.ok(!HostStatusRequestSchema.safeParse({ type: 'host_status' }).success)
      })

      it('rejects an over-long requestId', async () => {
        const { HostStatusRequestSchema } = await import('../src/schemas/client.ts')
        assert.ok(!HostStatusRequestSchema.safeParse({ type: 'host_status_request', requestId: 'x'.repeat(129) }).success)
      })

      it('is accepted by the ClientMessageSchema union', async () => {
        const { ClientMessageSchema } = await import('../src/schemas/client.ts')
        const result = ClientMessageSchema.safeParse({ type: 'host_status_request', requestId: 'r1' })
        assert.ok(result.success, JSON.stringify(result.error?.issues))
        assert.equal(result.data.type, 'host_status_request')
      })
    })

    // #5253: self-hosted runner status contract.
    describe('runner status (#5253)', () => {
      const service = { manager: 'launchd', label: 'actions.runner.o-r.n', running: true, pid: 1778, lastExitCode: 0 }
      const runner = {
        name: 'medlens-mac-arm64',
        dir: '/Users/dev/github-runners/actions-runner-medlens',
        verdict: 'idle',
        service,
        githubStatus: 'online',
        busy: false,
        os: 'macOS',
        labels: ['self-hosted', 'macOS', 'ARM64'],
      }
      const repoRunners = {
        name: 'medlens',
        owner: 'blamechris',
        repo: 'medlens',
        githubUrl: 'https://github.com/blamechris/medlens',
        runnersUrl: 'https://github.com/blamechris/medlens/settings/actions/runners',
        runners: [runner],
      }
      const snapshot = {
        type: 'runner_status_snapshot',
        generatedAt: '2026-06-06T12:00:00.000Z',
        root: '/Users/dev/github-runners',
        summary: { total: 1, busy: 0, idle: 1, offline: 0, stopped: 0, unregistered: 0 },
        repos: [repoRunners],
      }

      it('accepts every runner verdict and rejects an unknown one', async () => {
        const { RunnerVerdictSchema } = await import('../src/schemas/server.ts')
        for (const v of ['busy', 'idle', 'offline', 'stopped', 'unregistered']) {
          assert.ok(RunnerVerdictSchema.safeParse(v).success, `should accept ${v}`)
        }
        assert.ok(!RunnerVerdictSchema.safeParse('dead').success)
      })

      it('RunnerServiceStateSchema accepts running and stopped shapes', async () => {
        const { RunnerServiceStateSchema } = await import('../src/schemas/server.ts')
        assert.ok(RunnerServiceStateSchema.safeParse(service).success)
        assert.ok(RunnerServiceStateSchema.safeParse({ manager: 'none', label: null, running: false, pid: null, lastExitCode: null }).success)
        // lastExitCode may be negative (signal-style) — only pid is non-negative.
        assert.ok(RunnerServiceStateSchema.safeParse({ ...service, running: false, pid: null, lastExitCode: -15 }).success)
        assert.ok(!RunnerServiceStateSchema.safeParse({ ...service, pid: -1 }).success)
        assert.ok(!RunnerServiceStateSchema.safeParse({ ...service, manager: 'upstart' }).success)
      })

      it('RunnerInfoSchema round-trips and enforces null vs value semantics', async () => {
        const { RunnerInfoSchema } = await import('../src/schemas/server.ts')
        assert.ok(RunnerInfoSchema.safeParse(runner).success)
        // GitHub view unavailable → null, not a guess.
        assert.ok(RunnerInfoSchema.safeParse({ ...runner, githubStatus: null, busy: null, os: null }).success)
        // labels must be an array, never null.
        assert.ok(!RunnerInfoSchema.safeParse({ ...runner, labels: null }).success)
        assert.ok(!RunnerInfoSchema.safeParse({ ...runner, githubStatus: 'busy' }).success)
      })

      it('RepoRunnersSchema constrains runnersUrl to the settings shape', async () => {
        const { RepoRunnersSchema } = await import('../src/schemas/server.ts')
        assert.ok(RepoRunnersSchema.safeParse(repoRunners).success)
        assert.ok(RepoRunnersSchema.safeParse({ ...repoRunners, runnersUrl: 'https://github.com/organizations/acme/settings/actions/runners', repo: null }).success)
        assert.ok(RepoRunnersSchema.safeParse({ ...repoRunners, runnersUrl: null }).success)
        for (const bad of [
          'javascript:alert(1)',
          'https://evil.com/o/r/settings/actions/runners',
          'https://github.com/o/r/pulls',
          'http://github.com/o/r/settings/actions/runners',
        ]) {
          assert.ok(!RepoRunnersSchema.safeParse({ ...repoRunners, runnersUrl: bad }).success, `should reject ${bad}`)
        }
      })

      it('ServerRunnerStatusSnapshotSchema round-trips a full snapshot', async () => {
        const { ServerRunnerStatusSnapshotSchema } = await import('../src/schemas/server.ts')
        const result = ServerRunnerStatusSnapshotSchema.safeParse(snapshot)
        assert.ok(result.success, JSON.stringify(result.error?.issues))
        assert.equal(result.data.repos[0].runners[0].name, 'medlens-mac-arm64')
        assert.equal(result.data.summary.idle, 1)
      })

      it('ServerRunnerStatusSnapshotSchema accepts an empty repos array', async () => {
        const { ServerRunnerStatusSnapshotSchema } = await import('../src/schemas/server.ts')
        assert.ok(ServerRunnerStatusSnapshotSchema.safeParse({
          ...snapshot,
          repos: [],
          summary: { total: 0, busy: 0, idle: 0, offline: 0, stopped: 0, unregistered: 0 },
        }).success)
      })

      it('ServerRunnerStatusSnapshotSchema rejects the wrong type + an invalid nested runner', async () => {
        const { ServerRunnerStatusSnapshotSchema } = await import('../src/schemas/server.ts')
        assert.ok(!ServerRunnerStatusSnapshotSchema.safeParse({ ...snapshot, type: 'runner_status' }).success)
        assert.ok(!ServerRunnerStatusSnapshotSchema.safeParse({
          ...snapshot,
          repos: [{ ...repoRunners, runners: [{ ...runner, verdict: 'dead' }] }],
        }).success)
      })

      it('RunnerStatusRequestSchema validates + is accepted by the client union', async () => {
        const { RunnerStatusRequestSchema, ClientMessageSchema } = await import('../src/schemas/client.ts')
        assert.ok(RunnerStatusRequestSchema.safeParse({ type: 'runner_status_request' }).success)
        assert.ok(RunnerStatusRequestSchema.safeParse({ type: 'runner_status_request', requestId: 'r1' }).success)
        assert.ok(!RunnerStatusRequestSchema.safeParse({ type: 'runner_status_request', requestId: 'x'.repeat(129) }).success)
        const u = ClientMessageSchema.safeParse({ type: 'runner_status_request', requestId: 'r2' })
        assert.ok(u.success, JSON.stringify(u.error?.issues))
        assert.equal(u.data.type, 'runner_status_request')
      })

      it('pins the runner contract at the package entry point', async () => {
        const mod = await import('../src/index.ts')
        // Types are erased at runtime; assert the runtime schemas are reachable
        // from the schemas entry point (the type re-exports are checked by tsc).
        const schemas = await import('../src/schemas/index.ts')
        assert.ok(schemas.ServerRunnerStatusSnapshotSchema)
        assert.ok(schemas.RunnerStatusRequestSchema)
        assert.ok(mod.ClientMessageSchema)
      })
    })

    // #5499 (epic #5498): Integrations tab — repo-memory observability contract.
    describe('integration status (#5499)', () => {
      const report = {
        totalEvents: 120,
        cacheHits: 90,
        cacheMisses: 30,
        cacheHitRatio: 0.75,
        estimatedTokensSaved: 48211,
        cacheEntryCount: 1391,
        staleEntryCount: 2,
        lastActivity: null,
      }
      const repoMemory = {
        configured: true,
        summarizer: 'ast',
        toolGroups: ['telemetry'],
        cache: { present: true, sizeBytes: 2310144, lastModified: '2026-06-09T22:00:00.000Z' },
        report,
        reason: null,
      }
      const snapshot = {
        type: 'integration_status_snapshot',
        generatedAt: '2026-06-10T12:00:00.000Z',
        root: '/Users/dev/Projects',
        summary: { total: 2, configured: 1, notConfigured: 1, degraded: 0 },
        repos: [
          { name: 'chroxy', path: '/Users/dev/Projects/chroxy', repoMemory },
          {
            name: 'scratch',
            path: '/Users/dev/Projects/scratch',
            repoMemory: { configured: false, summarizer: null, toolGroups: [], cache: null, report: null, reason: null },
          },
        ],
        repoMemoryCli: { found: true, path: '/usr/local/bin/repo-memory', note: null },
      }

      it('ServerIntegrationStatusSnapshotSchema round-trips a full snapshot', async () => {
        const { ServerIntegrationStatusSnapshotSchema } = await import('../src/schemas/server.ts')
        const result = ServerIntegrationStatusSnapshotSchema.safeParse(snapshot)
        assert.ok(result.success, JSON.stringify(result.error?.issues))
        assert.equal(result.data.repos[0].repoMemory.report.cacheHitRatio, 0.75)
        assert.equal(result.data.summary.configured, 1)
      })

      it('accepts a degraded configured repo (report null + reason) and a missing-CLI note', async () => {
        const { ServerIntegrationStatusSnapshotSchema } = await import('../src/schemas/server.ts')
        const degraded = {
          ...snapshot,
          summary: { total: 1, configured: 1, notConfigured: 0, degraded: 1 },
          repos: [{
            name: 'chroxy',
            path: '/p/chroxy',
            repoMemory: { ...repoMemory, report: null, reason: 'repo-memory CLI not found on PATH' },
          }],
          repoMemoryCli: { found: false, path: null, note: 'repo-memory CLI not found on PATH' },
        }
        assert.ok(ServerIntegrationStatusSnapshotSchema.safeParse(degraded).success)
      })

      it('tolerates a missing diagnostics block (nullable entry counts) and a lastActivity timestamp', async () => {
        const { RepoMemoryReportSchema } = await import('../src/schemas/server.ts')
        assert.ok(RepoMemoryReportSchema.safeParse({ ...report, cacheEntryCount: null, staleEntryCount: null }).success)
        assert.ok(RepoMemoryReportSchema.safeParse({ ...report, lastActivity: '2026-06-09T22:00:00.000Z' }).success)
        assert.ok(!RepoMemoryReportSchema.safeParse({ ...report, cacheHitRatio: 1.5 }).success)
        assert.ok(!RepoMemoryReportSchema.safeParse({ ...report, totalEvents: -1 }).success)
      })

      it('defaults topMissedQueries to [] when absent and validates entries (#5681)', async () => {
        const { RepoMemoryReportSchema } = await import('../src/schemas/server.ts')
        // Absent (pre-0.17.0 CLI) → defaults to [].
        const absent = RepoMemoryReportSchema.safeParse({ ...report })
        assert.ok(absent.success)
        assert.deepEqual(absent.data.topMissedQueries, [])
        // Well-formed entries pass through.
        const present = RepoMemoryReportSchema.safeParse({
          ...report,
          topMissedQueries: [{ query: 'websocket reconnect', count: 3 }],
        })
        assert.ok(present.success)
        assert.equal(present.data.topMissedQueries[0].query, 'websocket reconnect')
        // Malformed entries are rejected by the schema (count must be a non-negative int, query a string).
        assert.ok(!RepoMemoryReportSchema.safeParse({ ...report, topMissedQueries: [{ query: 'x', count: -1 }] }).success)
        assert.ok(!RepoMemoryReportSchema.safeParse({ ...report, topMissedQueries: [{ count: 1 }] }).success)
      })

      it('accepts an error snapshot without repoMemoryCli (shared error envelope)', async () => {
        const { ServerIntegrationStatusSnapshotSchema } = await import('../src/schemas/server.ts')
        assert.ok(ServerIntegrationStatusSnapshotSchema.safeParse({
          type: 'integration_status_snapshot',
          requestId: 'r1',
          generatedAt: '2026-06-10T12:00:00.000Z',
          root: '/Users/dev/Projects',
          summary: { total: 0, configured: 0, notConfigured: 0, degraded: 0 },
          repos: [],
          error: { code: 'FORBIDDEN', message: 'nope' },
        }).success)
      })

      it('rejects the wrong type and an invalid nested repoMemory block', async () => {
        const { ServerIntegrationStatusSnapshotSchema } = await import('../src/schemas/server.ts')
        assert.ok(!ServerIntegrationStatusSnapshotSchema.safeParse({ ...snapshot, type: 'integration_status' }).success)
        assert.ok(!ServerIntegrationStatusSnapshotSchema.safeParse({
          ...snapshot,
          repos: [{ name: 'x', path: '/x', repoMemory: { ...repoMemory, toolGroups: null } }],
        }).success)
      })

      it('IntegrationStatusRequestSchema validates + is accepted by the client union', async () => {
        const { IntegrationStatusRequestSchema, ClientMessageSchema } = await import('../src/schemas/client.ts')
        assert.ok(IntegrationStatusRequestSchema.safeParse({ type: 'integration_status_request' }).success)
        assert.ok(IntegrationStatusRequestSchema.safeParse({ type: 'integration_status_request', requestId: 'i1' }).success)
        assert.ok(!IntegrationStatusRequestSchema.safeParse({ type: 'integration_status_request', requestId: 'x'.repeat(129) }).success)
        const u = ClientMessageSchema.safeParse({ type: 'integration_status_request', requestId: 'i2' })
        assert.ok(u.success, JSON.stringify(u.error?.issues))
        assert.equal(u.data.type, 'integration_status_request')
      })

      it('pins the integrations contract at the package entry point', async () => {
        const mod = await import('../src/index.ts')
        const schemas = await import('../src/schemas/index.ts')
        assert.ok(schemas.ServerIntegrationStatusSnapshotSchema)
        assert.ok(schemas.IntegrationStatusRequestSchema)
        assert.ok(mod.ClientMessageSchema)
      })
    })

    describe('integration action (#5500)', () => {
      const counts = { scanned: 412, summarized: 12, fresh: 398, skipped: 2 }
      const ack = {
        type: 'integration_action_ack',
        action: 'repo_memory_reindex',
        repoPath: '/Users/dev/Projects/chroxy',
        requestId: 'reindex-1',
        counts,
      }

      it('IntegrationActionSchema validates + is accepted by the client union', async () => {
        const { IntegrationActionSchema, ClientMessageSchema } = await import('../src/schemas/client.ts')
        assert.ok(IntegrationActionSchema.safeParse({
          type: 'integration_action',
          action: 'repo_memory_reindex',
          repoPath: '/p/chroxy',
        }).success)
        assert.ok(IntegrationActionSchema.safeParse({
          type: 'integration_action',
          action: 'repo_memory_reindex',
          repoPath: '/p/chroxy',
          requestId: 'r1',
        }).success)
        const u = ClientMessageSchema.safeParse({
          type: 'integration_action',
          action: 'repo_memory_reindex',
          repoPath: '/p/chroxy',
          requestId: 'r2',
        })
        assert.ok(u.success, JSON.stringify(u.error?.issues))
        assert.equal(u.data.type, 'integration_action')
      })

      it('rejects an unknown action, a missing/empty repoPath, and an oversized requestId', async () => {
        const { IntegrationActionSchema } = await import('../src/schemas/client.ts')
        assert.ok(!IntegrationActionSchema.safeParse({
          type: 'integration_action',
          action: 'rm_rf_slash',
          repoPath: '/p/chroxy',
        }).success, 'action is a closed enum — unknown actions must not validate')
        assert.ok(!IntegrationActionSchema.safeParse({ type: 'integration_action', action: 'repo_memory_reindex' }).success)
        assert.ok(!IntegrationActionSchema.safeParse({
          type: 'integration_action',
          action: 'repo_memory_reindex',
          repoPath: '',
        }).success)
        assert.ok(!IntegrationActionSchema.safeParse({
          type: 'integration_action',
          action: 'repo_memory_reindex',
          repoPath: '/p/chroxy',
          requestId: 'x'.repeat(129),
        }).success)
      })

      it('ServerIntegrationActionAckSchema round-trips an ack with counts', async () => {
        const { ServerIntegrationActionAckSchema } = await import('../src/schemas/server.ts')
        const result = ServerIntegrationActionAckSchema.safeParse(ack)
        assert.ok(result.success, JSON.stringify(result.error?.issues))
        assert.equal(result.data.counts.summarized, 12)
        assert.equal(result.data.requestId, 'reindex-1')
      })

      it('accepts a null-counts ack (unparseable index output) and a null/absent requestId', async () => {
        const { ServerIntegrationActionAckSchema } = await import('../src/schemas/server.ts')
        assert.ok(ServerIntegrationActionAckSchema.safeParse({ ...ack, counts: null }).success)
        assert.ok(ServerIntegrationActionAckSchema.safeParse({ ...ack, requestId: null }).success)
        const { requestId, ...noRequestId } = ack
        assert.ok(ServerIntegrationActionAckSchema.safeParse(noRequestId).success)
      })

      it('rejects negative / non-integer / missing count fields', async () => {
        const { ServerIntegrationActionAckSchema, IntegrationActionCountsSchema } = await import('../src/schemas/server.ts')
        assert.ok(!IntegrationActionCountsSchema.safeParse({ ...counts, scanned: -1 }).success)
        assert.ok(!IntegrationActionCountsSchema.safeParse({ ...counts, fresh: 1.5 }).success)
        const { skipped, ...partial } = counts
        assert.ok(!ServerIntegrationActionAckSchema.safeParse({ ...ack, counts: partial }).success)
        assert.ok(!ServerIntegrationActionAckSchema.safeParse({ ...ack, type: 'integration_action' }).success)
      })

      it('pins the integration-action contract at the package entry point', async () => {
        const schemas = await import('../src/schemas/index.ts')
        assert.ok(schemas.IntegrationActionSchema)
        assert.ok(schemas.ServerIntegrationActionAckSchema)
        assert.ok(schemas.IntegrationActionCountsSchema)
      })
    })

    describe('repo-relay rerun action (#5502)', () => {
      it('IntegrationActionSchema accepts repo_relay_rerun with a runId + the client union takes it', async () => {
        const { IntegrationActionSchema, ClientMessageSchema } = await import('../src/schemas/client.ts')
        assert.ok(IntegrationActionSchema.safeParse({
          type: 'integration_action',
          action: 'repo_relay_rerun',
          repoPath: '/p/chroxy',
          runId: 16523339621,
          requestId: 'rr-1',
        }).success)
        const u = ClientMessageSchema.safeParse({
          type: 'integration_action',
          action: 'repo_relay_rerun',
          repoPath: '/p/chroxy',
          runId: 16523339621,
        })
        assert.ok(u.success, JSON.stringify(u.error?.issues))
        assert.equal(u.data.type, 'integration_action')
      })

      it('runId stays optional at the schema layer (shared envelope — required-for-rerun is server-side)', async () => {
        const { IntegrationActionSchema } = await import('../src/schemas/client.ts')
        assert.ok(IntegrationActionSchema.safeParse({
          type: 'integration_action',
          action: 'repo_relay_rerun',
          repoPath: '/p/chroxy',
        }).success, 'absence is a server-side rejection, not a wire-schema one')
        assert.ok(IntegrationActionSchema.safeParse({
          type: 'integration_action',
          action: 'repo_memory_reindex',
          repoPath: '/p/chroxy',
        }).success, 'reindex keeps working without a runId')
      })

      it('rejects a negative / non-integer / non-numeric runId', async () => {
        const { IntegrationActionSchema } = await import('../src/schemas/client.ts')
        const base = { type: 'integration_action', action: 'repo_relay_rerun', repoPath: '/p/chroxy' }
        assert.ok(!IntegrationActionSchema.safeParse({ ...base, runId: -1 }).success)
        assert.ok(!IntegrationActionSchema.safeParse({ ...base, runId: 1.5 }).success)
        assert.ok(!IntegrationActionSchema.safeParse({ ...base, runId: '9001' }).success)
        assert.ok(!IntegrationActionSchema.safeParse({ ...base, runId: Infinity }).success)
      })

      it('ServerIntegrationActionAckSchema round-trips a rerun ack (runId echoed, counts null)', async () => {
        const { ServerIntegrationActionAckSchema } = await import('../src/schemas/server.ts')
        const result = ServerIntegrationActionAckSchema.safeParse({
          type: 'integration_action_ack',
          action: 'repo_relay_rerun',
          repoPath: '/p/chroxy',
          requestId: 'rr-1',
          runId: 16523339621,
          counts: null,
        })
        assert.ok(result.success, JSON.stringify(result.error?.issues))
        assert.equal(result.data.runId, 16523339621)
        assert.equal(result.data.counts, null)
      })

      it('a reindex ack without runId still validates (runId is additive)', async () => {
        const { ServerIntegrationActionAckSchema } = await import('../src/schemas/server.ts')
        assert.ok(ServerIntegrationActionAckSchema.safeParse({
          type: 'integration_action_ack',
          action: 'repo_memory_reindex',
          repoPath: '/p/chroxy',
          counts: null,
        }).success)
      })
    })

    // #5515 (epic #5514): latency instrumentation — optional, additive
    // `serverTs` (wall-clock ms epoch, stamped at broadcast) on the stream
    // messages and the pong reply so clients can measure token-to-render and
    // split RTT into uplink/downlink.
    describe('serverTs latency instrumentation (#5515)', () => {
      it('ServerStreamDeltaSchema accepts an optional serverTs', async () => {
        const { ServerStreamDeltaSchema } = await import('../src/schemas/server.ts')
        const result = ServerStreamDeltaSchema.safeParse({
          type: 'stream_delta',
          messageId: 'm1',
          delta: 'hi',
          serverTs: 1_700_000_000_000,
        })
        assert.ok(result.success, JSON.stringify(result.error?.issues))
        assert.equal(result.data.serverTs, 1_700_000_000_000)
      })

      it('ServerStreamDeltaSchema still validates without serverTs (additive)', async () => {
        const { ServerStreamDeltaSchema } = await import('../src/schemas/server.ts')
        assert.ok(ServerStreamDeltaSchema.safeParse({
          type: 'stream_delta',
          messageId: 'm1',
          delta: 'hi',
        }).success)
      })

      it('ServerStreamStartSchema / ServerStreamEndSchema accept serverTs', async () => {
        const { ServerStreamStartSchema, ServerStreamEndSchema } = await import('../src/schemas/server.ts')
        assert.ok(ServerStreamStartSchema.safeParse({
          type: 'stream_start',
          messageId: 'm1',
          serverTs: 1_700_000_000_000,
        }).success)
        assert.ok(ServerStreamEndSchema.safeParse({
          type: 'stream_end',
          messageId: 'm1',
          serverTs: 1_700_000_000_000,
        }).success)
        // Additive: both still validate without it.
        assert.ok(ServerStreamStartSchema.safeParse({ type: 'stream_start', messageId: 'm1' }).success)
        assert.ok(ServerStreamEndSchema.safeParse({ type: 'stream_end', messageId: 'm1' }).success)
      })

      it('ServerPongSchema accepts an optional serverTs and still validates without it', async () => {
        const { ServerPongSchema } = await import('../src/schemas/server.ts')
        assert.ok(ServerPongSchema.safeParse({ type: 'pong', serverTs: 1_700_000_000_000 }).success)
        assert.ok(ServerPongSchema.safeParse({ type: 'pong' }).success)
      })

      it('rejects a non-numeric serverTs on stream_delta', async () => {
        const { ServerStreamDeltaSchema } = await import('../src/schemas/server.ts')
        assert.ok(!ServerStreamDeltaSchema.safeParse({
          type: 'stream_delta',
          messageId: 'm1',
          delta: 'hi',
          serverTs: 'nope',
        }).success)
      })
    })
  })

  describe('ServerAvailableModelsSchema provider tag (#6370)', () => {
    it('accepts a roster tagged with a provider string', async () => {
      const { ServerAvailableModelsSchema } = await import('../src/schemas/server/stream.ts')
      const r = ServerAvailableModelsSchema.safeParse({
        type: 'available_models',
        models: [{ id: 'sonnet' }],
        defaultModel: 'sonnet',
        provider: 'claude-sdk',
      })
      assert.ok(r.success)
      assert.equal(r.data.provider, 'claude-sdk', 'provider is preserved on parse, not stripped')
    })

    it('accepts an explicit provider: null (the default/unscoped roster — ws-history.js:859)', async () => {
      const { ServerAvailableModelsSchema } = await import('../src/schemas/server/stream.ts')
      const r = ServerAvailableModelsSchema.safeParse({ type: 'available_models', models: [], provider: null })
      assert.ok(r.success)
      assert.equal(r.data.provider, null)
    })

    it('accepts an omitted provider (backward compatible)', async () => {
      const { ServerAvailableModelsSchema } = await import('../src/schemas/server/stream.ts')
      const r = ServerAvailableModelsSchema.safeParse({ type: 'available_models', models: [], defaultModel: 'opus' })
      assert.ok(r.success)
      assert.equal(r.data.provider, undefined)
    })

    it('rejects a non-string provider', async () => {
      const { ServerAvailableModelsSchema } = await import('../src/schemas/server/stream.ts')
      assert.ok(!ServerAvailableModelsSchema.safeParse({ type: 'available_models', provider: 42 }).success)
    })
  })

  describe('#5966 — repo-events Control Room survey', () => {
    it('RepoEventSchema round-trips a pull_request event from normalizeGithubEvent', async () => {
      const { RepoEventSchema } = await import('../src/schemas/server/control-room/repo-events.ts')
      const r = RepoEventSchema.safeParse({
        kind: 'pull_request',
        repo: 'blamechris/chroxy',
        actor: 'blamechris',
        at: '2026-07-02T12:00:00.000Z',
        action: 'opened',
        number: 42,
        title: 'feat: repo-events pane',
        url: 'https://github.com/blamechris/chroxy/pull/42',
        summary: 'opened PR #42',
      })
      assert.ok(r.success)
      assert.equal(r.data.kind, 'pull_request')
      assert.equal(r.data.number, 42)
    })

    it('RepoEventSchema accepts a push event (branch present, action/number absent)', async () => {
      const { RepoEventSchema } = await import('../src/schemas/server/control-room/repo-events.ts')
      const r = RepoEventSchema.safeParse({
        kind: 'push', repo: 'blamechris/chroxy', actor: 'blamechris',
        at: '2026-07-02T12:00:00.000Z', branch: 'main', title: 'fix things',
        url: 'https://github.com/blamechris/chroxy/commit/abc', summary: 'pushed 3 commits to main',
      })
      assert.ok(r.success)
      assert.equal(r.data.branch, 'main')
    })

    it('RepoEventSchema accepts a ping (nullable repo/actor, url null)', async () => {
      const { RepoEventSchema } = await import('../src/schemas/server/control-room/repo-events.ts')
      const r = RepoEventSchema.safeParse({
        kind: 'ping', repo: null, actor: null, at: '2026-07-02T12:00:00.000Z',
        title: 'Keep it logically awesome.', url: null, summary: 'webhook configured (ping)',
      })
      assert.ok(r.success)
      assert.equal(r.data.repo, null)
    })

    it('RepoEventSchema rejects an unsurfaced kind', async () => {
      const { RepoEventSchema } = await import('../src/schemas/server/control-room/repo-events.ts')
      assert.ok(!RepoEventSchema.safeParse({
        kind: 'release', repo: 'x/y', actor: 'a', at: '2026-07-02T12:00:00.000Z', summary: 'released',
      }).success, 'only push/pull_request/issues/ping are surfaced')
    })

    it('ServerRepoEventsSnapshotSchema round-trips an empty snapshot (nothing buffered yet)', async () => {
      const { ServerRepoEventsSnapshotSchema } = await import('../src/schemas/server/control-room/repo-events.ts')
      const r = ServerRepoEventsSnapshotSchema.safeParse({
        type: 'repo_events_snapshot', generatedAt: '2026-07-02T12:00:00.000Z', events: [],
      })
      assert.ok(r.success)
      assert.deepEqual(r.data.events, [])
    })

    it('ServerRepoEventsSnapshotSchema carries the additive degraded error (FORBIDDEN refusal)', async () => {
      const { ServerRepoEventsSnapshotSchema } = await import('../src/schemas/server/control-room/repo-events.ts')
      const r = ServerRepoEventsSnapshotSchema.safeParse({
        type: 'repo_events_snapshot', requestId: 'req-1', generatedAt: '2026-07-02T12:00:00.000Z',
        events: [], error: { code: 'FORBIDDEN', message: 'session-bound token cannot survey the host' },
      })
      assert.ok(r.success)
      assert.equal(r.data.error.code, 'FORBIDDEN')
    })

    it('ClientMessageSchema accepts repo_events_request (union membership)', async () => {
      const { ClientMessageSchema } = await import('../src/schemas/client.ts')
      assert.ok(ClientMessageSchema.safeParse({ type: 'repo_events_request' }).success)
      assert.ok(ClientMessageSchema.safeParse({ type: 'repo_events_request', requestId: 'r1' }).success)
    })

    it('ServerRepoEventsDeltaSchema round-trips a single live event (#6536)', async () => {
      const { ServerRepoEventsDeltaSchema } = await import('../src/schemas/server/control-room/repo-events.ts')
      const r = ServerRepoEventsDeltaSchema.safeParse({
        type: 'repo_events_delta',
        generatedAt: '2026-07-03T12:00:00.000Z',
        event: {
          kind: 'pull_request', repo: 'blamechris/chroxy', actor: 'blamechris', at: '2026-07-03T12:00:00.000Z',
          action: 'opened', number: 43, title: 'live', url: 'https://github.com/blamechris/chroxy/pull/43', summary: 'opened PR #43',
        },
      })
      assert.ok(r.success)
      assert.equal(r.data.event.number, 43)
    })

    it('ServerRepoEventsDeltaSchema rejects a missing/invalid event', async () => {
      const { ServerRepoEventsDeltaSchema } = await import('../src/schemas/server/control-room/repo-events.ts')
      assert.ok(!ServerRepoEventsDeltaSchema.safeParse({ type: 'repo_events_delta', generatedAt: '2026-07-03T12:00:00.000Z' }).success)
      assert.ok(!ServerRepoEventsDeltaSchema.safeParse({
        type: 'repo_events_delta', generatedAt: '2026-07-03T12:00:00.000Z', event: { kind: 'nope', summary: 'x', at: '2026-07-03T12:00:00.000Z', repo: null, actor: null },
      }).success)
    })
  })

  describe('#6543 — get_permission_input / permission_input', () => {
    it('ClientMessageSchema accepts get_permission_input (union membership)', async () => {
      const { ClientMessageSchema } = await import('../src/schemas/client.ts')
      assert.ok(ClientMessageSchema.safeParse({ type: 'get_permission_input', requestId: 'r1' }).success)
      assert.ok(!ClientMessageSchema.safeParse({ type: 'get_permission_input' }).success, 'requestId required')
    })

    it('ServerPermissionInputSchema round-trips a found reply + a not-found reply', async () => {
      const { ServerPermissionInputSchema } = await import('../src/schemas/server/stream.ts')
      const found = ServerPermissionInputSchema.safeParse({
        type: 'permission_input', requestId: 'r1', found: true, tool: 'Write',
        input: { file_path: '/x', content: 'a\nb' },
      })
      assert.ok(found.success)
      assert.equal(found.data.tool, 'Write')
      const missing = ServerPermissionInputSchema.safeParse({
        type: 'permission_input', requestId: 'r1', found: false, error: { code: 'NOT_PENDING', message: 'gone' },
      })
      assert.ok(missing.success)
      assert.equal(missing.data.input, undefined)
    })
  })
})
