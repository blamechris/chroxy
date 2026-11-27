// The ONE parse of the `permission_resolved` reasons the server emits, and of how the
// journal reads them (#9368).
//
// Every function REFUSES (throws, or returns a `problems` entry the test turns red)
// rather than returning an empty or partial result: a guard that quantifies over zero
// emitters, or that silently skips an emit shape it cannot read, is the "cannot check
// treated as nothing to check" failure from docs/false-safety-guards.md.
//
// FAIL CLOSED. Rather than list bad shapes, the guard accepts a short list of understood ones:
//   - a resolve-path reason is the `reason` of every `emit('permission_resolved', {...})` call
//     (`x.emit`, `x['emit']`, a bare `emit`, a name bound from `.emit`/`.emit.bind`);
//   - a reason resolves through a string literal, a conditional of resolvable branches, a `const`
//     of those, or a parameter that is NEVER assigned (then the argument at that position of EVERY
//     call site of the function, which must not be referenced any other way). A `let`, a `var`,
//     a reassigned parameter or a destructured binding is a problem;
//   - a re-emit is a RELAY only if its payload is the enclosing `permission_resolved` listener's
//     own parameter and that listener leaves it untouched (`checkRelay`); any other non-literal
//     payload is a problem, never skipped;
//   - EVERY 'permission_resolved' string or expression-free template literal in a file must be
//     classified (`classifyLiteral`): a listener registration, an emit's event, a comparison, a
//     wire-frame `type:` value, or a roster array element. Anything else is a problem naming file:line.

import { parse as acornParse } from 'acorn'

const EVENT = 'permission_resolved'
const LISTENER_METHODS = new Set(['on', 'once', 'off', 'addListener', 'prependListener', 'prependOnceListener', 'removeListener', 'removeAllListeners'])
/** Calls that forward an event as [eventIdx, payloadIdx]: the byok agent-event wrapper (`emit` is [0, 1]). */
const WRAPPER_EMITTERS = new Map([['_emitAgentEvent', [1, 2]]])

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
/** The event name as a string literal OR an expression-free template literal. */
const isEventLit = n => isStr(n, EVENT) || (n?.type === 'TemplateLiteral' && n.expressions.length === 0 && n.quasis[0].value.cooked === EVENT)
const identsIn = n => { const out = []; walk(n, [], m => { if (m.type === 'Identifier') out.push(m.name) }); return out }

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

/** [eventIdx, payloadIdx] if `call` forwards an event, else null. */
function relayShape(call, aliases) {
  if (call.type !== 'CallExpression') return null
  if (isEmitCall(call, aliases)) return [0, 1]
  const c = call.callee
  return WRAPPER_EMITTERS.get(c.type === 'Identifier' ? c.name : memberName(c)) ?? null
}

