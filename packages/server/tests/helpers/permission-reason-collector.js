// The ONE parse of the `permission_resolved` reasons the server emits, and of how the
// journal reads them (#9368).
//
// Every function REFUSES (throws, or returns a `problems` entry the test turns red)
// rather than returning an empty or partial result: a guard that quantifies over zero
// emitters, or that silently skips an emit shape it cannot read, is the "cannot check
// treated as nothing to check" failure from docs/false-safety-guards.md.
//
// A resolve-path reason is the `reason` of every `emit('permission_resolved', {...})`
// call. An emit call is any `<x>.emit(...)`, `<x>['emit'](...)`, a bare `emit(...)`, and
// a call to a name bound from `.emit` (`const e = this.emit.bind(this)`, `const {emit} = this`).
// The reason is resolved from the AST as:
//   - a string literal                         reason: 'timeout'
//   - a conditional of resolvable branches     userStop ? 'stopped' : 'cleared'
//   - a local `const` of one of those          const reason = stop ? 'stopped' : 'aborted'
//   - a parameter of the enclosing function    the argument at that position of EVERY call
//     site of that function (by name); the function must not be referenced any other way
//     (`setTimeout(f)`, `.then(f)`, `const g = f`), which would hide a path's reason.
// A re-emit of a `.on('permission_resolved', (data) => ...)` listener's own payload is a
// relay, not an emitter, and is not counted.
// TRIPWIRE: every `'permission_resolved'` string literal in the file must be the event of an
// emit call or a listener registration; any other occurrence (`const EVT = '...'`) is a problem,
// and so is an emit whose event is not a string literal (it could be this one).
// Anything unresolvable is reported, never ignored.

import { parse as acornParse } from 'acorn'

const EVENT = 'permission_resolved'
const LISTENER_METHODS = new Set(['on', 'once', 'off', 'addListener', 'prependListener', 'prependOnceListener', 'removeListener', 'removeAllListeners'])

export function parseSource(src, label) {
  try {
    return acornParse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true })
  } catch (err) {
    throw new Error(`REFUSE: ${label}: cannot parse (${err.message})`)
  }
}

