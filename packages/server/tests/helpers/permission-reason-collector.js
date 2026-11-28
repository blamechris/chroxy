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
//     wire-frame `type:` value, or a roster array element. Anything else is a problem naming file:line;
//   - a wire frame's reason (including inside a spread object) is a string literal, which is recorded,
//     or a pass-through of a `permission_resolved` LISTENER's own parameter (plus an explicit,
//     both-ways-asserted allowlist of builder functions); a duplicate `reason` key is a problem;
//   - the journal's caller is covered too: in the callback that calls `permissionOutcomeForEvent`,
//     every read of the event's reason is the table lookup's argument, a strict comparison with a
//     toolUseId-only reason, or inside another named event's `if (event === '<other>')` branch.

import { parse as acornParse } from 'acorn'

const EVENT = 'permission_resolved'
const LISTENER_METHODS = new Set(['on', 'once', 'off', 'addListener', 'prependListener', 'prependOnceListener', 'removeListener', 'removeAllListeners'])
/** Calls that forward an event as [eventIdx, payloadIdx]: the byok agent-event wrapper (`emit` is [0, 1]). */
const WRAPPER_EMITTERS = new Map([['_emitAgentEvent', [1, 2]]])

/**
 * A repo-relative path as forward slashes, whatever separator produced it: `path.relative` gives
 * `agent-control\\client.js` on Windows, and every roster key in the guard is written with `/`.
 * Splits on BOTH separators (never `split(path.sep)` alone, which leaves the other one in place).
 */
export function toPosixRel(p) {
  return p.split(/[\\/]+/).join('/')
}

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
 *   emit        the event of an emit call
 *   wrapper     the event of the byok agent-event wrapper (a forwarding helper, not an emit call)
 *   comparison  an operand of ==, ===, !=, !==, or a `case` test
 *   frame       the value of a `type:` property of an object literal (a wire frame)
 *   roster      an element of an array literal: a list of event names. Reading it is harmless; a
 *               dynamic forwarder over a roster (`for (const ev of ROSTER) this.on(ev, d => this.emit(ev, d))`)
 *               is NOT visible to this guard, and dynamic-name forwarding is out of the threat model.
 */
