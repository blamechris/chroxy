import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DASHBOARD_SRC = resolve(import.meta.dirname, '../src/dashboard-next/src')

describe('isTauri import hygiene (#2058)', () => {
  it('App.tsx imports isTauri from utils/tauri, not from useTauriEvents', () => {
    const src = readFileSync(resolve(DASHBOARD_SRC, 'App.tsx'), 'utf-8')
    assert.ok(
      src.includes("from './utils/tauri'") || src.includes('from "./utils/tauri"'),
      'App.tsx should import isTauri from utils/tauri',
    )
    assert.ok(
      !src.match(/import\s*\{[^}]*isTauri[^}]*\}\s*from\s*['"]\.\/hooks\/useTauriEvents['"]/),
      'App.tsx should NOT import isTauri from hooks/useTauriEvents',
    )
  })

  it('useTauriEvents.ts does not re-export isTauri', () => {
    const src = readFileSync(resolve(DASHBOARD_SRC, 'hooks/useTauriEvents.ts'), 'utf-8')
    assert.ok(
      !src.includes('export { isTauri }'),
      'useTauriEvents.ts should not re-export isTauri',
    )
  })
})
