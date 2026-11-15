/**
 * The frame names the daemon source EMITS toward a client, enumerated from the
 * syntax tree with acorn (not a regex, and not borrowed from outgoing-policy.js):
 * every object literal with a string-literal `type` that is an argument of a
 * send-like call, looking through `JSON.stringify(...)` and spreads.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'acorn'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

// Send-like calls and the position of the frame argument. `send(ws, msg)` and friends carry the
// frame second (or first for `socket.send(json)`); `broadcast(msg)` first; the session
// broadcasts `(sessionId, msg)` second. sendError / sendSessionError build their own frames in
// handler-utils.js, which the scan reads directly.
const FRAME_ARG = {
  send: 'send', sendFn: 'send', _send: 'send', transportSend: 'send', clientSend: 'send', _clientSend: 'send',
  broadcast: 0, _broadcast: 0, broadcastFn: 0, broadcastPairPending: 0,
  broadcastToSession: 1, _broadcastToSession: 1, broadcastMinProtocolVersion: 1,
}
const SEND_CALLEES = new Set(Object.keys(FRAME_ARG))

function frameArgs(call, name) {
  const pos = FRAME_ARG[name]
  if (pos === 'send') return call.arguments.length >= 2 ? [call.arguments[1]] : call.arguments.slice(0, 1)
  return call.arguments[pos] ? [call.arguments[pos]] : []
}

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name
  return null
}

function typeLiteral(obj) {
  for (const p of obj.properties) {
    if (p.type !== 'Property' || p.computed) continue
    const key = p.key.type === 'Identifier' ? p.key.name : p.key.value
    if (key === 'type' && p.value.type === 'Literal' && typeof p.value.value === 'string') return p.value.value
  }
  return null
}

// Wrappers whose first argument is the frame (looked through).
const FRAME_WRAPPERS = new Set(['stringify', 'withServerTs', 'freeze'])

const FUNCTION_NODES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/** name -> initializer expressions assigned to that name inside `fn` (declarations and plain assignments). */
function localInitializers(fn) {
  const map = new Map()
  const add = (name, expr) => { if (!map.has(name)) map.set(name, []); map.get(name).push(expr) }
  walk(fn.body, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) add(n.id.name, n.init)
    if (n.type === 'AssignmentExpression' && n.operator === '=' && n.left.type === 'Identifier') add(n.left.name, n.right)
  })
  return map
}

/**
 * Collect the frame types a send argument can carry. Resolves object literals, wrapper calls,
 * conditional and logical branches, and identifiers bound to such an expression in an enclosing
 * function (`const response = { type: 'x' }; send(ws, response)`). Anything else it cannot see
 * through is reported to `unresolved` instead of vanishing.
 */
function collectFromArg(node, out, scopes = [], unresolved = null, seen = new Set()) {
  if (!node) return
  switch (node.type) {
    case 'ObjectExpression': {
      const t = typeLiteral(node)
      if (t !== null && /^[a-z][a-z0-9_]*$/.test(t)) out.add(t)
      else if (t === null && unresolved) unresolved.push({ line: node.loc?.start.line, kind: 'object without a literal type' })
      return
    }
    case 'CallExpression':
      if (FRAME_WRAPPERS.has(calleeName(node.callee))) {
        for (const a of node.arguments) collectFromArg(a, out, scopes, unresolved, seen)
        return
      }
      break
    case 'ConditionalExpression':
      collectFromArg(node.consequent, out, scopes, unresolved, seen)
      collectFromArg(node.alternate, out, scopes, unresolved, seen)
      return
    case 'LogicalExpression':
      collectFromArg(node.left, out, scopes, unresolved, seen)
      collectFromArg(node.right, out, scopes, unresolved, seen)
      return
    case 'Identifier': {
      for (let i = scopes.length - 1; i >= 0; i--) {
        const inits = scopes[i].get(node.name)
        if (!inits) continue
        if (seen.has(node)) return
        seen.add(node)
        for (const init of inits) collectFromArg(init, out, scopes, unresolved, seen)
        return
      }
      break
    }
    case 'Literal':
      return
    default:
  }
  if (unresolved) unresolved.push({ line: node.loc?.start.line, kind: node.type === 'Identifier' ? `identifier ${node.name}` : node.type })
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const key of Object.keys(node)) {
    const v = node[key]
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit))
    else if (v && typeof v.type === 'string') walk(v, visit)
  }
}

