/**
 * A SEMANTIC inventory of HTTP routing and bearer reading, from the AST (acorn), for the
 * principal HTTP roster (tests/principal-http-roster.test.js).
 *
 * It does not match source spelling. It classifies constructs:
 *
 *   ROUTES   a route is a top-level IfStatement of the request handler whose test compares
 *            `req.method` (either operand order, `==`/`===`, a string Literal or a plain
 *            template literal, or an array `.includes(req.method)`). Any other use of
 *            `req.method`, or an `if` that tests `req.url` (or a name derived from it)
 *            without comparing the method, is UNPLACED, and so is any call that hands
 *            `req` to a function outside the pinned non-routing helper list (a delegated
 *            route handler). UNPLACED is reported, and the test fails on it.
 *   BEARER   a READ of the authorization header in whatever form: `.authorization`,
 *            `['authorization']` (any case, string or plain template), `.get('authorization')`,
 *            a destructured `authorization`, `rawHeaders`, and `headers` handed on whole
 *            (escaping to code that can read any header). A `Bearer ` slice or literal
 *            counts too. Writes of an outgoing `Authorization` header are not reads.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'acorn'

export function parseFile(path) {
  const src = readFileSync(path, 'utf8')
  return { src, ast: parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, locations: true }) }
}

export function walk(node, fn, parent = null, ancestors = []) {
  if (!node || typeof node.type !== 'string') return
  fn(node, parent, ancestors)
  const next = [...ancestors, node]
  for (const key of Object.keys(node)) {
    const v = node[key]
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn, node, next))
    else if (v && typeof v.type === 'string') walk(v, fn, node, next)
  }
}

/** The compile-time string of a Literal or a template with no expressions, else null. */
export function staticString(n) {
  if (!n) return null
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis.map((q) => q.value.cooked).join('')
  return null
}

const propName = (m) => {
  if (m.type !== 'MemberExpression') return null
  if (!m.computed && m.property.type === 'Identifier') return m.property.name
  return staticString(m.property)
}

const isReq = (n) => n?.type === 'Identifier' && n.name === 'req'
/** `req.method` in any spelling (dot, bracket-literal, optional chain). */
const isReqMember = (n, name) => n?.type === 'MemberExpression' && isReq(n.object) && propName(n) === name

/** Names whose initializer reads `req.url` (transitively): `const snapPath = (req.url ?? '').split('?')[0]`. */
function urlDerivedNames(root) {
  const derived = new Set()
  const touchesUrl = (init) => {
    let hit = false
    walk(init, (n) => {
      if (isReqMember(n, 'url')) hit = true
      if (n.type === 'Identifier' && derived.has(n.name)) hit = true
    })
    return hit
  }
  for (let pass = 0; pass < 4; pass++) {
    walk(root, (n) => {
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && touchesUrl(n.init)) derived.add(n.id.name)
    })
  }
  return derived
}

/**
 * Methods compared against `req.method` in a test expression, or null when the
 * test mentions `req.method` in a way that does not resolve to string literals.
 */
function methodsOfTest(test) {
  const methods = []
  let unresolved = false
  let mentions = false
  walk(test, (n, parent) => {
    if (!isReqMember(n, 'method')) return
    mentions = true
    if (parent?.type === 'BinaryExpression' && ['===', '==', '!==', '!='].includes(parent.operator)) {
      const other = parent.left === n ? parent.right : parent.left
      const s = staticString(other)
      if (s === null) unresolved = true
      else methods.push(s)
    } else if (parent?.type === 'CallExpression' && parent.arguments.includes(n) && propName(parent.callee) === 'includes') {
      const arr = parent.callee.object
      if (arr.type === 'ArrayExpression' && arr.elements.every((e) => staticString(e) !== null)) methods.push(...arr.elements.map(staticString))
      else unresolved = true
    } else unresolved = true
  })
  return { mentions, unresolved, methods }
}

/**
 * The guard family a route body uses, from the calls it makes (not from its spelling):
 * the LAST name of each callee, plus the options object of `_validateBearerAuth`.
 */
export function familyOf(body) {
  const names = []
  let scoped = false
  walk(body, (n) => {
    if (n.type !== 'CallExpression') return
    const callee = n.callee.type === 'MemberExpression' ? propName(n.callee) : n.callee.name
    if (typeof callee !== 'string') return
    names.push(callee)
    if (callee === '_validateBearerAuth') {
      const opt = n.arguments[2]
      if (opt?.type === 'ObjectExpression' && opt.properties.some((p) => (p.key?.name === 'allowScoped' || staticString(p.key) === 'allowScoped') && p.value?.type === 'Literal' && p.value.value === true)) scoped = true
    }
  })
  const has = (re) => names.some((x) => re.test(x))
  if (has(/^_authenticateDashboardRequest$/)) return 'dashboard'
  if (has(/^_validatePrimaryBearerAuth$/)) return 'primary'
  if (has(/^_validateBearerAuth$/)) return scoped ? 'bearer-scoped' : 'bearer'
  if (has(/^(handleEventIngest|handleMailboxPing|handleMailboxRegister)$/)) return 'ingest-secret'
  if (has(/^handleGithubWebhook$/)) return 'hmac'
  if (has(/^(handlePermissionRequest|handlePermissionFloorCheck)$/)) return 'hook-secret'
  if (has(/^handlePermissionResponseHttp$/)) return 'bearer-scoped'
  return 'public'
}