function isListenerCall(node) {
  return node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
    && LISTENER_METHODS.has(memberName(node.callee)) && isEventLit(node.arguments[0])
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
 * The one relay predicate. `call` forwards the event with payload `call.arguments[payloadIdx]`.
 * It is a RELAY (not an emitter of reasons of its own) only when that payload is a parameter of
 * the nearest enclosing `permission_resolved` listener callback AND the listener leaves the
 * parameter UNTOUCHED: it appears only as a relay payload, in a plain non-assignment member read
 * (`d.requestId`), or in a test position (`if (d && ...)`). Assigning to it or to a member,
 * `delete`, passing it to any other call, spreading it, or aliasing it are problems.
 * @returns {{ok: boolean, problems: string[]}}  ok=false with no problems = not a relay at all.
 */
function checkRelay(call, ancestors, payloadIdx) {
  const payload = call.arguments[payloadIdx]
  if (payload?.type !== 'Identifier') return { ok: false, problems: [] }
  let fn = null
  for (let i = ancestors.length - 1; i >= 0 && !fn; i--) {
    const a = ancestors[i]
    if (isFunction(a) && ancestors.slice(0, i).some(c => isListenerCall(c) && c.arguments.includes(a))
      && a.params.some(q => q.type === 'Identifier' && q.name === payload.name)) fn = a
  }
  if (!fn) return { ok: false, problems: [] }
  const problems = []
  walk(fn.body, [], (n, anc) => {
    if (n.type !== 'Identifier' || n.name !== payload.name) return
    const parent = anc[anc.length - 1]
    if (!parent) return
    const bad = why => problems.push(`${where(n)}: the relayed payload '${n.name}' is ${why}, so the reason it forwards is no longer the emitter's`)
    if (parent.type === 'CallExpression' && parent.callee !== n) {
      const k = parent.arguments.indexOf(n)
      if (k >= 1 && isEventLit(parent.arguments[k - 1])) return // a relay payload
      return bad('passed to another call')
    }
    if (parent.type === 'MemberExpression' && parent.object === n) {
      let top = parent
      let up = anc.length - 2
      while (up >= 0 && anc[up].type === 'MemberExpression' && anc[up].object === top) { top = anc[up]; up-- }
      const g = anc[up]
      if (g && ((g.type === 'AssignmentExpression' && g.left === top) || g.type === 'UpdateExpression'
        || (g.type === 'UnaryExpression' && g.operator === 'delete'))) bad('assigned to, updated or deleted through a member')
      return // otherwise a plain member read
    }
    // A test position: `if (d && d.x)`, `!d`, `typeof d`.
    let cur = n
    let idx = anc.length - 1
    while (idx >= 0 && ['LogicalExpression', 'UnaryExpression', 'BinaryExpression'].includes(anc[idx].type)
      && !(anc[idx].type === 'UnaryExpression' && anc[idx].operator === 'delete')) { cur = anc[idx]; idx-- }
    const holder = anc[idx]
    if (holder && (holder.type === 'IfStatement' || holder.type === 'ConditionalExpression') && holder.test === cur) return
    bad(`used as a ${parent.type}`)
  })
  return { ok: problems.length === 0, problems }
}

/**
 * How one 'permission_resolved' literal is used, or null (unclassified).
 *   listener    the event of `.on/.once/.off/...`
 *   emit        the event of an emit call or the byok agent-event wrapper
 *   comparison  an operand of ==, ===, !=, !==, or a `case` test
 *   frame       the value of a `type:` property of an object literal (a wire frame)
 *   roster      an element of an array literal (a list of event names; it cannot emit)
 */
function classifyLiteral(node, ancestors, aliases) {
  const parent = ancestors[ancestors.length - 1]
  if (!parent) return null
  if (parent.type === 'CallExpression') {
    const k = parent.arguments.indexOf(node)
    if (k === 0 && isListenerCall(parent)) return 'listener'
    const shape = relayShape(parent, aliases)
    return shape && shape[0] === k ? 'emit' : null
  }
  if (parent.type === 'BinaryExpression' && ['==', '===', '!=', '!=='].includes(parent.operator)) return 'comparison'
  if (parent.type === 'SwitchCase' && parent.test === node) return 'comparison'
  if (parent.type === 'Property' && parent.value === node && !parent.computed && propName(parent) === 'type'
    && ancestors[ancestors.length - 2]?.type === 'ObjectExpression') return 'frame'
  if (parent.type === 'ArrayExpression') return 'roster'
  return null
}

/** Every AssignmentExpression / UpdateExpression in `body` that targets the plain name `name`. */
function assignmentsTo(body, name) {
  const hits = []
  walk(body, [], n => {
    if (n.type === 'AssignmentExpression' && n.left.type !== 'MemberExpression' && identsIn(n.left).includes(name)) hits.push(n)
    else if (n.type === 'UpdateExpression' && n.argument.type === 'Identifier' && n.argument.name === name) hits.push(n)
  })
  return hits
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
      const reassigned = assignmentsTo(fn.body, expr.name)
      if (reassigned.length) return { values: [], problems: reassigned.map(a => `${where(a)}: reason parameter '${expr.name}' is reassigned, so its call-site literals are not what is emitted`) }
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
    const patterned = []
    walk(fn.body, [], (n, anc) => {
      if (n.type !== 'VariableDeclarator' || anc.some(a => isFunction(a))) return
      if (n.id.type === 'Identifier' && n.id.name === expr.name) decls.push({ n, anc: [fn, ...anc], kind: anc[anc.length - 1].kind })
      else if (n.id.type !== 'Identifier' && identsIn(n.id).includes(expr.name)) patterned.push(n)
    })
    if (patterned.length) return { values: [], problems: [`${where(patterned[0])}: '${expr.name}' is bound by a destructuring pattern this guard cannot follow`] }
    if (decls.length > 1) return { values: [], problems: [`${where(expr)}: '${expr.name}' is declared ${decls.length} times in one function`] }
    if (decls.length === 1) {
      if (decls[0].kind !== 'const') return { values: [], problems: [`${where(decls[0].n)}: '${expr.name}' is a \`${decls[0].kind}\`; only a \`const\` reason can be resolved`] }
      const reassigned = assignmentsTo(fn.body, expr.name)
      if (reassigned.length) return { values: [], problems: reassigned.map(a => `${where(a)}: '${expr.name}' is assigned after its declaration`) }
      if (!decls[0].n.init) return { values: [], problems: [`${where(expr)}: '${expr.name}' has no initializer`] }
      return resolve(decls[0].n.init, decls[0].anc, ast, aliases, seen)
    }
  }
  return { values: [], problems: [`${where(expr)}: reason '${expr.name}' is not bound to a literal in any enclosing function`] }
}

