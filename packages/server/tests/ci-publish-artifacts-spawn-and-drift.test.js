import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { discoverPublishInputs, VERIFY_SCRIPT } from './helpers/publish-artifacts-inputs.js'

// Companion to ci-publish-artifacts-path-filter.test.js (#9150). Three gaps in
// what input discovery can see: a child process started with a script path, a
// drifted exemption snippet that failed with one generic message, and code
// loaders (eval, new Function, process.binding, process.getBuiltinModule) that
// were silently ignored. Every cell asserts the EXACT outcome.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const REAL_VERIFIER = readFileSync(`${ROOT}${VERIFY_SCRIPT}`, 'utf8')

const PACKAGE_SOURCE = `const PACKAGES = [
  { name: '@chroxy/protocol', packFrom: null },
  { name: '@chroxy/store-core', packFrom: 'packages/store-core/publish' },
  { name: '@chroxy/server', packFrom: null },
]`
const CP = "import { execFileSync, spawnSync, spawn, fork } from 'node:child_process'\n"
const WRAPPER = 'const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts })\n'
const ROOT_DECL = "import { resolve, dirname } from 'node:path'; import { fileURLToPath } from 'node:url'; const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')\n"

function discover(extra = '', files = {}) {
  const sources = { [VERIFY_SCRIPT]: `${PACKAGE_SOURCE}\n${extra}`, ...files }
  const reads = []
  const result = discoverPublishInputs({
    readSource: name => {
      reads.push(name)
      if (!(name in sources)) throw new Error(`missing fixture ${name}`)
      return sources[name]
    },
  })
  return { ...result, reads }
}

function discoverReal(transform) {
  const source = transform(REAL_VERIFIER)
  assert.notEqual(source, REAL_VERIFIER, 'the mutation must change the real verifier source')
  return discoverPublishInputs({ readSource: p => p === VERIFY_SCRIPT ? source : readFileSync(`${ROOT}${p}`, 'utf8') })
}

function replaceOnce(from, to) {
  return source => {
    assert.equal(source.split(from).length - 1, 1, `expected exactly one occurrence of: ${from}`)
    return source.replace(from, to)
  }
}

