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
  SRC, walkSources, walkStylesheets, fullScreenLayers, partialLayers, parseFixedLayers,
  elementsUsingClass, overlayElements, jsxClassElements, parseSource,
  DYNAMIC_CLASSNAME_OK, inlinePositionSites, inlinePositionsIn, layerLiteralSites,
} from './overlayRoster.testSupport'

const HOOK = join(SRC, 'hooks', 'useModalOverlay.ts')
const files = walkSources()
const read = (p: string) => readFileSync(p, 'utf-8')

// Full-screen layers that are deliberately NOT modal overlays (no toast pause,
// no topmost-Escape participation). Each needs a reason. Currently none: every
// full-screen layer >= 1000 in the stylesheet is a modal/palette/panel backdrop.
const EXEMPT: Record<string, string> = {}

// Fixed layers (z >= 1000) that do NOT cover the viewport. Each is classified
// with the reason a toast may or may not cover it; asserted both ways below
// (every non-full-screen layer is listed, every entry is still one).
const PARTIAL: Record<string, string> = {
  'toast-container': 'the toast stack itself (z 2000); it drops to 999 beneath a registered overlay, so it is never the cover',
  'settings-panel': 'side panel rendered by SettingsPanel next to .settings-backdrop; the backdrop registers (z 1100 < panel 1101), so toasts sit under both while open',
  'repo-preset-drawer': 'non-modal side drawer (z 1000); deliberately unregistered, so toasts (2000) may cover it and it neither pauses toasts nor joins Escape',
}

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