/**
 * Can a payload spread carry a `reason`? Returns a problem string or null.
 * `passThrough` (wire frames only) additionally accepts a reason that is a plain
 * `<param>.reason` read, and a spread of an enclosing function's own parameter.
 */
function spreadProblem(arg, ast, params = new Set(), passThrough = false, trusted = new Set()) {
  const bad = `${where(arg)}: spread in a payload that this guard cannot show lacks a \`reason\` (it could override it)`
  if (passThrough && arg.type === 'Identifier' && params.has(arg.name)) return null
  if (arg.type === 'CallExpression' && arg.callee.type === 'Identifier' && trusted.has(arg.callee.name)) return null
  const objectsOf = e => {
    if (e.type === 'ObjectExpression') return [e]
    if (e.type === 'ConditionalExpression') { const a = objectsOf(e.consequent), b = objectsOf(e.alternate); return a && b ? [...a, ...b] : null }
    if (e.type === 'LogicalExpression') return objectsOf(e.right)
    return null
  }
  const reasonFree = o => o.properties.every(p => p.type === 'Property' && !p.computed && (propName(p) !== 'reason'
    || (passThrough && frameReasonProblem(p.value, params) === null)))
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
  return objs && objs.every(reasonFree) ? null : bad
}

/** A wire frame's `reason` value: a string literal or `<param>.reason`; else a problem string. */
function frameReasonProblem(v, params) {
  if (isStr(v)) return null
  if (v.type === 'MemberExpression' && memberName(v) === 'reason' && v.object.type === 'Identifier' && params.has(v.object.name)) return null
  return `${where(v)}: a wire frame's reason is a ${v.type}, not a string literal or a pass-through of a handler parameter's \`reason\``
}

const fnParams = ancestors => new Set(ancestors.filter(isFunction).flatMap(f => f.params.filter(q => q.type === 'Identifier').map(q => q.name)))

/**
 * Every reason `permission_resolved` is emitted with in `src` (permission-manager.js).
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
    if (isEventLit(node)) {
      const kind = classifyLiteral(node, ancestors, aliases)
      if (kind !== 'listener' && kind !== 'emit') problems.push(`${where(node)}: '${EVENT}' literal is neither an emit's event nor a listener registration (an emit through it would be invisible)`)
    }
    if (!isEmitCall(node, aliases)) return
    const callee = node.callee
    if (callee.type === 'MemberExpression' && ['call', 'apply'].includes(memberName(callee))) {
      problems.push(`${where(node)}: emit.call/apply cannot be analysed`)
      return
    }
    const ev = node.arguments[0]
    const evName = isEventLit(ev) ? EVENT : isStr(ev) ? ev.value : ev?.type === 'Identifier' && consts.has(ev.name) ? consts.get(ev.name) : null
    if (evName === null) { problems.push(`${where(node)}: emit whose event is not a string literal: it could be '${EVENT}'`); return }
    if (evName !== EVENT) return
    emits++
    const obj = node.arguments[1]
    if (obj?.type !== 'ObjectExpression') {
      const rel = checkRelay(node, ancestors, 1)
      if (rel.ok) relays++
      else problems.push(...(rel.problems.length ? rel.problems : [`${where(node)}: payload is neither an object literal nor the untouched parameter of a '${EVENT}' listener`]))
      return
    }
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
 * How one source file uses the event, for the all-of-src roster. Every literal is classified
 * (`classifyLiteral`); an unclassified one is a problem. An emit of the event outside
 * permission-manager.js must be a valid relay (`checkRelay`), so a literal-object emit, even
 * inside a listener, is a violation. A `roster` (array element) use is a problem unless `allowRoster`. A wire frame's `reason` must be a string literal (returned
 * in `frameReasons`) or a pass-through of a handler parameter's `.reason`. `trustedSpreadFns`
 * names imported helpers whose returns the caller has verified reason-free with `returnsReasonFreeObjects`.
 * @returns {{problems: string[], counts: Record<string, number>, frameReasons: string[]}}
 */
