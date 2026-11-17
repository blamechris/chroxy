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

const ZERO = /^0(px|rem|em|%)?$/

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>()
  // Split on ';' (not "match name: value;") so a final declaration with no
  // trailing semicolon is still read.
  for (const d of body.split(';')) {
    const i = d.indexOf(':')
    if (i < 0) continue
    out.set(d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim())
  }
  return out
}

/** Edge values -> full-screen? Throws on anything it cannot read (var(), calc()). */
function edgesFullScreen(sel: string, decls: Map<string, string>): boolean {
  const edges: Record<string, string | undefined> = {}
  const inset = decls.get('inset')
  if (inset !== undefined) {
    const v = inset.split(/\s+/).filter(Boolean)
    if (v.length < 1 || v.length > 4) throw new Error(`${sel}: cannot read inset "${inset}"`)
    const [t, r = t, bo = t, l = r] = v
    Object.assign(edges, { top: t, right: r, bottom: bo, left: l })
  }
  for (const e of ['top', 'right', 'bottom', 'left']) {
    const v = decls.get(e)
    if (v !== undefined) edges[e] = v
  }
  return ['top', 'right', 'bottom', 'left'].every(e => {
    const v = edges[e]
    if (v === undefined) return false
    if (/var\(|calc\(|env\(/.test(v)) throw new Error(`${sel}: cannot classify ${e}: ${v}`)
    return ZERO.test(v)
  })
}

/**
 * Every class that declares position: fixed (declarations merged across all of
 * its plain-class rules, so position and edges split over two rules still
 * classify). A fixed rule it cannot classify THROWS naming the selector; it is
 * never silently skipped. Layers are those with a numeric z-index >= MIN_LAYER_Z;
 * a fixed class with no z-index (auto) or a lower one is classified "not a layer".
 */
export function parseFixedLayers(css: string = readFileSync(CSS_PATH, 'utf-8')): Layer[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const merged = new Map<string, Map<string, string>>()
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorText = (m[1] ?? '').trim()
    const decls = declarations(m[2] ?? '')
    const fixed = /^fixed\b/.test(decls.get('position') ?? '')
    for (const part of selectorText.split(',').map(x => x.trim())) {
      if (!/^\.[\w-]+$/.test(part)) {
        if (fixed) throw new Error(`${selectorText}: position: fixed on a non-plain-class selector "${part}"`)
        continue
      }
      const into = merged.get(part) ?? new Map<string, string>()
      for (const [k, v] of decls) into.set(k, v)
      merged.set(part, into)
    }
  }
  const out: Layer[] = []
  for (const [selector, decls] of merged) {
    if (!/^fixed\b/.test(decls.get('position') ?? '')) continue
    const zRaw = decls.get('z-index')
    if (zRaw === undefined) continue // z-index: auto — below any layer
    if (!/^-?\d+$/.test(zRaw)) throw new Error(`${selector}: position: fixed with unreadable z-index "${zRaw}"`)
    const z = Number(zRaw)
    if (z < MIN_LAYER_Z) continue
    out.push({ selector, z, fullScreen: edgesFullScreen(selector, decls) })
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
