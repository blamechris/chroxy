/**
 * #9168 roster guard. The roster is DERIVED from the stylesheet and sources:
 * every full-screen fixed layer (z-index >= 1000) must be rendered only by
 * components that register through useModalOverlay, and the overlay attribute
 * may be written nowhere except the hook itself.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, relative } from 'path'
import {
  SRC, walkSources, fullScreenLayers, parseFixedLayers, filesUsingClass, usesOverlayHook,
} from './overlayRoster.testSupport'

const HOOK = join(SRC, 'hooks', 'useModalOverlay.ts')
const files = walkSources()
const read = (p: string) => readFileSync(p, 'utf-8')

// Full-screen layers that are deliberately NOT modal overlays (no toast pause,
// no topmost-Escape participation). Each needs a reason. Currently none: every
// full-screen layer >= 1000 in the stylesheet is a modal/palette/panel backdrop.
const EXEMPT: Record<string, string> = {}

describe('data-modal-overlay attribute writers (#9168)', () => {
  it('no file other than the hook writes the attribute (JSX, props, setAttribute, dataset)', () => {
    const writers = [
      /(^|[\s{])data-modal-overlay(?=[\s=/>}])/,
      /['"]data-modal-overlay['"]\s*:/,
      /setAttribute\(\s*['"]data-modal-overlay['"]/,
      /dataset\.modalOverlay|dataset\[\s*['"]modalOverlay['"]\s*\]/,
    ]
    const offenders = files
      .filter(f => f !== HOOK)
      .filter(f => writers.some(re => re.test(read(f))))
      .map(f => relative(SRC, f))
    expect(offenders).toEqual([])
  })
})

describe('derived overlay roster (#9168)', () => {
  const layers = fullScreenLayers()

  it('finds full-screen layers at all (a zero-layer derivation is a broken guard)', () => {
    expect(layers.length).toBeGreaterThan(0)
  })

  // FLOOR, not the roster: these must always be derived. It catches the parser
  // rotting into skipping real layers; GROWTH (a new overlay) is caught by the
  // derivation itself requiring every derived layer's users to use the hook.
  it('the derived roster includes the known overlays (parser-rot floor)', () => {
    const got = layers.map(l => l.selector)
    const missing = ['.modal-overlay', '.settings-backdrop', '.shortcut-help-overlay',
      '.file-open-palette-overlay', '.command-palette'].filter(c => !got.includes(c))
    expect(missing).toEqual([])
  })

  it('every component using a non-exempt full-screen layer registers through the hook', () => {
    const problems: string[] = []
    for (const layer of layers) {
      if (layer.selector.slice(1) in EXEMPT) continue
      const users = filesUsingClass(layer.selector)
      if (users.length === 0) problems.push(`${layer.selector}: no component uses this class`)
      for (const u of users) {
        if (!usesOverlayHook(u)) problems.push(`${layer.selector} (z ${layer.z}) used by ${u} without useModalOverlay`)
      }
    }
    expect(problems).toEqual([])
  })

  it('exemptions still exist and are still full-screen layers', () => {
    const all = parseFixedLayers()
    for (const name of Object.keys(EXEMPT)) {
      const layer = all.find(l => l.selector === `.${name}`)
      expect(layer, `exempt layer .${name} no longer exists`).toBeDefined()
      expect(layer?.fullScreen, `exempt layer .${name} is no longer full-screen`).toBe(true)
    }
  })

  it('reverse direction: every hook user renders a derived full-screen layer', () => {
    const layerClasses = layers.map(l => l.selector)
    const hookUsers = files.filter(f => f !== HOOK && /{\.\.\.overlayProps}/.test(read(f))).map(f => relative(SRC, f))
    expect(hookUsers.length).toBeGreaterThan(0)
    const orphans = hookUsers.filter(u => !layerClasses.some(c => filesUsingClass(c).includes(u)))
    expect(orphans).toEqual([])
  })
})

describe('parseFixedLayers classifies or throws, never skips (#9168)', () => {
  const full = (decl: string) => `.x { position: fixed; ${decl}; z-index: 1500 }`
  it('classifies inset shorthands and a final declaration with no semicolon', () => {
    expect(parseFixedLayers('.x { position: fixed; inset: 0; z-index: 1500 }')[0]?.fullScreen).toBe(true)
    expect(parseFixedLayers(full('inset: 0 0 0 0'))[0]?.fullScreen).toBe(true)
    expect(parseFixedLayers(full('inset: 0 0'))[0]?.fullScreen).toBe(true)
    expect(parseFixedLayers(full('top: 0; right: 0; bottom: 0; left: 0'))[0]?.fullScreen).toBe(true)
    expect(parseFixedLayers(full('inset: 0 0 8px 0'))[0]?.fullScreen).toBe(false)
  })
  it('merges position and edges split across two rules of one class', () => {
    const l = parseFixedLayers('.x { position: fixed; z-index: 2000 }\n.x { inset: 0 }')
    expect(l).toEqual([{ selector: '.x', z: 2000, fullScreen: true }])
  })
  it('splits comma selectors', () => {
    const l = parseFixedLayers('.a, .b { position: fixed; inset: 0; z-index: 1200 }')
    expect(l.map(x => x.selector)).toEqual(['.a', '.b'])
  })
  it('throws on a var() z-index', () => {
    expect(() => parseFixedLayers('.x { position: fixed; inset: 0; z-index: var(--z, 1000) }')).toThrow(/\.x.*z-index/)
  })
  it('throws on a var() edge', () => {
    expect(() => parseFixedLayers('.x { position: fixed; inset: var(--e, 0); z-index: 1500 }')).toThrow(/\.x/)
  })
  it('throws on a compound selector with position: fixed', () => {
    expect(() => parseFixedLayers('.a .b { position: fixed; inset: 0; z-index: 1500 }')).toThrow(/\.a \.b/)
  })
  it('ignores non-fixed rules with odd selectors', () => {
    expect(parseFixedLayers('.a .b { color: red } .c:hover { z-index: var(--z, 1000) }')).toEqual([])
  })
})
