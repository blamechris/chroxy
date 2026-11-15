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

const SEND_CALLEES = new Set([
  'send', 'sendFn', '_send', 'broadcast', '_broadcast', 'broadcastToSession', '_broadcastToSession',
  'broadcastMinProtocolVersion', 'sendError', 'sendSessionError', 'broadcastPairPending', 'broadcastFn',
  'transportSend', 'clientSend', '_clientSend',
])

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

function collectFromArg(node, out) {
  if (!node) return
  if (node.type === 'ObjectExpression') {
    const t = typeLiteral(node)
    if (t !== null && /^[a-z][a-z0-9_]*$/.test(t)) out.add(t)
    return
  }
  if (node.type === 'CallExpression' && calleeName(node.callee) === 'stringify') {
    for (const a of node.arguments) collectFromArg(a, out)
    return
  }
  if (node.type === 'ConditionalExpression') {
    collectFromArg(node.consequent, out)
    collectFromArg(node.alternate, out)
  }
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

export function emittedFrameTypes(dir = SRC) {
  const out = new Set()
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
    const ast = parse(readFileSync(f, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })
    walk(ast, (n) => {
      if (n.type === 'CallExpression' && SEND_CALLEES.has(calleeName(n.callee))) {
        for (const a of n.arguments) collectFromArg(a, out)
      }
    })
  }
  return out
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
    walk(ast, (n) => {
      if (n.type !== 'ForOfStatement' || !iteratesClients(n)) return
      let single = false
      const types = new Set()
      walk(n.body, (m) => {
        if (m.type === 'BreakStatement') single = true
        if (m.type === 'CallExpression' && SEND_CALLEES.has(calleeName(m.callee))) {
          for (const a of m.arguments) collectFromArg(a, types)
        }
      })
      for (const type of types) found.push({ file: f.slice(SRC.length + 1), line: n.loc.start.line, type, single })
    })
  }
  return found
}
