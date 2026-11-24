/**
 * Test support (#9168, #9198): derive the modal-overlay roster from the code
 * instead of listing it. A "full-screen layer" is a stylesheet rule with
 * position: fixed, all four edges at 0 (or inset: 0) and z-index >= 1000; every
 * non-test source file element carrying such a class must register through
 * useModalOverlay (the element itself must spread the hook's props).
 *
 * Stylesheets: EVERY *.css under src is read (no exclusions; the generated
 * theme.css declares no position: fixed and is read like the rest).
 *
 * CSS limits, stated so nobody mistakes the parser for a cascade engine: rules
 * are merged per plain class in source order (last declaration wins), with no
 * specificity or !important arbitration. Anything the parser cannot classify
 * THROWS: a fixed rule on a non-plain selector, a var()/calc() edge or z-index,
 * geometry declared inside native nesting or a conditional at-rule block.
 *
 * Hook check: a TypeScript AST walk (typescript is a dashboard devDependency
 * already used by tsc; a regex cannot tell which JSX element a spread belongs
 * to). A spread element whose className cannot be read throws.
 *
 * Remaining limit (#9207): a layer class that is only ever ASSEMBLED at runtime
 * (concatenated, built from parts, read from data) never appears as a string
 * literal, so no scan of literals can see it. Everything else is closed: a
 * dynamic className in a file naming a layer class throws (jsxClassElements),
 * and every string-literal occurrence of a layer class must be the className of
 * an element spreading the hook's props, or sit on a reviewed allow-list
 * (layerLiteralSites, per literal site), which covers a class handed over
 * through an exported constant or a prop. The one remaining limit: fully
 * computed class strings, and selector literals such as '.cls'.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve, join, relative } from 'path'
import ts from 'typescript'

export const SRC = resolve(__dirname, '..')
export const MIN_LAYER_Z = 1000

function walk(dir: string, accept: (name: string) => boolean, out: string[]): string[] {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, accept, out)
    else if (accept(n)) out.push(p)
  }
  return out
}

export function walkSources(dir: string = SRC, out: string[] = []): string[] {
  return walk(dir, n => /\.(tsx?|jsx?)$/.test(n) && !/\.test\.[tj]sx?$/.test(n) && !/\.testSupport\.[tj]sx?$/.test(n), out)
}

export function walkStylesheets(dir: string = SRC): string[] {
  return walk(dir, n => /\.css$/i.test(n), [])
}

// ---------------------------------------------------------------- CSS parsing

export interface Layer { selector: string; z: number; fullScreen: boolean }

type Decl = [prop: string, value: string]
interface Rule { prelude: string; decls: Decl[]; children: Rule[] }

/** Block-bodied at-rules whose rules apply conditionally on top of the base rules. */
const CONDITIONAL_AT = /^@(media|supports|container|layer|scope|document|starting-style)\b/i
/** Block-bodied at-rules that never style a document element by class. */
const INERT_AT = /^@(-\w+-)?(keyframes|font-face|property|counter-style|font-feature-values|page|view-transition|position-try)\b/i
const GEOMETRY = /^(position|z-index|top|right|bottom|left|inset(-.+)?)$/

function stripValue(v: string): string {
  return v.replace(/\s*!\s*important\s*$/i, '').trim()
}

