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