describe('stylesheet coverage (#9198)', () => {
  it('reads every stylesheet under src, including component-local ones', () => {
    const names = walkStylesheets().map(f => relative(SRC, f))
    expect(names).toContain(join('theme', 'components.css'))
    expect(names).toContain(join('components', 'SetupWizard.css'))
    expect(names.length).toBeGreaterThan(5)
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

  it('every ELEMENT carrying a non-exempt full-screen layer class spreads the hook props', () => {
    const problems: string[] = []
    for (const layer of layers) {
      if (Object.prototype.hasOwnProperty.call(EXEMPT, layer.selector.slice(1))) continue
      const users = elementsUsingClass(layer.selector)
      if (users.length === 0) problems.push(`${layer.selector}: no component uses this class`)
      for (const u of users) {
        if (!u.el.spreadsOverlay) problems.push(`${layer.selector} (z ${layer.z}) on ${u.file}:${u.el.line} does not spread the overlay props`)
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

  it('reverse direction: every overlay-spreading element carries a derived full-screen layer class', () => {
    const layerClasses = new Set(layers.map(l => l.selector.slice(1)))
    const spreaders = overlayElements()
    expect(spreaders.length).toBeGreaterThan(0)
    const orphans = spreaders
      .filter(s => !s.el.classes.some(c => layerClasses.has(c)))
      .map(s => `${s.file}:${s.el.line} [${s.el.classes.join(' ')}]`)
    expect(orphans).toEqual([])
  })

  it('non-full-screen fixed layers are classified both ways', () => {
    const found = partialLayers().map(l => l.selector.slice(1)).sort()
    expect(found).toEqual(Object.keys(PARTIAL).sort())
    // Each reason must cite the layer's real z-index, so a stale or copy-pasted reason fails.
    const zs = new Map(partialLayers().map(l => [l.selector.slice(1), l.z]))
    for (const [name, why] of Object.entries(PARTIAL)) expect(why.includes(String(zs.get(name))), `${name}: reason must cite z ${zs.get(name)}`).toBe(true)
    expect(new Set(Object.values(PARTIAL)).size).toBe(Object.keys(PARTIAL).length)
  })
})

describe('jsxClassElements binds the class to the spreading element (#9198)', () => {
  const two = (second: string) => `
    import { useModalOverlay } from './useModalOverlay'
    export function X() {
      const { overlayProps } = useModalOverlay()
      return (<>
        <div {...overlayProps} className="modal-overlay" />
        ${second}
      </>)
    }`
  it('a file with two overlay-class elements where only one registers is told apart', () => {
    const els = jsxClassElements(two('<div className="command-palette" />'))
    expect(els.find(e => e.classes.includes('modal-overlay'))?.spreadsOverlay).toBe(true)
    expect(els.find(e => e.classes.includes('command-palette'))?.spreadsOverlay).toBe(false)
  })
  it('reads template, ternary and call-wrapped class literals', () => {
    const els = jsxClassElements(two('<div className={`a ${x} command-palette`} /><i className={x ? "p q" : cn("r")} />'))
    expect(els.some(e => e.classes.includes('command-palette'))).toBe(true)
    expect(els.some(e => e.classes.includes('q') && e.classes.includes('r'))).toBe(true)
  })
  it('throws when the spreading element has no readable className', () => {
    const src = `import { useModalOverlay } from './h'
      export const X = () => { const { overlayProps } = useModalOverlay(); return <div {...overlayProps} className={cls} /> }`
    expect(() => jsxClassElements(src)).toThrow(/no readable class/)
  })
  it('throws when the hook is called but its props binding cannot be resolved', () => {
    const src = `import { useModalOverlay } from './h'
      export const X = () => { useModalOverlay(); return <div className="modal-overlay" /> }`
    expect(() => jsxClassElements(src)).toThrow(/cannot be resolved/)
  })
  it('follows a renamed binding and a handle object', () => {
    const renamed = `export const X = () => { const { overlayProps: p } = useModalOverlay(); return <div {...p} className="a" /> }`
    expect(jsxClassElements(renamed)[0]?.spreadsOverlay).toBe(true)
    const handle = `export const X = () => { const h = useModalOverlay(); return <div {...h.overlayProps} className="a" /> }`
    expect(jsxClassElements(handle)[0]?.spreadsOverlay).toBe(true)
  })
})

describe('the scan reads what it claims to (#9198)', () => {
  it('a syntax error throws, naming the file', () => {
    expect(() => jsxClassElements('export const X = () => <div className="a"', 'broken.tsx')).toThrow(/broken\.tsx.*syntax error/)
    expect(() => parseSource('const = ;', 'broken.ts')).toThrow(/broken\.ts:1/)
  })
  it('.ts is parsed as TS and .tsx as TSX', () => {
    const assertion = 'export const f = (x: unknown) => <string>x'
    expect(() => parseSource(assertion, 'a.ts')).not.toThrow()
    expect(() => parseSource(assertion, 'a.tsx')).toThrow(/syntax error/)
  })
  const L = new Set(['modal-overlay'])
  const file = (other: string) => `
    import { useModalOverlay } from './h'
    export function X() {
      const { overlayProps } = useModalOverlay()
      return (<>
        <div {...overlayProps} className="modal-overlay" />
        ${other}
      </>)
    }`
  it.each([
    ['an identifier', '<div className={cls} />'],
    ['a template with an expression', '<div className={`a ${cls}`} />'],
    ['a call', '<div className={clsx("a", cls)} />'],
    ['a conditional with a dynamic branch', '<div className={on ? "a" : cls} />'],
  ])('throws on a non-spreading dynamic className (%s) in a file naming a layer class', (_n, el) => {
    expect(() => jsxClassElements(file(el), 'y.tsx', L)).toThrow(/cannot verify/)
  })
  it('reads literal-only conditionals and templates as static', () => {
    expect(() => jsxClassElements(file('<div className={on ? "a" : "b"} /><i className={`a ${on ? "x" : ""}`} />'), 'y.tsx', L)).not.toThrow()
  })
  it('does not throw in a file that never names a layer class', () => {
    expect(() => jsxClassElements('export const X = () => <div className={cls} />', 'y.tsx', L)).not.toThrow()
  })
  it('allow-listed dynamic classNames are reviewed, and each still exists', () => {
    const live = new Set<string>()
    for (const f of walkSources()) {
      for (const el of jsxClassElements(read(f), relative(SRC, f), L, new Set(Object.keys(DYNAMIC_CLASSNAME_OK)))) {
        if (el.dynamicText && !el.spreadsOverlay) live.add(`${relative(SRC, f)}::${el.dynamicText}`)
      }
    }
    for (const k of Object.keys(DYNAMIC_CLASSNAME_OK)) expect(live.has(k), `stale allow-list entry ${k}`).toBe(true)
  })
})

// Files whose string literals NAME a layer class without an element of their own
// spreading the hook's props. Each is reviewed: the literal is never rendered as
// a className. Key: file under src. The reason must cite the class it names, and
// the guard below asserts the list both ways.
const LAYER_LITERAL_OK: Record<string, string> = {
  'hooks/useShortcutDispatch.ts::shortcut-help-overlay': 'reads shortcut-help-overlay through classList.contains on mounted overlays to tell whether only the help dialog is open; a DOM query, never a rendered className',
}

describe('a layer class reaches an element only through a spreading one (#9207)', () => {
  const layerSet = new Set(fullScreenLayers().map(l => l.selector.slice(1)))
  const sites = layerLiteralSites(layerSet)
  const loose = sites.filter(s => !s.spreading)
  const key = (s: { file: string; cls: string }) => `${s.file}::${s.cls}`

  it('every layer-class literal is the className of a spreading element, or allow-listed', () => {
    expect(sites.length).toBeGreaterThan(0) // floor: a zero-site scan is a broken guard
    expect(sites.some(s => s.spreading)).toBe(true)
    const problems = loose
      .filter(s => !Object.prototype.hasOwnProperty.call(LAYER_LITERAL_OK, key(s)))
      .map(s => `${s.file}:${s.line} holds the literal "${s.cls}" outside the className of an element that spreads the overlay props (imported constant or prop path?)`)
    expect(problems).toEqual([])
  })

  it('every allow-list entry is still such a literal, and its reason names the class', () => {
    const live = new Set(loose.map(key))
    for (const [k, why] of Object.entries(LAYER_LITERAL_OK)) {
      expect(live.has(k), `stale allow-list entry ${k}: no such unspread literal remains`).toBe(true)
      expect(why.includes(k.split('::')[1] as string), `${k}: reason must name the class`).toBe(true)
    }
  })
})

// Inline position: fixed styles are invisible to the stylesheet derivation. Each
// is classified here with the reason it is not a modal overlay; asserted both ways.
const INLINE_FIXED: Record<string, string> = {
  'components/ErrorBoundary.tsx': 'z 9999 full-screen fallback that REPLACES the whole tree, so no toast stack or Modal is mounted beside it; a class component cannot use the hook',
  'components/SessionContextMenu.tsx': 'z 1000 popup at the pointer (not full-screen, not modal); sits under toasts (2000) by design and needs no pause',
}

describe('inline position: fixed styles (#9198)', () => {
  it('every inline-fixed site is classified, and every entry still is one', () => {
    const sites = inlinePositionSites()
    const fixed = [...new Set(sites.filter(s => s.value === 'fixed').map(s => s.file))].sort()
    expect(fixed).toEqual(Object.keys(INLINE_FIXED).sort())
    expect(sites.length).toBeGreaterThan(fixed.length) // non-fixed positions are read too (floor)
  })
  it('reads style attributes and CSSProperties constants, any quoting and case', () => {
    const src = `const a: React.CSSProperties = { position: "FIXED" }
      export const X = () => <div style={{ position: 'fixed', top: 0 }} />`
    expect(inlinePositionsIn(src, 'z.tsx').map(s => s.value)).toEqual(['fixed', 'fixed'])
    expect(inlinePositionsIn(`const a = () => <i style={{ position: 'absolute' }} />`, 'z.tsx')[0]?.value).toBe('absolute')
  })
  it('throws on a non-literal position', () => {
    expect(() => inlinePositionsIn('export const X = () => <div style={{ position: pos }} />', 'z.tsx')).toThrow(/not a string literal/)
    expect(() => inlinePositionsIn('const a: CSSProperties = { position }', 'z.tsx')).toThrow(/not a string literal/)
  })
  it('ignores a position key outside style objects', () => {
    expect(inlinePositionsIn('const d = { position: pos }', 'z.ts')).toEqual([])
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

describe('parseFixedLayers hardening (#9198)', () => {
  const FS = 'position: fixed; z-index: 1500;'
  it('reads uppercase FIXED', () => {
    expect(parseFixedLayers('.x { position: FIXED; inset: 0; z-index: 1500 }')).toEqual([{ selector: '.x', z: 1500, fullScreen: true }])
    expect(parseFixedLayers('.x { POSITION: Fixed; INSET: 0; Z-INDEX: 1500 }')[0]?.fullScreen).toBe(true)
  })
  it('reads 0 !important and 0px edges', () => {
    expect(parseFixedLayers('.x { position: fixed !important; inset: 0 !important; z-index: 1500 !important }')).toEqual([{ selector: '.x', z: 1500, fullScreen: true }])
    expect(parseFixedLayers(`.x { ${FS} top: 0 !important; right: 0px; bottom: 0 !important; left: 0 }`)[0]?.fullScreen).toBe(true)
    expect(parseFixedLayers(`.x { ${FS} inset: 8px !important }`)[0]?.fullScreen).toBe(false)
  })
  it('reads inset-block / inset-inline and the -start/-end longhands', () => {
    expect(parseFixedLayers(`.x { ${FS} inset-block: 0; inset-inline: 0 }`)[0]?.fullScreen).toBe(true)
    expect(parseFixedLayers(`.x { ${FS} inset-block: 0 0; inset-inline: 0 }`)[0]?.fullScreen).toBe(true)
    expect(parseFixedLayers(`.x { ${FS} inset-block-start: 0; inset-block-end: 0; inset-inline-start: 0; inset-inline-end: 0 }`)[0]?.fullScreen).toBe(true)
    expect(parseFixedLayers(`.x { ${FS} inset-block: 0; inset-inline: 0 12px }`)[0]?.fullScreen).toBe(false)
    expect(parseFixedLayers(`.x { ${FS} inset-block: 0 }`)[0]?.fullScreen).toBe(false)
    expect(() => parseFixedLayers(`.x { ${FS} inset-block: var(--e, 0); inset-inline: 0 }`)).toThrow(/\.x/)
  })
  it('a later longhand overrides an earlier shorthand, and the reverse', () => {
    expect(parseFixedLayers(`.x { ${FS} inset: 0; top: 8px }`)[0]?.fullScreen).toBe(false)
    expect(parseFixedLayers(`.x { ${FS} top: 8px; inset: 0 }`)[0]?.fullScreen).toBe(true)
  })
  it('does not split declarations on a ; inside url() or a string, and survives braces in strings', () => {
    const css = `.x { background: url(data:image/png;base64,AAA); content: "};{"; ${FS} inset: 0 }`
    expect(parseFixedLayers(css)).toEqual([{ selector: '.x', z: 1500, fullScreen: true }])
  })
  it('throws on native nesting that declares geometry inside a fixed rule', () => {
    expect(() => parseFixedLayers(`.x { ${FS} inset: 0; &.compact { inset: 8px } }`)).toThrow(/\.x.*nested/)
    expect(() => parseFixedLayers(`.x { ${FS} inset: 0; .y { z-index: 1 } }`)).toThrow(/\.x.*nested/)
  })
  it('throws on a nested rule that is itself fixed', () => {
    expect(() => parseFixedLayers('.a { color: red; .b { position: fixed; inset: 0; z-index: 1500 } }')).toThrow(/nested/)
  })
  it('lets non-geometry nesting under a fixed rule pass', () => {
    expect(parseFixedLayers(`.x { ${FS} inset: 0; &:hover { color: red } }`)[0]?.fullScreen).toBe(true)
  })
  it('does not merge @media into the base: a conditional that flips classification throws', () => {
    const base = `.x { ${FS} inset: 0 }`
    expect(() => parseFixedLayers(`${base} @media (max-width: 600px) { .x { top: 8px } }`)).toThrow(/\.x.*@media/)
    expect(() => parseFixedLayers(`${base} @media (max-width: 600px) { .x { z-index: 10 } }`)).toThrow(/\.x.*@media/)
    expect(() => parseFixedLayers(`${base} @media (max-width: 600px) { .x { position: relative } }`)).toThrow(/\.x.*@media/)
  })
  it('classifies a conditional that leaves the classification unchanged, without merging it', () => {
    const base = `.x { ${FS} right: 20px; bottom: 20px }`
    expect(parseFixedLayers(`${base} @media (max-width: 600px) { .x { right: 10px; left: 10px } }`)).toEqual([{ selector: '.x', z: 1500, fullScreen: false }])
    // completing the edges inside @media is not merged into the base: it throws instead of reading full-screen
    expect(() => parseFixedLayers(`.x { ${FS} top: 0; right: 0 } @media (min-width: 1px) { .x { bottom: 0; left: 0 } }`)).toThrow(/@media/)
  })
  it('throws on position: fixed declared only inside a conditional block, at any depth', () => {
    expect(() => parseFixedLayers('@media (max-width: 600px) { .x { position: fixed; inset: 0; z-index: 1500 } }')).toThrow(/@media/)
    expect(() => parseFixedLayers('@media screen { @supports (display: grid) { .x { position: fixed; z-index: 1500 } } }')).toThrow(/fixed/)
  })
  it('throws on unbalanced braces (unclosed block, stray close)', () => {
    expect(() => parseFixedLayers(`.x { ${FS} inset: 0`)).toThrow(/unbalanced/)
    expect(() => parseFixedLayers(`.x { ${FS} inset: 0 } }`)).toThrow(/unbalanced/)
    expect(() => parseFixedLayers('@media screen { .x { color: red }')).toThrow(/unbalanced/)
  })
  it('throws when a fixed class gets its z-index only through a non-plain selector', () => {
    expect(() => parseFixedLayers('.x { position: fixed; inset: 0 } .a .x { z-index: 2000 }')).toThrow(/\.x.*non-plain/)
    expect(parseFixedLayers('.x { position: fixed; inset: 0 } .a .y { z-index: 2000 }')).toEqual([])
  })
  it('throws on fixed inside an unclassified at-rule but ignores keyframes', () => {
    expect(() => parseFixedLayers('@foo { .x { position: fixed } }')).toThrow(/at-rule/)
    expect(parseFixedLayers('@keyframes k { from { position: fixed; top: 0 } to { top: 5px } } .y { color: red }')).toEqual([])
  })
})