/** Reads one block body: declarations and nested rules. Handles quotes, parens (url(data:...;...)) and nesting. */
function parseBody(text: string, pos: { i: number }, top: boolean): { decls: Decl[]; children: Rule[] } {
  const decls: Decl[] = []
  const children: Rule[] = []
  let buf = ''
  let paren = 0
  let quote = ''
  const flushDecl = () => {
    const d = buf
    buf = ''
    const c = d.indexOf(':')
    if (c < 0) return
    decls.push([d.slice(0, c).trim().toLowerCase(), d.slice(c + 1).trim()])
  }
  while (pos.i < text.length) {
    const ch = text[pos.i] as string
    if (quote) {
      buf += ch
      if (ch === '\\') { buf += text[pos.i + 1] ?? ''; pos.i += 2; continue }
      if (ch === quote) quote = ''
      pos.i++
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; pos.i++; continue }
    if (ch === '(') paren++
    else if (ch === ')') paren = Math.max(0, paren - 1)
    if (paren === 0) {
      if (ch === ';') { flushDecl(); pos.i++; continue }
      if (ch === '{') {
        pos.i++
        const inner = parseBody(text, pos, false)
        children.push({ prelude: buf.trim(), ...inner })
        buf = ''
        continue
      }
      if (ch === '}') {
        if (top) throw new Error(`unbalanced CSS: stray "}" near "${text.slice(Math.max(0, pos.i - 40), pos.i + 1).trim()}"`)
        pos.i++
        flushDecl()
        return { decls, children }
      }
    }
    buf += ch
    pos.i++
  }
  if (!top) throw new Error('unbalanced CSS: a block is never closed before end of input')
  flushDecl()
  return { decls, children }
}

function parseStylesheet(css: string): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return parseBody(stripped, { i: 0 }, true).children
}

const isFixed = (decls: Decl[]): boolean => {
  let v: string | undefined
  for (const [p, val] of decls) if (p === 'position') v = val
  return v !== undefined && /^fixed\b/i.test(stripValue(v))
}

function lastOf(decls: Decl[], prop: string): string | undefined {
  let v: string | undefined
  for (const [p, val] of decls) if (p === prop) v = stripValue(val)
  return v
}

const ZERO = /^[-+]?0*\.?0+(px|rem|em|%|vh|vw)?$/i
const EDGES = ['top', 'right', 'bottom', 'left'] as const

/**
 * Edge values -> full-screen? Resolves declarations IN ORDER so a later longhand
 * overrides an earlier shorthand and vice versa. The logical longhands
 * (inset-block / inset-inline and their -start/-end forms) map to the four
 * physical edges by a fixed bijection; full-screen needs all four zero, so the
 * answer does not depend on writing mode. Throws on anything it cannot read.
 */
