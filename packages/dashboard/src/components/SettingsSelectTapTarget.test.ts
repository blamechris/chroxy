/** #8277: Settings selects meet the 44px tap-target floor (AGENTS.md). CSS contract; jsdom has no layout. */
import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')

describe('Settings select tap target', () => {
  test('.settings-field select has min-height: 44px', () => {
    const m = css.match(/(?:^|\})\s*\.settings-field select\s*\{([^}]*)\}/m)
    expect(m).not.toBeNull()
    expect(/min-height:\s*44px/.test(m![1]!)).toBe(true)
  })
})