/**
 * Inventory the request handler in http-routes.js.
 * @param {string} path
 * @param {{ nonRoutingReqCalls?: string[], strict?: boolean }} opts  `strict` (the HTTP request handler file) also
 *   rejects delegated routes, path tests with no method, and other uses of `req.method`; `nonRoutingReqCalls` are
 *   the callee names allowed to receive `req` without being a route
 * @returns {{ routes: { method: string, test: string, body: string }[], unplaced: string[] }}
 */
export function inventoryRoutes(path, { nonRoutingReqCalls = [], strict = false } = {}) {
  const { src, ast } = parseFile(path)
  const routes = []
  const unplaced = []
  const routeIfs = new Set()
  const line = (n) => `${path.split('/').pop()}:${n.loc.start.line}`
  const text = (n) => src.slice(n.start, n.end).replace(/\s+/g, ' ')

  // Pass 1: route ifs. Only the outermost route if counts; nested conditions belong to it.
  walk(ast, (n, _p, ancestors) => {
    if (n.type !== 'IfStatement') return
    const { mentions, unresolved, methods } = methodsOfTest(n.test)
    if (!mentions) return
    if (ancestors.some((a) => routeIfs.has(a))) return
    routeIfs.add(n)
    if (unresolved || methods.length === 0) { unplaced.push(`${line(n)} method test not resolvable: ${text(n.test).slice(0, 80)}`); return }
    for (const method of methods) routes.push({ method, test: text(n.test), body: src.slice(n.consequent.start, n.consequent.end), family: familyOf(n.consequent) })
  })
  const inRoute = (ancestors) => ancestors.some((a) => routeIfs.has(a))
  if (!strict) return { routes, unplaced }

  // The request handler(s): the functions that contain a route. Pass 2 looks only inside them.
  const handlers = new Set()
  walk(ast, (n, _p, ancestors) => {
    if (!routeIfs.has(n)) return
    const fn = ancestors.slice().reverse().find((a) => /Function/.test(a.type))
    if (fn) handlers.add(fn)
  })
  // Every function that takes the request: a request handed on from any of them is a
  // delegation (the exported wrapper around `dispatch` is one of these).
  const reqFns = new Set(handlers)
  walk(ast, (n) => {
    if (/Function/.test(n.type) && n.params.some((q) => q.name === 'req')) reqFns.add(n)
  })
  const derived = new Set()
  for (const h of handlers) for (const name of urlDerivedNames(h)) derived.add(name)
  const inHandler = (ancestors) => ancestors.some((a) => handlers.has(a))
  const inReqFn = (ancestors) => ancestors.some((a) => reqFns.has(a))

  // Pass 2: everything that routes or hands the request on, outside a route.
  walk(ast, (n, parent, ancestors) => {
    if (!inReqFn(ancestors)) return
    if (inRoute([...ancestors, n]) && n.type !== 'IfStatement') return
    const handler = inHandler(ancestors)
    if (handler && n.type === 'IfStatement' && !routeIfs.has(n) && !inRoute(ancestors)) {
      let usesUrl = false
      walk(n.test, (m) => {
        if (isReqMember(m, 'url') || (m.type === 'Identifier' && derived.has(m.name))) usesUrl = true
        if (isReqMember(m, 'method')) usesUrl = true
      })
      if (usesUrl) unplaced.push(`${line(n)} path test with no method comparison: ${text(n.test).slice(0, 80)}`)
    }
    if (handler && isReqMember(n, 'method') && !inRoute(ancestors)) {
      const fnCall = ancestors.slice().reverse().find((a) => a.type === 'CallExpression')
      const logging = fnCall && /^(log|console)\b/.test(text(fnCall.callee))
      if (!logging) unplaced.push(`${line(n)} req.method used outside a route test`)
    }
    if (handler && n.type === 'SwitchStatement') {
      let usesReq = false
      walk(n.discriminant, (m) => {
        if (isReqMember(m, 'method') || isReqMember(m, 'url') || (m.type === 'Identifier' && derived.has(m.name))) usesReq = true
      })
      if (usesReq) unplaced.push(`${line(n)} switch on the request`)
    }
    if (n.type === 'CallExpression' && !inRoute(ancestors)) {
      const handsReq = n.arguments.some((a) => isReq(a) || (a.type === 'MemberExpression' && isReq(a.object) && ['headers', 'socket'].includes(propName(a))) || (a.type === 'SpreadElement'))
      if (handsReq) {
        const callee = text(n.callee).replace(/^await /, '')
        const name = callee.split('.').pop()
        if (!nonRoutingReqCalls.includes(name)) unplaced.push(`${line(n)} request handed to ${callee} outside any route (a delegated route?)`)
      }
    }
  })
  // Pass 3: `req` itself must only ever be the base of a member access or an argument to a
  // call. Any other use is an alias or an escape (`const r = req`, `{ method } = req`,
  // `fns.push(req)`, a return, a ternary) and hides routing and header reads from this
  // inventory, so it is UNPLACED rather than quietly ignored.
  walk(ast, (n, parent, ancestors) => {
    if (!inReqFn(ancestors) || !isReq(n) || !parent) return
    if (/Function/.test(parent.type) && parent.params.includes(n)) return
    if (parent.type === 'MemberExpression' && parent.object === n) return
    if (parent.type === 'CallExpression' && parent.arguments.includes(n)) return
    if (parent.type === 'Property' && parent.key === n && !parent.shorthand) return
    unplaced.push(`${line(n)} request aliased or escaped (${parent.type})`)
  })
  return { routes, unplaced }
}

