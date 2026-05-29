// Shared helpers for asserting SessionManager's "forward only when set"
// providerOpts pattern (#4511).
//
// SessionManager's createSession() block (session-manager.js:581-666) has a
// dozen-plus knobs that follow an identical contract: when the config field is
// set to a meaningful value (positive number, non-empty string, populated
// array, etc.) the value is forwarded verbatim as providerOpts[<key>]; when
// it's null/unset the key is OMITTED from providerOpts (key absent — not set
// to null/undefined) so each provider's BaseSession-level default applies.
//
// PR #4506 introduced inline versions of `CapturingProvider`,
// `captureProviderOpts`, and `assertForwardingPattern` inside
// session-manager.test.js for the four operator-tunable timeout knobs
// (resultTimeoutMs / hardTimeoutMs / streamStallTimeoutMs /
// mcpToolCallTimeoutMs). Extracting them here lets future per-knob coverage be
// one-liners and ensures all callers share the same provider class — important
// because providerRegistration is process-global so re-defining a class under
// the same name would leak state between test files.
//
// Usage:
//
//   import {
//     ensureCapturingProvider,
//     captureProviderOpts,
//     assertForwardingPattern,
//   } from './helpers/provider-forwarding.js'
//
//   await assertForwardingPattern({
//     SessionManager,
//     tmpStateFile,
//     configKey: 'resultTimeoutMs',
//     providerOptsKey: 'resultTimeoutMs',
//     setValue: 90_000,
//   })

import assert from 'node:assert/strict'
import { EventEmitter } from 'events'

// Module-level buffer of providerOpts snapshots, one entry per
// CapturingProvider instantiation. Reset between calls by
// `captureProviderOpts` so callers reading `captured[0]` always see the most
// recent invocation.
const captured = []

// Bare-bones provider class that records the providerOpts handed to its
// constructor. Mirrors the FailingProvider / TestProvider shapes used
// elsewhere in the suite so providers.js's `validateProviderClass` contract
// is satisfied (capabilities getter, start/destroy/interrupt/sendMessage,
// setModel/setPermissionMode, isRunning + resumeSessionId fields).
export class CapturingProvider extends EventEmitter {
  constructor(opts) {
    super()
    captured.push(opts)
    this.cwd = opts.cwd
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.isRunning = false
    this.resumeSessionId = null
  }
  static get capabilities() { return {} }
  start() {}
  destroy() {}
  interrupt() {}
  sendMessage() {}
  setModel() {}
  setPermissionMode() {}
}

// providers.js's registry is process-global, so the FIRST test file to import
// this helper registers the provider class and all subsequent imports become
// no-ops. Tracked with a module-level flag rather than try/catch because the
// registry throws on duplicate registration.
let providerRegistered = false
export async function ensureCapturingProvider() {
  if (providerRegistered) return
  const { registerProvider } = await import('../../src/providers.js')
  registerProvider('test-timeout-capture', CapturingProvider)
  providerRegistered = true
}

/**
 * Build a SessionManager with `configKey` set to `configValue`, drive
 * createSession() through the capturing provider, and return the captured
 * providerOpts so the caller can assert on a single key.
 *
 * Resets the shared `captured` buffer per call so back-to-back invocations
 * within one test (set + null) read clean.
 *
 * @param {object} args
 * @param {Function} args.SessionManager — the SessionManager class under test
 * @param {Function} args.tmpStateFile — factory returning a unique temp path
 *   (every SessionManager instance MUST use a temp stateFilePath, see
 *   feedback_test_state_contamination — without it real session-state.json
 *   gets clobbered)
 * @param {string} args.configKey — the SessionManager constructor option key
 * @param {unknown} args.configValue — the value to assign to configKey
 * @param {object} [args.extraConfig] — additional SessionManager constructor
 *   opts merged in (e.g. when the knob under test requires a partner field)
 */
export async function captureProviderOpts({
  SessionManager,
  tmpStateFile,
  configKey,
  configValue,
  extraConfig = {},
}) {
  await ensureCapturingProvider()
  captured.length = 0
  const mgr = new SessionManager({
    skipPreflight: true,
    maxSessions: 5,
    stateFilePath: tmpStateFile(),
    [configKey]: configValue,
    ...extraConfig,
  })
  mgr.createSession({ cwd: '/tmp', provider: 'test-timeout-capture' })
  assert.equal(
    captured.length,
    1,
    'CapturingProvider should be instantiated exactly once per captureProviderOpts call',
  )
  return captured[0]
}

/**
 * Assert that `configKey` flows through as `providerOpts[providerOptsKey]`
 * when configured to a meaningful value, and is OMITTED (key absent — not
 * set to null/undefined) when configured to null.
 *
 * Most forward-only-when-set knobs (`resultTimeoutMs`, `hardTimeoutMs`,
 * `mcpToolCallTimeoutMs`, etc.) only forward strictly-positive values, so a
 * single `setValue` exercises the happy path. Some knobs accept additional
 * valid-value classes that still forward — `streamStallTimeoutMs` accepts
 * `0` (which disables stream-stall recovery, see #4508) — so pass those via
 * `extraSetValues` to keep the assertion shape uniform.
 *
 * @param {object} args
 * @param {Function} args.SessionManager — the SessionManager class under test
 * @param {Function} args.tmpStateFile — factory returning a unique temp path
 * @param {string} args.configKey — SessionManager constructor option key
 * @param {string} args.providerOptsKey — expected key on providerOpts
 * @param {unknown} args.setValue — primary "configured" value to forward
 * @param {Array<unknown>} [args.extraSetValues] — additional valid values
 *   that should also forward verbatim (e.g. `[0]` for `streamStallTimeoutMs`)
 */
export async function assertForwardingPattern({
  SessionManager,
  tmpStateFile,
  configKey,
  providerOptsKey,
  setValue,
  extraSetValues = [],
}) {
  for (const value of [setValue, ...extraSetValues]) {
    const setOpts = await captureProviderOpts({
      SessionManager,
      tmpStateFile,
      configKey,
      configValue: value,
    })
    assert.equal(
      setOpts[providerOptsKey],
      value,
      `${providerOptsKey} should be forwarded verbatim when ${configKey}=${value}`,
    )
  }

  const nullOpts = await captureProviderOpts({
    SessionManager,
    tmpStateFile,
    configKey,
    configValue: null,
  })
  assert.equal(
    Object.prototype.hasOwnProperty.call(nullOpts, providerOptsKey),
    false,
    `${providerOptsKey} should be OMITTED from providerOpts when ${configKey} is null (got ${nullOpts[providerOptsKey]})`,
  )
}