/** Depth-first walk giving every node its ancestor chain (nearest last). */
export function walk(node, ancestors, visit) {
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
const isStr = (n, v) => n?.type === 'Literal' && typeof n.value === 'string' && (v === undefined || n.value === v)

/** Name of a member callee/property: `.x`, `['x']`, or null when it is computed non-literally. */
function memberName(m) {
  if (m.type !== 'MemberExpression') return null
  if (!m.computed) return m.property.type === 'Identifier' ? m.property.name : null
  return m.property.type === 'Literal' && typeof m.property.value === 'string' ? m.property.value : null
}

/** Names bound from `emit` (`const e = this.emit.bind(this)`, `const {emit} = this`), program-wide. */
function emitAliases(ast) {
  const names = new Set()
  walk(ast, [], n => {
    if (n.type !== 'VariableDeclarator') return
    if (n.id.type === 'Identifier' && n.init) {
      // `x.emit` or `x.emit.bind(...)` itself, not a function that merely calls emit inside.
      const e = n.init.type === 'CallExpression' && n.init.callee.type === 'MemberExpression' && memberName(n.init.callee) === 'bind' ? n.init.callee.object : n.init
      if (e.type === 'MemberExpression' && memberName(e) === 'emit') names.add(n.id.name)
    } else if (n.id.type === 'ObjectPattern') {
      for (const p of n.id.properties) {
        if (p.type === 'Property' && propName(p) === 'emit' && p.value.type === 'Identifier') names.add(p.value.name)
      }
    }
  })
  return names
}

function isEmitCall(node, aliases) {
  if (node.type !== 'CallExpression') return false
  const c = node.callee
  if (c.type === 'Identifier') return c.name === 'emit' || aliases.has(c.name)
  if (c.type !== 'MemberExpression') return false
  if (memberName(c) === 'emit') return true
  // `emit.call(...)` / `emit.apply(...)`
  return ['call', 'apply'].includes(memberName(c)) && c.object.type === 'MemberExpression' && memberName(c.object) === 'emit'
}

function isListenerCall(node) {
  return node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
    && LISTENER_METHODS.has(memberName(node.callee)) && isStr(node.arguments[0], EVENT)
}

/** Is `ancestors` inside a function registered as a `permission_resolved` listener? */
function insideListener(ancestors) {
  return ancestors.some((a, i) => isFunction(a) && ancestors.slice(0, i).some(c => isListenerCall(c) && c.arguments.includes(a)))
}

function functionName(fn, parent) {
  if (fn.type === 'FunctionDeclaration' && fn.id) return fn.id.name
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name
  if (parent?.type === 'MethodDefinition' && parent.key.type === 'Identifier') return parent.key.name
  return null
}

/** Top-level `const X = 'literal'` bindings. */
function topLevelStrings(ast) {
  const m = new Map()
  for (const s of ast.body) {
    if (s.type !== 'VariableDeclaration') continue
    for (const d of s.declarations) if (d.id.type === 'Identifier' && isStr(d.init)) m.set(d.id.name, d.init.value)
  }
  return m
}

/**
 * Every reference to function `name` that is not a call, as problems. A reference as the
 * callee (`f()`, `x.f()`) and a property definition `{ f }` (stored, then called as `x.f()`)
 * are the accounted shapes.
 */
function strayReferences(ast, name) {
  const problems = []
  walk(ast, [], (n, anc) => {
    const parent = anc[anc.length - 1]
    if (n.type === 'Identifier' && n.name === name) {
      if (!parent) return
      if (parent.type === 'CallExpression' && parent.callee === n) return
      if (parent.type === 'VariableDeclarator' && parent.id === n) return
      if (isFunction(parent) && parent.params.includes(n)) return
      if (parent.type === 'FunctionDeclaration' && parent.id === n) return
      if (parent.type === 'Property') {
        if (parent.shorthand) return
        if (parent.key === n && !parent.computed) return
      }
      if (parent.type === 'MemberExpression' && parent.property === n && !parent.computed) return // handled below
      problems.push(`${where(n)}: '${name}' is referenced other than as a call (${parent.type}); its reason would be invisible to this guard`)
    } else if (n.type === 'MemberExpression' && memberName(n) === name) {
      if (parent?.type === 'CallExpression' && parent.callee === n) return
      problems.push(`${where(n)}: '.${name}' is referenced other than as a call (${parent?.type}); its reason would be invisible to this guard`)
    }
  })
  return problems
}

/** @returns {{values: string[], problems: string[]}} */
function resolve(expr, ancestors, ast, aliases, seen = new Set()) {
  if (expr.type === 'Literal') {
    return typeof expr.value === 'string'
      ? { values: [expr.value], problems: [] }
      : { values: [], problems: [`${where(expr)}: reason is a non-string literal`] }
  }
  if (expr.type === 'ConditionalExpression') {
    const a = resolve(expr.consequent, ancestors, ast, aliases, seen)
    const b = resolve(expr.alternate, ancestors, ast, aliases, seen)
    return { values: [...a.values, ...b.values], problems: [...a.problems, ...b.problems] }
  }
  if (expr.type !== 'Identifier') return { values: [], problems: [`${where(expr)}: reason is a ${expr.type}, not a literal this guard can resolve`] }

  const key = `${expr.name}@${expr.start}`
  if (seen.has(key)) return { values: [], problems: [`${where(expr)}: reason '${expr.name}' is defined in terms of itself`] }
  seen.add(key)

  for (let i = ancestors.length - 1; i >= 0; i--) {
    const fn = ancestors[i]
    if (!isFunction(fn)) continue
    const idx = fn.params.findIndex(p => p.type === 'Identifier' && p.name === expr.name)
    if (idx >= 0) {
      const name = functionName(fn, ancestors[i - 1])
      if (!name) return { values: [], problems: [`${where(expr)}: reason '${expr.name}' is a parameter of an anonymous function`] }
      const out = { values: [], problems: strayReferences(ast, name) }
      let sites = 0
      walk(ast, [], (n, anc) => {
        if (n.type !== 'CallExpression') return
        const c = n.callee
        const callee = c.type === 'Identifier' ? c.name : memberName(c)
        if (callee !== name) return
        if (!n.arguments[idx]) { out.problems.push(`${where(n)}: call to '${name}' passes no argument for '${expr.name}'`); return }
        sites++
        const r = resolve(n.arguments[idx], [...anc], ast, aliases, new Set(seen))
        out.values.push(...r.values); out.problems.push(...r.problems)
      })
      if (sites === 0) out.problems.push(`${where(expr)}: parameter '${expr.name}' of '${name}' has no call site that passes it`)
      return out
    }
    const decls = []
    walk(fn.body, [], (n, anc) => {
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === expr.name) {
        if (!anc.some(a => isFunction(a))) decls.push({ n, anc: [fn, ...anc] })
      }
    })
    if (decls.length > 1) return { values: [], problems: [`${where(expr)}: '${expr.name}' is declared ${decls.length} times in one function`] }
    if (decls.length === 1) {
      if (!decls[0].n.init) return { values: [], problems: [`${where(expr)}: '${expr.name}' has no initializer`] }
      return resolve(decls[0].n.init, decls[0].anc, ast, aliases, seen)
    }
  }
  return { values: [], problems: [`${where(expr)}: reason '${expr.name}' is not bound to a literal in any enclosing function`] }
}

