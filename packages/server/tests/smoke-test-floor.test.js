import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as acornParse } from 'acorn'
import { harnessVerdict, SMOKE_MIN_CASES, smokeMinCases, requireIdeFrom } from './helpers/harness-floor.mjs'

// Pure verdict fixtures only: this file never imports or runs the browser harness.
const pass = n => Array.from({ length: n }, () => ({ status: 'PASS' }))

describe('smoke-test mode-aware verdict (#7657, #8435)', () => {
  it('keeps the explicit 16-case local and existing 18-case required floors', () => {
    assert.equal(smokeMinCases(false), 16)
    assert.equal(smokeMinCases(true), 18)
    assert.equal(SMOKE_MIN_CASES, 18, 'existing callers keep the required-mode constant')
  })

  it('defaults the pure selector to the non-required mode', () => {
    assert.equal(smokeMinCases(), 16)
  })

  it('requireIdeFrom decides strictness from the flag and CI', () => {
    const table = [
      [{ CI: 'true' }, true, 'CI, flag unset -> strict'],
      [{}, false, 'no CI, flag unset -> lenient'],
      [{ CI: 'true', SMOKE_REQUIRE_IDE: '0' }, false, "flag '0' opts out under CI"],
      [{ SMOKE_REQUIRE_IDE: '1' }, true, "flag '1' without CI -> strict"],
      [{ CI: 'true', SMOKE_REQUIRE_IDE: '1' }, true, "flag '1' under CI -> strict"],
      [{ CI: 'true', SMOKE_REQUIRE_IDE: '' }, true, 'empty flag = unset, under CI'],
      [{ CI: 'true', SMOKE_REQUIRE_IDE: 'false' }, true, 'other flag value = unset, under CI'],
      [{ CI: 'true', SMOKE_REQUIRE_IDE: 'yes' }, true, 'typo cannot loosen CI'],
      [{ SMOKE_REQUIRE_IDE: 'true' }, false, 'other flag value = unset, no CI'],
      [{ CI: '' }, false, 'empty CI is not CI'],
      [{ CI: '0' }, false, "CI '0' is not CI"],
      [{ CI: 'false' }, false, "CI 'false' is not CI"],
    ]
    for (const [env, strict, why] of table) {
      assert.equal(requireIdeFrom(env), strict, why)
      assert.equal(smokeMinCases(requireIdeFrom(env)), strict ? 18 : 16, `floor: ${why}`)
    }
  })

  for (const { mode, requireIde, floor } of [
    { mode: 'non-required IDE', requireIde: false, floor: 16 },
    { mode: 'required IDE', requireIde: true, floor: 18 },
  ]) {
    describe(mode, () => {
      it('zero cases is broken, not passing', () => {
        const v = harnessVerdict([], smokeMinCases(requireIde))
        assert.equal(v.failed, 0)
        assert.equal(v.broken, true)
        assert.equal(v.exitCode, 1)
        assert.ok(v.summary.startsWith(`HARNESS BROKEN: ran 0 cases, expected at least ${floor}.`))
      })

      it('one below its floor is broken even when every case passes', () => {
        const v = harnessVerdict(pass(floor - 1), smokeMinCases(requireIde))
        assert.equal(v.total, floor - 1)
        assert.equal(v.failed, 0)
        assert.equal(v.broken, true)
        assert.equal(v.exitCode, 1)
      })

      it('a healthy run exactly at its floor passes', () => {
        const v = harnessVerdict(pass(floor), smokeMinCases(requireIde))
        assert.equal(v.total, floor)
        assert.equal(v.passed, floor)
        assert.equal(v.broken, false)
        assert.equal(v.exitCode, 0)
        assert.equal(v.summary, `${floor} passed, 0 failed`)
      })

      it('a healthy run above its floor passes', () => {
        const v = harnessVerdict(pass(floor + 1), smokeMinCases(requireIde))
        assert.equal(v.broken, false)
        assert.equal(v.exitCode, 0)
      })

      it('an actual recorded failure at its floor still fails', () => {
        const v = harnessVerdict([
          ...pass(floor - 1), { name: 'WebSocket connects', status: 'FAIL' },
        ], smokeMinCases(requireIde))
        assert.equal(v.broken, false)
        assert.equal(v.failed, 1)
        assert.equal(v.exitCode, 1)
        assert.equal(v.summary, `${floor - 1} passed, 1 failed`)
      })

      it('an actual recorded failure above its floor still fails', () => {
        const v = harnessVerdict([...pass(floor), { status: 'FAIL' }], smokeMinCases(requireIde))
        assert.equal(v.broken, false)
        assert.equal(v.failed, 1)
        assert.equal(v.exitCode, 1)
      })
    })
  }

  it('the healthy 16-row local fixture remains broken in required mode', () => {
    const v = harnessVerdict(pass(16), smokeMinCases(true))
    assert.equal(v.broken, true)
    assert.equal(v.exitCode, 1)
  })

  it('the historical 22-row required fixture remains a positive control', () => {
    const v = harnessVerdict(pass(22), smokeMinCases(true))
    assert.equal(v.broken, false)
    assert.equal(v.exitCode, 0)
    assert.ok(SMOKE_MIN_CASES < 22)
  })
})