function classifyLiteral(node, ancestors, aliases) {
  const parent = ancestors[ancestors.length - 1]
  if (!parent) return null
  if (parent.type === 'CallExpression') {
    const k = parent.arguments.indexOf(node)
    if (k === 0 && isListenerCall(parent)) return 'listener'
    const shape = relayShape(parent, aliases)
    if (!shape || shape[0] !== k) return null
    return isEmitCall(parent, aliases) ? 'emit' : 'wrapper'
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
    if (n.type === 'Property' && parent?.type === 'ObjectPattern' && !n.computed && propName(n) === name) {
      problems.push(`${where(n)}: '${name}' is destructured out of an object, so a call through the new name is invisible to this guard`)
      return
    }
    if (n.type === 'Identifier' && n.name === name) {
      if (!parent) return
      if (parent.type === 'Property' && anc[anc.length - 2]?.type === 'ObjectPattern') return // reported on the Property
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

/** Name of the function a node is the body of: `{ key: () => ..}`, `function f`, `const f = ..`, a method. */
function enclosingName(fn, parent) {
  if (parent?.type === 'Property' && !parent.computed && parent.value === fn) return propName(parent)
  return functionName(fn, parent)
}

/**
 * The names whose `.reason` / spread a wire frame may pass through: the parameters of the enclosing
 * `permission_resolved` LISTENER callback (tag 'listener'), and of an enclosing function named in
 * `builders` (tag `builder:<name>`), the explicit allowlist of frame builders that legitimately
 * forward a handler's reason. No other function's parameter qualifies.
 * @returns {Map<string, string>}
 */
function passThroughParams(ancestors, builders) {
  const m = new Map()
  ancestors.forEach((fn, i) => {
    if (!isFunction(fn)) return
    const isListener = ancestors.slice(0, i).some(c => isListenerCall(c) && c.arguments.includes(fn))
    const name = enclosingName(fn, ancestors[i - 1])
    const tag = isListener ? 'listener' : builders.has(name) ? `builder:${name}` : null
    // A listener forwards its event parameter(s); an allowlisted builder only its FIRST parameter (the handler's data).
    if (tag) for (const q of (tag === 'listener' ? fn.params : fn.params.slice(0, 1))) if (q.type === 'Identifier') m.set(q.name, tag)
  })
  return m
}

/** A wire frame's `reason` value: a string literal (recorded) or `<param>.reason`; else a problem string. */
function frameReasonProblem(v, ctx) {
  if (isStr(v)) { ctx.reasons.push(v.value); return null }
  if (v.type === 'MemberExpression' && memberName(v) === 'reason' && v.object.type === 'Identifier' && ctx.passThrough.has(v.object.name)) {
    ctx.used.add(ctx.passThrough.get(v.object.name))
    return null
  }
  return `${where(v)}: a wire frame's reason is a ${v.type}, not a string literal or a pass-through of a listener's \`reason\``
}

/**
 * Problems in one object literal that is (or is spread into) a payload or frame: a non-plain property,
 * a duplicate `reason` key, a `reason` that is not allowed (emit payloads: none; frames: `frameReasonProblem`),
 * and nested spreads. `ctx` is null for an emit payload, else `{passThrough, used, reasons}` for a frame.
 * @returns {string[]}
 */
function objectProblems(o, ast, ctx, trusted) {
  const out = []
  if (o.properties.filter(p => p.type === 'Property' && !p.computed && propName(p) === 'reason').length > 1) {
    out.push(`${where(o)}: duplicate \`reason\` key (the later one wins at run time; only one can be read)`)
  }
  for (const p of o.properties) {
    if (p.type === 'SpreadElement') { const sp = spreadProblem(p.argument, ast, ctx, trusted); if (sp) out.push(sp) }
    else if (p.type !== 'Property' || (p.computed && p.key.type !== 'Literal')) out.push(`${where(p)}: computed or non-plain key could be \`reason\``)
    else if (propName(p) === 'reason') {
      if (!ctx) out.push(`${where(p)}: a \`reason\` inside a spread that this guard cannot resolve (it could override the emit's reason)`)
      else { const fp = frameReasonProblem(p.value, ctx); if (fp) out.push(fp) }
    }
  }
  return out
}

/**
 * Can a payload spread carry a `reason`? Returns a problem string or null. For a frame (`ctx`), a literal
 * `reason` found in the spread object (any branch of a conditional or logical spread) is RECORDED, and the
 * spread of a pass-through parameter is accepted.
 */
function spreadProblem(arg, ast, ctx = null, trusted = new Set()) {
  const bad = `${where(arg)}: spread in a payload that this guard cannot show lacks a \`reason\` (it could override it)`
  if (ctx && arg.type === 'Identifier' && ctx.passThrough.has(arg.name)) { ctx.used.add(ctx.passThrough.get(arg.name)); return null }
  if (arg.type === 'CallExpression' && arg.callee.type === 'Identifier' && trusted.has(arg.callee.name)) return null
  const objectsOf = e => {
    if (e.type === 'ObjectExpression') return [e]
    if (e.type === 'ConditionalExpression') { const a = objectsOf(e.consequent), b = objectsOf(e.alternate); return a && b ? [...a, ...b] : null }
    if (e.type === 'LogicalExpression') {
      // `a && b` spreads b (or a falsy value, which carries nothing); `a || b` / `a ?? b` spread a when it
      // is truthy / non-null, so BOTH operands must be shown reason-free.
      if (e.operator === '&&') return objectsOf(e.right)
      const l = objectsOf(e.left), r = objectsOf(e.right)
      return l && r ? [...l, ...r] : null
    }
    return null
  }
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
  if (!objs) return bad
  return objs.flatMap(o => objectProblems(o, ast, ctx, trusted))[0] ?? null
}

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
      if (kind === 'wrapper') problems.push(`${where(node)}: '${EVENT}' is emitted through a forwarding wrapper, not an emit call this guard reads (its payload's reason is invisible here)`)
      else if (kind !== 'listener' && kind !== 'emit' && kind !== 'comparison') problems.push(`${where(node)}: '${EVENT}' literal is neither an emit's event, a listener registration nor a comparison (${kind ?? 'unclassified'}); an emit through it would be invisible`)
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
    const reasonProps = obj.properties.filter(p => p.type === 'Property' && !p.computed && propName(p) === 'reason')
    if (reasonProps.length > 1) problems.push(`${where(node)}: duplicate \`reason\` key in the payload`)
    const prop = reasonProps[0]
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
 * inside a listener, is a violation. A `roster` (array element) use is a problem unless
 * `allowRoster`. A wire frame's `reason`, directly or inside a spread object, must be a string
 * literal (returned in `frameReasons`) or a pass-through of an allowed handler parameter's
 * `.reason`. `trustedSpreadFns` names imported helpers whose returns the caller has verified
 * reason-free with `returnsReasonFreeObjects`.
 * `passThroughBuilders` names frame-building functions (not listeners) allowed to pass a handler
 * parameter's reason through; `usedBuilders` reports which were actually relied on.
 * @returns {{problems: string[], counts: Record<string, number>, frameReasons: string[], usedBuilders: string[]}}
 */
export function classifyResolvedUses(src, label, { allowEmitters = false, allowRoster = false, trustedSpreadFns = new Set(), passThroughBuilders = new Set() } = {}) {
  const ast = parseSource(src, label)
  const aliases = emitAliases(ast)
  const counts = { listener: 0, emit: 0, relay: 0, comparison: 0, frame: 0, roster: 0 }
  const problems = []
  const frameReasons = []
  const used = new Set()
  walk(ast, [], (n, anc) => {
    if (!isEventLit(n)) return
    const kind = classifyLiteral(n, anc, aliases)
    if (!kind) { problems.push(`${where(n)}: unclassified use of '${EVENT}' (not a listener, an emit, a comparison, a frame type or a roster element)`); return }
    if (kind === 'wrapper' && allowEmitters) { problems.push(`${where(n)}: '${EVENT}' is emitted through a forwarding wrapper where only emit calls the collector reads are allowed`); return }
    if (kind === 'roster' && !allowRoster) { problems.push(`${where(n)}: '${EVENT}' is an array element in a file not declared as an event-name roster (it could be an argument list, e.g. Reflect.apply(emit, ..., [event, ...]))`); return }
    counts[kind === 'wrapper' ? 'emit' : kind]++
    const parent = anc[anc.length - 1]
    if ((kind === 'emit' || kind === 'wrapper') && !allowEmitters) {
      const shape = relayShape(parent, aliases)
      const rel = checkRelay(parent, anc.slice(0, -1), shape[1])
      if (rel.ok) counts.relay++
      else problems.push(...(rel.problems.length ? rel.problems : [`${where(parent)}: emits '${EVENT}' with a payload that is not the untouched parameter of a '${EVENT}' listener`]))
    }
    if (kind === 'frame') {
      const ctx = { passThrough: passThroughParams(anc, passThroughBuilders), used, reasons: frameReasons }
      problems.push(...objectProblems(anc[anc.length - 2], ast, ctx, trustedSpreadFns))
    }
  })
  return { problems, counts, frameReasons, usedBuilders: [...used].filter(t => t.startsWith('builder:')).map(t => t.slice(8)).sort() }
}

const LOOKUP = 'permissionOutcomeForReason'
const isLookupArg = (n, parent) => parent?.type === 'CallExpression' && parent.callee.type === 'Identifier'
  && parent.callee.name === LOOKUP && parent.arguments.includes(n)

/** Climb past optional-chain wrappers: returns [node, parent, ancestorsAboveNode]. */
function chainUp(n, anc) {
  let cur = n
  let i = anc.length - 1
  while (i >= 0 && anc[i].type === 'ChainExpression') { cur = anc[i]; i-- }
  return [cur, anc[i], anc.slice(0, i + 1)]
}

/**
 * Follow the event parameter through aliases and destructuring, then require that every read of its
 * `reason` is allowed by `okReason(node, parent, ancestors)` (returns 'lookup', true or false) and that
 * the event object is otherwise only read through plain `.member`s, negated, or allowed by `okData`.
 * @returns {{problems: string[], lookups: number}}
 */
function analyseReads(body, dataParam, label, { okReason, okData = () => false, suffix = '' }) {
  const dataNames = new Set([dataParam])
  const reasonNames = new Set()
  const keyIsReason = p => p.type === 'Property' && propName(p) === 'reason'
  const patternNamesReason = pat => { let hit = false; walk(pat, [], q => { if (q.type === 'Property' && propName(q) === 'reason') hit = true }); return hit }
  const unfollowable = []
  for (let changed = true; changed;) {
    changed = false
    walk(body, [], n => {
      if (n.type !== 'VariableDeclarator' || !n.init) return
      const init = n.init.type === 'ChainExpression' ? n.init.expression : n.init
      if (init.type === 'Identifier' && dataNames.has(init.name)) {
        if (n.id.type === 'Identifier' && !dataNames.has(n.id.name)) { dataNames.add(n.id.name); changed = true }
        if (n.id.type === 'ObjectPattern') {
          for (const p of n.id.properties) {
            if (keyIsReason(p)) {
              // `{ reason }`, `{ reason: r }`, `{ reason = 'x' }`, `{ reason: r = 'x' }`; anything else (a nested pattern) cannot be followed.
              const target = p.value.type === 'AssignmentPattern' ? p.value.left : p.value
              if (target.type === 'Identifier') { if (!reasonNames.has(target.name)) { reasonNames.add(target.name); changed = true } }
              else unfollowable.push(p)
            } else if (p.type === 'RestElement') reasonNames.add('<rest>')
            else if (p.type === 'Property' && p.value.type !== 'Identifier' && identsIn(p.value).length && patternNamesReason(p.value)) unfollowable.push(p)
          }
        }
      }
      if (n.id.type === 'Identifier' && init.type === 'MemberExpression' && dataNames.has(init.object.name) && memberName(init) === 'reason' && !reasonNames.has(n.id.name)) {
        reasonNames.add(n.id.name); changed = true
      }
      if (n.id.type === 'Identifier' && init.type === 'Identifier' && reasonNames.has(init.name) && !reasonNames.has(n.id.name)) { reasonNames.add(n.id.name); changed = true }
    })
  }
  const problems = []
  let lookups = 0
  let accepted = 0
  if (reasonNames.has('<rest>')) problems.push(`${label}: a rest element destructured from the event hides its reason`)
  for (const p of unfollowable) problems.push(`${where(p)}: the event's reason is destructured into a pattern this guard cannot follow`)
  walk(body, [], (n, anc) => {
    const parent = anc[anc.length - 1]
    if (n.type === 'MemberExpression' && n.object.type === 'Identifier' && dataNames.has(n.object.name)) {
      const name = memberName(n)
      if (name === null) problems.push(`${where(n)}: computed access on the event could read its reason`)
      else if (name === 'reason') {
        const [cur, p, a] = chainUp(n, anc)
        const r = okReason(cur, p, a)
        if (r) accepted++
        if (r === 'lookup') lookups++
        else if (!r) problems.push(`${where(n)}: the event's reason is read other than as the argument of ${LOOKUP}${suffix}`)
      }
      return
    }
    if (n.type === 'Identifier' && reasonNames.has(n.name)) {
      if (parent?.type === 'VariableDeclarator' && parent.id === n) return
      if (parent?.type === 'Property' && parent.key === n && !parent.shorthand) return
      if (parent?.type === 'Property' && anc[anc.length - 2]?.type === 'ObjectPattern') return // the pattern's own binding
      if (parent?.type === 'AssignmentPattern' && parent.left === n) return // `{ reason: r = 'x' }`: the binding, not a read
      const r = okReason(n, parent, anc)
      if (r) accepted++
      if (r === 'lookup') lookups++
      else if (!r) problems.push(`${where(n)}: '${n.name}' (the event's reason) is used other than as the argument of ${LOOKUP}${suffix}`)
      return
    }
    if (n.type === 'Identifier' && dataNames.has(n.name)) {
      if (!parent) return
      if (parent.type === 'MemberExpression' && parent.object === n) return // checked above
      if (parent.type === 'UnaryExpression' && parent.operator === '!') return
      if (parent.type === 'VariableDeclarator' && (parent.id === n || parent.init === n)) return
      if (isFunction(parent) && parent.params.includes(n)) return
      if (okData(n, parent, anc)) return
      problems.push(`${where(n)}: the event ('${n.name}') is used as a ${parent.type}, so its reason could be read where this guard cannot see`)
    }
  })
  return { problems, lookups, accepted }
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
    && s.specifiers.some(x => x.imported?.name === LOOKUP && x.local.name === LOOKUP))
  if (!imported) throw new Error(`REFUSE: ${label}: ${LOOKUP} is not imported from '@chroxy/protocol' -- the table lookup is not the shared one`)
  if (fn.params.length < 2 || fn.params[1].type !== 'Identifier') throw new Error(`REFUSE: ${label}: ${fnName}'s second parameter is not a plain identifier`)

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
  const r = analyseReads(fn.body, fn.params[1].name, label, { okReason: (n, parent) => (isLookupArg(n, parent) ? 'lookup' : false) })
  problems.push(...r.problems)
  if (r.lookups === 0) problems.push(`${label}: ${fnName} never passes the event's reason to ${LOOKUP}`)
  return { problems, lookups: r.lookups, accepted: r.accepted }
}

/**
 * The same positive check for the CALLER of `permissionOutcomeForEvent`: the `session.on(event, (data) => ...)`
 * callback in session-manager.js. That callback sees the raw event too, so a second reason map could live
 * there (it is what #8952 removed). Every read of the callback parameter's `.reason` (member, `?.`,
 * destructured or aliased) must be one of:
 *   (i)   the argument of `permissionOutcomeForReason`;
 *   (ii)  a strict `===`/`!==` comparison against a `toolUseIdOnly` literal (those never reach the journal);
 *   (iii) inside an `if (event === '<other>')` consequent, where `<other>` is not `permission_resolved` or
 *         `permission_expired`: a path only another named event reaches.
 * Anything else is a problem. The event object may also be handed to `permissionOutcomeForEvent`, to
 * `this.emit(...)` inside an object payload, or used inside an (iii) branch.
 * Throws unless there is exactly one call to `permissionOutcomeForEvent(<event>, <data>)` in a callback.
 * `accepted` counts the reads that WERE allowed, so a caller that sees none can tell "clean" from "blind".
 * @returns {{problems: string[], lookups: number, accepted: number}}
 */
export function checkJournalCaller(src, label, { fnName = 'permissionOutcomeForEvent', toolUseIdOnly } = {}) {
  if (!toolUseIdOnly?.length) throw new Error(`REFUSE: ${label}: no toolUseId-only reasons given`)
  const ast = parseSource(src, label)
  const calls = []
  walk(ast, [], (n, anc) => { if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === fnName) calls.push({ n, anc: [...anc] }) })
  if (calls.length !== 1) throw new Error(`REFUSE: ${label}: expected exactly one call to ${fnName}, found ${calls.length} -- the caller guard cannot run`)
  const { n: call, anc } = calls[0]
  const [evArg, dataArg] = call.arguments
  if (evArg?.type !== 'Identifier' || dataArg?.type !== 'Identifier') throw new Error(`REFUSE: ${label}: the call to ${fnName} does not pass two plain identifiers`)
  const cb = [...anc].reverse().find(a => isFunction(a) && a.params[0]?.type === 'Identifier' && a.params[0].name === dataArg.name)
  if (!cb) throw new Error(`REFUSE: ${label}: the call to ${fnName} is not inside a callback whose first parameter is '${dataArg.name}'`)
  const eventName = evArg.name
  const OWN = new Set(['permission_resolved', 'permission_expired'])
  // (iii) placed under `if (event === '<other>')`: the node is inside that if's CONSEQUENT.
  const placed = (n, ancestors) => ancestors.some((a, i) => a.type === 'IfStatement'
    && (ancestors[i + 1] ?? n) === a.consequent
    && a.test.type === 'BinaryExpression' && a.test.operator === '==='
    && [[a.test.left, a.test.right], [a.test.right, a.test.left]].some(([x, y]) => x.type === 'Identifier' && x.name === eventName && isStr(y) && !OWN.has(y.value)))
  const okReason = (n, parent, ancestors) => {
    if (isLookupArg(n, parent)) return 'lookup'
    if (parent?.type === 'BinaryExpression' && ['===', '!=='].includes(parent.operator)
      && [parent.left, parent.right].some(x => x !== n && isStr(x) && toolUseIdOnly.includes(x.value))) return true
    return placed(n, ancestors)
  }
  const okData = (n, parent, ancestors) => {
    if (parent.type === 'CallExpression' && parent.callee.type === 'Identifier' && parent.callee.name === fnName && parent.arguments[1] === n) return true
    if (parent.type === 'Property' && (parent.value === n || (parent.shorthand && parent.key === n)) && ancestors[ancestors.length - 2]?.type === 'ObjectExpression') {
      const c = ancestors[ancestors.length - 3]
      if (c?.type === 'CallExpression' && c.callee.type === 'MemberExpression' && memberName(c.callee) === 'emit') return true
    }
    return placed(n, ancestors)
  }
  const r = analyseReads(cb.body, cb.params[0].name, label, {
    okReason, okData,
    suffix: `, a strict comparison with a toolUseId-only reason (${toolUseIdOnly.join(', ')}), or a branch of another named event`,
  })
  return { problems: r.problems, lookups: r.lookups, accepted: r.accepted }
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