/** Can an object-literal spread carry a `reason`? Returns a problem string or null. */
function spreadProblem(arg, ast) {
  const objectsOf = e => {
    if (e.type === 'ObjectExpression') return [e]
    if (e.type === 'ConditionalExpression') { const a = objectsOf(e.consequent), b = objectsOf(e.alternate); return a && b ? [...a, ...b] : null }
    return null
  }
  const checkObjects = objs => objs.every(o => o.properties.every(p => p.type === 'Property' && !p.computed && propName(p) !== 'reason'))
  let objs = objectsOf(arg)
  if (!objs && arg.type === 'CallExpression' && arg.callee.type === 'Identifier') {
    const decl = ast.body.find(s => s.type === 'FunctionDeclaration' && s.id.name === arg.callee.name)
    if (decl) {
      const returns = []
      walk(decl.body, [], n => { if (n.type === 'ReturnStatement') returns.push(n.argument) })
      const all = returns.map(r => (r ? objectsOf(r) : null))
      if (returns.length > 0 && all.every(Boolean)) objs = all.flat()
    }
  }
  if (objs && checkObjects(objs)) return null
  return `${where(arg)}: spread in a payload that this guard cannot show lacks a \`reason\` (it could override it)`
}

/**
 * Every reason `permission_resolved` is emitted with in `src`.
 * @returns {{reasons: Set<string>, emits: number, problems: string[]}}
 */
export function collectResolvedReasons(src, label) {
  const ast = parseSource(src, label)
  const aliases = emitAliases(ast)
  const consts = topLevelStrings(ast)
  const reasons = new Set()
  const problems = []
  let emits = 0
  let relays = 0
  walk(ast, [], (node, ancestors) => {
    // Tripwire: every 'permission_resolved' literal is the event of an emit or a listener.
    if (isStr(node, EVENT)) {
      const parent = ancestors[ancestors.length - 1]
      const claimed = parent?.type === 'CallExpression' && parent.arguments[0] === node && (isEmitCall(parent, aliases) || isListenerCall(parent))
      if (!claimed) problems.push(`${where(node)}: '${EVENT}' literal is neither an emit's event nor a listener registration (an emit through it would be invisible)`)
    }
    if (!isEmitCall(node, aliases)) return
    const callee = node.callee
    if (callee.type === 'MemberExpression' && ['call', 'apply'].includes(memberName(callee))) {
      problems.push(`${where(node)}: emit.call/apply cannot be analysed`)
      return
    }
    const ev = node.arguments[0]
    const evName = isStr(ev) ? ev.value : ev?.type === 'Identifier' && consts.has(ev.name) ? consts.get(ev.name) : null
    if (evName === null) { problems.push(`${where(node)}: emit whose event is not a string literal: it could be '${EVENT}'`); return }
    if (evName !== EVENT) return
    emits++
    const obj = node.arguments[1]
    if (obj?.type === 'Identifier' && insideListener(ancestors) && ancestors.some(a => isFunction(a) && a.params.some(q => q.type === 'Identifier' && q.name === obj.name))) { relays++; return }
    if (obj?.type !== 'ObjectExpression') { problems.push(`${where(node)}: payload is not an object literal`); return }
    for (const p of obj.properties) {
      if (p.type === 'SpreadElement') { const sp = spreadProblem(p.argument, ast); if (sp) problems.push(sp) }
      else if (p.computed && p.key.type !== 'Literal') problems.push(`${where(p)}: computed payload key could be \`reason\``)
    }
    const prop = obj.properties.find(p => p.type === 'Property' && propName(p) === 'reason')
    if (!prop) { problems.push(`${where(node)}: emit has no \`reason\` property`); return }
    const r = resolve(prop.value, [...ancestors, node, obj], ast, aliases)
    r.values.forEach(v => reasons.add(v))
    problems.push(...r.problems)
  })
  return { reasons, emits: emits - relays, problems }
}