describe('a child process started with a literal script path is followed or recorded (#9150)', () => {
  const followed = [
    ['spawnSync', `${CP}spawnSync('node', ['scripts/x.mjs'])`],
    ['execFileSync with ./ prefix', `${CP}execFileSync('node', ['./scripts/x.mjs'])`],
    ['spawn', `${CP}spawn('node', ['scripts/x.mjs'], { stdio: 'inherit' })`],
    ['namespace import', "import * as cp from 'node:child_process'; cp.spawnSync('node', ['scripts/x.mjs'])"],
    ['default import', "import cp from 'child_process'; cp.execFileSync('node', ['scripts/x.mjs'])"],
    ['aliased import', "import { spawnSync as launch } from 'node:child_process'; launch('node', ['scripts/x.mjs'])"],
    ['leading node flags', `${CP}spawnSync('node', ['--no-warnings', '--input-type=module', 'scripts/x.mjs'])`],
    ['template literal path', `${CP}spawnSync('node', [\`scripts/x.mjs\`])`],
    ['local wrapper function expression', `${CP}${WRAPPER}run('node', ['scripts/x.mjs'])`],
    ['local wrapper function declaration', `${CP}function run(cmd, args) { return execFileSync(cmd, args) }\nrun('node', ['scripts/x.mjs'])`],
    ['wrapper that forwards through spawnSync', `${CP}const go = (c, a) => spawnSync(c, a)\ngo('node', ['scripts/x.mjs'])`],
    ['cwd at the repo root', `${CP}${ROOT_DECL}spawnSync('node', ['scripts/x.mjs'], { cwd: ROOT })`],
  ]
  for (const [label, source] of followed) {
    it(`${label}: follows a JS script like any other input`, () => {
      const result = discover(source, { 'scripts/x.mjs': "import './lib/y.mjs'", 'scripts/lib/y.mjs': 'export const y = 1' })
      assert.deepEqual(result.inputs, ['scripts/lib/y.mjs', 'scripts/x.mjs'])
      assert.deepEqual(result.modules, ['scripts/lib/y.mjs', 'scripts/x.mjs', VERIFY_SCRIPT].sort())
    })
  }

  it('fork follows its module path', () => {
    assert.deepEqual(discover(`${CP}fork('scripts/x.mjs')`, { 'scripts/x.mjs': '' }).inputs, ['scripts/x.mjs'])
  })

  it('records a .js and a .cjs script and parses it', () => {
    assert.deepEqual(discover(`${CP}spawnSync('node', ['scripts/a.js']); spawnSync('node', ['scripts/b.cjs'])`, { 'scripts/a.js': '', 'scripts/b.cjs': '' }).inputs, ['scripts/a.js', 'scripts/b.cjs'])
  })

  it('a followed script is walked: its own reads, imports and spawns become inputs', () => {
    const result = discover(`${CP}spawnSync('node', ['scripts/x.mjs'])`, {
      'scripts/x.mjs': `import { readFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process'; readFileSync('scripts/data.json'); spawnSync('bash', ['scripts/y.sh']); spawnSync('node', ['scripts/x.mjs'])`,
      'scripts/data.json': '{}',
      'scripts/y.sh': 'echo y',
    })
    assert.deepEqual(result.inputs, ['scripts/data.json', 'scripts/x.mjs', 'scripts/y.sh'])
  })

  it('a followed script is held to the same refusals (require is refused inside it)', () => {
    assert.throws(() => discover(`${CP}spawnSync('node', ['scripts/x.mjs'])`, { 'scripts/x.mjs': "const fs = require('node:fs')" }), /scripts\/x\.mjs:\d+: .*require\(\) needs explicit/)
  })

  it('a missing script is refused by name instead of skipped', () => {
    assert.throws(() => discover(`${CP}spawnSync('node', ['scripts/missing.mjs'])`), /scripts\/missing\.mjs: cannot read publish-verification input/)
  })

  for (const [label, source] of [
    ['bash', `${CP}spawnSync('bash', ['scripts/x.sh'])`],
    ['sh with a flag first', `${CP}spawnSync('sh', ['-x', 'scripts/x.sh'])`],
    ['python3', `${CP}spawnSync('python3', ['scripts/x.sh'])`],
    ['a direct executable path', `${CP}execFileSync('./scripts/x.sh', [])`],
    ['a direct executable through the wrapper', `${CP}${WRAPPER}run('scripts/x.sh', ['--flag'])`],
  ]) {
    it(`${label}: records a non-JS script as an input path and requires it to exist`, () => {
      const result = discover(source, { 'scripts/x.sh': '#!/bin/sh\necho hi' })
      assert.deepEqual(result.inputs, ['scripts/x.sh'])
      assert.deepEqual(result.modules, [VERIFY_SCRIPT])
      assert.throws(() => discover(source), /scripts\/x\.sh: cannot read publish-verification input/)
    })
  }

  it('does not treat inline code, installed bins or package tools as script inputs', () => {
    const source = `${CP}${WRAPPER}${ROOT_DECL}
      run('node', ['-p', "JSON.stringify(require('./packages/server/package.json'))"], { cwd: ROOT })
      spawnSync('node', ['--input-type=module', '-e', 'await import("x")'], { encoding: 'utf8' })
      spawnSync('node', ['--eval=1'])
      spawnSync('bash', ['-c', 'echo hi'])
      spawnSync('node')
      run('npm', ['run', 'build', '-w', '@chroxy/protocol'], { cwd: ROOT })
      run('tar', ['tzf', 'a.tgz'])
      run('mkdir', ['-p', 'x'])
      const bin = 'chroxy'
      run(bin, ['--version'])
      spawnSync(bin, ['doctor'], { timeout: 1 })`
    const result = discover(source)
    assert.deepEqual(result.inputs, [])
    assert.deepEqual(result.modules, [VERIFY_SCRIPT])
  })

  it('does not follow a command string that merely names a script path as an argument of a non-interpreter', () => {
    assert.deepEqual(discover(`${CP}spawnSync('tar', ['tzf', 'scripts/x.mjs'])`).inputs, [])
  })

  for (const [label, source, message] of [
    ['a computed script argument', `${CP}const s = f(); spawnSync('node', [s])`, /child process 'spawnSync' runs interpreter 'node' with a computed argument/],
    ['a computed template script', `${CP}spawnSync('node', [\`scripts/\${name}.mjs\`])`, /with a computed argument/],
    ['a computed script behind a flag', `${CP}spawnSync('node', ['--no-warnings', s])`, /with a computed argument/],
    ['a computed script through the wrapper', `${CP}${WRAPPER}run('bash', [s])`, /child process 'wrapper' runs interpreter 'bash' with a computed argument/],
    ['a variable argument array', `${CP}const args = ['scripts/x.mjs']; spawnSync('node', args)`, /with computed arguments/],
    ['a spread inside the argument array', `${CP}spawnSync('node', [...rest, 'scripts/x.mjs'])`, /with computed arguments/],
    ['a built argument array', `${CP}spawnSync('node', ['a'].concat(s))`, /with computed arguments/],
    ['a computed fork module', `${CP}fork(modulePath)`, /child process 'fork' needs a literal script path/],
    ['a node flag that takes a separate value', `${CP}spawnSync('node', ['--import', './hook.mjs', 'scripts/x.mjs'])`, /passes '--import' to 'node'/],
    ['a shell command string (exec)', "import { exec } from 'node:child_process'; exec('node scripts/x.mjs')", /child process 'exec' runs a shell command string/],
    ['a shell command string (execSync)', "import { execSync } from 'node:child_process'; execSync('bash scripts/x.sh')", /child process 'execSync' runs a shell command string/],
    ['a script outside the repo', `${CP}spawnSync('node', ['../outside.mjs'])`, /escapes the repo/],
    ['an absolute script path', `${CP}spawnSync('node', ['/tmp/x.mjs'])`, /escapes the repo|absolute/],
    ['a URL script path', `${CP}spawnSync('node', ['file:///tmp/x.mjs'])`, /without URL suffixes/],
    ['a script with a query', `${CP}spawnSync('node', ['scripts/x.mjs?v=1'])`, /without URL suffixes/],
    ['a cwd that is not the repo root', `${CP}spawnSync('node', ['scripts/x.mjs'], { cwd: '/tmp' })`, /its cwd must be the repo root/],
    ['a computed cwd', `${CP}spawnSync('node', ['scripts/x.mjs'], { cwd: elsewhere })`, /its cwd must be the repo root/],
    ['spread options', `${CP}spawnSync('node', ['scripts/x.mjs'], { ...opts })`, /options discovery cannot resolve/],
    ['an options variable', `${CP}spawnSync('node', ['scripts/x.mjs'], opts)`, /options discovery cannot resolve/],
  ]) {
    it(`refuses ${label}`, () => {
      assert.throws(() => discover(source, { 'scripts/x.mjs': '', 'scripts/x.sh': '' }), message)
    })
  }

  it('names the call and the file in a refusal', () => {
    assert.throws(() => discover(`${CP}spawnSync('node', [s])`), /verify-publish-artifacts\.mjs:\d+: unsupported publish-verification input: child process 'spawnSync'/)
  })

  describe('against the real verifier', () => {
    it('the real verifier still passes unchanged, with the same inputs it had', () => {
      const result = discoverPublishInputs({ readSource: p => readFileSync(`${ROOT}${p}`, 'utf8') })
      assert.deepEqual(result.packages, ['protocol', 'store-core', 'server'])
      assert.ok(result.inputs.includes('scripts/lib/classify-doctor-output.mjs'))
      assert.ok(result.inputs.includes('scripts/lib/daemon-entry-modules.mjs'))
      assert.ok(result.inputs.every(p => !p.endsWith('.sh')), JSON.stringify(result.inputs))
    })

    it('sees a spawn through the verifier own run() wrapper: a computed script is refused', () => {
      assert.throws(() => discoverReal(source => `${source}\nrun('node', [computedScript])\n`), /child process 'wrapper' runs interpreter 'node' with a computed argument/)
    })

    it('sees a spawn through the verifier own run() wrapper: a literal script is recorded', () => {
      const result = discoverPublishInputs({
        readSource: p => p === VERIFY_SCRIPT ? `${REAL_VERIFIER}\nrun('bash', ['scripts/zz-added.sh'])\n` : p === 'scripts/zz-added.sh' ? '' : readFileSync(`${ROOT}${p}`, 'utf8'),
      })
      assert.ok(result.inputs.includes('scripts/zz-added.sh'))
    })

    it('sees a direct spawnSync in the verifier: a computed script is refused', () => {
      assert.throws(() => discoverReal(source => `${source}\nspawnSync('node', [computedScript])\n`), /child process 'spawnSync' runs interpreter 'node' with a computed argument/)
    })
  })
})

