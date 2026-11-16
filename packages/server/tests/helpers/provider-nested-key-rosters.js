// #8548: parse code, never execute source or import provider/auth machinery.
import { parse } from 'acorn'

function walk(node, visit, parent = null, grandparent = null) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node, parent, grandparent)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, node, parent))
    else if (value && typeof value === 'object') walk(value, visit, node, parent)
  }
}

function parseSource(source, label) {
  try {
    return parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch (error) {
    throw new Error(`REFUSE: ${label}: cannot parse: ${error.message}`)
  }
}

function bindingNames(pattern) {
  if (!pattern) return []
  if (pattern.type === 'Identifier') return [pattern.name]
  if (pattern.type === 'RestElement') return bindingNames(pattern.argument)
  if (pattern.type === 'AssignmentPattern') return bindingNames(pattern.left)
  if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(bindingNames)
  if (pattern.type === 'ObjectPattern') return pattern.properties.flatMap(prop => bindingNames(prop.type === 'RestElement' ? prop.argument : prop.value))
  return []
}

/** All *_KEYS declarations, including private, function-local and multi-declarations. */
export function scanKeyRosterDeclarations(source, label) {
  const found = new Map()
  walk(parseSource(source, label), node => {
    if (node.type !== 'VariableDeclarator') return
    // Only bound names count, not destructuring property names or default-value
    // reads. A destructured roster is discovered, then refused as non-literal.
    for (const name of bindingNames(node.id).filter(name => name.endsWith('_KEYS'))) {
      if (found.has(name)) throw new Error(`REFUSE: ${label}: duplicate roster ${name}`)
      found.set(name, node.id.type === 'Identifier' ? node.init : null)
    }
  })
  return found
}

/**
 * The initializer is the complete roster only while the binding cannot escape
 * or be written later. Permit the producer's narrow, direct readonly uses;
 * refuse every other reference, including alias creation and detached methods.
 * This is a syntax contract, not whole-program proof against eval or monkey-
 * patching built-in prototypes. New forms require deliberate audit here.
 */
export function auditReadonlyRosterReferences(source, label, name, { methods, iterable = false }) {
  let declarations = 0
  let reads = 0
  walk(parseSource(source, label), (node, parent, grandparent) => {
    if (node.type !== 'Identifier' || node.name !== name) return
    // These are property names, not reads of the lexical binding.
    if ((parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
        (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent?.type) && parent.key === node && !parent.computed && !parent.shorthand)) return
    if (parent?.type === 'VariableDeclarator' && parent.id === node) { declarations++; return }
    const directCall = parent?.type === 'MemberExpression' && parent.object === node &&
      !parent.computed && !parent.optional && methods.includes(parent.property.name) &&
      grandparent?.type === 'CallExpression' && grandparent.callee === parent && !grandparent.optional
    const iteration = iterable && parent?.type === 'ForOfStatement' && parent.right === node && !parent.await
    if (directCall || iteration) { reads++; return }
    throw new Error(`REFUSE: ${label}: ${name}: unsupported roster reference (${parent?.type ?? 'unknown'}) — possible write or alias escape`)
  })
  if (declarations !== 1) throw new Error(`REFUSE: ${label}: ${name}: expected one audited declaration`)
  return reads
}

/** Literal array, new Set(array), or Object.freeze(array/Set), with no evaluation. */
export function readLiteralRoster(node, label) {
  if (node?.type === 'CallExpression' && !node.optional && node.arguments.length === 1 &&
      node.callee.type === 'MemberExpression' && !node.callee.computed &&
      node.callee.object.name === 'Object' && node.callee.property.name === 'freeze') {
    return readLiteralRoster(node.arguments[0], label)
  }
  if (node?.type === 'NewExpression' && node.callee.name === 'Set' && node.arguments.length === 1) {
    return readLiteralRoster(node.arguments[0], label)
  }
  if (node?.type !== 'ArrayExpression' || node.elements.length === 0 ||
      node.elements.some(e => e?.type !== 'Literal' || typeof e.value !== 'string' || !e.value)) {
    throw new Error(`REFUSE: ${label}: expected a non-empty literal string roster (no spread or computed members)`)
  }
  const names = node.elements.map(e => e.value)
  if (new Set(names).size !== names.length) throw new Error(`REFUSE: ${label}: duplicate roster keys`)
  return names
}

/** Each compatible provider has its own field table; require both independently. */
export function readNestedProviderShapes(markdown) {
  const result = new Map()
  for (const dialect of ['Anthropic', 'OpenAI']) {
    const title = `## ${dialect}-compatible endpoints (config-driven)`
    const sections = markdown.replace(/\r\n/g, '\n').split(/^## /m)
      .filter(section => `## ${section}`.startsWith(title + '\n'))
    if (sections.length !== 1) throw new Error(`REFUSE: docs/providers.md: expected one ${title} section`)
    for (const field of ['modelDiscovery', 'pricing']) {
      const label = `docs/providers.md ${dialect}.${field}`
      const rows = sections[0].split('\n').filter(line => line.startsWith(`| \`${field}\` |`))
      if (rows.length !== 1) throw new Error(`REFUSE: ${label}: expected one field table row`)
      const shapes = [...rows[0].matchAll(/`\{([^{}]*)\}`/g)]
      if (shapes.length !== 1) throw new Error(`REFUSE: ${label}: expected one quoted-key shape`)
      let keys
      try { keys = JSON.parse(`[${shapes[0][1]}]`) } catch { throw new Error(`REFUSE: ${label}: unreadable quoted-key shape`) }
      if (!Array.isArray(keys) || keys.length === 0 || keys.some(k => typeof k !== 'string' || !k) || new Set(keys).size !== keys.length) {
        throw new Error(`REFUSE: ${label}: expected non-empty, unique string keys`)
      }
      result.set(`${dialect}.${field}`, keys)
    }
  }
  return result
}

/** CONFIG.md's inline modelDiscovery example is JavaScript object syntax. */
export function readConfigDiscoveryShape(markdown) {
  const rows = markdown.split('\n').filter(line => line.startsWith('| `providers` |') && line.split('|').length - 2 >= 5)
  if (rows.length !== 1) throw new Error('REFUSE: CONFIG.md: expected one providers table row')
  const shapes = []
  for (const [, snippet] of rows[0].matchAll(/`([^`]+)`/g)) {
    let tree
    try { tree = parse(`({${snippet}})`, { ecmaVersion: 'latest' }) } catch { continue }
    const properties = tree.body[0].expression.properties
    for (const prop of properties) {
      if ((prop.key?.name ?? prop.key?.value) !== 'modelDiscovery') continue
      const value = prop.value
      if (prop.computed || value.type !== 'ObjectExpression' || value.properties.length === 0 ||
          value.properties.some(p => p.type !== 'Property' || p.computed || p.method || p.kind !== 'init')) {
        throw new Error('REFUSE: CONFIG.md: unreadable modelDiscovery object example')
      }
      const names = value.properties.map(p => p.key.name ?? p.key.value)
      if (names.some(n => typeof n !== 'string') || new Set(names).size !== names.length) {
        throw new Error('REFUSE: CONFIG.md: invalid or duplicate modelDiscovery example keys')
      }
      shapes.push(names)
    }
  }
  if (shapes.length !== 1) throw new Error('REFUSE: CONFIG.md: expected one modelDiscovery object example')
  return shapes[0]
}
