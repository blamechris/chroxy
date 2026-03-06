import fs from 'fs'
import path from 'path'

const bannerSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/components/SessionNotificationBanner.tsx'),
  'utf-8',
)

const typesSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/store/types.ts'),
  'utf-8',
)

const handlerSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/store/message-handler.ts'),
  'utf-8',
)

describe('Quick-approve permissions from notification banner (#1048)', () => {
  test('SessionNotification type has optional requestId field', () => {
    // Must be inside the SessionNotification interface specifically
    const match = typesSrc.match(/interface SessionNotification\s*\{([\s\S]*?)\}/)
    expect(match).toBeTruthy()
    expect(match![1]).toMatch(/requestId\??\s*:\s*string/)
  })

  test('pushSessionNotification accepts and stores requestId', () => {
    // The function signature should accept requestId parameter (within 200 chars of function name)
    const match = handlerSrc.match(/function pushSessionNotification\(([\s\S]{0,200}?)\)/)
    expect(match).toBeTruthy()
    expect(match![1]).toMatch(/requestId/)
  })

  test('banner shows Approve button for permission notifications', () => {
    expect(bannerSrc).toMatch(/Approve/)
    // Should call sendPermissionResponse
    expect(bannerSrc).toMatch(/sendPermissionResponse/)
  })

  test('banner shows Deny button for permission notifications', () => {
    expect(bannerSrc).toMatch(/Deny/)
  })

  test('Approve/Deny only shown for permission eventType', () => {
    // Should conditionally render based on eventType === 'permission'
    expect(bannerSrc).toMatch(/eventType\s*===?\s*['"]permission['"]/)
  })

  test('dismisses notification after approve/deny action', () => {
    // After approve/deny, should call dismiss with notification.id
    // The handler should dismiss AND send permission response
    expect(bannerSrc).toMatch(/sendPermissionResponse[\s\S]*?dismiss|dismiss[\s\S]*?sendPermissionResponse/)
  })

  test('buttons have accessibility labels', () => {
    expect(bannerSrc).toMatch(/accessibilityLabel.*[Aa]pprove/)
    expect(bannerSrc).toMatch(/accessibilityLabel.*[Dd]eny/)
  })
})