function walkWithScopes(node, scopes, visit) {
  if (!node || typeof node.type !== 'string') return
  const inner = FUNCTION_NODES.has(node.type) ? [...scopes, localInitializers(node)] : scopes
  visit(node, inner)
  for (const key of Object.keys(node)) {
    const v = node[key]
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walkWithScopes(c, inner, visit))
    else if (v && typeof v.type === 'string') walkWithScopes(v, inner, visit)
  }
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
  return files
}

/**
 * The frame names the source emits, plus every send argument the scanner could NOT resolve
 * to a frame type (`unresolved`: file, line, callee, kind, and the argument's source text),
 * so a send the scanner cannot see has to be accounted for rather than disappearing.
 */
export function scanEmittedFrames(dir = SRC) {
  const out = new Set()
  const unresolved = []
  for (const f of listSourceFiles(dir)) {
    const src = readFileSync(f, 'utf8')
    const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true })
    walkWithScopes(ast, [], (n, scopes) => {
      if (n.type === 'CallExpression' && SEND_CALLEES.has(calleeName(n.callee))) {
        const callee = calleeName(n.callee)
        // The frame is the last argument for send(ws, msg) and the first for broadcast(msg);
        // look at every argument and ignore ones that are plainly not frames.
        for (const a of frameArgs(n, callee)) {
          if (a.type === 'Literal' || a.type === 'TemplateLiteral') continue
          const local = []
          collectFromArg(a, out, scopes, local)
          for (const u of local) unresolved.push({ file: f.slice(SRC.length + 1), line: u.line ?? n.loc.start.line, callee, kind: u.kind, text: src.slice(a.start, a.end).replace(/\s+/g, ' ').slice(0, 80) })
        }
      }
    })
  }
  return { types: out, unresolved }
}

export function emittedFrameTypes(dir = SRC) {
  return scanEmittedFrames(dir).types
}

function iteratesClients(node) {
  // `for (... of X.clients)`, `of [...X.clients]`, `of X.clients.values()`, `of X.clients.entries()`
  let right = node.right
  if (right.type === 'ArrayExpression' && right.elements[0]?.type === 'SpreadElement') right = right.elements[0].argument
  if (right.type === 'CallExpression' && right.callee.type === 'MemberExpression') right = right.callee.object
  return right.type === 'MemberExpression' && !right.computed && right.property.type === 'Identifier' &&
    (right.property.name === 'clients' || right.property.name === '_clients')
}

/**
 * Frame types sent from INSIDE a loop over the connected clients, i.e. a producer that
 * calls a per-client `send`/`_send` for every client. Such a send is a DIRECT reply as far
 * as the outgoing policy can tell, so a type on the direct-reply allowlist sent this way
 * would reach every principal. `single` is true when the loop body can `break` (a lookup
 * of one client, not a fan-out).
 * @returns {{ file: string, line: number, type: string, single: boolean }[]}
 */
export function perClientLoopFrames(dir = SRC) {
  const found = []
  const files = []
  const rec = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name)
      if (e.isDirectory()) rec(f)
      else if (e.name.endsWith('.js')) files.push(f)
    }
  }
  rec(dir)
  for (const f of files) {
    const ast = parse(readFileSync(f, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true })
    walkWithScopes(ast, [], (n, loopScopes) => {
      if (n.type !== 'ForOfStatement' || !iteratesClients(n)) return
      let single = false
      const types = new Set()
      walk(n.body, (m) => {
        if (m.type === 'BreakStatement') single = true
        if (m.type === 'CallExpression' && SEND_CALLEES.has(calleeName(m.callee))) {
          for (const a of frameArgs(m, calleeName(m.callee))) collectFromArg(a, types, loopScopes)
        }
      })
      for (const type of types) found.push({ file: f.slice(SRC.length + 1), line: n.loc.start.line, type, single })
    })
  }
  return found
}
