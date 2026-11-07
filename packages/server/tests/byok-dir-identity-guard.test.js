import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'acorn'
import { isVerifiedDirIdentity } from '../src/byok-tool-executor.js'

// The Glob walk has exactly one "same directory as the verified one" check,
// `isVerifiedDirIdentity`. This guard parses the executor source and fails when
// any other expression compares a `.dev` or `.ino` member with something that is
// not a literal, so a second hand-written copy cannot appear unnoticed.

const SRC_PATH = fileURLToPath(new URL('../src/byok-tool-executor.js', import.meta.url))
const COMPARE_OPS = new Set(['===', '!==', '==', '!='])
const HELPER = 'isVerifiedDirIdentity'

function isIdentityMember(node) {
  if (!node || node.type !== 'MemberExpression') return false
  if (node.computed) return node.property.type === 'Literal' && (node.property.value === 'dev' || node.property.value === 'ino')
  return node.property.type === 'Identifier' && (node.property.name === 'dev' || node.property.name === 'ino')
}

function isLiteral(node) {
  return node.type === 'Literal'
}

/** Line numbers of dev/ino comparisons outside the helper's own body, plus the count inside it. */
function findStrayIdentityCompares(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true })
  const stray = []
  let helperCompares = 0
  const visit = (node, inHelper) => {
    if (!node || typeof node.type !== 'string') return
    const entering = node.type === 'FunctionDeclaration' && node.id && node.id.name === HELPER
    const here = inHelper || entering
    if (node.type === 'BinaryExpression' && COMPARE_OPS.has(node.operator)) {
      const touches = isIdentityMember(node.left) || isIdentityMember(node.right)
      const literalSide = isLiteral(node.left) || isLiteral(node.right)
      if (touches && !literalSide) {
        if (here) helperCompares++
        else stray.push(node.loc.start.line)
      }
    }
    for (const key of Object.keys(node)) {
      const child = node[key]
      if (Array.isArray(child)) child.forEach((c) => visit(c, here))
      else if (child && typeof child === 'object') visit(child, here)
    }
  }
  visit(ast, false)
  return { stray, helperCompares }
}

describe('directory identity check in the Glob walk', () => {
  const source = readFileSync(SRC_PATH, 'utf8')

  it('parses the executor source and finds the helper comparisons (positive control)', () => {
    const { helperCompares } = findStrayIdentityCompares(source)
    assert.equal(helperCompares, 2, 'helper compares dev and ino')
  })

  it('has no device/inode comparison outside the helper', () => {
    const { stray } = findStrayIdentityCompares(source)
    assert.ok(stray.length === 0, `hand-written dev/ino comparison at line(s) ${stray.join(', ')}; use ${HELPER}`)
  })

  it('reports a second hand-written comparison (the guard can fail)', () => {
    const extra = `${source}\nfunction another(a, b) { return a.dev === b.dev && a.ino === b.ino }\n`
    const before = findStrayIdentityCompares(source).stray.length
    const { stray } = findStrayIdentityCompares(extra)
    assert.equal(stray.length, before + 2)
  })

  it('does not flag comparisons of an inode with a literal', () => {
    const { stray } = findStrayIdentityCompares('function f(st) { return st.ino === 0n }')
    assert.deepEqual(stray, [])
  })
})

describe('isVerifiedDirIdentity', () => {
  const stat = (over = {}) => ({
    dev: 7n,
    ino: 42n,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    ...over,
  })
  const verified = stat()

  it('accepts a directory with the same device and inode', () => {
    assert.equal(isVerifiedDirIdentity(stat(), verified), true)
  })
  it('rejects a different device', () => {
    assert.equal(isVerifiedDirIdentity(stat({ dev: 8n }), verified), false)
  })
  it('rejects a different inode', () => {
    assert.equal(isVerifiedDirIdentity(stat({ ino: 43n }), verified), false)
  })
  it('rejects a zero inode even when both sides are zero', () => {
    assert.equal(isVerifiedDirIdentity(stat({ ino: 0n }), stat({ ino: 0n })), false)
  })
  it('rejects a symlink', () => {
    assert.equal(isVerifiedDirIdentity(stat({ isSymbolicLink: () => true }), verified), false)
  })
  it('rejects a non-directory', () => {
    assert.equal(isVerifiedDirIdentity(stat({ isDirectory: () => false }), verified), false)
  })
})
