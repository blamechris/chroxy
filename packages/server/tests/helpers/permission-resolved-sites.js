/**
 * Every place the daemon source ANNOUNCES `permission_resolved`, found from the syntax tree
 * with acorn (not a regex, so a comment or a string cannot satisfy or hide a site).
 *
 * A string is "permission_resolved" when it RESOLVES to it, not only when it is that literal:
 * a Literal, a template with no expressions, a `+` of resolvable parts, an Identifier bound by
 * a `const` in the same module to such a value, and a computed property key that resolves.
 *
 * Three shapes are sites:
 *   - `emit-literal`  a call with such a string as an argument (not a listener registration)
 *                     whose payload argument is an object literal
 *   - `emit-relay`    the same call whose payload is NOT a literal (a relay of an event
 *                     someone else built)
 *   - `frame-literal` an object literal with `type: <that string>` (a wire frame)
 *
 * `hasResolvedBy` is true only when the literal's `resolvedBy` VALUE is one of the vetted
 * producers: `RESOLVED_BY.<member>`, `resolvedByForReason(...)`, `normalizeResolvedBy(...)`
 * (either side of `??` / `||` / a conditional), or a `...resolvedByField(...)` spread. The
 * key merely being present does not count (`resolvedBy: undefined`, `{ kind, clientId }`).
 *
 * `scanUnclassifiedMentions` is the cross-check: every OTHER place the string appears (outside
 * a site, a listener registration, or a comment) is reported, so a shape the scanner does not
 * understand cannot hide. A caller allow-lists the legitimate ones with a reason.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from 'acorn'
import { RESOLVED_BY } from '../../src/permission-resolved-by.js'

const TARGET = 'permission_resolved'
const LISTENER_REGISTRATION = new Set(['on', 'once', 'off', 'addListener', 'removeListener', 'prependListener', 'prependOnceListener'])
const VETTED_CALLS = new Set(['resolvedByForReason', 'normalizeResolvedBy'])
// Spread helpers known to add nothing under the `resolvedBy` key (permission-manager.js).
const NEUTRAL_SPREAD_CALLS = new Set(['stoppedToolUseField'])

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return
  visit(node, parent)
  for (const key of Object.keys(node)) {
    const v = node[key]
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit, node))
    else if (v && typeof v.type === 'string') walk(v, visit, node)
  }
}

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name
  return null
}

/** The string an expression resolves to, or undefined. `consts` maps module-level names to values. */
function resolveString(node, consts) {
  if (!node) return undefined
  switch (node.type) {
    case 'Literal': return typeof node.value === 'string' ? node.value : undefined
    case 'TemplateLiteral': return node.expressions.length === 0 ? node.quasis[0].value.cooked : undefined
    case 'Identifier': return consts.get(node.name)
    case 'BinaryExpression': {
      if (node.operator !== '+') return undefined
      const l = resolveString(node.left, consts)
      const r = l === undefined ? undefined : resolveString(node.right, consts)
      return l !== undefined && r !== undefined ? l + r : undefined
    }
    default: return undefined
  }
}

function collectConsts(ast) {
  const consts = new Map()
  for (let changed = true; changed;) {
    changed = false
    walk(ast, (n) => {
      if (n.type === 'VariableDeclaration' && n.kind === 'const') {
        for (const d of n.declarations) {
          if (d.id.type !== 'Identifier' || consts.has(d.id.name)) continue
          const v = resolveString(d.init, consts)
          if (v !== undefined) { consts.set(d.id.name, v); changed = true }
        }
      }
    })
  }
  return consts
}

function keyOf(p, consts) {
  if (p.type !== 'Property') return undefined
  if (!p.computed) return p.key.type === 'Identifier' ? p.key.name : p.key.value
  return resolveString(p.key, consts)
}

function validResolvedByValue(v) {
  if (!v) return false
  // a REAL member of RESOLVED_BY: a typo or an invented kind is not vetted
  if (v.type === 'MemberExpression') return v.object.type === 'Identifier' && v.object.name === 'RESOLVED_BY' && !v.computed && v.property.type === 'Identifier' && Object.hasOwn(RESOLVED_BY, v.property.name)
  if (v.type === 'CallExpression') return v.callee.type === 'Identifier' && VETTED_CALLS.has(v.callee.name)
  if (v.type === 'LogicalExpression') return validResolvedByValue(v.left) && validResolvedByValue(v.right)
  if (v.type === 'ConditionalExpression') return validResolvedByValue(v.consequent) && validResolvedByValue(v.alternate)
  return false
}

/**
 * The effect of a list of properties on `resolvedBy`, folded in source order because the LAST
 * writer wins: 'vetted' (it ends as a vetted value), 'bad' (it ends unvetted, overridden or
 * unknown) or 'neutral' (it never touches the key).
 */