/**
 * How one source file touches `permission_resolved`, for the all-of-src roster. Emit-like
 * calls (a callee named like `emit`, `_emitAgentEvent`, or an alias of `.emit`) carrying the
 * event as ANY argument must be a relay inside a `permission_resolved` listener; everything
 * else is classified: `listeners`, `relays`, `comparisons`, `frames` (an object literal with
 * `type: 'permission_resolved'`, whose literal `reason`s are returned), `other`.
 * @returns {{violations: string[], listeners: number, relays: number, comparisons: number, frames: number, frameReasons: string[], other: number}}
 */
export function classifyResolvedUses(src, label) {
  const ast = parseSource(src, label)
  const aliases = emitAliases(ast)
  const consts = topLevelStrings(ast)
  const out = { violations: [], listeners: 0, relays: 0, comparisons: 0, frames: 0, frameReasons: [], other: 0 }
  const isEv = a => isStr(a, EVENT) || (a?.type === 'Identifier' && consts.get(a.name) === EVENT)
  const emitLike = n => {
    if (n.type !== 'CallExpression') return false
    if (isEmitCall(n, aliases)) return true
    const c = n.callee
    const name = c.type === 'Identifier' ? c.name : memberName(c)
    return typeof name === 'string' && /emit/i.test(name)
  }
  walk(ast, [], (n, anc) => {
    const parent = anc[anc.length - 1]
    if (n.type === 'CallExpression' && emitLike(n) && n.arguments.some(isEv)) {
      if (insideListener(anc)) out.relays++
      else out.violations.push(`${where(n)}: emits '${EVENT}' outside a '${EVENT}' listener`)
    }
    if (isListenerCall(n)) out.listeners++
    if (n.type === 'ObjectExpression') {
      const t = n.properties.find(p => p.type === 'Property' && propName(p) === 'type' && isStr(p.value, EVENT))
      if (t) {
        out.frames++
        for (const p of n.properties) if (p.type === 'Property' && propName(p) === 'reason' && isStr(p.value)) out.frameReasons.push(p.value.value)
      }
    }
    if (isStr(n, EVENT)) {
      if (parent?.type === 'BinaryExpression' || parent?.type === 'SwitchCase') out.comparisons++
      else if (!(parent?.type === 'CallExpression') && !(parent?.type === 'Property')) out.other++
    }
  })
  return out
}

/**
 * Positive check on the journal's reason map: inside `permissionOutcomeForEvent`, every read
 * of the event's `reason` (a `.reason` member of the data parameter or an alias of it, or a
 * name destructured from it) must be a direct argument of `permissionOutcomeForReason`, the
 * shared table's lookup, and there must be at least one such call. The data parameter itself
 * may only be read through a plain `.member` (or negated), never handed on, spread or indexed,
 * so no helper, lookup object, `in`, Map, regex or `switch` can see the reason.
 * Throws if the function (or its import from '@chroxy/protocol') is missing.
 * @returns {{problems: string[], lookups: number}}
 */
