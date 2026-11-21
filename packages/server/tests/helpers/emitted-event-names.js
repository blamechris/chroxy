/**
 * Event names emitted with a LITERAL name, found from the syntax tree with acorn (so a
 * comment or a string cannot satisfy or hide an emit), over every .js file under `src/`
 * (recursively).
 *
 * An emit is a call `<anything>.emit('name', ...)` or `emitTurnEvent('name', ...)`.
 * `sessionClassFiles` marks the files that declare a class extending a `*Session` (and
 * base-session.js itself): the events those emit are the ones a turn can produce.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from 'acorn'

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const key of Object.keys(node)) {
    const v = node[key]
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit))
    else if (v && typeof v.type === 'string') walk(v, visit)
  }
}

function isEmitCall(node) {
  if (node.type !== 'CallExpression') return false
  const c = node.callee
  if (c.type === 'Identifier') return c.name === 'emitTurnEvent'
  return c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' && c.property.name === 'emit'
}

/** @returns {{ all: Set<string>, bySessionClassFiles: Set<string>, files: number }} */
export function scanEmittedEventNames(srcDir) {
  const all = new Set()
  const bySessionClassFiles = new Set()
  let files = 0
  for (const rel of readdirSync(srcDir, { recursive: true })) {
    if (typeof rel !== 'string' || !rel.endsWith('.js')) continue
    const full = join(srcDir, rel)
    let ast
    try {
      ast = parse(readFileSync(full, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })
    } catch (err) {
      throw new Error(`emitted-event-names: cannot parse ${relative(srcDir, full)}: ${err.message}`)
    }
    files += 1
    const names = new Set()
    let sessionClass = relative(srcDir, full) === 'base-session.js'
    walk(ast, (n) => {
      if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && n.superClass?.type === 'Identifier' && /Session$/.test(n.superClass.name)) {
        sessionClass = true
      }
      if (isEmitCall(n) && n.arguments[0]?.type === 'Literal' && typeof n.arguments[0].value === 'string') names.add(n.arguments[0].value)
    })
    for (const name of names) {
      all.add(name)
      if (sessionClass) bySessionClassFiles.add(name)
    }
  }
  return { all, bySessionClassFiles, files }
}
