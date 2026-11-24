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

  it('refuses (never ignores) a script-looking argument to a program that is not an interpreter, even tar', () => {
    assert.throws(() => discover(`${CP}spawnSync('tar', ['tzf', 'scripts/x.mjs'])`), /runs program 'tar' with script argument 'scripts\/x\.mjs'/)
  })

  for (const [label, source, message] of [
    ['a computed script argument', `${CP}const s = f(); spawnSync('node', [s])`, /child process 'spawnSync' runs interpreter 'node' with a computed argument/],
    ['a computed template script', `${CP}spawnSync('node', [\`scripts/\${name}.mjs\`])`, /with a computed argument/],
    ['a computed script behind a flag', `${CP}spawnSync('node', ['--no-warnings', s])`, /with a computed argument/],
    ['a computed script through the wrapper', `${CP}${WRAPPER}run('bash', [s])`, /child process 'run' runs interpreter 'bash' with a computed argument/],
    ['a variable argument array', `${CP}const args = ['scripts/x.mjs']; spawnSync('node', args)`, /with computed arguments/],
    ['a spread inside the argument array', `${CP}spawnSync('node', [...rest, 'scripts/x.mjs'])`, /with computed arguments/],
    ['a built argument array', `${CP}spawnSync('node', ['a'].concat(s))`, /with computed arguments/],
    ['a computed fork module', `${CP}fork(modulePath)`, /child process 'fork' needs a literal script path/],
    ['a node flag that takes a separate value', `${CP}spawnSync('node', ['--import', './hook.mjs', 'scripts/x.mjs'])`, /passes flag '--import' to 'node'/],
    ['a shell command string (exec)', "import { exec } from 'node:child_process'; exec('node scripts/x.mjs')", /child process 'exec' runs a shell command string/],
    ['a shell command string (execSync)', "import { execSync } from 'node:child_process'; execSync('bash scripts/x.sh')", /child process 'execSync' runs a shell command string/],
    ['a script outside the repo', `${CP}spawnSync('node', ['../outside.mjs'])`, /escapes the repo/],
    ['an absolute script path', `${CP}spawnSync('node', ['/tmp/x.mjs'])`, /input path escapes the repo/],
    ['a URL script path', `${CP}spawnSync('node', ['file:///tmp/x.mjs'])`, /without URL suffixes/],
    ['a script with a query', `${CP}spawnSync('node', ['scripts/x.mjs?v=1'])`, /without URL suffixes/],
    ['a cwd that is not the repo root', `${CP}spawnSync('node', ['scripts/x.mjs'], { cwd: '/tmp' })`, /cwd that is not the repo root/],
    ['a computed cwd', `${CP}spawnSync('node', ['scripts/x.mjs'], { cwd: elsewhere })`, /cwd that is not the repo root/],
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
    it('the real verifier still passes unchanged, with exactly the inputs the base helper (64423ce60) found', () => {
      const result = discoverPublishInputs({ readSource: p => readFileSync(`${ROOT}${p}`, 'utf8') })
      assert.deepEqual(result.packages, ['protocol', 'store-core', 'server'])
      // Captured by running the base helper on the real tree, not copied from this helper's output.
      assert.deepEqual(result.inputs, ['scripts/lib/classify-doctor-output.mjs', 'scripts/lib/daemon-entry-modules.mjs'])
    })

    it('sees a spawn through the verifier own run() wrapper: a computed script is refused', () => {
      assert.throws(() => discoverReal(source => `${source}\nrun('node', [computedScript])\n`), /child process 'run' runs interpreter 'node' with a computed argument/)
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

  it('an entryPointsFor that is no longer a function declaration is named (a true duplicate is a syntax error)', () => {
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
    ['process.getBuiltinModule', "const fs = process.getBuiltinModule('fs')", /process\.getBuiltinModule loads or runs code/],
    ['process.binding', "process.binding('fs')", /process\.binding loads or runs code/],
    ['process bracket binding', "process['binding']('fs')", /process\.binding loads or runs code/],
    ['process bracket getBuiltinModule', "process['getBuiltinModule']('fs')", /process\.getBuiltinModule loads or runs code/],
    ['optional-chained binding', "process?.binding?.('fs')", /process\.binding loads or runs code/],
    ['globalThis.process.binding', "globalThis.process.binding('fs')", /process\.binding loads or runs code/],
    ['an aliased binding', "const load = process.binding", /process\.binding loads or runs code/],
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
    assert.throws(() => discover(`${CP}spawnSync('node', ['scripts/x.mjs'])`, { 'scripts/x.mjs': "process.binding('fs')" }), /scripts\/x\.mjs:\d+: .*process\.binding/)
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

describe('child-process flags are per interpreter and refuse-by-default (#9150 review)', () => {
  const files = { 'scripts/x.mjs': '', 'scripts/x.sh': '', 'scripts/x.py': '' }
  for (const [label, source, expected] of [
    ['bash -e (errexit) then the script', `${CP}spawnSync('bash', ['-e', 'scripts/x.sh'])`, ['scripts/x.sh']],
    ['sh -x -u then the script', `${CP}spawnSync('sh', ['-u', '-x', 'scripts/x.sh'])`, ['scripts/x.sh']],
    ['shell -- then the script', `${CP}spawnSync('bash', ['--', 'scripts/x.sh'])`, ['scripts/x.sh']],
    ['python -u -B then the script', `${CP}spawnSync('python3', ['-u', '-B', 'scripts/x.py'])`, ['scripts/x.py']],
    ['node --no-warnings --input-type=commonjs', `${CP}spawnSync('node', ['--no-warnings', '--input-type=commonjs', 'scripts/x.mjs'])`, ['scripts/x.mjs']],
    ['node -- then the script', `${CP}spawnSync('node', ['--', 'scripts/x.mjs'])`, ['scripts/x.mjs']],
  ]) {
    it(`follows ${label}`, () => assert.deepEqual(discover(source, files).inputs, expected))
  }

  for (const [label, source, message] of [
    ['bash -c', `${CP}spawnSync('bash', ['-c', 'node scripts/x.mjs'])`, /passes '-c' to 'bash': inline code or a command string/],
    ['sh -c', `${CP}spawnSync('sh', ['-c', 'echo hi'])`, /passes '-c' to 'sh'/],
    ['python -c', `${CP}spawnSync('python3', ['-c', 'print(1)'])`, /passes '-c' to 'python3'/],
    ['python -m', `${CP}spawnSync('python', ['-m', 'http.server'])`, /passes '-m' to 'python'/],
    ['bash -p (not a shell allowlist flag)', `${CP}spawnSync('bash', ['-p', 'scripts/x.sh'])`, /passes flag '-p' to 'bash'/],
    ['python -e', `${CP}spawnSync('python3', ['-e', 'scripts/x.py'])`, /passes flag '-e' to 'python3'/],
    ['node --import=', `${CP}spawnSync('node', ['--import=./h.mjs', 'scripts/x.mjs'])`, /passes flag '--import=\.\/h\.mjs'/],
    ['node --require=', `${CP}spawnSync('node', ['--require=./h.cjs', 'scripts/x.mjs'])`, /passes flag '--require=\.\/h\.cjs'/],
    ['node -r attached', `${CP}spawnSync('node', ['-r./h.cjs', 'scripts/x.mjs'])`, /passes flag '-r\.\/h\.cjs'/],
    ['node --loader=', `${CP}spawnSync('node', ['--loader=./l.mjs', 'scripts/x.mjs'])`, /passes flag '--loader=\.\/l\.mjs'/],
    ['node --env-file=', `${CP}spawnSync('node', ['--env-file=.env', 'scripts/x.mjs'])`, /passes flag '--env-file=\.env'/],
    ['node --import separate', `${CP}spawnSync('node', ['--import', './h.mjs', 'scripts/x.mjs'])`, /passes flag '--import' to 'node'/],
    ['node bare -', `${CP}spawnSync('node', ['-', 'scripts/x.mjs'])`, /passes flag '-' to 'node'/],
  ]) {
    it(`refuses ${label}`, () => assert.throws(() => discover(source, files), message))
  }

  it('node inline code stays accepted and is not analysed (documented limit)', () => {
    assert.deepEqual(discover(`${CP}spawnSync('node', ['--input-type=module', '--eval', 'await import("x")'])`).inputs, [])
    assert.deepEqual(discover(`${CP}spawnSync('node', ['-pe', '1'])`).inputs, [])
  })
})

describe('the program a child process runs is resolved or its script arguments refused (#9150 review)', () => {
  const files = { 'scripts/x.mjs': '', 'scripts/x.ts': '', 'scripts/x.sh': '' }
  for (const [label, source] of [
    ['process.execPath', `${CP}execFileSync(process.execPath, ['scripts/x.mjs'])`],
    ['a const bound to a literal', `${CP}const NODE = 'node'\nspawnSync(NODE, ['scripts/x.mjs'])`],
    ['a const through the wrapper', `${CP}${WRAPPER}const NODE = 'node'\nrun(NODE, ['scripts/x.mjs'])`],
    ['a computed key on the namespace with a literal key', "import * as cp from 'node:child_process'; cp['spawnSync']('node', ['scripts/x.mjs'])"],
  ]) {
    it(`follows ${label}`, () => assert.deepEqual(discover(source, files).inputs, ['scripts/x.mjs']))
  }

  for (const [label, source, message] of [
    ['tsx', `${CP}spawnSync('tsx', ['scripts/x.ts'])`, /runs program 'tsx' with script argument 'scripts\/x\.ts'/],
    ['env', `${CP}spawnSync('env', ['node', 'scripts/x.mjs'])`, /runs program 'env' with script argument/],
    ['npx', `${CP}spawnSync('npx', ['tsx', 'scripts/x.ts'])`, /runs program 'npx'/],
    ['deno', `${CP}spawnSync('deno', ['run', 'scripts/x.ts'])`, /runs program 'deno'/],
    ['bun', `${CP}spawnSync('bun', ['scripts/x.ts'])`, /runs program 'bun'/],
    ['perl', `${CP}spawnSync('perl', ['scripts/x.pl'])`, /runs program 'perl'/],
    ['ruby', `${CP}spawnSync('ruby', ['scripts/x.rb'])`, /runs program 'ruby'/],
    ['an unresolved program', `${CP}spawnSync(chosenProgram, ['scripts/x.mjs'])`, /runs a computed program with script argument/],
    ['a reassigned program variable', `${CP}let NODE = 'node'; NODE = other; spawnSync(NODE, ['scripts/x.mjs'])`, /runs a computed program with script argument/],
    ['an unresolved program through the wrapper', `${CP}${WRAPPER}run(chosen, ['scripts/x.sh'])`, /child process 'run' runs a computed program with script argument 'scripts\/x\.sh'/],
  ]) {
    it(`refuses ${label} given a script argument`, () => assert.throws(() => discover(source, files), message))
  }

  it('still accepts the verifier shapes: unresolved bin, npm, tar, mkdir with no script argument', () => {
    const source = `${CP}${WRAPPER}${ROOT_DECL}const work = f(); const bin = g()
      run(bin, ['--version'], { env: {} })
      spawnSync(bin, ['doctor'], { timeout: 1 })
      run('npm', ['pack', '-w', '@chroxy/protocol', '--pack-destination', work], { cwd: ROOT })
      run('tar', ['tzf', work])
      run('mkdir', ['-p', work])`
    assert.deepEqual(discover(source).inputs, [])
  })
})

describe('wrappers and aliases of child_process fail closed (#9150 review)', () => {
  const files = { 'scripts/x.mjs': '' }
  it('recognises a wrapper of a wrapper that forwards its parameters', () => {
    assert.deepEqual(discover(`${CP}${WRAPPER}const go = (c, a) => run(c, a)\ngo('node', ['scripts/x.mjs'])`, files).inputs, ['scripts/x.mjs'])
  })
  it('follows a wrapper of a wrapper whose program is computed only when no script is named', () => {
    assert.deepEqual(discover(`${CP}${WRAPPER}const go = (c, a) => run(c, a)\ngo(bin, ['--version'])`).inputs, [])
  })

  for (const [label, source, message] of [
    ['a wrapper that swaps its parameters', `${CP}const go = (a, b) => spawnSync(b, [a])\ngo('scripts/x.mjs', 'node')`, /local function 'go' reaches a child process without forwarding/],
    ['a wrapper that forwards only one parameter', `${CP}const go = (c, a) => spawnSync(c, [...a])\ngo('node', [])`, /local function 'go' reaches a child process without forwarding/],
    ['a wrapper whose first argument is not its first parameter', `${CP}function go(c, a) { return spawnSync(a, a) }\ngo('node', ['scripts/x.mjs'])`, /runs a computed program with computed arguments/],
    ['a wrapper that forwards in the wrong order', `${CP}function go(c, a) { return spawnSync(a, c) }\ngo(['x'], 'node')`, /runs a computed program with computed arguments/],
    ['a wrapper of an opaque wrapper', `${CP}const inner = (a, b) => spawnSync(b, [a])\nconst outer = (c, a) => inner(c, a)\nouter('node', ['x'])`, /local function '(?:inner|outer)' reaches a child process without forwarding/],
    ['a wrapper aliased to another name', `${CP}${WRAPPER}const go = run\ngo('node', ['scripts/x.mjs'])`, /child process wrapper 'run' may only be called directly/],
    ['a wrapper passed as a value', `${CP}${WRAPPER}[['node', ['scripts/x.mjs']]].map(([c, a]) => 1); const list = [run]`, /child process wrapper 'run' may only be called directly/],
    ['an aliased member', "import * as cp from 'node:child_process'; const f = cp.spawnSync; f('node', ['scripts/x.mjs'])", /child_process binding 'cp' may only be called directly/],
    ['a destructured namespace', "import * as cp from 'node:child_process'; const { spawn } = cp; spawn('node', ['scripts/x.mjs'])", /child_process binding 'cp' may only be called directly/],
    ['a named import used as a value', `${CP}const f = spawnSync; f('node', ['scripts/x.mjs'])`, /child_process binding 'spawnSync' may only be called directly/],
    ['.call on a named import', `${CP}execFileSync.call(null, 'node', ['scripts/x.mjs'])`, /child_process binding 'execFileSync' may only be called directly/],
    ['a computed non-literal key', "import * as cp from 'node:child_process'; cp[name]('node', ['scripts/x.mjs'])", /child_process binding 'cp' may only be called directly/],
    ['the function passed as an argument', `${CP}[1].map(spawnSync)`, /child_process binding 'spawnSync' may only be called directly/],
    ['a dynamic import', "const cp = await import('node:child_process')", /dynamic child_process bindings/],
    ['a dynamic import (bare)', "await import('child_process')", /dynamic child_process bindings/],
    ['a re-export', "export { spawn } from 'node:child_process'", /child_process re-exports/],
    ['a shadowed binding', `${CP}function f(spawnSync) { spawnSync('node', ['scripts/x.mjs']) }`, /shadowed built-in binding 'spawnSync'/],
    ['an unknown child_process export', "import { ChildProcess } from 'node:child_process'; ChildProcess()", /child process 'ChildProcess' is not understood/],
  ]) {
    it(`refuses ${label}`, () => assert.throws(() => discover(source, files), message))
  }
})

describe('options of a followed script are an allowlist (#9150 review)', () => {
  const files = { 'scripts/x.mjs': '' }
  it('follows a fork or spawn with allowed literal options (env contents are not analysed)', () => {
    assert.deepEqual(discover(`${CP}${ROOT_DECL}fork('scripts/x.mjs', { cwd: ROOT, stdio: 'inherit' })`, files).inputs, ['scripts/x.mjs'])
    assert.deepEqual(discover(`${CP}fork('scripts/x.mjs', ['a', 'b'], { env: { NODE_OPTIONS: '--x' }, timeout: 1, maxBuffer: 2, encoding: 'utf8', input: 'i' })`, files).inputs, ['scripts/x.mjs'])
  })
  for (const [label, source, message] of [
    ['fork execArgv as the second argument', `${CP}fork('scripts/x.mjs', { execArgv: ['--import=./h.mjs'] })`, /passes option 'execArgv'/],
    ['fork execPath after an args array', `${CP}fork('scripts/x.mjs', ['a'], { execPath: '/bin/other' })`, /passes option 'execPath'/],
    ['fork options that are a variable', `${CP}fork('scripts/x.mjs', opts)`, /options or arguments discovery cannot resolve/],
    ['fork options with a spread', `${CP}fork('scripts/x.mjs', { ...opts })`, /options discovery cannot resolve/],
    ['spawnSync shell: true', `${CP}spawnSync('node', ['scripts/x.mjs'], { shell: true })`, /passes option 'shell'/],
    ['spawnSync argv0', `${CP}spawnSync('node', ['scripts/x.mjs'], { argv0: 'other' })`, /passes option 'argv0'/],
    ['a cwd that is not the repo root', `${CP}fork('scripts/x.mjs', { cwd: '/tmp' })`, /cwd that is not the repo root/],
  ]) {
    it(`refuses ${label}`, () => assert.throws(() => discover(source, files), message))
  }
})

describe('loader aliases and escapes are refused (#9150 review)', () => {
  for (const [label, source, message] of [
    ['an aliased Function', 'const F = Function', /new Function\(\) runs code/],
    ['Reflect.construct(Function)', "Reflect.construct(Function, ['return 1'])", /new Function\(\) runs code/],
    ['a bare process value', 'const p = process', /'process' used as a bare value/],
    ['a bare globalThis value', 'const g = globalThis', /'globalThis' used as a bare value/],
    ['a bare global value', 'const g = global', /'global' used as a bare value/],
    ['process passed as an argument', 'f(process)', /'process' used as a bare value/],
    ['an imported process used bare', "import proc from 'node:process'; const p = proc", /'proc' used as a bare value/],
    ['an imported process binding', "import proc from 'node:process'; proc.binding('fs')", /process\.binding/],
    ['process.dlopen', "process.dlopen(module, 'x.node')", /process\.dlopen/],
    ['process.mainModule', 'const m = process.mainModule', /process\.mainModule/],
    ['a named getBuiltinModule import', "import { getBuiltinModule } from 'node:process'", /importing 'getBuiltinModule' from process/],
    ['a named binding import', "import { binding as b } from 'process'", /importing 'binding' from process/],
    ['a named dlopen import', "import { dlopen } from 'process'", /importing 'dlopen' from process/],
    ['static vm', "import vm from 'node:vm'", /'node:vm' runs code or threads/],
    ['bare vm', "import { runInThisContext } from 'vm'", /'vm' runs code or threads/],
    ['dynamic vm', "await import('node:vm')", /'node:vm' runs code or threads/],
    ['static worker_threads', "import { Worker } from 'node:worker_threads'", /'node:worker_threads' runs code or threads/],
    ['dynamic worker_threads', "await import('worker_threads')", /'worker_threads' runs code or threads/],
  ]) {
    it(`refuses ${label}`, () => assert.throws(() => discover(source), message))
  }

  it('still accepts members of process, globalThis and an imported process', () => {
    assert.deepEqual(discover("import proc from 'node:process'; const a = process.env.HOME + proc.argv.length + globalThis.setTimeout.name + process.execPath").inputs, [])
  })
})

describe('refuse at the spawn source: an unknown program with computed arguments only inside a recognised wrapper (#9150 round 2)', () => {
  const REFUSED = /runs a computed program with computed arguments/
  for (const [label, source] of [
    ['an exported const wrapper', `${CP}export const run = (c, a) => execFileSync(c, a)`],
    ['an exported function wrapper', `${CP}export function run(c, a) { return execFileSync(c, a) }`],
    ['a wrapper exported by name', `${CP}const run = (c, a) => execFileSync(c, a)\nexport { run }`],
    ['a wrapper exported under another name', `${CP}const run = (c, a) => execFileSync(c, a)\nexport { run as launch }`],
    ['a default-exported wrapper', `${CP}export default function run(c, a) { return execFileSync(c, a) }`],
    ['a default-exported wrapper by name', `${CP}const run = (c, a) => execFileSync(c, a)\nexport default run`],
    ['a duplicate-named wrapper', `${CP}const run = (c, a) => execFileSync(c, a)\n{ const run = 1 }`],
    ['a var-bound wrapper', `${CP}var run = (c, a) => execFileSync(c, a)`],
    ['an object-method wrapper', `${CP}const o = { run(c, a) { return execFileSync(c, a) } }\no.run('node', ['scripts/x.mjs'])`],
    ['a class wrapper', `${CP}class W { static run(c, a) { return spawnSync(c, a) } }\nW.run('node', ['scripts/x.mjs'])`],
    ['an IIFE wrapper', `${CP};((c, a) => execFileSync(c, a))('node', ['scripts/x.mjs'])`],
    ['a wrapper that reassigns its program', `${CP}const run = (c, a) => { c = other; return execFileSync(c, a) }`],
    ['a wrapper that mutates its arguments binding', `${CP}function run(c, a) { a = ['x']; return execFileSync(c, a) }`],
    ['a wrapper that updates a param', `${CP}function run(c, a) { a++; return execFileSync(c, a) }`],
    ['a wrapper that shadows a param in a nested function', `${CP}const run = (c, a) => { const f = (a) => 1; return execFileSync(c, a) }`],
    ['a wrapper that shadows a param by declaration', `${CP}function run(c, a) { { const c = 'node'; f(c) } return execFileSync(c, a) }`],
    ['a wrapper with a default first param', `${CP}const run = (c = 'node', a) => execFileSync(c, a)`],
    ['a bare computed call', `${CP}execFileSync(chosen, args)`],
  ]) {
    it(`refuses ${label} at its inner call`, () => assert.throws(() => discover(source, { 'scripts/x.mjs': '' }), REFUSED))
  }

  it('still recognises the verifier wrapper shape (const arrow forwarding params 0 and 1, options spread from a param)', () => {
    assert.deepEqual(discover(`${CP}${WRAPPER}run(bin, ['--version'])`).inputs, [])
  })

  for (const [label, source] of [
    ['a spread program', `${CP}spawnSync(...argv)`],
    ['spread arguments', `${CP}spawnSync('node', ...rest)`],
    ['a spread through the wrapper', `${CP}${WRAPPER}run(...argv)`],
    ['a spread second argument through the wrapper', `${CP}${WRAPPER}run('node', ...rest)`],
    ['a spread fork path', `${CP}fork(...argv)`],
  ]) {
    it(`refuses ${label}`, () => assert.throws(() => discover(source), /called with a spread argument/))
  }
})

describe('options are refused on every call site, except the wrapper own forwarding call (#9150 round 2)', () => {
  for (const [label, source, message] of [
    ['a shell command string with shell: true', `${CP}execFileSync('node x.mjs', { shell: true })`, /passes option 'shell'/],
    ['shell on a non-script program', `${CP}spawnSync('npm', ['pack'], { shell: true })`, /passes option 'shell'/],
    ['execArgv on a non-script program', `${CP}spawnSync('npm', ['pack'], { execArgv: ['--import=x'] })`, /passes option 'execArgv'/],
    ['execPath on a non-script program', `${CP}spawnSync('npm', ['pack'], { execPath: 'x' })`, /passes option 'execPath'/],
    ['argv0 on a non-script program', `${CP}spawnSync('npm', ['pack'], { argv0: 'x' })`, /passes option 'argv0'/],
    ['a computed options variable', `${CP}spawnSync('npm', ['pack'], opts)`, /options discovery cannot resolve/],
    ['a spread inside options', `${CP}spawnSync('npm', ['pack'], { ...opts })`, /options discovery cannot resolve/],
    ['a computed option key', `${CP}spawnSync('npm', ['pack'], { [k]: 1 })`, /options discovery cannot resolve/],
    ['options-only form with shell', `${CP}spawnSync('npm', { shell: true })`, /passes option 'shell'/],
    ['shell at a wrapper call site', `${CP}${WRAPPER}run('npm', ['pack'], { shell: true })`, /child process 'run' passes option 'shell'/],
    ['computed options at a wrapper call site', `${CP}${WRAPPER}run('npm', ['pack'], opts)`, /child process 'run' has options discovery cannot resolve/],
    ['computed options with an unknown program', `${CP}spawnSync(bin, ['doctor'], opts)`, /options discovery cannot resolve/],
  ]) {
    it(`refuses ${label}`, () => assert.throws(() => discover(source, { 'scripts/x.mjs': '' }), message))
  }

  it('accepts literal options, and the wrapper own forwarding call may spread its params', () => {
    assert.deepEqual(discover(`${CP}${WRAPPER}run('npm', ['pack'], { cwd: 'x', env: {}, stdio: 'inherit' }); spawnSync('npm', args, { timeout: 1 })`).inputs, [])
  })
})

describe('an interpreter given no script reads its program from stdin (#9150 round 2)', () => {
  it('accepts a bare interpreter call and one with ordinary options', () => {
    assert.deepEqual(discover(`${CP}spawnSync('node')`).inputs, [])
    assert.deepEqual(discover(`${CP}spawnSync('node', [], { encoding: 'utf8' })`).inputs, [])
    assert.deepEqual(discover(`${CP}spawnSync('node', ['--no-warnings'])`).inputs, [])
  })
  for (const [label, source] of [
    ['an empty argument array with input', `${CP}spawnSync('node', [], { input: 'import("x")' })`],
    ['only allowed flags with input', `${CP}spawnSync('node', ['--no-warnings'], { input: 'x' })`],
    ['no argument array with input', `${CP}spawnSync('bash', { input: 'echo hi' })`],
    ['a through-the-wrapper call with input', `${CP}${WRAPPER}run('python3', [], { input: 'print(1)' })`],
  ]) {
    it(`refuses ${label}`, () => assert.throws(() => discover(source), /with no script and an 'input' option: its program comes from stdin/))
  }
  it('refuses options that are not a literal object', () => {
    assert.throws(() => discover(`${CP}spawnSync('node', [], opts)`), /options discovery cannot resolve/)
  })
})

describe('globals, modules and members that can reach code discovery cannot see (#9150 round 2)', () => {
  for (const [label, source, message] of [
    ['a computed globalThis member', 'globalThis[name]("x")', /computed globalThis\[\.\.\.\] member/],
    ['a computed global member', "global[key]('x')", /computed global\[\.\.\.\] member/],
    ['a concatenated eval key', "globalThis['ev' + 'al']('1')", /computed globalThis\[\.\.\.\] member/],
    ['globalThis.process as a value', 'const p = globalThis.process', /'globalThis\.process' used as a bare value/],
    ['global.process as a value', 'f(global.process)', /'global\.process' used as a bare value/],
    ['static cluster', "import cluster from 'node:cluster'", /'node:cluster' runs code or threads/],
    ['bare cluster', "import cluster from 'cluster'", /'cluster' runs code or threads/],
    ['dynamic cluster', "await import('node:cluster')", /'node:cluster' runs code or threads/],
    ['static inspector', "import inspector from 'node:inspector'", /'node:inspector' runs code or threads/],
    ['dynamic inspector', "await import('inspector')", /'inspector' runs code or threads/],
    ['static node:test', "import { test } from 'node:test'", /'node:test' runs code or threads/],
    ['dynamic bare test', "await import('test')", /'test' runs code or threads/],
    ['process.execve', "process.execve('/bin/sh', [])", /process\.execve/],
    ['a data: import', "import 'data:text/javascript,1'", /scheme imports/],
    ['a dynamic data: import', "await import('data:text/javascript,1')", /scheme imports/],
    ['an https: import', "import 'https://example.test/x.mjs'", /scheme imports/],
    ['a file: import', "import 'file:///tmp/x.mjs'", /file URL imports|scheme imports/],
    ['a node: builtin look-alike scheme', "import 'nodex:fs'", /scheme imports/],
  ]) {
    it(`refuses ${label}`, () => assert.throws(() => discover(source), message))
  }
  it('still accepts members: globalThis.process.env, a literal globalThis key, node: builtins', () => {
    assert.deepEqual(discover("const a = globalThis.process.env.HOME + globalThis['setTimeout'].name; import 'node:path'").inputs, [])
  })
})

describe('unknown programs: const-bound and more script extensions (#9150 round 2)', () => {
  for (const [label, source] of [
    ['a const-bound .ts argument', `${CP}const S = 'scripts/x.ts'\nspawnSync('tsx', [S])`],
    ['a const-bound .sh argument to an unresolved program', `${CP}const S = 'scripts/x.sh'\nspawnSync(chosen, [S])`],
    ['a const-bound argument through the wrapper', `${CP}${WRAPPER}const S = 'scripts/x.py'\nrun('uv', ['run', S])`],
    ['.zsh', `${CP}spawnSync('runner', ['scripts/x.zsh'])`],
    ['.php', `${CP}spawnSync('php', ['scripts/x.php'])`],
    ['.ps1', `${CP}spawnSync('pwsh', ['scripts/x.ps1'])`],
    ['.bat', `${CP}spawnSync('cmd', ['scripts/x.bat'])`],
    ['.cmd', `${CP}spawnSync('cmd', ['scripts/x.cmd'])`],
  ]) {
    it(`refuses ${label}`, () => assert.throws(() => discover(source), /with script argument/))
  }
  it('names the local wrapper by its own name', () => {
    assert.throws(() => discover(`${CP}const go = (c, a) => spawnSync(c, a)\ngo(x, ['scripts/x.sh'])`), /child process 'go' runs a computed program with script argument/)
  })
})
