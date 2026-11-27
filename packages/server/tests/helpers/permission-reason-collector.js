// The ONE parse of the `permission_resolved` reasons a source file emits (#9368).
//
// Every function REFUSES (throws, naming the anchor it lost) rather than
// returning an empty or partial result: a guard that quantifies over zero
// emitters is the "cannot check treated as nothing to check" failure from
// docs/false-safety-guards.md.
//
// What counts as a reason on a resolve path: every `<x>.emit('permission_resolved',
// { ..., reason: <expr>, ... })` call. permission-manager.js builds the reason four ways,
// and each is resolved from the AST:
//   - a string literal                         reason: 'timeout'
//   - a conditional of resolvable branches     userStop ? 'stopped' : 'cleared'
//   - a local `const` of one of those          const reason = stop ? 'stopped' : 'aborted'
//   - a parameter of the enclosing function    finish(false, 'cancelled'); the reason is the
//     argument at that position of EVERY call site of that function (by name)
// A re-emit of a `.on('permission_resolved', (data) => ...)` listener's own payload is a relay, not
// an emitter, and is not counted.
// Anything else (a member read, a call, a template, an unbound name) is reported as
// unresolvable, and so is an emit with no `reason` property or a parameter with no call site.

import { parse as acornParse } from 'acorn'

function parseSource(src, label) {
  try {
    return acornParse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true })
  } catch (err) {
    throw new Error(`REFUSE: ${label}: cannot parse (${err.message})`)
  }
}

/** Depth-first walk giving every node its ancestor chain (nearest last). */
function walk(node, ancestors, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node, ancestors)
  ancestors.push(node)
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue
    const child = node[key]
    if (Array.isArray(child)) child.forEach(c => c && typeof c.type === 'string' && walk(c, ancestors, visit))
    else if (child && typeof child.type === 'string') walk(child, ancestors, visit)
  }
  ancestors.pop()
}

const isFunction = n => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression'
const where = n => `line ${n.loc.start.line}`
const propName = p => (p.key.type === 'Identifier' && !p.computed ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : null)

function isResolveEmit(node) {
  return node.type === 'CallExpression'
    && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.name === 'emit'
    && node.arguments[0]?.type === 'Literal' && node.arguments[0].value === 'permission_resolved'
}

/** Name a function is callable by: `const f = () => ..`, `function f`, or a method key. */
function functionName(fn, parent) {
  if (fn.type === 'FunctionDeclaration' && fn.id) return fn.id.name
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name
  if (parent?.type === 'MethodDefinition' && parent.key.type === 'Identifier') return parent.key.name
  return null
}

/**
 * Resolve an expression to string literals.
 * @returns {{values: string[], problems: string[]}}
 */
function resolve(expr, ancestors, ast, seen = new Set()) {
  if (expr.type === 'Literal') {
    return typeof expr.value === 'string'
      ? { values: [expr.value], problems: [] }
      : { values: [], problems: [`${where(expr)}: reason is a non-string literal`] }
  }
  if (expr.type === 'ConditionalExpression') {
    const a = resolve(expr.consequent, ancestors, ast, seen)
    const b = resolve(expr.alternate, ancestors, ast, seen)
    return { values: [...a.values, ...b.values], problems: [...a.problems, ...b.problems] }
  }
  if (expr.type !== 'Identifier') return { values: [], problems: [`${where(expr)}: reason is a ${expr.type}, not a literal this guard can resolve`] }

  const key = `${expr.name}@${expr.start}`
  if (seen.has(key)) return { values: [], problems: [`${where(expr)}: reason '${expr.name}' is defined in terms of itself`] }
  seen.add(key)

  for (let i = ancestors.length - 1; i >= 0; i--) {
    const fn = ancestors[i]
    if (!isFunction(fn)) continue
    // A parameter: the reason is whatever EVERY call site passes at that position.
    const idx = fn.params.findIndex(p => p.type === 'Identifier' && p.name === expr.name)
    if (idx >= 0) {
      const name = functionName(fn, ancestors[i - 1])
      if (!name) return { values: [], problems: [`${where(expr)}: reason '${expr.name}' is a parameter of an anonymous function`] }
      const out = { values: [], problems: [] }
      let sites = 0
      walk(ast, [], (n, anc) => {
        if (n.type !== 'CallExpression') return
        const c = n.callee
        const callee = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' && !c.computed ? c.property.name : null)
        if (callee !== name || !n.arguments[idx]) return
        sites++
        const r = resolve(n.arguments[idx], [...anc], ast, new Set(seen))
        out.values.push(...r.values); out.problems.push(...r.problems)
      })
      if (sites === 0) out.problems.push(`${where(expr)}: parameter '${expr.name}' of '${name}' has no call site that passes it`)
      return out
    }
    // A local const/let declared in this function.
    const decls = []
    walk(fn.body, [], (n, anc) => {
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === expr.name) {
        if (!anc.some(a => isFunction(a))) decls.push({ n, anc: [fn, ...anc] })
      }
    })
    if (decls.length > 1) return { values: [], problems: [`${where(expr)}: '${expr.name}' is declared ${decls.length} times in one function`] }
    if (decls.length === 1) {
      if (!decls[0].n.init) return { values: [], problems: [`${where(expr)}: '${expr.name}' has no initializer`] }
      return resolve(decls[0].n.init, decls[0].anc, ast, seen)
    }
  }
  return { values: [], problems: [`${where(expr)}: reason '${expr.name}' is not bound to a literal in any enclosing function`] }
}

