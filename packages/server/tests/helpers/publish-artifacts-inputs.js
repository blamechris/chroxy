import { parse } from 'acorn'
import { posix as path } from 'node:path'

export const VERIFY_SCRIPT = 'scripts/verify-publish-artifacts.mjs'
const REPO = '/__chroxy_repo__'

// The only fs functions whose argument is followed as an input.
const FS_READS = ['readFile', 'readFileSync', 'createReadStream']
// The real verifier also creates/removes its temp dir, writes a generated
// consumer package.json and checks for files it just produced. None of those
// is a repo content input, so they are tolerated ONLY in the verifier and only
// up to today's call counts: any additional call is refused, never ignored.
// existsSync with a literal repo path is still discovered as an input.
const VERIFIER_FS_CALLS = { mkdtempSync: 1, rmSync: 1, writeFileSync: 1, existsSync: 3 }
// Child processes whose first literal script argument is followed as an input.
// Flags are refuse-by-default PER interpreter: only the listed ones may precede
// the script, because `-e` is inline code for node but errexit for a shell, and
// any other flag (`--import=x`, `-r./h.cjs`, `--env-file=x`) can change what runs.
const INTERPRETER_KIND = { node: 'node', nodejs: 'node', bash: 'shell', sh: 'shell', zsh: 'shell', python: 'python', python3: 'python' }
const INTERPRETER_FLAGS = {
  node: { allowed: ['--', '--no-warnings', '--input-type=module', '--input-type=commonjs'], inline: ['-e', '-p', '-pe', '--eval', '--print'], refused: [] },
  shell: { allowed: ['--', '-e', '-u', '-x'], inline: [], refused: ['-c'] },
  python: { allowed: ['-u', '-B'], inline: [], refused: ['-c', '-m'] },
}
const CHILD_PROCESS_FNS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'])
// Options a followed script may be started with. `env` contents are NOT analysed.
// Refused on EVERY child-process call: each can change which program or code runs.
const DANGEROUS_OPTION_KEYS = new Set(['shell', 'execArgv', 'execPath', 'argv0'])
const SPAWN_OPTION_KEYS = new Set(['cwd', 'stdio', 'encoding', 'timeout', 'maxBuffer', 'input', 'env'])
// A literal argument with one of these extensions to an unknown program is a script we cannot follow.
const SCRIPT_ARGUMENT = /\.(?:js|mjs|cjs|ts|mts|cts|sh|zsh|py|rb|pl|php|ps1|bat|cmd)$/
const GLOBAL_OBJECTS = new Set(['globalThis', 'global'])
const SHELL_STRING_FNS = new Set(['exec', 'execSync'])
const FORBIDDEN_MODULE = /^(?:node:)?(?:vm|worker_threads|cluster|inspector|test)$/
const SCRIPT_MODULE = /\.(?:mjs|cjs|js)$/

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
 *
 * Child processes (refuse-by-default). A call to a child_process function, or to
 * a local wrapper that forwards its first two parameters as the call's first two
 * arguments (resolved transitively), is examined:
 *  - FOLLOWED: a literal script after an interpreter (node/nodejs, bash/sh/zsh,
 *    python/python3, named by literal, process.execPath or a const bound once),
 *    fork(path), or a relative direct-executable path. A JS script is parsed like
 *    any module; any other script is recorded as an input and must exist.
 *    Options must be a literal object with only cwd (the repo root), stdio,
 *    encoding, timeout, maxBuffer, input, env.
 *  - REFUSED: flags outside the per-interpreter allowlist, shell/python inline
 *    code (-c, -m), exec/execSync command strings, a computed script, computed or
 *    spread arguments, a literal script-looking argument (.js .mjs .cjs .ts .mts
 *    .cts .sh .py .rb .pl) to any other program, a child_process binding that is
 *    aliased, destructured or passed on, a non-forwarding local wrapper, dynamic
 *    import of child_process, vm, worker_threads, cluster, inspector and test;
 *    a spread in a call's program/argument position; options that are not a
 *    literal object or that carry shell/execArgv/execPath/argv0; an interpreter
 *    given no script and an `input` option (its program comes from stdin); and
 *    a child-process call whose program is unknown and whose arguments are not
 *    a literal array, unless it is the forwarding call of a RECOGNISED wrapper
 *    (declared once, never exported, a declaration or const function, forwarding
 *    its own unmodified params 0 and 1). Refused at the spawn, so no caller works.
 *  - NOT ANALYSED (known limits): inline node -e/-p code; the children of a
 *    followed non-JS script; env / NODE_OPTIONS contents; `npm run <script>`;
 *    (()=>{}).constructor(...); a computed program name (the verifier's installed bin);
 *    an extensionless relative script passed to an unknown program.
 *
 * Code loaders are refused, never ignored: require(), eval, any bare Function,
 * process.binding/getBuiltinModule/dlopen/mainModule/execve, process, globalThis or
 * global used as a bare value (including globalThis.process), a computed
 * globalThis[...] member, and any non-node: scheme import (data:, file:, https:). Other computed content reads/imports, module URL
 * queries/fragments, absolute/escaping paths and ambiguous bindings fail with a
 * location. This is not a general JS evaluator or a shell/runtime-output analysis.
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
      if (['fs', 'fs/promises', 'path', 'url', 'child_process'].includes(imp.source) && declarations.get(name) !== 1) {
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
        if (!SCRIPT_MODULE.test(target)) unsupported(file, node, 'local module imports must have a .js/.mjs/.cjs extension')
        visit(target)
      } else if (/^(?:[/.]|file:)/.test(value)) unsupported(file, node, 'absolute or file URL imports are not supported')
      else if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^node:/.test(value)) unsupported(file, node, `'${value}' is not a node: builtin or a local path; scheme imports (data:, file:, https:) cannot be followed`)
      else if (FORBIDDEN_MODULE.test(value)) unsupported(file, node, `'${value}' runs code or threads discovery cannot see and needs explicit support`)
      else if (/^(?:node:)?module$/.test(value)) unsupported(file, node, "'node:module' (createRequire) lets a CommonJS dependency escape discovery")
    }
    function fsFnName(node) {
      if (node?.type === 'Identifier') {
        const imp = imports.get(node.name)
        if (['fs', 'fs/promises'].includes(imp?.source) && imp.name !== '*' && imp.name !== 'promises') return imp.name
        return null
      }
      if (node?.type === 'MemberExpression' && fsNamespace(node.object) && !fsNamespace(node) && !['default', 'promises'].includes(property(node))) return property(node) ?? null
      return null
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
    // Child processes. A call is a child-process call when its callee is a
    // child_process function (named, aliased or through a namespace) or a local
    // function whose body forwards to one, as the verifier's own `run` does.
    function childProcessFn(callee) {
      if (callee?.type === 'Identifier') {
        const imp = imports.get(callee.name)
        return imp?.source === 'child_process' && imp.name !== '*' ? imp.name : null
      }
      if (callee?.type === 'MemberExpression' && callee.object.type === 'Identifier') {
        const imp = imports.get(callee.object.name)
        return imp?.source === 'child_process' && imp.name === '*' ? property(callee) ?? null : null
      }
      return null
    }
    const localFunctions = new Map()
    walk(ast, (node, parent) => {
      if (node.type === 'FunctionDeclaration' && node.id) localFunctions.set(node.id.name, { fn: node, bound: true })
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)) {
        localFunctions.set(node.id.name, { fn: node.init, bound: parent?.kind === 'const' })
      }
    })
    const exportedNames = new Set()
    walk(ast, node => {
      if (node.type === 'ExportNamedDeclaration') {
        const d = node.declaration
        if (d?.id) exportedNames.add(d.id.name)
        for (const declarator of d?.declarations ?? []) patternNames(declarator.id).forEach(n => exportedNames.add(n))
        if (!node.source) for (const spec of node.specifiers) exportedNames.add(spec.local.name)
      }
      if (node.type === 'ExportDefaultDeclaration') {
        if (node.declaration.type === 'Identifier') exportedNames.add(node.declaration.name)
        if (node.declaration.id) exportedNames.add(node.declaration.id.name)
      }
    })
    // The invariant: a child-process call whose program is unknown and whose
    // arguments are not a literal array is accepted ONLY as the forwarding call
    // of a RECOGNISED wrapper. A wrapper is recognised when its function is
    // declared once, never exported, a declaration or const-bound function,
    // and forwards its own params 0 and 1 (plain, never reassigned or shadowed)
    // as that call's arguments 0 and 1. Every other such call is refused where
    // it is spawned, so no caller spelling can reach it.
    const callerKinds = new Map()
    const forwardingCalls = new WeakSet()
    const paramsRebound = (fn, names) => {
      let rebound = false
      walk(fn.body, inner => {
        const names2 = []
        if (inner.type === 'AssignmentExpression') names2.push(...patternNames(inner.left))
        if (inner.type === 'UpdateExpression') names2.push(...patternNames(inner.argument))
        if (['ForInStatement', 'ForOfStatement'].includes(inner.type) && inner.left.type !== 'VariableDeclaration') names2.push(...patternNames(inner.left))
        if (inner.type === 'VariableDeclarator') names2.push(...patternNames(inner.id))
        if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(inner.type)) {
          if (inner.id) names2.push(inner.id.name)
          for (const param of inner.params) names2.push(...patternNames(param))
        }
        if (inner.type === 'CatchClause' && inner.param) names2.push(...patternNames(inner.param))
        if (['ClassDeclaration', 'ClassExpression'].includes(inner.type) && inner.id) names2.push(inner.id.name)
        if (names2.some(n => names.includes(n))) rebound = true
      })
      return rebound
    }
    for (let changed = true; changed;) {
      changed = false
      for (const [name, { fn, bound }] of localFunctions) {
        if (callerKinds.has(name) || declarations.get(name) !== 1) continue
        let reaches = false
        const forwarding = []
        const [p0, p1] = fn.params
        walk(fn.body, inner => {
          if (inner.type !== 'CallExpression') return
          const known = childProcessFn(inner.callee) !== null || (inner.callee.type === 'Identifier' && callerKinds.has(inner.callee.name))
          if (!known) return
          reaches = true
          if (p0?.type === 'Identifier' && p1?.type === 'Identifier' &&
            inner.arguments[0]?.type === 'Identifier' && inner.arguments[0].name === p0.name &&
            inner.arguments[1]?.type === 'Identifier' && inner.arguments[1].name === p1.name) forwarding.push(inner)
        })
        if (!reaches) continue
        const recognised = bound && !exportedNames.has(name) && forwarding.length > 0 && !paramsRebound(fn, [p0.name, p1.name]) &&
          forwarding.every(call => callerKinds.get(call.callee.name) !== 'opaque')
        if (recognised) forwarding.forEach(call => forwardingCalls.add(call))
        callerKinds.set(name, recognised ? 'wrapper' : 'opaque')
        changed = true
      }
    }
    const plainObject = node => node?.type === 'ObjectExpression' && node.properties.every(p => p.type === 'Property' && !p.computed && !p.method && p.kind === 'init')
    // Where a call's options live: (cmd, args, opts), (cmd, opts) or (cmd, computedArgs, opts).
    const optionsOf = (second, third) => second?.type === 'ArrayExpression' ? third : second?.type === 'ObjectExpression' ? second : third
    function spawnedScript(node, label, scriptNode, optionsNode) {
      const what = `child process '${label}'`
      const script = text(scriptNode)
      if (script === null) unsupported(file, node, `${what} needs a literal script path: a computed one cannot be followed`)
      if (optionsNode !== undefined) {
        if (!plainObject(optionsNode)) unsupported(file, node, `${what} runs '${script}' with options discovery cannot resolve: they must be a literal object`)
        for (const p of optionsNode.properties) {
          const key = p.key.name ?? p.key.value
          if (!SPAWN_OPTION_KEYS.has(key)) unsupported(file, node, `${what} runs '${script}' with option '${key}', which can change what runs and is not understood`)
          if (key === 'cwd' && staticPath(p.value) !== REPO) unsupported(file, node, `${what} runs '${script}' with a cwd that is not the repo root`)
        }
      }
      const target = localInput(script, node, false)
      inputs.add(target)
      if (SCRIPT_MODULE.test(target)) visit(target)
      else read(target)
    }
    // The program a call names: a literal, process.execPath (node), or a const
    // bound once to a literal. Anything else is unknown (null).
    function commandName(node) {
      const literal = text(node)
      if (literal !== null) return literal
      if (node?.type === 'MemberExpression' && isProcess(node.object) && property(node) === 'execPath') return 'node'
      if (node?.type === 'Identifier') return text(visibleBinding(node))
      return null
    }
    function spawned(node, name, label) {
      if (name !== 'wrapper' && !CHILD_PROCESS_FNS.has(name)) unsupported(file, node, `child process '${name}' is not understood by input discovery`)
      if (SHELL_STRING_FNS.has(name)) unsupported(file, node, `child process '${name}' runs a shell command string that discovery cannot follow`)
      const [first, second, third] = node.arguments
      const forwardingCall = forwardingCalls.has(node)
      if (node.arguments.slice(0, 2).some(arg => arg?.type === 'SpreadElement')) {
        unsupported(file, node, `child process '${label}' is called with a spread argument: its program and arguments cannot be followed`)
      }
      const options = optionsOf(second, third)
      if (!forwardingCall && options !== undefined) {
        if (!plainObject(options)) unsupported(file, node, `child process '${label}' has options discovery cannot resolve: they must be a literal object`)
        for (const p of options.properties) {
          const key = p.key.name ?? p.key.value
          if (DANGEROUS_OPTION_KEYS.has(key)) unsupported(file, node, `child process '${label}' passes option '${key}', which can change what runs and is not understood`)
        }
      }
      if (name === 'fork') {
        if (second !== undefined && options === undefined) unsupported(file, node, `child process '${label}' has options or arguments discovery cannot resolve: they must be a literal array or object`)
        return spawnedScript(node, label, first, options)
      }
      const command = commandName(first)
      if (command === null && !forwardingCall && second?.type !== 'ArrayExpression') {
        unsupported(file, node, `child process '${label}' runs a computed program with computed arguments: only a recognised forwarding wrapper may`)
      }
      const kind = command === null || !Object.hasOwn(INTERPRETER_KIND, path.basename(command)) ? undefined : INTERPRETER_KIND[path.basename(command)]
      if (kind === undefined) {
        if (command !== null && command.includes('/') && !path.isAbsolute(command)) return spawnedScript(node, label, first, options)
        // Unknown program: refuse a literal or const-bound script-looking argument, never ignore it.
        const program = command === null ? 'a computed program' : `program '${command}'`
        for (const el of second?.type === 'ArrayExpression' ? second.elements : []) {
          const arg = el?.type === 'SpreadElement' ? null : commandName(el)
          if (arg !== null && SCRIPT_ARGUMENT.test(arg)) unsupported(file, node, `child process '${label}' runs ${program} with script argument '${arg}': discovery cannot follow it`)
        }
        return
      }
      // An interpreter that is given no script reads its program from stdin.
      const noScript = () => {
        if (options?.properties.some(p => (p.key.name ?? p.key.value) === 'input')) {
          unsupported(file, node, `child process '${label}' runs interpreter '${command}' with no script and an 'input' option: its program comes from stdin`)
        }
      }
      if (second === undefined || (second.type === 'ObjectExpression' && second === options)) return noScript()
      if (second.type !== 'ArrayExpression' || second.elements.some(el => !el || el.type === 'SpreadElement')) {
        unsupported(file, node, `child process '${label}' runs interpreter '${command}' with computed arguments: its script cannot be followed`)
      }
      const flags = INTERPRETER_FLAGS[kind]
      for (const el of second.elements) {
        const arg = text(el)
        if (arg === null) unsupported(file, node, `child process '${label}' runs interpreter '${command}' with a computed argument: its script cannot be followed`)
        // Inline node code is not analysed (documented limit).
        if (flags.inline.includes(arg) || /^--(?:eval|print)=/.test(arg) && kind === 'node') return
        if (flags.refused.includes(arg)) unsupported(file, node, `child process '${label}' passes '${arg}' to '${command}': inline code or a command string cannot be followed`)
        if (flags.allowed.includes(arg)) continue
        if (arg.startsWith('-')) unsupported(file, node, `child process '${label}' passes flag '${arg}' to '${command}': only ${flags.allowed.concat(flags.inline).join(' ')} are understood`)
        return spawnedScript(node, label, el, options)
      }
      noScript()
    }
    const isGlobalObject = node => node?.type === 'Identifier' && GLOBAL_OBJECTS.has(node.name)
    const isProcess = node => (node?.type === 'Identifier' && (node.name === 'process' || imports.get(node.name)?.source === 'process')) ||
      (node?.type === 'MemberExpression' && property(node) === 'process' && isGlobalObject(node.object))
    const fsCalls = new Map()
    walk(ast, (node, parent) => {
      const importedBinding = ['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(parent?.type)
      const memberProperty = parent?.type === 'MemberExpression' && parent.property === node && !parent.computed
      const fsName = importedBinding || memberProperty ? null : fsFnName(node)
      if (fsName !== null) {
        const tolerated = file === VERIFY_SCRIPT && Object.hasOwn(VERIFIER_FS_CALLS, fsName)
        if (!FS_READS.includes(fsName) && !tolerated) {
          unsupported(file, node, `fs '${fsName}' is not understood by input discovery; only ${FS_READS.join('/')} are followed`)
        }
        if (tolerated) {
          if (!(parent?.type === 'CallExpression' && parent.callee === node)) unsupported(file, node, `fs '${fsName}' must be called directly`)
          const count = (fsCalls.get(fsName) || 0) + 1
          fsCalls.set(fsName, count)
          if (count > VERIFIER_FS_CALLS[fsName]) unsupported(file, node, `new fs '${fsName}' call: only ${VERIFIER_FS_CALLS[fsName]} are known and none reads a repo input`)
          const literal = fsName === 'existsSync' ? staticPath(parent.arguments[0]) : null
          if (literal !== null) {
            const rel = literal.startsWith(`${REPO}/`) ? literal.slice(REPO.length + 1) : literal
            if (text(parent.arguments[0])?.startsWith('/') || rel.startsWith('/')) unsupported(file, node, 'absolute filesystem paths are not supported')
            inputs.add(localInput(rel, node, false))
          }
        }
      }
      if (['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source && /^(?:node:)?child_process$/.test(text(node.source) ?? '')) {
        unsupported(file, node, 'child_process re-exports require explicit discovery support')
      }
      if (['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source && /^(?:node:)?fs(?:\/promises)?$/.test(text(node.source) ?? '')) {
        unsupported(file, node, 'filesystem re-exports require explicit discovery support')
      }
      if (fsRead(node) || fsNamespace(node)) {
        const directUse = parent?.type === 'CallExpression' && parent.callee === node && fsRead(node)
        const memberUse = fsNamespace(node) && parent?.type === 'MemberExpression' && parent.object === node && property(parent) !== null &&
          (!['default', 'promises'].includes(property(parent)) || fsNamespace(parent))
        if (!importedBinding && !memberProperty && !directUse && !memberUse) unsupported(file, node, 'filesystem bindings may not escape into aliases or indirect calls')
      }
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) imported(node, node.source)
      if (node.type === 'ImportExpression') {
        if (/^(?:node:)?child_process$/.test(text(node.source) ?? '')) unsupported(file, node, 'dynamic child_process bindings require explicit discovery support')
        if (/^(?:node:)?fs(?:\/promises)?$/.test(text(node.source) ?? '')) unsupported(file, node, 'dynamic filesystem bindings require explicit discovery support')
        imported(node, node.source)
      }
      // Forms that load or run code discovery cannot see. Refused wherever they
      // appear, including aliased or optional-chained, never silently ignored.
      if (node.type === 'MemberExpression' && isProcess(node.object)) {
        const member = property(node)
        if (member === null || member === undefined) unsupported(file, node, 'a computed process[...] member needs explicit discovery support')
        if (['getBuiltinModule', 'binding', 'dlopen', 'mainModule', 'execve'].includes(member)) unsupported(file, node, `process.${member} loads or runs code discovery cannot follow and needs explicit support`)
      }
      if (node.type === 'MemberExpression' && isGlobalObject(node.object) && node.computed && text(node.property) === null) {
        unsupported(file, node, `a computed ${node.object.name}[...] member can name eval, Function or process and needs explicit discovery support`)
      }
      if (node.type === 'MemberExpression' && isGlobalObject(node.object) && property(node) === 'process' && !(parent?.type === 'MemberExpression' && parent.object === node)) {
        unsupported(file, node, `'${node.object.name}.process' used as a bare value can leak members discovery cannot see; use its members directly`)
      }
      if (node.type === 'MemberExpression' && isGlobalObject(node.object) && ['eval', 'Function'].includes(property(node))) {
        unsupported(file, node, `${property(node) === 'eval' ? 'eval()' : 'new Function()'} runs code discovery cannot see and needs explicit support`)
      }
      if (node.type === 'Identifier' && node.name === 'eval' && !memberProperty && !(parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand)) {
        unsupported(file, node, 'eval() runs code discovery cannot see and needs explicit support')
      }
      const objectKey = parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand
      if (node.type === 'Identifier' && node.name === 'Function' && !memberProperty && !objectKey && !importedBinding) {
        unsupported(file, node, 'new Function() runs code discovery cannot see and needs explicit support')
      }
      // process/globalThis/global are only ever read through a member, so the
      // forms above can see what is used. A bare value would let it escape.
      if (node.type === 'Identifier' && !importedBinding && !memberProperty && !objectKey && !(parent?.type === 'MemberExpression' && parent.object === node) &&
        (node.name === 'process' || GLOBAL_OBJECTS.has(node.name) || imports.get(node.name)?.source === 'process')) {
        unsupported(file, node, `'${node.name}' used as a bare value can leak members discovery cannot see; use its members directly`)
      }
      if (node.type === 'ImportDeclaration' && /^(?:node:)?process$/.test(text(node.source) ?? '')) {
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportSpecifier' && ['getBuiltinModule', 'binding', 'dlopen'].includes(spec.imported.name ?? spec.imported.value)) {
            unsupported(file, spec, `importing '${spec.imported.name ?? spec.imported.value}' from process loads code discovery cannot follow`)
          }
        }
      }
      // Child-process bindings are only understood directly in callee position.
      if (node.type === 'Identifier' && !importedBinding && !memberProperty && !objectKey) {
        const imp = imports.get(node.name)
        const callee = parent?.type === 'CallExpression' && parent.callee === node
        if (imp?.source === 'child_process') {
          const viaNamespace = imp.name === '*' && parent?.type === 'MemberExpression' && parent.object === node && property(parent) !== null &&
            property(parent) !== undefined && parents.get(parent)?.type === 'CallExpression' && parents.get(parent).callee === parent
          if (!(imp.name === '*' ? viaNamespace : callee)) unsupported(file, node, `child_process binding '${node.name}' may only be called directly, not aliased, destructured or passed on`)
        }
        const kind = callerKinds.get(node.name)
        const declaration = (parent?.type === 'VariableDeclarator' && parent.id === node) || (parent?.type === 'FunctionDeclaration' && parent.id === node)
        if (kind && !declaration && declarations.get(node.name) === 1) {
          if (kind === 'opaque') unsupported(file, node, `local function '${node.name}' reaches a child process without forwarding its first two parameters, so its callers cannot be followed`)
          if (!callee) unsupported(file, node, `child process wrapper '${node.name}' may only be called directly, not aliased or passed on`)
        }
      }
      if (node.type !== 'CallExpression') return
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') unsupported(file, node, 'require() needs explicit discovery support')
      const childFn = childProcessFn(node.callee) ?? (node.callee.type === 'Identifier' && callerKinds.get(node.callee.name) === 'wrapper' ? 'wrapper' : null)
      if (childFn !== null) spawned(node, childFn, childFn === 'wrapper' ? node.callee.name : childFn)
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
        let rosterDrift = null
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
          if (!declaration && !packLoop && !filterCall && !entryFilter && rosterDrift === null) {
            const call = parent?.type === 'MemberExpression' && parent.object === candidate ? parents.get(parent) : null
            if (parent?.type === 'ForOfStatement' && parent.right === candidate) rosterDrift = 'the PACKAGES pack loop drifted'
            else if (call && (sameSyntax(call, expectedBuildFilter) || parents.get(call)?.type === 'ForOfStatement')) rosterDrift = 'the PACKAGES.filter((p) => p.build) build loop drifted'
            else rosterDrift = 'PACKAGES is used outside its declaration, pack loop, build loop and entryPointsFor filter'
          }
        })
        // Each coupled snippet is named, in a fixed order, so a legitimate edit to
        // one fails with the snippet that drifted instead of one generic message.
        // The conjunction is exactly the old single boolean: nothing newly passes.
        const drift = file !== VERIFY_SCRIPT ? null : [
          [fn !== null, 'entryPointsFor must be declared exactly once'],
          [fn === enclosingFunction, 'this dynamic read is not inside entryPointsFor'],
          [sameSyntax(fn, expectedFunction), 'entryPointsFor no longer matches the expected function'],
          [uses.length === 1 && sameSyntax(uses[0], expectedUse), 'the PACKAGES.filter(...).flatMap(entryPointsFor) use drifted'],
          [rosterDrift === null, rosterDrift],
          [rosterUses === 4, `PACKAGES has ${rosterUses} uses, expected its declaration plus the pack loop, build loop and entryPointsFor filter`],
          // Defence in depth: an earlier condition (the declaration shape in the roster check) always pre-empts this one.
          [declarations.get('PACKAGES') === 1, 'PACKAGES must be declared exactly once'],
          [builtin({ type: 'Identifier', name: 'join' }, 'path', 'join'), "'join' is no longer imported from node:path"],
          [staticPath(bindings.get('ROOT')?.init) === REPO, 'ROOT no longer resolves to the repo root'],
        ].find(([ok]) => !ok)
        if (file === VERIFY_SCRIPT && !drift) return
        const detail = drift ? `: ${drift[1]}` : ''
        unsupported(file, node, `filesystem content reads require a static repo path (or proven package-only manifest use)${detail}`)
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
