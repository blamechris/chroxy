import { parse } from 'acorn'
import { posix as path } from 'node:path'

export const VERIFY_SCRIPT = 'scripts/verify-publish-artifacts.mjs'
const REPO = '/__chroxy_repo__'

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return
  visit(node, parent)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, node))
    else if (value && typeof value === 'object') walk(value, visit, node)
  }
}

function syntax(src, file) {
  try {
    return parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  } catch (err) {
    throw new Error(`${file}: cannot parse publish-verification input: ${err.message}`)
  }
}

function unsupported(file, node, detail) {
  throw new Error(`${file}:${node.loc.start.line}: unsupported publish-verification input: ${detail}`)
}

function text(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked
  return null
}

function property(node) {
  return node?.computed ? text(node.property) : node?.property?.name
}

function shape(node) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(shape)
  return Object.fromEntries(Object.entries(node).filter(([key]) => !['start', 'end', 'loc', 'raw'].includes(key)).map(([key, value]) => [key, shape(value)]))
}

function sameSyntax(a, b) {
  return JSON.stringify(shape(a)) === JSON.stringify(shape(b))
}

function patternNames(node) {
  if (!node) return []
  if (node.type === 'Identifier') return [node.name]
  if (node.type === 'RestElement') return patternNames(node.argument)
  if (node.type === 'AssignmentPattern') return patternNames(node.left)
  if (node.type === 'ArrayPattern') return node.elements.flatMap(patternNames)
  if (node.type === 'ObjectPattern') return node.properties.flatMap(p => patternNames(p.type === 'RestElement' ? p.argument : p.value))
  return []
}

/** Only the actual top-level PACKAGES array, never comments or other objects. */
export function extractPackedPackages(src, file = VERIFY_SCRIPT) {
  const ast = syntax(src, file)
  const declarations = ast.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : [])
    .filter(node => node.id.type === 'Identifier' && node.id.name === 'PACKAGES')
  if (declarations.length !== 1 || declarations[0].init?.type !== 'ArrayExpression') {
    throw new Error(`${file}: expected one literal top-level PACKAGES array`)
  }
  const packages = declarations[0].init.elements.map(node => {
    if (node?.type !== 'ObjectExpression' || node.properties.some(p => p.type !== 'Property' || p.computed || p.kind !== 'init' || p.method)) {
      unsupported(file, node || declarations[0], 'PACKAGES entries must be plain literal objects')
    }
    const names = node.properties.filter(p => (p.key.name ?? p.key.value) === 'name')
    const name = names.length === 1 ? text(names[0].value) : null
    if (!/^@chroxy\/[\w-]+$/.test(name ?? '')) unsupported(file, node, 'PACKAGES name must be a literal @chroxy/<name>')
    const short = name.split('/')[1]
    const packFrom = node.properties.filter(p => (p.key.name ?? p.key.value) === 'packFrom')
    if (packFrom.length > 1) unsupported(file, node, 'PACKAGES packFrom must not be duplicated')
    if (packFrom.length && packFrom[0].value.value !== null) {
      const value = text(packFrom[0].value)
      if (!value || !value.startsWith(`packages/${short}/`) || path.normalize(value) !== value || /[?#%\\\0]/.test(value)) {
        unsupported(file, node, 'PACKAGES packFrom must be a literal path inside its package')
      }
    }
    return short
  })
  if (!packages.length || new Set(packages).size !== packages.length) {
    throw new Error(`${file}: PACKAGES must be nonempty with unique package names`)
  }
  return packages
}

/**
 * Parse, never execute, the module graph. Paths and readers are repo-relative.
 * Supported: local import/export-from and literal import(), including static
 * templates; fs readFile/readFileSync/createReadStream (named aliases, default,
 * namespace, fs.promises, or fs/promises), with literal repo-relative paths,
 * new URL(relative, import.meta.url), or path.join/resolve(ROOT, literals).
 * Const path aliases, dirname and fileURLToPath cover the verifier's ROOT.
 *
 * The verifier's existing package-manifest read is explicitly recognized below.
 * Other computed content reads/imports, require(), module URL queries/fragments,
 * absolute/escaping paths and ambiguous bindings fail with a location. This is
 * not a general JS evaluator or a shell/runtime-output dependency analysis.
 */
