/**
 * Test support (#9168): derive the modal-overlay roster from the code instead of
 * listing it. A "full-screen layer" is a stylesheet rule with position: fixed,
 * all four edges at 0 (or inset: 0) and z-index >= 1000; every non-test source
 * file using such a class must register through useModalOverlay.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve, join, relative } from 'path'

export const SRC = resolve(__dirname, '..')
export const CSS_PATH = join(SRC, 'theme', 'components.css')
export const MIN_LAYER_Z = 1000

export function walkSources(dir: string = SRC, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walkSources(p, out)
    else if (/\.(tsx?|jsx?)$/.test(n) && !/\.test\.[tj]sx?$/.test(n) && !/\.testSupport\.[tj]sx?$/.test(n)) out.push(p)
  }
  return out
}

export interface Layer { selector: string; z: number; fullScreen: boolean }

/** Every plain `.class` rule with position: fixed and z-index >= MIN_LAYER_Z. */
export function parseFixedLayers(css: string = readFileSync(CSS_PATH, 'utf-8')): Layer[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Layer[] = []
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? '').trim()
    const body = m[2] ?? ''
    if (!/^\.[\w-]+$/.test(selector)) continue
    if (!/position:\s*fixed\s*;/.test(body)) continue
    const z = /z-index:\s*(\d+)/.exec(body)
    if (!z || z[1] === undefined || Number(z[1]) < MIN_LAYER_Z) continue
    const fullScreen =
      /(^|[\s;])inset:\s*0(px)?\s*;/.test(body) ||
      ['top', 'right', 'bottom', 'left'].every(e => new RegExp(`(^|[\\s;])${e}:\\s*0(px)?\\s*;`).test(body))
    out.push({ selector, z: Number(z[1]), fullScreen })
  }
  return out
}

export function fullScreenLayers(css?: string): Layer[] {
  return parseFixedLayers(css).filter(l => l.fullScreen)
}

/** Non-test source files that put `cls` in a JSX className (not merely name it, e.g. as a command id). */
export function filesUsingClass(cls: string, files: string[] = walkSources()): string[] {
  const name = cls.replace(/^\./, '').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  const token = new RegExp(`(?<![\\w-])${name}(?![\\w-])`)
  const attr = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g
  return files
    .filter(f => [...readFileSync(f, 'utf-8').matchAll(attr)].some(m => token.test(m[1] ?? m[2] ?? m[3] ?? '')))
    .map(f => relative(SRC, f))
    .sort()
}

export function usesOverlayHook(relPath: string): boolean {
  const src = readFileSync(join(SRC, relPath), 'utf-8')
  return /\buseModalOverlay\b/.test(src) && src.includes('{...overlayProps}')
}