describe('a drifted exemption snippet is named, and nothing newly passes (#9150)', () => {
  const generic = /filesystem content reads require a static repo path \(or proven package-only manifest use\)/
  for (const [label, from, to, named] of [
    ['entryPointsFor body', 'const exportsField = manifest.exports', 'const exportsField = manifest.exports ?? null', /entryPointsFor no longer matches the expected function/],
    ['the entryPointsFor use', ".filter((p) => p.name !== '@chroxy/server') //", ".filter((p) => p.name !== '@chroxy/protocol') //", /the PACKAGES\.filter\(\.\.\.\)\.flatMap\(entryPointsFor\) use drifted/],
    ['the entryPointsFor callback', '.flatMap(entryPointsFor)', '.flatMap((pkg) => entryPointsFor(pkg))', /the PACKAGES\.filter\(\.\.\.\)\.flatMap\(entryPointsFor\) use drifted/],
    ['the pack loop', 'tarballs.push(tgz)', 'tarballs.push(tgz, tgz)', /the PACKAGES pack loop drifted/],
    ['the build loop body', "['run', p.build, '-w', p.name]", "['run', p.build, '-w', p.name, '--silent']", /the PACKAGES\.filter\(\(p\) => p\.build\) build loop drifted/],
    ['the build filter', 'for (const p of PACKAGES.filter((p) => p.build)) {', "for (const p of PACKAGES.filter((p) => p.build !== 'none')) {", /the PACKAGES\.filter\(\(p\) => p\.build\) build loop drifted/],
    ['a new PACKAGES use', 'const KEEP =', 'const countOfPackages = PACKAGES.length\nconst KEEP =', /PACKAGES is used outside its declaration, pack loop, build loop and entryPointsFor filter/],
    ['the path join import', "import { join, resolve, dirname } from 'node:path'", "import { resolve, dirname } from 'node:path'\nconst join = (...parts) => parts.join('/')", /'join' is no longer imported from node:path/],
    ['the ROOT definition', "resolve(dirname(fileURLToPath(import.meta.url)), '..')", "resolve(dirname(fileURLToPath(import.meta.url)), '../..')", /ROOT no longer resolves to the repo root/],
  ]) {
    it(`${label} fails naming the drifted snippet, under the old message`, () => {
      assert.throws(() => discoverReal(replaceOnce(from, to)), error => {
        assert.ok(generic.test(error.message), error.message)
        assert.ok(named.test(error.message), error.message)
        return true
      })
    })
  }

  it('a byte-identical extra build loop is still a roster-count drift, named with the count', () => {
    const loop = "for (const p of PACKAGES.filter((p) => p.build)) { run('npm', ['run', p.build, '-w', p.name], { cwd: ROOT, stdio: 'inherit' }) }"
    assert.throws(() => discoverReal(source => `${source}\n${loop}\n`), /PACKAGES has 5 uses, expected its declaration plus the pack loop, build loop and entryPointsFor filter/)
  })

  it('a second entryPointsFor declaration is named', () => {
    assert.throws(() => discoverReal(replaceOnce('function entryPointsFor(pkg) {', 'const entryPointsFor = function (pkg) {')), /entryPointsFor must be declared exactly once/)
  })

  it('a dynamic read outside entryPointsFor is named', () => {
    assert.throws(() => discoverReal(source => `${source}\nreadFileSync(join(ROOT, computedName))\n`), /this dynamic read is not inside entryPointsFor/)
  })

  it('a dynamic read outside the verifier carries the generic message only', () => {
    assert.throws(() => discover("import './lib/h.mjs'", { 'scripts/lib/h.mjs': "import { readFileSync } from 'node:fs'; readFileSync(runtimePath)" }), error => {
      assert.ok(generic.test(error.message) && !error.message.includes('entryPointsFor'), error.message)
      return true
    })
  })

  it('the untouched real verifier still earns the exemption', () => {
    assert.doesNotThrow(() => discoverPublishInputs({ readSource: p => readFileSync(`${ROOT}${p}`, 'utf8') }))
  })
})

