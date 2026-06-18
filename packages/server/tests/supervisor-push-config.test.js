/**
 * Supervisor per-send PushManager config plumbing (#5430).
 *
 * `Supervisor._sendPushNotification` constructs a fresh PushManager per send
 * (by design — the supervisor must re-read tokens the child wrote to disk).
 * After #5413 Phase 2 that manager fans out to sinks, and DiscordWebhookSink
 * reads its cosmetic knobs (botName, colors, throttle/heartbeat intervals)
 * from its constructor opts. The supervisor used to pass only `{ storagePath }`,
 * so a supervisor-emitted notification ("Chroxy server is down") rendered the
 * Discord status embed with default identity/colors while the child server's
 * sink honoured the operator's `notifications.discord` block.
 *
 * These tests assert the supervisor mirrors server-cli.js:
 *   { storagePath, discord: { statePath, ...config.notifications?.discord } }
 *
 * Mock strategy: mock.module('../src/push.js') BEFORE importing supervisor.js
 * so the per-send `new PushManager(...)` call lands on a fake that captures
 * constructor opts — this exercises the REAL _sendPushNotification (the main
 * supervisor.test.js suite overrides that method entirely).
 */
import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import { homedir } from 'os'

// ── Guard: skip silently if mock.module is not available ──────────────────
// mock.module requires --experimental-test-module-mocks. The test runner
// command passes this flag; if for any reason the tests are run without it,
// we emit a single skip rather than hard-failing the suite.
if (typeof mock.module !== 'function') {
  describe('Supervisor per-send PushManager config (#5430)', () => {
    it('skipped — mock.module requires --experimental-test-module-mocks', (t) => {
      t.skip('re-run with --experimental-test-module-mocks to exercise these tests')
    })
  })
} else {
  // Captured per-construction records: { opts, sendCalls, destroyed }
  const constructions = []
  let sendShouldThrow = false

  class FakePushManager {
    constructor(opts = {}) {
      this._record = { opts, sendCalls: [], destroyed: false }
      constructions.push(this._record)
    }

    async send(category, title, body) {
      this._record.sendCalls.push({ category, title, body })
      if (sendShouldThrow) throw new Error('simulated send failure')
    }

    destroy() {
      this._record.destroyed = true
    }
  }

  // supervisor.js imports `{ PushManager } from './push.js'` — resolve the
  // same module URL from here so the mock intercepts that import.
  mock.module(new URL('../src/push.js', import.meta.url).href, {
    namedExports: { PushManager: FakePushManager },
  })

  const { Supervisor } = await import('../src/supervisor.js')

  describe('Supervisor per-send PushManager config (#5430)', () => {
    beforeEach(() => {
      constructions.length = 0
      sendShouldThrow = false
    })

    it('passes notifications.discord config knobs through to the per-send PushManager', async () => {
      const supervisor = new Supervisor({
        apiToken: 'test-token-123',
        pushStoragePath: '/tmp/chroxy-test-push-tokens.json',
        notifications: {
          discord: {
            botName: 'Custom Bot',
            updateThrottleMs: 1234,
            heartbeatIntervalMs: 60000,
            colors: { chroxy: 3447003 },
          },
        },
      })

      await supervisor._sendPushNotification('activity_error', 'Chroxy server is down', 'body')

      assert.equal(constructions.length, 1, 'expected exactly one per-send PushManager')
      const { opts, sendCalls, destroyed } = constructions[0]

      assert.equal(opts.storagePath, '/tmp/chroxy-test-push-tokens.json')

      // The operator's notifications.discord block must reach the sink opts —
      // this is the #5430 bug: previously only { storagePath } was passed.
      assert.equal(opts.discord?.botName, 'Custom Bot')
      assert.equal(opts.discord?.updateThrottleMs, 1234)
      assert.equal(opts.discord?.heartbeatIntervalMs, 60000)
      assert.deepEqual(opts.discord?.colors, { chroxy: 3447003 })

      // statePath must match the child server's default so message-id
      // convergence keeps working (both processes edit the same embed).
      assert.equal(opts.discord?.statePath, join(homedir(), '.chroxy', 'discord-webhook-state.json'))

      // prefsPath must mirror server-cli.js too — otherwise the per-send
      // manager runs with default prefs and supervisor notifications ignore
      // the operator's category mutes / quiet hours (both sinks gate on prefs).
      assert.equal(opts.prefsPath, join(homedir(), '.chroxy', 'notification-prefs.json'))

      assert.deepEqual(sendCalls, [
        { category: 'activity_error', title: 'Chroxy server is down', body: 'body' },
      ])
      assert.equal(destroyed, true, 'per-send manager must be destroyed (#5413 interval leak)')
    })

    it('config statePath override wins over the default (spread order mirrors server-cli.js)', async () => {
      const supervisor = new Supervisor({
        apiToken: 'test-token-123',
        pushStoragePath: '/tmp/chroxy-test-push-tokens.json',
        notifications: {
          discord: { statePath: '/tmp/custom-discord-state.json' },
        },
      })

      await supervisor._sendPushNotification('activity_error', 'title', 'body')

      assert.equal(constructions.length, 1)
      assert.equal(constructions[0].opts.discord?.statePath, '/tmp/custom-discord-state.json')
    })

    it('without a notifications block the discord sink still gets the default statePath', async () => {
      const supervisor = new Supervisor({
        apiToken: 'test-token-123',
        pushStoragePath: '/tmp/chroxy-test-push-tokens.json',
      })

      await supervisor._sendPushNotification('activity_restarted', 'Chroxy restarted', 'body')

      assert.equal(constructions.length, 1)
      const { opts } = constructions[0]
      assert.equal(opts.discord?.statePath, join(homedir(), '.chroxy', 'discord-webhook-state.json'))
    })

    it('destroys the per-send PushManager even when send() rejects', async () => {
      sendShouldThrow = true
      const supervisor = new Supervisor({
        apiToken: 'test-token-123',
        pushStoragePath: '/tmp/chroxy-test-push-tokens.json',
        notifications: { discord: { botName: 'Custom Bot' } },
      })

      await assert.rejects(
        () => supervisor._sendPushNotification('activity_error', 'title', 'body'),
        /simulated send failure/,
      )
      assert.equal(constructions.length, 1)
      assert.equal(constructions[0].destroyed, true)
    })
  })
}
