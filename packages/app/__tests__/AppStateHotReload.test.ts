import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/store/connection.ts'),
  'utf-8',
)

describe('AppState hot-reload cleanup (#1995)', () => {
  test('checks for existing subscription before creating new one', () => {
    expect(src).toMatch(/global\.__chroxy_appStateSub/)
  })

  test('removes previous subscription on hot-reload', () => {
    expect(src).toMatch(/global\.__chroxy_appStateSub.*\.remove\(\)/)
  })

  test('stores new subscription on global for next hot-reload', () => {
    expect(src).toMatch(/global\.__chroxy_appStateSub = _appStateSub/)
  })
})
