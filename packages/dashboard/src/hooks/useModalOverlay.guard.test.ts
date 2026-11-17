/**
 * #9168 roster guard, both directions: the literal `data-modal-overlay`
 * attribute lives ONLY in useModalOverlay.ts, and every source file that
 * renders an overlay uses the hook (so cannot carry the attribute unregistered).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve, join, relative } from 'path'

const SRC = resolve(__dirname, '..')
const HOOK = join(SRC, 'hooks', 'useModalOverlay.ts')

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|jsx?)$/.test(n) && !/\.test\.[tj]sx?$/.test(n)) out.push(p)
  }
  return out
}

const files = walk(SRC)
const read = (p: string) => readFileSync(p, 'utf-8')

describe('data-modal-overlay roster (#9168)', () => {
  it('no file other than the hook writes the attribute as JSX/props', () => {
    // Querying it (`querySelector('[data-modal-overlay]')`) is fine; setting it is not.
    const offenders = files
      .filter(f => f !== HOOK)
      .filter(f => /(^|[\s{])data-modal-overlay(?=[\s=/>}])|['"]data-modal-overlay['"]\s*:/.test(read(f)))
      .map(f => relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('the hook is used at every overlay site (and the roster has not shrunk)', () => {
    const users = files
      .filter(f => f !== HOOK && /\buseModalOverlay\b/.test(read(f)) && read(f).includes('{...overlayProps}'))
      .map(f => relative(SRC, f)).sort()
    expect(users).toEqual([
      'components/CodeSearchPalette.tsx',
      'components/FileOpenPalette.tsx',
      'components/Modal.tsx',
      'components/ReferencesPalette.tsx',
      'components/SettingsPanel.tsx',
      'components/ShortcutHelp.tsx',
      'components/SymbolSearchPalette.tsx',
    ])
  })

  it('every file that QUERIES overlays and is not a listed site does not render one', () => {
    // Reverse direction: anything spreading overlayProps must be in the roster above.
    const spreaders = files.filter(f => read(f).includes('{...overlayProps}')).length
    expect(spreaders).toBe(7)
  })
})