/**
 * Every READ of the authorization header (or an escape of the whole header bag) in one file.
 * @returns {{ reads: string[], escapes: string[], unplaced: string[] }}
 */
export function inventoryBearerReads(path) {
  const { ast } = parseFile(path)
  const reads = []
  const escapes = []
  const unplaced = []
  const at = (n) => `${path.split('/').pop()}:${n.loc.start.line}`
  const isAuthName = (s) => typeof s === 'string' && s.toLowerCase() === 'authorization'
  const isReqLike = (n) => n?.type === 'Identifier' && /^(req|request)$/.test(n.name)
  const HANDED_ON = new Set(['CallExpression', 'NewExpression', 'VariableDeclarator', 'SpreadElement', 'Property', 'ReturnStatement', 'AssignmentExpression', 'ArrayExpression'])
  walk(ast, (n, parent) => {
    if (n.type === 'MemberExpression') {
      // `=` only writes; `||=`, `??=`, `&&=`, `+=` ... read the value first.
      const assignedTo = parent?.type === 'AssignmentExpression' && parent.left === n && parent.operator === '='
      if (isAuthName(propName(n)) && !assignedTo) reads.push(`${at(n)} member`)
      // A computed key on a request's header bag that is not a string literal can name any header.
      if (n.computed && isReqMember(n.object, 'headers') && staticString(n.property) === null) unplaced.push(`${at(n)} computed header key`)
      if (propName(n) === 'rawHeaders' && isReqLike(n.object)) escapes.push(`${at(n)} rawHeaders`)
      // `req.headers` used as a value (not as the base of a further member, not a guard)
      if (propName(n) === 'headers' && isReqLike(n.object) && HANDED_ON.has(parent?.type) && !(parent.type === 'CallExpression' && parent.callee === n)) {
        escapes.push(`${at(n)} headers handed on whole`)
      }
    }
    if (n.type === 'CallExpression' && ['get', 'getHeader', 'header'].includes(propName(n.callee)) && isAuthName(staticString(n.arguments[0]))) reads.push(`${at(n)} call`)
    if (n.type === 'ObjectPattern') {
      for (const p of n.properties) {
        if (p.type === 'Property' && (isAuthName(p.key?.name) || isAuthName(staticString(p.key)))) reads.push(`${at(p)} destructure`)
      }
    }
    // A bearer regex literal anywhere (`/^Bearer (.+)$/.exec(h)`), whatever it is called on.
    if (n.type === 'Literal' && n.regex && /bearer/i.test(n.regex.pattern)) reads.push(`${at(n)} bearer regex`)
    // A bearer being PARSED: 'Bearer ' handed to startsWith / indexOf / includes / test / match.
    if (n.type === 'CallExpression' && ['startsWith', 'indexOf', 'includes', 'match', 'test', 'slice', 'replace'].includes(propName(n.callee))) {
      for (const a of n.arguments) {
        const str = staticString(a)
        if (str !== null && /^bearer\b/i.test(str)) reads.push(`${at(a)} bearer parse`)
      }
    }
  })
  return { reads, escapes, unplaced }
}

export function srcFiles(root, prefix = '') {
  const out = []
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (d.isDirectory()) out.push(...srcFiles(join(root, d.name), `${prefix}${d.name}/`))
    else if (d.name.endsWith('.js')) out.push({ rel: `${prefix}${d.name}`, path: join(root, d.name) })
  }
  return out
}