function edgesFullScreen(sel: string, decls: Decl[]): boolean {
  const edges: Record<string, string | undefined> = {}
  const pair = (prop: string, v: string, a: string, b: string) => {
    const parts = v.split(/\s+/).filter(Boolean)
    if (parts.length < 1 || parts.length > 2) throw new Error(`${sel}: cannot read ${prop} "${v}"`)
    edges[a] = parts[0]
    edges[b] = parts[1] ?? parts[0]
  }
  for (const [prop, raw] of decls) {
    const v = stripValue(raw)
    if (prop === 'inset') {
      const p = v.split(/\s+/).filter(Boolean)
      if (p.length < 1 || p.length > 4) throw new Error(`${sel}: cannot read inset "${v}"`)
      const [t, r = t, bo = t, l = r] = p
      Object.assign(edges, { top: t, right: r, bottom: bo, left: l })
    } else if (prop === 'inset-block') pair(prop, v, 'top', 'bottom')
    else if (prop === 'inset-inline') pair(prop, v, 'left', 'right')
    else if (prop === 'inset-block-start') edges.top = v
    else if (prop === 'inset-block-end') edges.bottom = v
    else if (prop === 'inset-inline-start') edges.left = v
    else if (prop === 'inset-inline-end') edges.right = v
    else if ((EDGES as readonly string[]).includes(prop)) edges[prop] = v
  }
  return EDGES.every(e => {
    const v = edges[e]
    if (v === undefined) return false
    if (/var\(|calc\(|env\(|min\(|max\(|clamp\(/i.test(v)) throw new Error(`${sel}: cannot classify ${e}: ${v}`)
    return ZERO.test(v)
  })
}

function plainClasses(prelude: string): string[] | null {
  const parts = prelude.split(',').map(x => x.trim())
  return parts.every(p => /^\.[\w-]+$/.test(p)) ? parts : null
}

/**
 * Every class that declares position: fixed (declarations merged across all of
 * its plain-class rules in source order, so position and edges split over two
 * rules still classify). A fixed rule it cannot classify THROWS naming the
 * selector; it is never silently skipped. Layers are those with a numeric
 * z-index >= MIN_LAYER_Z; a fixed class with no z-index (auto) or a lower one
 * is classified "not a layer".
 *
 * Native nesting: a fixed class whose body nests a rule declaring geometry
 * (position/z-index/edges/inset*) throws; so does a nested rule that is itself
 * fixed. At-rules: @media/@supports/@container/@layer/... blocks are never
 * merged into the base class; a conditional rule that declares position: fixed throws, and one that
 * changes geometry of a base-fixed class is classified (variant must classify
 * like the base) or throws. @keyframes,
 * @font-face and similar are inert. Any other block at-rule mentioning `fixed`
 * throws.
 */
export function parseFixedLayers(css: string = allStylesheetCss()): Layer[] {
  const merged = new Map<string, Decl[]>()
  const baseFixed = new Set<string>()
  const nonPlainZ: string[] = [] // preludes of non-plain rules that set z-index
  const conditional: Array<{ at: string; rule: Rule }> = []

  const checkNested = (outer: string, rule: Rule) => {
    for (const child of rule.children) {
      if (child.decls.some(([p]) => GEOMETRY.test(p)) || isFixed(child.decls)) {
        throw new Error(`${outer}: geometry declared in nested rule "${child.prelude}" inside a fixed rule`)
      }
      checkNested(outer, child)
    }
  }
  const nestedFixed = (outer: string, rule: Rule) => {
    for (const child of rule.children) {
      if (isFixed(child.decls)) throw new Error(`${outer}: position: fixed in nested rule "${child.prelude}"`)
      nestedFixed(outer, child)
    }
  }
  const collectConditional = (at: string, rules: Rule[]) => {
    for (const r of rules) {
      if (r.prelude.startsWith('@')) {
        if (CONDITIONAL_AT.test(r.prelude)) collectConditional(`${at} ${r.prelude}`, r.children)
        continue
      }
      conditional.push({ at, rule: r })
      collectConditional(at, r.children.filter(c => !c.prelude.startsWith('@')))
    }
  }

  for (const rule of parseStylesheet(css)) {
    const p = rule.prelude
    if (p.startsWith('@')) {
      if (CONDITIONAL_AT.test(p)) collectConditional(p, rule.children)
      else if (!INERT_AT.test(p) && /\bfixed\b/i.test(JSON.stringify(rule))) {
        throw new Error(`${p}: position: fixed inside an at-rule the parser does not classify`)
      }
      continue
    }
    const fixed = isFixed(rule.decls)
    const classes = plainClasses(p)
    if (!classes) {
      if (fixed) throw new Error(`${p}: position: fixed on a non-plain-class selector "${p}"`)
      if (rule.decls.some(([d]) => d === 'z-index')) nonPlainZ.push(p)
      nestedFixed(p, rule)
      continue
    }
    nestedFixed(p, rule)
    for (const c of classes) {
      merged.set(c, [...(merged.get(c) ?? []), ...rule.decls])
      if (fixed) baseFixed.add(c)
      if (fixed || baseFixed.has(c)) checkNested(c, rule)
    }
  }

  const classify = (selector: string, decls: Decl[]): Layer | null => {
    if (!isFixed(decls)) return null
    const zRaw = lastOf(decls, 'z-index')
    if (zRaw === undefined) {
      // z-index: auto — below any layer, UNLESS a compound selector sets it (then we cannot classify)
      const name = selector.replace(/^\./, '').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
      const re = new RegExp(`\\.${name}(?![\\w-])`)
      const via = nonPlainZ.find(pre => re.test(pre))
      if (via) throw new Error(`${selector}: position: fixed with z-index set only via non-plain selector "${via}"`)
      return null
    }
    if (!/^-?\d+$/.test(zRaw)) throw new Error(`${selector}: position: fixed with unreadable z-index "${zRaw}"`)
    const z = Number(zRaw)
    if (z < MIN_LAYER_Z) return null
    return { selector, z, fullScreen: edgesFullScreen(selector, decls) }
  }

  // A conditional rule that touches a fixed class is CLASSIFIED, not merged: the
  // variant (base + conditional declarations) must classify exactly like the
  // base (same layer-ness, z-index and full-screen-ness), otherwise the answer
  // depends on the viewport and the guard throws.
  for (const { at, rule } of conditional) {
    const touches = rule.decls.some(([p]) => GEOMETRY.test(p))
    if (isFixed(rule.decls)) throw new Error(`${rule.prelude}: position: fixed inside ${at}`)
    const classes = plainClasses(rule.prelude)
    if (!classes) {
      if (touches && [...baseFixed].some(c => rule.prelude.includes(c))) {
        throw new Error(`${rule.prelude}: geometry on a fixed layer's selector inside ${at}`)
      }
      continue
    }
    for (const c of classes) {
      if (!baseFixed.has(c) || !touches) continue
      const base = classify(c, merged.get(c) ?? [])
      const variant = classify(c, [...(merged.get(c) ?? []), ...rule.decls])
      if (base?.z !== variant?.z || base?.fullScreen !== variant?.fullScreen) {
        throw new Error(`${c}: ${at} changes the layer classification (${JSON.stringify(base)} -> ${JSON.stringify(variant)})`)
      }
    }
  }

  const out: Layer[] = []
  for (const [selector, decls] of merged) {
    const layer = classify(selector, decls)
    if (layer) out.push(layer)
  }
  return out
}

/** z-index declared by the rule(s) whose selector text is exactly `selector` (compound selectors included). Throws if none. */
export function declaredZIndex(selector: string, css: string = allStylesheetCss()): number {
  let z: string | undefined
  const visit = (rules: Rule[]) => {
    for (const r of rules) {
      if (r.prelude === selector) z = lastOf(r.decls, 'z-index') ?? z
      if (r.prelude.startsWith('@') && !INERT_AT.test(r.prelude)) visit(r.children)
    }
  }
  visit(parseStylesheet(css))
  if (z === undefined || !/^-?\d+$/.test(z)) throw new Error(`${selector}: no readable z-index`)
  return Number(z)
}

/** All stylesheets concatenated in path order. Each is also parsed alone first so a throw names its file. */
export function allStylesheetCss(files: string[] = walkStylesheets()): string {
  const parts: string[] = []
  for (const f of files) {
    const css = readFileSync(f, 'utf-8')
    try { parseFixedLayers(css) } catch (e) {
      throw new Error(`${relative(SRC, f)}: ${(e as Error).message}`)
    }
    parts.push(css)
  }
  return parts.join('\n')
}

export function fullScreenLayers(css?: string): Layer[] {
  return parseFixedLayers(css).filter(l => l.fullScreen)
}

/** Fixed layers at or above MIN_LAYER_Z that do not cover the viewport (drawers, side panels). */
export function partialLayers(css?: string): Layer[] {
  return parseFixedLayers(css).filter(l => !l.fullScreen)
}

// ------------------------------------------------------------- JSX element scan

/**
 * Parses with the ScriptKind the extension implies (.ts is NOT parsed as TSX, so
 * `<T>x` assertions read correctly) and THROWS on any syntax error: the parser
 * is tolerant and would otherwise hand back a partial tree whose dropped
 * elements read as "nothing to check".
 */
export function parseSource(src: string, fileName: string): ts.SourceFile {
  const kind = /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : /\.jsx$/i.test(fileName) ? ts.ScriptKind.JSX : /\.jsx?$/i.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind)
  // Syntactic diagnostics through the public Program API (no emit, no resolution).
  const options: ts.CompilerOptions = { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, allowJs: true, noResolve: true, noLib: true }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = (name, lang) => (name === fileName ? ts.createSourceFile(name, src, lang, true, kind) : undefined)
  host.fileExists = name => name === fileName
  host.readFile = name => (name === fileName ? src : undefined)
  const prog = ts.createProgram([fileName], options, host)
  const errs = prog.getSyntacticDiagnostics(prog.getSourceFile(fileName))
  if (errs.length > 0) {
    const d = errs[0]!
    const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0
    throw new Error(`${fileName}:${line}: syntax error: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
  }
  return sf
}

export interface JsxClassElement {
  /** Class tokens readable from the element's className (string/template/ternary/call literals). */
  classes: string[]
  /** Spreads the overlay hook's props onto this very element. */
  spreadsOverlay: boolean
  /** 1-based line, for messages. */
  line: number
  /** className holds an expression the scan cannot read (identifier, call, template with ${}, ...). */
  dynamic: boolean
  /** Source text of the dynamic className initializer (null when static). */
  dynamicText: string | null
}

/** True when the expression is built only from string literals (through ternaries / && / || / ??). */
function isStaticClassExpr(n: ts.Node): boolean {
  if (ts.isJsxExpression(n)) return n.expression ? isStaticClassExpr(n.expression) : true
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true
  if (ts.isParenthesizedExpression(n)) return isStaticClassExpr(n.expression)
  if (ts.isTemplateExpression(n)) return n.templateSpans.every(sp => isStaticClassExpr(sp.expression))
  if (ts.isIdentifier(n)) return n.text === 'undefined'
  if (n.kind === ts.SyntaxKind.NullKeyword || n.kind === ts.SyntaxKind.FalseKeyword) return true
  if (ts.isConditionalExpression(n)) return isStaticClassExpr(n.whenTrue) && isStaticClassExpr(n.whenFalse)
  if (ts.isBinaryExpression(n)) {
    const k = n.operatorToken.kind
    if (k === ts.SyntaxKind.AmpersandAmpersandToken) return isStaticClassExpr(n.right)
    if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) return isStaticClassExpr(n.left) && isStaticClassExpr(n.right)
  }
  return false
}

function literalsIn(node: ts.Node, out: string[]): void {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text)
  else if (ts.isTemplateExpression(node)) out.push(node.head.text, ...node.templateSpans.map(s => s.literal.text))
  ts.forEachChild(node, c => literalsIn(c, out))
}

/** Every whitespace-separated token of every string literal in the file (a class can only reach an element through one). */
function fileLiterals(sf: ts.SourceFile): string[] {
  const lits: string[] = []
  literalsIn(sf, lits)
  return lits.join(' ').split(/\s+/).filter(Boolean)
}

/** Names bound to `overlayProps` from useModalOverlay() calls in this file. */
function overlayBindings(sf: ts.SourceFile): { calls: number; names: Set<string> } {
  const names = new Set<string>()
  let calls = 0
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'useModalOverlay') {
      calls++
      const decl = n.parent
      if (ts.isVariableDeclaration(decl) && ts.isObjectBindingPattern(decl.name)) {
        for (const el of decl.name.elements) {
          const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : ''
          if (prop === 'overlayProps' && ts.isIdentifier(el.name)) names.add(el.name.text)
        }
      } else if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
        names.add(`${decl.name.text}.overlayProps`)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return { calls, names }
}

/**
 * Every JSX element carrying a className (or an overlay spread) in `src`.
 * THROWS when an element spreads the overlay props but its className yields no
 * readable class token (the guard could not bind a class to the element), or
 * when the file calls useModalOverlay but the props binding cannot be resolved.
 */
export function jsxClassElements(src: string, fileName = 'x.tsx', layerClasses?: ReadonlySet<string>, allowDynamic: ReadonlySet<string> = new Set()): JsxClassElement[] {
  const sf = parseSource(src, fileName)
  const { calls, names } = overlayBindings(sf)
  if (calls > 0 && names.size === 0) throw new Error(`${fileName}: useModalOverlay() called but its overlayProps binding cannot be resolved`)
  const out: JsxClassElement[] = []
  const visit = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
      let spreadsOverlay = false
      const lits: string[] = []
      let hasClassName = false
      let dynamic = false
      let dynamicText: string | null = null
      for (const a of n.attributes.properties) {
        if (ts.isJsxSpreadAttribute(a)) {
          if (names.has(a.expression.getText(sf))) spreadsOverlay = true
        } else if (ts.isIdentifier(a.name) && a.name.text === 'className') {
          hasClassName = true
          if (a.initializer) {
            literalsIn(a.initializer, lits)
            if (!isStaticClassExpr(a.initializer)) { dynamic = true; dynamicText = a.initializer.getText(sf) }
          }
        }
      }
      const classes = lits.join(' ').split(/\s+/).filter(Boolean)
      if (spreadsOverlay && classes.length === 0) {
        throw new Error(`${fileName}:${line}: element spreads the overlay props but its className has no readable class`)
      }
      if (dynamic && !spreadsOverlay && !allowDynamic.has(`${fileName}::${dynamicText}`) && layerClasses && fileLiterals(sf).some(t => layerClasses.has(t))) {
        throw new Error(`${fileName}:${line}: cannot verify a dynamic className that does not spread the overlay props, in a file that names an overlay layer class`)
      }
      if (hasClassName || spreadsOverlay) out.push({ classes, spreadsOverlay, line, dynamic, dynamicText })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

const elementCache = new Map<string, JsxClassElement[]>()
/**
 * Dynamic classNames on NON-spreading elements in files that name an overlay
 * layer class, which are reviewed and allowed. Key: `<file under src>::<exact
 * className expression>`. Asserted both ways by the guard test.
 */
export const DYNAMIC_CLASSNAME_OK: Record<string, string> = {
  'components/Modal.tsx::{contentClassName ? `modal-content ${contentClassName}` : \'modal-content\'}':
    'the dialog box INSIDE the registered overlay: appends a caller-supplied extra class to modal-content; it can never be the overlay layer itself',
}

let layerClassSet: Set<string> | undefined
function elementsOf(file: string): JsxClassElement[] {
  let e = elementCache.get(file)
  if (!e) {
    layerClassSet ??= new Set(fullScreenLayers().map(l => l.selector.slice(1)))
    e = jsxClassElements(readFileSync(file, 'utf-8'), relative(SRC, file), layerClassSet, new Set(Object.keys(DYNAMIC_CLASSNAME_OK)))
    elementCache.set(file, e)
  }
  return e
}

/** Elements (file-relative, with line) putting `cls` in a JSX className. */
export function elementsUsingClass(cls: string, files: string[] = walkSources()): Array<{ file: string; el: JsxClassElement }> {
  const name = cls.replace(/^\./, '')
  return files.flatMap(f => elementsOf(f).filter(el => el.classes.includes(name)).map(el => ({ file: relative(SRC, f), el })))
}

/** Non-test source files that put `cls` in a JSX className (not merely name it, e.g. as a command id). */
export function filesUsingClass(cls: string, files: string[] = walkSources()): string[] {
  return [...new Set(elementsUsingClass(cls, files).map(u => u.file))].sort()
}

/** Overlay-spreading elements across the sources, with the class tokens on each. */
export function overlayElements(files: string[] = walkSources()): Array<{ file: string; el: JsxClassElement }> {
  return files.flatMap(f => elementsOf(f).filter(el => el.spreadsOverlay).map(el => ({ file: relative(SRC, f), el })))
}

export interface LayerLiteralSite { file: string; line: number; cls: string; spreading: boolean }

/**
 * EVERY occurrence of a full-screen layer class in a string literal (or template
 * chunk) of a non-test source file, with whether that very literal is part of
 * the className of an element that spreads the overlay props. Judged per
 * literal site, not per file: a file that renders the class on a spreading
 * element AND exports it as a constant is still reported at the constant.
 * A plain string data-testid value is skipped (a test hook, not a class position).
 * Only full-screen layers are scanned (pass fullScreenLayers() names), not
 * partial ones. Sources walked are .ts/.tsx/.js/.jsx; src holds no .mjs or .cjs
 * today, and one added there would need walkSources widened.
 * LIMITS: a class only ever assembled at runtime (no literal holds it), and a
 * selector literal like '.cls' (the token is '.cls', not 'cls').
 */
export function layerLiteralSites(layerClasses: ReadonlySet<string>, files: string[] = walkSources()): LayerLiteralSite[] {
  return files.flatMap(f => layerLiteralSitesIn(readFileSync(f, 'utf-8'), relative(SRC, f), layerClasses))
}

/** The per-source core of layerLiteralSites: one source string, reported under `rel`. Pure, so fixtures can pin it. */
export function layerLiteralSitesIn(src: string, rel: string, layerClasses: ReadonlySet<string>): LayerLiteralSite[] {
  const out: LayerLiteralSite[] = []
  const sf = parseSource(src, rel)
  const { names } = overlayBindings(sf)
  const spreadingClassName = (n: ts.Node): boolean => {
    for (let cur: ts.Node | undefined = n; cur; cur = cur.parent) {
      if (ts.isJsxAttribute(cur)) {
        if (!ts.isIdentifier(cur.name) || cur.name.text !== 'className') return false
        const el = cur.parent.parent
        return el.attributes.properties.some(a => ts.isJsxSpreadAttribute(a) && names.has(a.expression.getText(sf)))
      }
      if (ts.isJsxOpeningElement(cur) || ts.isJsxSelfClosingElement(cur) || ts.isStatement(cur)) return false
    }
    return false
  }
  // A plain string data-testid value is a test hook, never a class position.
  const isPlainTestId = (n: ts.Node) => ts.isStringLiteral(n) && ts.isJsxAttribute(n.parent) && ts.isIdentifier(n.parent.name) && n.parent.name.text === 'data-testid'
  const visit = (n: ts.Node) => {
    if (isPlainTestId(n)) return
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
      for (const t of n.text.split(/\s+/)) {
        if (layerClasses.has(t)) out.push({ file: rel, line, cls: t, spreading: spreadingClassName(n) })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

// ------------------------------------------------------------ inline fixed styles

export interface InlineFixedSite { file: string; line: number; value: string }

const isCssPropertiesType = (t: ts.TypeNode | undefined, sf: ts.SourceFile) => !!t && /CSSProperties/.test(t.getText(sf))

/**
 * Inline `position` declarations in dashboard sources, from object literals that
 * are (a) the value of a JSX `style` attribute or (b) the initializer of a
 * variable typed CSSProperties. Returns every one; a `position` whose value is
 * not a string literal THROWS (cannot classify). LIMIT: styles built elsewhere
 * (spread from a function result, an imported constant, a computed key) are
 * invisible to this scan.
 */
export function inlinePositionSites(files: string[] = walkSources()): InlineFixedSite[] {
  const out: InlineFixedSite[] = []
  for (const f of files) {
    inlinePositionsIn(readFileSync(f, 'utf-8'), relative(SRC, f), out)
  }
  return out
}

export function inlinePositionsIn(src: string, fileName: string, out: InlineFixedSite[] = []): InlineFixedSite[] {
  const sf = parseSource(src, fileName)
  const objects: ts.ObjectLiteralExpression[] = []
  const visit = (n: ts.Node) => {
    if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name) && n.name.text === 'style' && n.initializer && ts.isJsxExpression(n.initializer)) {
      const e = n.initializer.expression
      if (e && ts.isObjectLiteralExpression(e)) objects.push(e)
    }
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectLiteralExpression(n.initializer) && isCssPropertiesType(n.type, sf)) {
      objects.push(n.initializer)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  for (const o of objects) {
    for (const p of o.properties) {
      const key = ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ? p.name : undefined
      if (!key || !(ts.isIdentifier(key) || ts.isStringLiteral(key)) || key.text !== 'position') continue
      const line = sf.getLineAndCharacterOfPosition(p.getStart()).line + 1
      if (ts.isPropertyAssignment(p) && (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer))) {
        out.push({ file: fileName, line, value: p.initializer.text.trim().toLowerCase() })
      } else {
        throw new Error(`${fileName}:${line}: inline style position is not a string literal; cannot classify`)
      }
    }
  }
  return out
}