export function discoverPublishInputs({ readSource, entry = VERIFY_SCRIPT }) {
  const sources = new Map()
  function read(file) {
    if (!sources.has(file)) {
      try {
        const source = readSource(file)
        if (typeof source !== 'string') throw new Error('reader must return source text')
        sources.set(file, source)
      } catch (err) {
        throw new Error(`${file}: cannot read publish-verification input: ${err.message}`)
      }
    }
    return sources.get(file)
  }
  const packages = extractPackedPackages(read(entry), entry)
  const inputs = new Set()
  const modules = new Set()

  function visit(file) {
    if (modules.has(file)) return
    modules.add(file) // before recursion: cycles are ordinary dependencies
    const src = read(file)
    const ast = syntax(src, file)
    const bindings = new Map()
    const declarations = new Map()
    const parents = new WeakMap()
    const imports = new Map()
    const scopeTypes = new Set(['Program', 'BlockStatement', 'StaticBlock', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement'])
    function enclosingScope(node) {
      for (let current = node; current; current = parents.get(current)) {
        if (scopeTypes.has(current.type)) return current
      }
      return null
    }
    function declare(pattern, init, scope) {
      for (const name of patternNames(pattern)) {
        const count = (declarations.get(name) || 0) + 1
        declarations.set(name, count)
        bindings.set(name, count === 1 && init ? { init, scope } : null)
      }
    }
    walk(ast, (node, parent) => {
      if (parent) parents.set(node, parent)
      if (node.type === 'VariableDeclarator') {
        declare(node.id, parent?.kind === 'const' && node.id.type === 'Identifier' ? node.init : null, enclosingScope(parent))
      }
      if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
        if (node.id) declare(node.id, null, enclosingScope(parent))
        for (const param of node.params) declare(param, null, node)
      }
      if (['ClassDeclaration', 'ClassExpression'].includes(node.type) && node.id) declare(node.id, null, enclosingScope(parent))
      if (node.type === 'CatchClause') declare(node.param, null, node)
      if (node.type === 'ImportDeclaration') {
        for (const spec of node.specifiers) {
          const imported = spec.type === 'ImportSpecifier' ? (spec.imported.name ?? spec.imported.value) : 'default'
          imports.set(spec.local.name, {
            source: node.source.value.replace(/^node:/, ''),
            name: spec.type === 'ImportNamespaceSpecifier' || imported === 'default' ? '*' : imported,
            node: spec,
            namespace: spec.type === 'ImportNamespaceSpecifier',
          })
          declare(spec.local, null, ast)
        }
      }
    })
    // A conservative bound, not cross-function evaluation: any duplicate name
    // invalidates a static const, including parameters/patterns in other scopes.
    // Built-in import aliases must not be shadowed and silently stop matching.
    for (const [name, imp] of imports) {
      if (['fs', 'fs/promises', 'path', 'url'].includes(imp.source) && declarations.get(name) !== 1) {
        unsupported(file, imp.node, `shadowed built-in binding '${name}' requires explicit discovery support`)
      }
    }
    function visibleBinding(node) {
      const binding = bindings.get(node?.name)
      if (!binding) return null
      for (let current = node; current; current = parents.get(current)) {
        if (current === binding.scope) return binding.init
      }
      return null
    }
    function builtin(node, module, name) {
      if (node?.type === 'Identifier') {
        const imp = imports.get(node.name)
        return imp?.source === module && imp.name === name
      }
      if (node?.type === 'MemberExpression') {
        const imp = imports.get(node.object.name)
        return imp?.source === module && imp.name === '*' && property(node) === name
      }
      return false
    }
    const metaUrl = node => node?.type === 'MemberExpression' && property(node) === 'url' &&
      node.object.type === 'MetaProperty' && node.object.meta.name === 'import' && node.object.property.name === 'meta'
    function staticPath(node, seen = new Set()) {
      const literal = text(node)
      if (literal !== null) return literal
      if (metaUrl(node)) return `${REPO}/${file}`
      if (node?.type === 'Identifier' && visibleBinding(node) && !seen.has(node.name)) {
        return staticPath(visibleBinding(node), new Set([...seen, node.name]))
      }
      if (node?.type === 'NewExpression' && node.callee.name === 'URL' && (!declarations.has('URL') || builtin(node.callee, 'url', 'URL')) && node.arguments.length === 2 && metaUrl(node.arguments[1])) {
        const rel = text(node.arguments[0])
        if (rel !== null && /^\.{1,2}\//.test(rel) && !/[?#%\\\0]/.test(rel)) return path.resolve(REPO, path.dirname(file), rel)
      }
      if (node?.type === 'CallExpression') {
        if (builtin(node.callee, 'url', 'fileURLToPath') && node.arguments.length === 1) return staticPath(node.arguments[0], seen)
        if (builtin(node.callee, 'path', 'dirname') && node.arguments.length === 1) {
          const value = staticPath(node.arguments[0], seen)
          if (value !== null) return path.dirname(value)
        }
        for (const method of ['join', 'resolve']) {
          if (builtin(node.callee, 'path', method)) {
            const args = node.arguments.map(arg => staticPath(arg, seen))
            if (args.length && args.every(arg => arg !== null)) return method === 'join' && path.isAbsolute(args[0]) ? path.join(...args) : path[method](REPO, ...args)
          }
        }
      }
      return null
    }
    function localInput(value, node, relativeToModule) {
      if (!value || /[?#%\\\0]/.test(value) || /^[a-z]+:/i.test(value)) unsupported(file, node, 'input paths must be literal local paths without URL suffixes or encodings')
      const normalized = path.normalize(relativeToModule ? path.join(path.dirname(file), value) : value)
      if (normalized.startsWith('../') || normalized === '..' || path.isAbsolute(normalized)) unsupported(file, node, 'input path escapes the repo')
      return normalized.replace(/^\.\//, '')
    }
    function imported(node, specifier) {
      const value = text(specifier)
      if (value === null) unsupported(file, node, 'import() requires a literal specifier')
      if (/^\.{1,2}\//.test(value)) {
        const target = localInput(value, node, true)
        inputs.add(target)
        if (!/\.(?:mjs|cjs|js)$/.test(target)) unsupported(file, node, 'local module imports must have a .js/.mjs/.cjs extension')
        visit(target)
      } else if (/^(?:[/.]|file:)/.test(value)) unsupported(file, node, 'absolute or file URL imports are not supported')
    }
    function fsRead(callee) {
      const reads = ['readFile', 'readFileSync', 'createReadStream']
      if (reads.some(name => builtin(callee, 'fs', name) || builtin(callee, 'fs/promises', name))) return true
      return callee?.type === 'MemberExpression' && reads.includes(property(callee)) &&
        fsNamespace(callee.object)
    }
    function fsNamespace(node) {
      if (node?.type === 'Identifier') {
        const imp = imports.get(node.name)
        if (['fs', 'fs/promises'].includes(imp?.source) && (imp.name === '*' || imp.name === 'promises')) {
          return { source: imp.name === 'promises' ? 'fs/promises' : imp.source, defaultExport: imp.namespace }
        }
        return null
      }
      if (node?.type !== 'MemberExpression') return null
      const base = fsNamespace(node.object)
      // Only known built-in projections, never arbitrary member evaluation.
      // A namespace's default is the filesystem object, not another namespace.
      if (base?.defaultExport && property(node) === 'default') return { source: base.source, defaultExport: false }
      if (base?.source === 'fs' && property(node) === 'promises') return { source: 'fs/promises', defaultExport: false }
      return null
    }
    walk(ast, (node, parent) => {
      if (fsRead(node) || fsNamespace(node)) {
        const importedBinding = ['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(parent?.type)
        const memberProperty = parent?.type === 'MemberExpression' && parent.property === node && !parent.computed
        const directUse = parent?.type === 'CallExpression' && parent.callee === node && fsRead(node)
        const memberUse = fsNamespace(node) && parent?.type === 'MemberExpression' && parent.object === node && property(parent) !== null &&
          (!['default', 'promises'].includes(property(parent)) || fsNamespace(parent))
        if (!importedBinding && !memberProperty && !directUse && !memberUse) unsupported(file, node, 'filesystem bindings may not escape into aliases or indirect calls')
      }
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) imported(node, node.source)
      if (node.type === 'ImportExpression') {
        if (/^(?:node:)?fs(?:\/promises)?$/.test(text(node.source) ?? '')) unsupported(file, node, 'dynamic filesystem bindings require explicit discovery support')
        imported(node, node.source)
      }
      if (node.type !== 'CallExpression') return
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') unsupported(file, node, 'require() needs explicit discovery support')
      if (!fsRead(node.callee)) return
      const arg = node.arguments[0]
      let value = staticPath(arg)
      if (value === null) {
        // The sole exempt dynamic content read must remain inside the exact
        // current function and be reachable only from the validated PACKAGES
        // filter/flatMap expression. New calls, aliases, exports or roster uses
        // invalidate the exemption instead of borrowing package provenance.
        const expectedFunction = syntax(`function entryPointsFor(pkg) {
          const manifestDir = pkg.packFrom ? join(ROOT, pkg.packFrom) : join(ROOT, 'packages', pkg.name.split('/')[1])
          const manifest = JSON.parse(readFileSync(join(manifestDir, 'package.json'), 'utf8'))
          const exportsField = manifest.exports
          if (!exportsField || typeof exportsField === 'string') return [pkg.name]
          return Object.keys(exportsField).filter((k) => k.startsWith('.'))
            .map((k) => (k === '.' ? pkg.name : \`\${pkg.name}/\${k.replace(/^\\.\\//, '')}\`))
        }`, file).body[0]
        const expectedUse = syntax("PACKAGES.filter((p) => p.name !== '@chroxy/server').flatMap(entryPointsFor)", file).body[0].expression
        const expectedBuildFilter = syntax('PACKAGES.filter((p) => p.build)', file).body[0].expression
        const expectedPackLoop = syntax(`for (const p of PACKAGES) {
          const cwd = p.packFrom ? join(ROOT, p.packFrom) : ROOT
          const args = p.packFrom ? ['pack', '--pack-destination', work] : ['pack', '-w', p.name, '--pack-destination', work]
          const out = run('npm', args, { cwd }).trim().split('\\n').pop().trim()
          const tgz = join(work, out)
          if (!existsSync(tgz)) throw new Error(\`npm pack did not produce \${tgz} for \${p.name}\`)
          tarballs.push(tgz)
          log(\`  packed \${p.name} -> \${out}\`)
        }`, file).body[0]
        const expectedBuildLoop = syntax("for (const p of PACKAGES.filter((p) => p.build)) { run('npm', ['run', p.build, '-w', p.name], { cwd: ROOT, stdio: 'inherit' }) }", file).body[0]
        const functions = ast.body.filter(n => n.type === 'FunctionDeclaration' && n.id.name === 'entryPointsFor')
        const fn = functions.length === 1 ? functions[0] : null
        let enclosingFunction = parents.get(node)
        while (enclosingFunction && !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(enclosingFunction.type)) enclosingFunction = parents.get(enclosingFunction)
        const uses = []
        let rosterBounded = true
        let rosterUses = 0
        walk(ast, (candidate, parent) => {
          if (candidate.type !== 'Identifier') return
          const memberKey = parent?.type === 'MemberExpression' && parent.property === candidate && !parent.computed
          const objectKey = parent?.type === 'Property' && parent.key === candidate && !parent.computed && !parent.shorthand
          if (memberKey || objectKey) return
          if (candidate.name === 'entryPointsFor' && candidate !== fn?.id) uses.push(parent)
          if (candidate.name !== 'PACKAGES') return
          rosterUses++
          const declaration = parent?.type === 'VariableDeclarator' && parent.id === candidate && parents.get(parent)?.kind === 'const' && parents.get(parents.get(parent)) === ast
          const packLoop = parent?.type === 'ForOfStatement' && parent.right === candidate && sameSyntax(parent, expectedPackLoop)
          const filterCall = parent?.type === 'MemberExpression' && parent.object === candidate && sameSyntax(parents.get(parent), expectedBuildFilter) && sameSyntax(parents.get(parents.get(parent)), expectedBuildLoop)
          const entryFilter = parent?.type === 'MemberExpression' && parent.object === candidate && sameSyntax(parents.get(parents.get(parents.get(parent))), expectedUse)
          if (!declaration && !packLoop && !filterCall && !entryFilter) rosterBounded = false
        })
        const coveredManifest = file === VERIFY_SCRIPT && fn === enclosingFunction && sameSyntax(fn, expectedFunction) &&
          uses.length === 1 && sameSyntax(uses[0], expectedUse) && rosterBounded && rosterUses === 4 && declarations.get('PACKAGES') === 1 &&
          builtin({ type: 'Identifier', name: 'join' }, 'path', 'join') && staticPath(bindings.get('ROOT')?.init) === REPO
        if (coveredManifest) return
        unsupported(file, node, 'filesystem content reads require a static repo path (or proven package-only manifest use)')
      }
      // Absolute strings authored by a source are not repo-relative. Only
      // values derived from import.meta.url/ROOT may use our virtual / root.
      if (text(arg)?.startsWith('/')) unsupported(file, node, 'absolute filesystem paths are not supported')
      if (value.startsWith(`${REPO}/`)) value = value.slice(REPO.length + 1)
      else if (value.startsWith('/')) unsupported(file, node, 'filesystem path escapes the repo')
      const target = localInput(value, node, false)
      inputs.add(target)
      read(target)
    })
  }
  visit(entry)
  return { packages, inputs: [...inputs].sort(), modules: [...modules].sort() }
}
