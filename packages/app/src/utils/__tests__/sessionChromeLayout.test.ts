import { chromeMaxHeight } from '../sessionChromeLayout'

describe('chromeMaxHeight (#8236)', () => {
  it('returns undefined when the keyboard is hidden', () => {
    expect(chromeMaxHeight({ containerHeight: 800, keyboardHeight: 0, bottomPadding: 34 })).toBeUndefined()
  })

  it('returns undefined when the container is not measured yet', () => {
    expect(chromeMaxHeight({ containerHeight: 0, keyboardHeight: 300, bottomPadding: 300 })).toBeUndefined()
  })

  it('caps to 40% of the space above the keyboard', () => {
    // 800 - 300 = 500 above the keyboard; 40% = 200
    expect(chromeMaxHeight({ containerHeight: 800, keyboardHeight: 300, bottomPadding: 300 })).toBe(200)
  })

  it('accounts for the Android suggestion-bar buffer in bottomPadding', () => {
    // 800 - 348 = 452; 40% = 180.8 -> 180
    expect(chromeMaxHeight({ containerHeight: 800, keyboardHeight: 300, bottomPadding: 348 })).toBe(180)
  })

  it('never goes negative when the keyboard exceeds the container', () => {
    expect(chromeMaxHeight({ containerHeight: 200, keyboardHeight: 500, bottomPadding: 500 })).toBe(0)
  })
})