export function checkJournalReasonReads(src, label, fnName = 'permissionOutcomeForEvent') {
  const ast = parseSource(src, label)
  let fn = null
  walk(ast, [], n => { if (n.type === 'FunctionDeclaration' && n.id?.name === fnName) fn = n })
  if (!fn) throw new Error(`REFUSE: ${label}: no function ${fnName} -- the guard on how it reads \`reason\` cannot run`)
  const imported = ast.body.some(s => s.type === 'ImportDeclaration' && s.source.value === '@chroxy/protocol'
    && s.specifiers.some(x => x.imported?.name === 'permissionOutcomeForReason' && x.local.name === 'permissionOutcomeForReason'))
  if (!imported) throw new Error(`REFUSE: ${label}: permissionOutcomeForReason is not imported from '@chroxy/protocol' -- the table lookup is not the shared one`)
  if (fn.params.length < 2 || fn.params[1].type !== 'Identifier') throw new Error(`REFUSE: ${label}: ${fnName}'s second parameter is not a plain identifier`)

  const dataNames = new Set([fn.params[1].name])
  const reasonNames = new Set()
  const keyIsReason = p => p.type === 'Property' && propName(p) === 'reason'
  for (let changed = true; changed;) {
    changed = false
    walk(fn.body, [], n => {
      if (n.type !== 'VariableDeclarator' || !n.init) return
      if (n.init.type === 'Identifier' && dataNames.has(n.init.name)) {
        if (n.id.type === 'Identifier' && !dataNames.has(n.id.name)) { dataNames.add(n.id.name); changed = true }
        if (n.id.type === 'ObjectPattern') {
          for (const p of n.id.properties) {
            if (keyIsReason(p) && p.value.type === 'Identifier' && !reasonNames.has(p.value.name)) { reasonNames.add(p.value.name); changed = true }
            else if (p.type === 'RestElement') reasonNames.add('<rest>')
          }
        }
      }
      if (n.id.type === 'Identifier' && n.init.type === 'MemberExpression' && dataNames.has(n.init.object.name) && memberName(n.init) === 'reason' && !reasonNames.has(n.id.name)) {
        reasonNames.add(n.id.name); changed = true
      }
      if (n.id.type === 'Identifier' && n.init.type === 'Identifier' && reasonNames.has(n.init.name) && !reasonNames.has(n.id.name)) { reasonNames.add(n.id.name); changed = true }
    })
  }

  const problems = []
  let lookups = 0
  if (reasonNames.has('<rest>')) problems.push(`${label}: a rest element destructured from the event hides its reason`)
  const isLookupArg = (n, parent) => parent?.type === 'CallExpression' && parent.callee.type === 'Identifier'
    && parent.callee.name === 'permissionOutcomeForReason' && parent.arguments.includes(n)
  walk(fn.body, [], (n, anc) => {
    const parent = anc[anc.length - 1]
    if (n.type === 'MemberExpression' && n.object.type === 'Identifier' && dataNames.has(n.object.name)) {
      const name = memberName(n)
      if (name === null) problems.push(`${where(n)}: computed access on the event could read its reason`)
      else if (name === 'reason') { if (isLookupArg(n, parent)) lookups++; else problems.push(`${where(n)}: the event's reason is read other than as the argument of permissionOutcomeForReason`) }
      return
    }
    if (n.type === 'Identifier' && reasonNames.has(n.name)) {
      if (parent?.type === 'VariableDeclarator' && parent.id === n) return
      if (parent?.type === 'Property' && parent.key === n && !parent.shorthand) return
      if (parent?.type === 'Property' && anc[anc.length - 2]?.type === 'ObjectPattern') return // the pattern's own binding
      if (isLookupArg(n, parent)) lookups++
      else problems.push(`${where(n)}: '${n.name}' (the event's reason) is used other than as the argument of permissionOutcomeForReason`)
      return
    }
    if (n.type === 'Identifier' && dataNames.has(n.name)) {
      if (!parent) return
      if (parent.type === 'MemberExpression' && parent.object === n) return // checked above
      if (parent.type === 'UnaryExpression' && parent.operator === '!') return
      if (parent.type === 'VariableDeclarator' && (parent.id === n || parent.init === n)) return
      if (isFunction(parent) && parent.params.includes(n)) return
      problems.push(`${where(n)}: the event ('${n.name}') is used as a ${parent.type}, so its reason could be read where this guard cannot see`)
    }
  })
  if (lookups === 0) problems.push(`${label}: ${fnName} never passes the event's reason to permissionOutcomeForReason`)
  return { problems, lookups }
}