/**
 * Every reason `permission_resolved` is emitted with in `src`.
 * @returns {{reasons: Set<string>, emits: number, problems: string[]}}
 */
export function collectResolvedReasons(src, label) {
  const ast = parseSource(src, label)
  const reasons = new Set()
  const problems = []
  let emits = 0
  let relays = 0
  walk(ast, [], (node, ancestors) => {
    if (!isResolveEmit(node)) return
    emits++
    const obj = node.arguments[1]
    // A relay re-emits the payload a `.on('permission_resolved', (data) => ...)` listener
    // received: the reason was already collected at the emit that produced it.
    if (obj?.type === 'Identifier' && ancestors.some(a => isFunction(a) && a.params.some(q => q.type === 'Identifier' && q.name === obj.name)
      && ancestors.some(c => c.type === 'CallExpression' && c.callee.type === 'MemberExpression' && c.callee.property.name === 'on'
        && c.arguments[0]?.type === 'Literal' && c.arguments[0].value === 'permission_resolved' && c.arguments.includes(a)))) { relays++; return }
    if (obj?.type !== 'ObjectExpression') { problems.push(`${where(node)}: payload is not an object literal`); return }
    const prop = obj.properties.find(p => p.type === 'Property' && propName(p) === 'reason')
    if (!prop) { problems.push(`${where(node)}: emit has no \`reason\` property`); return }
    const r = resolve(prop.value, [...ancestors, node, obj], ast)
    r.values.forEach(v => reasons.add(v))
    problems.push(...r.problems)
  })
  return { reasons, emits: emits - relays, problems }
}

/**
 * Comparisons of a REASON against a string literal inside `permissionOutcomeForEvent`:
 * a ==/===/!=/!== BinaryExpression, a switch with literal cases, or a literal-collection
 * membership test (`.includes/.has/.indexOf/.startsWith/.endsWith`), where the other side
 * reads `reason` (a `.reason` member, a `reason` identifier, or a local aliased from one).
 * Comparisons of other fields (`event === 'permission_expired'`) are not reason maps and pass.
 * Returns the offenders; throws if the function is absent.
 */
export function findInlineReasonComparisons(src, label, fnName = 'permissionOutcomeForEvent') {
  const ast = parseSource(src, label)
  let fn = null
  walk(ast, [], n => {
    if (n.type === 'FunctionDeclaration' && n.id?.name === fnName) fn = n
  })
  if (!fn) throw new Error(`REFUSE: ${label}: no function ${fnName} -- the guard that it compares no reason literal cannot run`)
  const isStr = n => n && ((n.type === 'Literal' && typeof n.value === 'string') || (n.type === 'TemplateLiteral' && n.expressions.length === 0))
  const readsReason = (expr, names) => {
    let found = false
    walk(expr, [], n => {
      if (n.type === 'MemberExpression' && ((!n.computed && n.property.name === 'reason') || (n.computed && n.property.type === 'Literal' && n.property.value === 'reason'))) found = true
      if (n.type === 'Identifier' && names.has(n.name)) found = true
      if (n.type === 'Property' && propName(n) === 'reason' && n.value.type === 'Identifier') names.add(n.value.name)
    })
    return found
  }
  // Names that carry a reason: `reason`, any local initialised from a read of one, and
  // any destructured `reason`. Iterated to a fixpoint so alias chains are followed.
  const names = new Set(['reason'])
  for (let changed = true; changed;) {
    changed = false
    walk(fn, [], n => {
      if (n.type === 'VariableDeclarator' && n.init && n.id.type === 'Identifier' && !names.has(n.id.name) && readsReason(n.init, names)) {
        names.add(n.id.name); changed = true
      }
      if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern') {
        for (const p of n.id.properties) {
          if (p.type === 'Property' && propName(p) === 'reason' && p.value.type === 'Identifier' && !names.has(p.value.name)) { names.add(p.value.name); changed = true }
        }
      }
    })
  }
  const hits = []
  walk(fn.body, [], n => {
    if (n.type === 'BinaryExpression' && ['==', '===', '!=', '!=='].includes(n.operator)) {
      const [lit, other] = isStr(n.left) ? [n.left, n.right] : isStr(n.right) ? [n.right, n.left] : [null, null]
      if (lit && readsReason(other, names)) hits.push(`${where(n)}: reason compared ${n.operator} a string literal`)
    } else if (n.type === 'SwitchStatement' && n.cases.some(c => isStr(c.test)) && readsReason(n.discriminant, names)) {
      hits.push(`${where(n)}: switch on a reason with string-literal cases`)
    } else if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed
      && ['includes', 'has', 'indexOf', 'startsWith', 'endsWith'].includes(n.callee.property.name)) {
      const literalSide = n.callee.object.type === 'ArrayExpression' || isStr(n.callee.object) || n.arguments.some(isStr)
      const reasonSide = n.arguments.some(a => readsReason(a, names)) || readsReason(n.callee.object, names)
      if (literalSide && reasonSide) hits.push(`${where(n)}: .${n.callee.property.name}() of a reason against a literal`)
    }
  })
  return hits
}