// Structural check (#9142): `requireIdeFrom(process.env)` must be the SOLE decider of
// strict mode in smoke-test.mjs. Parses the source with acorn rather than matching its
// spelling, so an appended `&& ...`, a bracket read or any operator cannot slip past.
// Returns a short list of problems (empty = wired correctly); throws on unparseable source.
const HELPER = 'requireIdeFrom'
const HELPER_MODULE = './helpers/harness-floor.mjs'
const MODE = 'requireIde'
// The two env inputs the helper consumes; smoke-test.mjs must never read either itself.
const HELPER_INPUTS = ['SMOKE_REQUIRE_IDE', 'CI']

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const key of Object.keys(node)) {
    const child = node[key]
    if (Array.isArray(child)) child.forEach(c => walk(c, visit))
    else if (child && typeof child.type === 'string') walk(child, visit)
  }
}

function patternNames(pattern, out = []) {
  if (!pattern) return out
  if (pattern.type === 'Identifier') out.push(pattern.name)
  else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(p => patternNames(p.value || p.argument, out))
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(e => patternNames(e, out))
  else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, out)
  else if (pattern.type === 'RestElement') patternNames(pattern.argument, out)
  return out
}

// Which helper input (if any) a property key names: an identifier (non-computed),
// a string literal, or a template literal with no substitutions.
function inputKeyName(node, computed) {
  if (!node) return null
  let name = null
  if (!computed && node.type === 'Identifier') name = node.name
  else if (node.type === 'Literal') name = node.value
  else if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) name = node.quasis[0].value.cooked
  return HELPER_INPUTS.includes(name) ? name : null
}

