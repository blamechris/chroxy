import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/store/connection.ts'),
  'utf-8',
)

describe('AppState listener cleanup (#1910)', () => {
  test('stores subscription handle in exported const', () => {
    expect(src).toMatch(/export const _appStateSub\s*=\s*AppState\.addEventListener/)
  })

  test('subscription handle is removable (NativeEventSubscription)', () => {
    // The return type of AppState.addEventListener is NativeEventSubscription
    // which has a .remove() method. Verify it's stored, not discarded.
    expect(src).not.toMatch(/^AppState\.addEventListener/m)
  })
})

describe('Resume zombie-socket liveness (#5633)', () => {
  test('tracks how long the app was backgrounded', () => {
    // A timestamp is recorded on the transition AWAY from foreground and read
    // back on resume to compute the background duration.
    expect(src).toMatch(/_backgroundedAt/)
    expect(src).toMatch(/if \(nextState !== 'active'\)/)
    expect(src).toMatch(/if \(_backgroundedAt === 0\) _backgroundedAt = Date\.now\(\)/)
  })

  test('uses the real heartbeat interval as the background threshold', () => {
    // The threshold must be the actual heartbeat constant read from
    // message-handler, not a separate magic number that could drift from it.
    expect(src).toMatch(/HEARTBEAT_INTERVAL_MS/)
    expect(src).toMatch(/backgroundedFor >= HEARTBEAT_INTERVAL_MS/)
  })

  test('reconnects even when the socket still claims OPEN after a long background', () => {
    // The whole point of the fix: readyState === OPEN is untrustworthy after a
    // background cycle, so a long-background resume must reconnect anyway.
    expect(src).toMatch(/socket\.readyState === WebSocket\.OPEN &&\s*\n\s*longBackground/)
  })

  test('respects the resume cooldown and user-disconnect intent', () => {
    expect(src).toMatch(/now - _lastResumeReconnectAt < RESUME_RECONNECT_COOLDOWN_MS/)
    // The zombie-socket branch must not fire when the user explicitly disconnected.
    expect(src).toMatch(/longBackground &&\s*\n\s*!userDisconnected/)
  })

  test('clears the backgrounded timestamp on every resume (clean next cycle)', () => {
    expect(src).toMatch(/_backgroundedAt = 0/)
  })
})