describe('code loaders discovery cannot follow are refused, not ignored (#9150)', () => {
  for (const [label, source, message] of [
    ['process.getBuiltinModule', "const fs = process.getBuiltinModule('fs')", /process\.getBuiltinModule\(\) loads modules/],
    ['process.binding', "process.binding('fs')", /process\.binding\(\) loads modules/],
    ['process bracket binding', "process['binding']('fs')", /process\.binding\(\) loads modules/],
    ['process bracket getBuiltinModule', "process['getBuiltinModule']('fs')", /process\.getBuiltinModule\(\) loads modules/],
    ['optional-chained binding', "process?.binding?.('fs')", /process\.binding\(\) loads modules/],
    ['globalThis.process.binding', "globalThis.process.binding('fs')", /process\.binding\(\) loads modules/],
    ['an aliased binding', "const load = process.binding", /process\.binding\(\) loads modules/],
    ['a computed process member', 'process[name]("fs")', /computed process\[\.\.\.\] member/],
    ['eval', "eval('1')", /eval\(\) runs code/],
    ['an indirect eval', ";(0, eval)('1')", /eval\(\) runs code/],
    ['an aliased eval', 'const run = eval', /eval\(\) runs code/],
    ['globalThis.eval', "globalThis.eval('1')", /eval\(\) runs code/],
    ['global bracket eval', "global['eval']('1')", /eval\(\) runs code/],
    ['new Function', "new Function('a', 'return a')", /new Function\(\) runs code/],
    ['Function called', "Function('return 1')()", /new Function\(\) runs code/],
    ['globalThis.Function', "new globalThis.Function('return 1')", /new Function\(\) runs code/],
  ]) {
    it(`refuses ${label} in the verifier`, () => {
      assert.throws(() => discover(source), message)
    })
  }

  it('refuses them inside a followed module, naming that file', () => {
    assert.throws(() => discover("import './lib/h.mjs'", { 'scripts/lib/h.mjs': "eval('1')" }), /scripts\/lib\/h\.mjs:\d+: unsupported publish-verification input: eval\(\)/)
  })

  it('refuses them inside a followed spawned script', () => {
    assert.throws(() => discover(`${CP}spawnSync('node', ['scripts/x.mjs'])`, { 'scripts/x.mjs': "process.binding('fs')" }), /scripts\/x\.mjs:\d+: .*process\.binding\(\)/)
  })

  it('does not refuse look-alikes: other objects, keys, strings and comments', () => {
    const result = discover(`
      // eval('x'); new Function('x'); process.binding('fs')
      const text = "eval(1) new Function(2) process.getBuiltinModule('fs')"
      const object = { eval: 1, Function: 2, binding: 3 }
      object.eval; object.binding; object.getBuiltinModule
      const evaluate = () => 1
      const key = process.env.HOME + process.argv.length + process.platform
      class Function2 {}
    `)
    assert.deepEqual(result.inputs, [])
  })
})