function foldProperties(properties, consts) {
  let state = 'neutral'
  for (const p of properties) {
    if (p.type === 'Property') {
      if (keyOf(p, consts) === 'resolvedBy') state = validResolvedByValue(p.value) ? 'vetted' : 'bad'
      continue
    }
    if (p.type !== 'SpreadElement') continue
    const effect = spreadEffect(p.argument, consts)
    if (effect !== 'neutral') state = effect
  }
  return state
}

function spreadEffect(arg, consts) {
  switch (arg.type) {
    case 'CallExpression': {
      const name = arg.callee.type === 'Identifier' ? arg.callee.name : null
      if (name === 'resolvedByField') return 'vetted'
      return NEUTRAL_SPREAD_CALLS.has(name) ? 'neutral' : 'bad'
    }
    case 'ObjectExpression': return foldProperties(arg.properties, consts)
    case 'ConditionalExpression': {
      const [x, y] = [spreadEffect(arg.consequent, consts), spreadEffect(arg.alternate, consts)]
      return x === y ? x : 'bad'
    }
    case 'LogicalExpression': return arg.operator === '&&' ? spreadEffect(arg.right, consts) : 'bad'
    default: return 'bad'
  }
}

function namesResolvedBy(obj, consts) {
  return foldProperties(obj.properties, consts) === 'vetted'
}

function listSourceFiles(dir) {
  const files = []
  const rec = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name)
      if (e.isDirectory()) rec(f)
      else if (e.name.endsWith('.js')) files.push(f)
    }
  }
  rec(dir)
  return files.sort()
}

/** Parse every file that could mention the string (literally or by assembling it). */
function scanFiles(srcDir, fn) {
  for (const path of listSourceFiles(srcDir)) {
    const text = readFileSync(path, 'utf8')
    const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
    fn(ast, relative(srcDir, path).split('\\').join('/'))
  }
}

/** Classify every resolvable-to-TARGET node; returns the sites and the set of nodes they cover. */
function classify(ast, file, consts) {
  const sites = []
  const covered = new Set()
  walk(ast, (node) => {
    if (node.type === 'CallExpression') {
      const at = node.arguments.findIndex((a) => resolveString(a, consts) === TARGET)
      if (at < 0) return
      covered.add(node.arguments[at])
      if (LISTENER_REGISTRATION.has(calleeName(node.callee))) return
      const payload = node.arguments[at + 1]
      if (payload?.type === 'ObjectExpression') {
        sites.push({ file, line: node.loc.start.line, shape: 'emit-literal', hasResolvedBy: namesResolvedBy(payload, consts) })
      } else {
        sites.push({ file, line: node.loc.start.line, shape: 'emit-relay', hasResolvedBy: false })
      }
    } else if (node.type === 'ObjectExpression') {
      const typeProp = node.properties.find((p) => keyOf(p, consts) === 'type' && resolveString(p.value, consts) === TARGET)
      if (typeProp) {
        covered.add(typeProp.value)
        sites.push({ file, line: node.loc.start.line, shape: 'frame-literal', hasResolvedBy: namesResolvedBy(node, consts) })
      }
    }
  })
  return { sites, covered }
}

/**
 * @param {string} srcDir
 * @returns {{ file: string, line: number, shape: 'emit-literal'|'emit-relay'|'frame-literal', hasResolvedBy: boolean }[]}
 */
export function scanPermissionResolvedSites(srcDir) {
  const sites = []
  scanFiles(srcDir, (ast, file) => sites.push(...classify(ast, file, collectConsts(ast)).sites))
  return sites
}

/**
 * Every place the string appears that is NOT a site or a listener registration: comparisons,
 * list members, object keys, constant initializers. The caller allow-lists the legitimate ones.
 * @param {string} srcDir
 * @returns {{ file: string, line: number, kind: string }[]}
 */
export function scanUnclassifiedMentions(srcDir) {
  const out = []
  scanFiles(srcDir, (ast, file) => {
    const consts = collectConsts(ast)
    const { covered } = classify(ast, file, consts)
    walk(ast, (node, parent) => {
      const isStringish = node.type === 'Literal' || node.type === 'TemplateLiteral' || (node.type === 'BinaryExpression' && node.operator === '+')
      // an object key spelled as the string (`permission_resolved: handler`) is a string too
      const isKey = node.type === 'Property' && !node.computed && node.key.type === 'Identifier' && node.key.name === TARGET
      if (isKey) { out.push({ file, line: node.loc.start.line, kind: 'property-key' }); return }
      if (!isStringish || covered.has(node)) return
      // do not double-report the halves of a resolved `+` chain
      if (node.type === 'Literal' && parent?.type === 'BinaryExpression' && resolveString(parent, consts) === TARGET) return
      if (resolveString(node, consts) !== TARGET) return
      out.push({ file, line: node.loc.start.line, kind: node.type })
    })
  })
  return out
}