export function checkRequireIdeWiring(source) {
  const ast = acornParse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const modeDeclarators = []
  const helperImports = []
  const helperBindings = []
  const problems = []
  const reads = []
  const bind = (names, how) => names.forEach(n => { if (n === HELPER) helperBindings.push(how) })
  walk(ast, node => {
    if (node.type === 'ImportDeclaration') {
      for (const sp of node.specifiers) {
        if (sp.local.name === HELPER) helperImports.push({ source: node.source.value, spec: sp })
      }
    }
    if (node.type === 'VariableDeclarator') {
      const names = patternNames(node.id)
      if (names.includes(MODE)) modeDeclarators.push(node)
      bind(names, 'variable')
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      if (node.id) bind([node.id.name], node.type)
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      node.params.forEach(prm => bind(patternNames(prm), 'parameter'))
      if (node.type === 'FunctionExpression' && node.id) bind([node.id.name], 'function expression')
    }
    if (node.type === 'ClassExpression' && node.id) bind([node.id.name], 'class expression')
    if (node.type === 'CatchClause' && node.param) bind(patternNames(node.param), 'catch parameter')
    if (node.type === 'MemberExpression') {
      const k = inputKeyName(node.property, node.computed)
      if (k) reads.push(k)
    }
    // `const { SMOKE_REQUIRE_IDE, CI } = process.env` reads without a MemberExpression
    if (node.type === 'ObjectPattern') {
      for (const p of node.properties) {
        const k = p.type === 'Property' ? inputKeyName(p.key, p.computed) : null
        if (k) reads.push(k)
      }
    }
    if (node.type === 'AssignmentExpression' && patternNames(node.left).includes(MODE)) problems.push('requireIde is reassigned')
    if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier' && node.argument.name === MODE) problems.push('requireIde is updated')
  })

  const goodImport = helperImports.length === 1 && helperImports[0].source === HELPER_MODULE &&
    helperImports[0].spec.type === 'ImportSpecifier' && helperImports[0].spec.imported.name === HELPER
  if (!goodImport) problems.push(`${HELPER} is not imported exactly once from ${HELPER_MODULE} under its own name`)
  if (helperBindings.length !== 0) problems.push(`${HELPER} is also bound locally (${helperBindings.join(', ')})`)

  if (modeDeclarators.length !== 1) problems.push(`expected exactly one requireIde declaration, found ${modeDeclarators.length}`)
  else {
    const init = modeDeclarators[0].init
    const isEnv = a => a && a.type === 'MemberExpression' && !a.computed && !a.optional &&
      a.object.type === 'Identifier' && a.object.name === 'process' &&
      a.property.type === 'Identifier' && a.property.name === 'env'
    const ok = modeDeclarators[0].id.type === 'Identifier' && init && init.type === 'CallExpression' &&
      !init.optional && init.callee.type === 'Identifier' && init.callee.name === HELPER &&
      init.arguments.length === 1 && isEnv(init.arguments[0])
    if (!ok) problems.push('requireIde init is not exactly requireIdeFrom(process.env)')
  }
  for (const input of HELPER_INPUTS) {
    const n = reads.filter(r => r === input).length
    if (n !== 0) problems.push(`${n} direct read(s) of ${input} beside the shared helper`)
  }
  return problems
}