export function classifyResolvedUses(src, label, { allowEmitters = false, allowRoster = false, trustedSpreadFns = new Set() } = {}) {
  const ast = parseSource(src, label)
  const aliases = emitAliases(ast)
  const counts = { listener: 0, emit: 0, relay: 0, comparison: 0, frame: 0, roster: 0 }
  const problems = []
  const frameReasons = []
  walk(ast, [], (n, anc) => {
    if (!isEventLit(n)) return
    const kind = classifyLiteral(n, anc, aliases)
    if (!kind) { problems.push(`${where(n)}: unclassified use of '${EVENT}' (not a listener, an emit, a comparison, a frame type or a roster element)`); return }
    if (kind === 'roster' && !allowRoster) { problems.push(`${where(n)}: '${EVENT}' is an array element in a file not declared as an event-name roster (it could be an argument list, e.g. Reflect.apply(emit, ..., [event, ...]))`); return }
    counts[kind]++
    const parent = anc[anc.length - 1]
    if (kind === 'emit' && !allowEmitters) {
      const shape = relayShape(parent, aliases)
      const rel = checkRelay(parent, anc.slice(0, -1), shape[1])
      if (rel.ok) counts.relay++
      else problems.push(...(rel.problems.length ? rel.problems : [`${where(parent)}: emits '${EVENT}' with a payload that is not the untouched parameter of a '${EVENT}' listener`]))
    }
    if (kind === 'frame') {
      const obj = anc[anc.length - 2]
      const params = fnParams(anc)
      for (const p of obj.properties) {
        if (p.type === 'SpreadElement') { const sp = spreadProblem(p.argument, ast, params, true, trustedSpreadFns); if (sp) problems.push(sp) }
        else if (p.computed && p.key.type !== 'Literal') problems.push(`${where(p)}: computed frame key could be \`reason\``)
        else if (propName(p) === 'reason') {
          const fp = frameReasonProblem(p.value, params)
          if (fp) problems.push(fp)
          else if (isStr(p.value)) frameReasons.push(p.value.value)
        }
      }
    }
  })
  return { problems, counts, frameReasons }
}

/**
 * Positive check on the journal's reason map: inside `permissionOutcomeForEvent`, every read
 * of the event's `reason` (a `.reason` member of the data parameter or an alias of it, or a
 * name destructured from it) must be a direct argument of `permissionOutcomeForReason`, the
 * shared table's lookup, and there must be at least one such call. The data parameter itself
 * may only be read through a plain `.member` (or negated), never handed on, spread or indexed,
 * so no helper, lookup object, `in`, Map, regex or `switch` can see the reason. No binding of
 * `permissionOutcomeForReason` other than the protocol import may exist at any scope.
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

  const LOOKUP = 'permissionOutcomeForReason'
  const problems = []
  // N-1: a local binding of the lookup's name, at any scope, shadows the shared table's.
  walk(ast, [], (n, anc) => {
    const rebinds = (n.type === 'VariableDeclarator' && identsIn(n.id).includes(LOOKUP))
      || ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id?.name === LOOKUP)
      || (isFunction(n) && n.params.some(q => identsIn(q).includes(LOOKUP)))
      || (n.type === 'ImportSpecifier' && n.local.name === LOOKUP && !(n.imported.name === LOOKUP && anc[anc.length - 1].source.value === '@chroxy/protocol'))
      || ((n.type === 'ImportDefaultSpecifier' || n.type === 'ImportNamespaceSpecifier') && n.local.name === LOOKUP)
      || (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && n.left.name === LOOKUP)
    if (rebinds) problems.push(`${where(n)}: rebinds ${LOOKUP}, which shadows the shared table's lookup`)
  })

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

  let lookups = 0
  if (reasonNames.has('<rest>')) problems.push(`${label}: a rest element destructured from the event hides its reason`)
  const isLookupArg = (n, parent) => parent?.type === 'CallExpression' && parent.callee.type === 'Identifier'
    && parent.callee.name === LOOKUP && parent.arguments.includes(n)
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

/**
 * Is function `fnName` in `src` a function every `return` of which is an object literal (or a
 * conditional of them) with no `reason` key and no spread/computed key? For helpers that are
 * spread into a payload but live in another file.
 * @returns {boolean}
 */
export function returnsReasonFreeObjects(src, label, fnName) {
  const ast = parseSource(src, label)
  const decl = ast.body.map(s => (s.type === 'ExportNamedDeclaration' && s.declaration ? s.declaration : s))
    .find(s => s.type === 'FunctionDeclaration' && s.id.name === fnName)
  if (!decl) throw new Error(`REFUSE: ${label}: no function ${fnName}`)
  const objectsOf = e => {
    if (e?.type === 'ObjectExpression') return [e]
    if (e?.type === 'ConditionalExpression') { const a = objectsOf(e.consequent), b = objectsOf(e.alternate); return a && b ? [...a, ...b] : null }
    return null
  }
  const returns = []
  walk(decl.body, [], n => { if (n.type === 'ReturnStatement') returns.push(n.argument) })
  const all = returns.map(objectsOf)
  return returns.length > 0 && all.every(Boolean)
    && all.flat().every(o => o.properties.every(p => p.type === 'Property' && !p.computed && propName(p) !== 'reason'))
}
