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