describe('requireIde wiring check proves both ways (#9142)', () => {
  const imp = "import { requireIdeFrom } from './helpers/harness-floor.mjs'\n"
  const decl = 'const requireIde = requireIdeFrom(process.env)\n'
  const real = imp + decl + "async function run() { if (requireIde) fail('x') }\n"
  // [name, source, stable substring of the reason it must be rejected for]
  const rejected = [
    ['appended && expression (review mutation 1)', imp + "const requireIde = requireIdeFrom(process.env) && process.env['SMOKE_REQUIRE_IDE'] !== '0'", 'requireIde init is not exactly'],
    ['bracket read with !== (review mutation 2)', imp + decl + "const x = process.env['SMOKE_REQUIRE_IDE'] !== '0'", 'direct read(s) of SMOKE_REQUIRE_IDE'],
    ['dot read with ===', imp + decl + "const x = process.env.SMOKE_REQUIRE_IDE === '1'", 'direct read(s) of SMOKE_REQUIRE_IDE'],
    ['dot read with !==', imp + decl + "const x = process.env.SMOKE_REQUIRE_IDE !== '0'", 'direct read(s) of SMOKE_REQUIRE_IDE'],
    ['dot read with ==', imp + decl + "const x = process.env.SMOKE_REQUIRE_IDE == '1'", 'direct read(s) of SMOKE_REQUIRE_IDE'],
    ['bracket read with ===', imp + decl + "const x = process.env['SMOKE_REQUIRE_IDE'] === '1'", 'direct read(s) of SMOKE_REQUIRE_IDE'],
    ['bracket read with ==', imp + decl + "const x = process.env['SMOKE_REQUIRE_IDE'] == '1'", 'direct read(s) of SMOKE_REQUIRE_IDE'],
    ['bare dot truthiness read', imp + decl + 'if (process.env.SMOKE_REQUIRE_IDE) {}', 'direct read(s) of SMOKE_REQUIRE_IDE'],
    ['bare bracket truthiness read', imp + decl + "if (process.env['SMOKE_REQUIRE_IDE']) {}", 'direct read(s) of SMOKE_REQUIRE_IDE'],
    ['template-literal key', imp + decl + 'const x = process.env[`SMOKE_REQUIRE_IDE`]', 'direct read(s) of SMOKE_REQUIRE_IDE'],
    ['optional-chain read', imp + decl + 'const x = process.env?.SMOKE_REQUIRE_IDE', 'direct read(s) of SMOKE_REQUIRE_IDE'],
    ['destructured read', imp + decl + 'const { SMOKE_REQUIRE_IDE } = process.env', 'direct read(s) of SMOKE_REQUIRE_IDE'],
    ['requireIde || process.env.CI', imp + decl + 'const strict = requireIde || process.env.CI', 'direct read(s) of CI'],
    ['bracket CI read', imp + decl + "const x = process.env['CI']", 'direct read(s) of CI'],
    ['template CI read', imp + decl + 'const x = process.env[`CI`]', 'direct read(s) of CI'],
    ['optional CI read', imp + decl + 'const x = process.env?.CI', 'direct read(s) of CI'],
    ['destructured CI read', imp + decl + 'const { CI } = process.env', 'direct read(s) of CI'],
    ['reassignment', imp + 'let requireIde = requireIdeFrom(process.env)\nrequireIde = false', 'requireIde is reassigned'],
    ['compound reassignment', imp + 'let requireIde = requireIdeFrom(process.env)\nrequireIde ||= true', 'requireIde is reassigned'],
    ['update expression', imp + 'let requireIde = requireIdeFrom(process.env)\nrequireIde++', 'requireIde is updated'],
    ['second declaration', imp + decl + 'function f() { const requireIde = false }', 'found 2'],
    ['no declaration', imp + 'const other = requireIdeFrom(process.env)', 'found 0'],
    ['wrong argument', imp + 'const requireIde = requireIdeFrom({})', 'requireIde init is not exactly'],
    ['extra argument', imp + 'const requireIde = requireIdeFrom(process.env, true)', 'requireIde init is not exactly'],
    ['wrapped call', imp + 'const requireIde = !requireIdeFrom(process.env)', 'requireIde init is not exactly'],
    ['local function instead of the import', 'function requireIdeFrom(e) { return false }\n' + decl, 'not imported exactly once'],
    ['nested local function shadowing the import', imp + decl + 'function g() { function requireIdeFrom(e) { return false } }', 'bound locally'],
    ['import from the wrong module', "import { requireIdeFrom } from './other.mjs'\n" + decl, 'not imported exactly once'],
    ['missing import', decl, 'not imported exactly once'],
    ['aliased import', "import { requireIdeFrom as r } from './helpers/harness-floor.mjs'\nconst requireIde = r(process.env)", 'not imported exactly once'],
    ['aliased import with the name rebound locally', "import { requireIdeFrom as r } from './helpers/harness-floor.mjs'\nconst requireIdeFrom = r\n" + decl, 'not imported exactly once'],
    ['later local rebind', imp + decl + 'function g() { const requireIdeFrom = () => false }', 'bound locally'],
    ['parameter shadow', imp + decl + 'function f(requireIdeFrom) {}', 'bound locally'],
    ['destructured rebind', imp + decl + 'function g(obj) { const { requireIdeFrom } = obj }', 'bound locally'],
  ]
  for (const [name, source, reason] of rejected) {
    it(`rejects: ${name}`, () => {
      const problems = checkRequireIdeWiring(source)
      assert.ok(problems.some(p => p.includes(reason)), `expected a problem containing "${reason}", got ${JSON.stringify(problems)}`)
    })
  }

  it('accepts the exact real form', () => {
    assert.deepEqual(checkRequireIdeWiring(real), [])
  })

  it('ignores the helper input names inside strings and comments', () => {
    assert.deepEqual(checkRequireIdeWiring("// SMOKE_REQUIRE_IDE, CI\n" + imp + decl + "fail('expected (SMOKE_REQUIRE_IDE) in CI')"), [])
  })

  it('a top-level redeclaration of the helper name is a parse error, not a pass', () => {
    assert.throws(() => checkRequireIdeWiring(imp + 'function requireIdeFrom(e) { return false }\n' + decl))
    assert.throws(() => checkRequireIdeWiring(imp + "import { requireIdeFrom } from './other.mjs'\n" + decl))
  })

  it('fails loudly on unparseable source instead of passing', () => {
    assert.throws(() => checkRequireIdeWiring('const requireIde = requireIdeFrom(process.env'))
  })
})

