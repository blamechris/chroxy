/**
 * Every place the daemon source ANNOUNCES `permission_resolved`, found from the syntax tree
 * with acorn (not a regex, so a comment or a string cannot satisfy or hide a site).
 *
 * Three shapes are sites:
 *   - `emit-literal`  a call with the string 'permission_resolved' as an argument (not a
 *                     listener registration) whose payload argument is an object literal
 *   - `emit-relay`    the same call whose payload is NOT a literal (an identifier or call:
 *                     a relay of an event someone else built)
 *   - `frame-literal` an object literal with `type: 'permission_resolved'` (a wire frame)
 *
 * `hasResolvedBy` is true when the literal names a `resolvedBy` property, or spreads
 * `resolvedByField(...)` (the one helper that rebuilds the wire value). A bare `...data`
 * spread does not count: it carries whatever the producer put there.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from 'acorn'

const LISTENER_REGISTRATION = new Set(['on', 'once', 'off', 'addListener', 'removeListener', 'prependListener', 'prependOnceListener'])

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const key of Object.keys(node)) {
    const v = node[key]
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit))
    else if (v && typeof v.type === 'string') walk(v, visit)
  }
}

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name
  return null
}

function keyName(p) {
  if (p.type !== 'Property' || p.computed) return null
  return p.key.type === 'Identifier' ? p.key.name : p.key.value
}

function namesResolvedBy(obj) {
  return obj.properties.some((p) => {
    if (keyName(p) === 'resolvedBy') return true
    return p.type === 'SpreadElement' && p.argument.type === 'CallExpression' && calleeName(p.argument.callee) === 'resolvedByField'
  })
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

/**
 * @param {string} srcDir
 * @returns {{ file: string, line: number, shape: 'emit-literal'|'emit-relay'|'frame-literal', hasResolvedBy: boolean }[]}
 */
export function scanPermissionResolvedSites(srcDir) {
  const sites = []
  for (const path of listSourceFiles(srcDir)) {
    const text = readFileSync(path, 'utf8')
    if (!text.includes('permission_resolved')) continue
    const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
    const file = relative(srcDir, path).split('\\').join('/')
    walk(ast, (node) => {
      if (node.type === 'CallExpression') {
        const at = node.arguments.findIndex((a) => a.type === 'Literal' && a.value === 'permission_resolved')
        if (at < 0 || LISTENER_REGISTRATION.has(calleeName(node.callee))) return
        const payload = node.arguments[at + 1]
        if (payload?.type === 'ObjectExpression') {
          sites.push({ file, line: node.loc.start.line, shape: 'emit-literal', hasResolvedBy: namesResolvedBy(payload) })
        } else {
          sites.push({ file, line: node.loc.start.line, shape: 'emit-relay', hasResolvedBy: false })
        }
      } else if (node.type === 'ObjectExpression') {
        const isFrame = node.properties.some((p) => keyName(p) === 'type' && p.value.type === 'Literal' && p.value.value === 'permission_resolved')
        if (isFrame) sites.push({ file, line: node.loc.start.line, shape: 'frame-literal', hasResolvedBy: namesResolvedBy(node) })
      }
    })
  }
  return sites
}