// Static source assertions, not live smoke coverage. Keep them separate from
// the executed pure-helper cases above: Playwright/server remain out of graph.
describe('smoke-test source wiring (#7657, #8435)', () => {
  const src = readFileSync(new URL('./smoke-test.mjs', import.meta.url), 'utf8')

  it('the actual summary selects its floor from the shared mode boolean', () => {
    const summary = src.slice(src.indexOf('  // Summary'), src.indexOf('  // Cleanup'))
    const declarations = summary.split('\n').map(l => l.trim()).filter(l => l.startsWith('const verdict ='))
    assert.deepEqual(declarations, ['const verdict = harnessVerdict(results, smokeMinCases(requireIde))'])
    assert.equal((src.match(/\bharnessVerdict\(/g) || []).length, 1, 'no other or dead verdict call')
  })

  it('the strict mode flag is derived once and keeps both required-IDE failures', () => {
    assert.deepEqual(checkRequireIdeWiring(src), [], 'requireIdeFrom(process.env) must be the sole decider')
    assert.ok(src.indexOf('const requireIde =') < src.indexOf('async function run()'), 'same mode reaches probes and summary')
    assert.ok(src.includes("if (requireIde) fail('IDE quick-open palette',"), 'missing required palette must still fail')
    assert.ok(src.includes("if (requireIde) fail('IDE go-to-def fixture',"), 'missing required fixture must still fail')
  })

  it('the non-IDE source inventory has 16 base labels plus two best-effort labels', () => {
    const core = src.slice(src.indexOf('async function run()'), src.indexOf('    // ---- IDE Go-to-Definition')) +
      src.slice(src.indexOf('    // ---- Console errors ----'), src.indexOf('  // Summary'))
    const labels = [...new Set([...core.matchAll(/\bpass\('([^']+)'/g)].map(m => m[1]))]
    const bestEffort = ['Control Room sort/filter controls', 'Control Room refresh']
    const base = labels.filter(label => !bestEffort.includes(label))
    assert.deepEqual(base, [
      'Dashboard loads', 'WebSocket connects', 'Version badge', 'Sidebar visible',
      'Session tabs', 'Full-width layout', 'Input bar present',
      'New Session modal opens (Ctrl+N)', 'Session name input', 'CWD combobox',
      'Provider picker', '? opens shortcut help', 'Control Room opens',
      'Control Room tab present', 'Control Room renders', 'No critical console errors',
    ])
    assert.equal(base.length, 16)
    assert.deepEqual(labels.filter(label => bestEffort.includes(label)), bestEffort)
  })

  it('run() returns the floored verdict without any exit bypass', () => {
    // Enumeration catches added bypass exits that presence checks would miss.
    const runBody = src.slice(src.indexOf('async function run()'), src.lastIndexOf('\nrun()'))
    assert.ok(runBody.length > 1000, 'precondition: the run() body was actually located')
    const exitsInRun = runBody.split('\n').filter(l => /process\.exit\s*\(/.test(l) && !l.trimStart().startsWith('//'))
    assert.equal(exitsInRun.length, 0, 'run() must return its code, never exit')
    assert.ok(/return verdict\.exitCode/.test(runBody), 'the returned code is the verdict')

    const tail = src.slice(src.lastIndexOf('\nrun()'))
    const exits = tail.split('\n').filter(l => /process\.exit\s*\(/.test(l) && !l.trimStart().startsWith('//'))
    assert.equal(exits.length, 2, `expected exactly two module-scope exits, found ${exits.length}`)
    assert.ok(/process\.exit\(code\)/.test(exits[0]), 'success exits on the returned code')
    assert.ok(/process\.exit\(1\)/.test(exits[1]), 'fatal errors exit non-zero')
  })
})
