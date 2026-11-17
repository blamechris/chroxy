/**
 * #8352 — the write sandbox must protect the live daemon's tmpdir bases.
 *
 * The full server suite deleted the real `tmpdir()/chroxy-claude-tui` (the
 * claude-tui hook-sink base) on a machine with a running daemon, which
 * validates that base by dev/ino and refuses every further tool event once it
 * changes. The #4633 guard did not notice: it protected `~/.chroxy` and
 * `~/.claude` only. `tests/_setup.mjs` now also protects each name in
 * `TMP_DAEMON_BASE_NAMES` (scripts/lib/test-fs-sandbox.mjs).
 *
 * Four things are pinned here, because a list beside a growing set is the
 * first recurring cause in docs/false-safety-guards.md:
 *
 *   1. ROSTER, source -> list: every `join(tmpdir(), 'chroxy-…')` base in
 *      `src/` is in `TMP_DAEMON_BASE_NAMES` (a NEW daemon base with no row is
 *      an unguarded hole).
 *   2. ROSTER, list -> source: every row names a base the source still builds
 *      (a stale row guards nothing and reads as cover).
 *   3. The class getters really resolve to `tmpdir()/<name>`, so (1) and (2),
 *      which read source TEXT, are tied to what the classes DO.
 *   4. BEHAVIOUR: a mutation of the real base — spelled lexically AND through
 *      realpath, as the sweeps spell it — throws CHROXY_TEST_SANDBOX, while a
 *      pinned per-test base and a lookalike sibling stay writable. Without the
 *      second half a guard that denies everything would pass the first
 *      (catalogue entry 18, #7273).
 *
 * The mutation probes below only ever hit paths that do not exist (`s-8352-…`),
 * so even a sandbox that failed to fire could not delete live state.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'acorn'

import { TMP_DAEMON_BASE_NAMES, tmpDaemonBaseRoots } from '../../../scripts/lib/test-fs-sandbox.mjs'
import { SANDBOX_IS_PROTECTED } from './_setup.mjs'
import { pinTmpDaemonBase } from './helpers/pin-tmp-daemon-base.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { CliSession } from '../src/cli-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { DockerByokSession } from '../src/docker-byok-session.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// Every static getter that returns a tmpdir-rooted daemon base, and the class
// that owns it. Sourced from the roster test below, not from memory.
const GETTERS = [
  [ClaudeTuiSession, 'SINK_BASE', 'chroxy-claude-tui'],
  [CliSession, 'PERMISSION_MODE_SIDECAR_BASE', 'chroxy-claude-cli'],
  [CodexAppServerSession, 'ATTACH_BASE', 'chroxy-codex-attach'],
  [DockerByokSession, 'ENV_FILE_BASE', 'chroxy-byok'],
]

// `join(tmpdir(), '…')` is not the only spelling a base could take, and source
// text is not the only way to spell it (#8354: a base split over several lines
// or routed through `const T = tmpdir()` slipped past a line scan). So the scan
// parses each file with acorn and works on the AST: any `chroxy-…` string in a
// statement that touches `tmpdir` must be the second argument of a `join`/`resolve`
// whose first argument is tmpdir-derived (a `tmpdir()` call, directly or via a
// local alias), or sit in an explicitly exempt file. Anything else — a template
// or `+` concatenation, a destructured or computed `tmpdir`, a file acorn
// cannot parse — is reported, never skipped (#7273: a check that matches
// nothing).
const EXEMPT_FILES = new Map([
  // `chroxy-pr-body-<random>.md` — a per-call random FILE written and read back
  // inside one request; not a base a daemon validates or sweeps.
  ['ws-file-ops/git.js', 'per-call random temp file, not a daemon base'],
])

const SCAN_EXTS = ['.js', '.mjs', '.cjs']
const OS_MODULES = new Set(['os', 'node:os'])

function walk (dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (SCAN_EXTS.some((x) => e.name.endsWith(x))) out.push(p)
  }
  return out
}

function parseSource (source) {
  const opts = { ecmaVersion: 'latest', allowHashBang: true, locations: true }
  try { return parse(source, { ...opts, sourceType: 'module' }) } catch { /* CommonJS: retry as a script */ }
  return parse(source, { ...opts, sourceType: 'script' })
}

function forEachNode (node, parent, fn, ancestors = []) {
  if (!node || typeof node.type !== 'string') return
  fn(node, parent, ancestors)
  ancestors.push(node)
  for (const key of Object.keys(node)) {
    const v = node[key]
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && forEachNode(c, node, fn, ancestors))
    else if (v && typeof v.type === 'string') forEachNode(v, node, fn, ancestors)
  }
  ancestors.pop()
}

const isRequireOs = (n) => n && n.type === 'CallExpression' && n.callee.type === 'Identifier' &&
  n.callee.name === 'require' && n.arguments.length === 1 && n.arguments[0].type === 'Literal' &&
  OS_MODULES.has(n.arguments[0].value)

/**
 * Pure: classify one file's source. Returns { bases: string[], problems: string[] }
 * where each problem is a `line: reason` string.. Self-tested below.
 */
function scanSourceText (source, { exempt = false } = {}) {
  let ast
  try { ast = parseSource(source) } catch (e) {
    return { bases: [], problems: [`unparseable source (${e.message}) — the scan cannot see this file`] }
  }
  const bases = []
  const problems = []
  const aliases = new Set(['tmpdir']) // local names that ARE os.tmpdir
  const tainted = new Set() // local names holding a tmpdir-derived value
  const line = (n) => n.loc.start.line

  // Pass 1: local names bound to os.tmpdir, and any spelling of it we cannot follow.
  forEachNode(ast, null, (n) => {
    if (n.type === 'ImportSpecifier' && n.imported.name === 'tmpdir') aliases.add(n.local.name)
    if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern' && isRequireOs(n.init)) {
      for (const p of n.id.properties) {
        if (p.type === 'Property' && !p.computed && p.key.name === 'tmpdir' && p.value.type === 'Identifier') aliases.add(p.value.name)
      }
    }
    if (n.type === 'VariableDeclarator' && n.init && n.init.type === 'Identifier' && aliases.has(n.init.name) &&
        n.id.type === 'Identifier') aliases.add(n.id.name) // const t = tmpdir
  })
  const isTmpCall = (n) => n.type === 'CallExpression' && (
    (n.callee.type === 'Identifier' && aliases.has(n.callee.name)) ||
    (n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.property.name === 'tmpdir'))
  const derived = (n) => {
    let hit = false
    forEachNode(n, null, (c) => {
      if (isTmpCall(c) || (c.type === 'Identifier' && tainted.has(c.name))) hit = true
    })
    return hit
  }
  // Pass 2: propagate taint through `const T = <tmpdir-derived>` to a fixpoint.
  for (let changed = true; changed;) {
    changed = false
    forEachNode(ast, null, (n) => {
      let target = null
      let value = null
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) { target = n.id.name; value = n.init }
      if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') { target = n.left.name; value = n.right }
      if (target && !tainted.has(target) && derived(value)) { tainted.add(target); changed = true }
    })
  }

  // Pass 3: every reference to tmpdir must be a call or an import we understand.
    forEachNode(ast, null, (n, parent) => {
    const bare = n.type === 'Identifier' && n.name === 'tmpdir'
    const prop = n.type === 'MemberExpression' && ((!n.computed && n.property.name === 'tmpdir') ||
      (n.computed && n.property.type === 'Literal' && n.property.value === 'tmpdir'))
    if (prop) {
      if (!(parent && parent.type === 'CallExpression' && parent.callee === n && !n.computed)) {
        problems.push(`${line(n)}: tmpdir referenced in a form the scan cannot follow (computed or not called)`)
      }
    }
    if (bare && parent) {
      const ok = parent.type === 'ImportSpecifier' ||
        (parent.type === 'CallExpression' && parent.callee === n) ||
        (parent.type === 'MemberExpression' && parent.property === n && !parent.computed) ||
        (parent.type === 'Property' && parent.key === n) || // `{ tmpdir }` pattern: bound in pass 1
        (parent.type === 'VariableDeclarator' && parent.init === n) // `const t = tmpdir`: aliased in pass 1
      if (!ok) problems.push(`${line(n)}: tmpdir referenced in a form the scan cannot follow`)
    }
  })

  // Pass 4: every chroxy-* string must be a recognised base or an exempt file.
  const CHROXY = /chroxy-/
  // A literal is only a tmp-base candidate when the statement holding it also
  // holds a tmpdir-derived value (a file-wide test flags unrelated `chroxy-*`
  // docker tags and branch names).
  const stmtOf = (ancestors) => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const t = ancestors[i].type
      if (t !== 'BlockStatement' && (t.endsWith('Statement') || t === 'VariableDeclaration' || t === 'PropertyDefinition')) return ancestors[i]
    }
    return ast
  }
  forEachNode(ast, null, (n, parent, ancestors) => {
    const isStr = n.type === 'Literal' && typeof n.value === 'string'
    const isTpl = n.type === 'TemplateElement'
    if (!(isStr || isTpl)) return
    const text = isStr ? n.value : (n.value.cooked ?? n.value.raw)
    if (!CHROXY.test(text)) return
    if (!derived(stmtOf(ancestors))) return
    const callee = parent && parent.type === 'CallExpression' ? parent.callee : null
    const fname = callee && (callee.type === 'Identifier' ? callee.name : (callee.type === 'MemberExpression' && !callee.computed ? callee.property.name : null))
    if (isStr && (fname === 'join' || fname === 'resolve') && parent.arguments.length >= 2 &&
        parent.arguments[1] === n && derived(parent.arguments[0]) && /^chroxy-[\w-]+$/.test(text)) {
      bases.push(text)
    } else if (!exempt) {
      problems.push(`${line(n)}: chroxy-* string ${JSON.stringify(text)} in a statement that touches tmpdir, in a shape the scan cannot classify`)
    }
  })
  return { bases, problems }
}

function scanSourceForTmpBases () {
  const found = new Set()
  const unrecognised = []
  for (const file of walk(SRC)) {
    // EXEMPT_FILES is keyed with '/' (POSIX); on Windows the walk yields '\\'.
    const rel = file.slice(SRC.length + 1).replace(/\\/g, '/')
    const { bases, problems } = scanSourceText(readFileSync(file, 'utf8'), { exempt: EXEMPT_FILES.has(rel) })
    bases.forEach((b) => found.add(b))
    problems.forEach((p) => unrecognised.push(`${rel}:${p}`))
  }
  return { found, unrecognised }
}

describe('tmpdir daemon-base roster (#8352)', () => {
  const { found, unrecognised } = scanSourceForTmpBases()

  it('the scan finds the known bases (positive control — a scan that finds nothing proves nothing)', () => {
    assert.ok(found.size >= 4, `expected at least the 4 known bases in src/, found ${[...found]}`)
  })

  it('the scan still finds each known base by name (floor: a parser regression cannot shrink the set silently)', () => {
    for (const [, , name] of GETTERS) assert.ok(found.has(name), `${name} not found in src/ — the scan lost a known base`)
  })

  it('every tmpdir()/chroxy-* base in src/ is in TMP_DAEMON_BASE_NAMES (source -> list)', () => {
    const missing = [...found].filter((n) => !TMP_DAEMON_BASE_NAMES.includes(n))
    assert.deepEqual(missing, [],
      `a daemon base with no row in scripts/lib/test-fs-sandbox.mjs is an unguarded hole: ${missing}`)
  })

  it('every TMP_DAEMON_BASE_NAMES row is a base the source still builds (list -> source)', () => {
    const stale = TMP_DAEMON_BASE_NAMES.filter((n) => !found.has(n))
    assert.deepEqual(stale, [], `a row that no source getter produces guards nothing: ${stale}`)
  })

  it('no src/ line pairs tmpdir with a chroxy-* literal in a shape the scan cannot classify', () => {
    assert.deepEqual(unrecognised, [],
      'add the base to TMP_DAEMON_BASE_NAMES, or exempt the file in EXEMPT_FILES with a reason')
  })

  describe('scanSourceText recognises every spelling (#8354)', () => {
    const IMPORT = "import { join } from 'path'\nimport { tmpdir } from 'os'\n"
    const bases = (body, pre = IMPORT) => scanSourceText(pre + body).bases
    const problems = (body, pre = IMPORT) => scanSourceText(pre + body).problems

    it('single-line join', () => assert.deepEqual(bases("const b = join(tmpdir(), 'chroxy-a')"), ['chroxy-a']))
    it('multi-line join', () => assert.deepEqual(bases("const b = join(\n  tmpdir(),\n  'chroxy-zzz-multi'\n)"), ['chroxy-zzz-multi']))
    it('aliased tmpdir()', () => assert.deepEqual(bases("const T = tmpdir()\nconst b = join(T, 'chroxy-zzz-alias')"), ['chroxy-zzz-alias']))
    it('renamed import', () => assert.deepEqual(bases("const b = join(t(), 'chroxy-r')", "import { join } from 'path'\nimport { tmpdir as t } from 'os'\n"), ['chroxy-r']))
    it('os.tmpdir() via namespace', () => assert.deepEqual(bases("const b = path.join(os.tmpdir(), 'chroxy-n')", "import os from 'os'\nimport path from 'path'\n"), ['chroxy-n']))
    it('CommonJS destructured require', () => assert.deepEqual(bases("const b = join(tmp(), 'chroxy-c')", "const { tmpdir: tmp } = require('os')\nconst { join } = require('path')\n"), ['chroxy-c']))

    it('template literal is reported, not skipped', () => assert.equal(problems("const b = `${tmpdir()}/chroxy-zzz-tpl`").length, 1))
    it('string concatenation is reported', () => assert.equal(problems("const b = tmpdir() + '/chroxy-zzz-cat'").length, 1))
    it('a base routed through a local helper is still found', () => assert.deepEqual(bases("const g = () => tmpdir()\nconst b = join(g(), 'chroxy-zzz-fn')"), ['chroxy-zzz-fn']))
    it('tmpdir passed around as a value is reported', () => assert.equal(problems('use(tmpdir)').length, 1))
    it('computed os["tmpdir"] is reported', () => assert.equal(problems("const b = os['tmpdir']()", "import os from 'os'\n").length, 1))
    it('unparseable source is reported', () => assert.equal(scanSourceText('const = (').problems.length, 1))
    it('a chroxy-* string in a statement with no tmpdir is ignored', () => {
      assert.deepEqual(scanSourceText("const n = 'chroxy-claude-tui'").problems, [])
    })
    it('comments are not code', () => {
      assert.deepEqual(scanSourceText(IMPORT + "// join(tmpdir(), 'chroxy-in-comment')\nconst x = tmpdir()").bases, [])
    })
  })

  for (const [Cls, prop, name] of GETTERS) {
    it(`${Cls.name}.${prop} resolves to tmpdir()/${name} and is in the roster`, () => {
      assert.equal(Cls[prop], join(tmpdir(), name))
      assert.ok(TMP_DAEMON_BASE_NAMES.includes(name))
    })
  }

  it('the GETTERS table above covers the whole roster', () => {
    assert.deepEqual(GETTERS.map((g) => g[2]).sort(), [...TMP_DAEMON_BASE_NAMES].sort())
  })
})

describe('sandbox guard on the live daemon bases (#8352)', () => {
  const lexicalRoot = tmpdir()
  const realRoot = realpathSync(tmpdir())

  for (const name of TMP_DAEMON_BASE_NAMES) {
    for (const [spelling, root] of [['lexical', lexicalRoot], ['realpath', realRoot]]) {
      const base = join(root, name)
      const child = join(base, 's-8352-nonexistent')

      it(`${name} (${spelling}): the base and its children are protected`, () => {
        assert.equal(SANDBOX_IS_PROTECTED(base), true, 'the base itself')
        assert.equal(SANDBOX_IS_PROTECTED(child), true, 'a session dir under it')
      })

      it(`${name} (${spelling}): rmSync / mkdirSync / writeFileSync on the real base throw CHROXY_TEST_SANDBOX`, () => {
        const code = { code: 'CHROXY_TEST_SANDBOX' }
        // Nonexistent targets only, so the probe is harmless when the guard
        // works. If the guard were MISSING, `mkdirSync` would create one empty
        // `s-8352-nonexistent` dir inside the live base; the `finally` removes
        // it so a red run does not leave the failure it reports behind.
        try {
          assert.throws(() => rmSync(child, { recursive: true, force: true }), code)
          assert.throws(() => writeFileSync(join(child, 'owner.pid'), '1'), code)
          assert.throws(() => mkdirSync(child, { recursive: true }), code)
          assert.equal(existsSync(child), false, 'and nothing was created')
        } finally {
          try { if (existsSync(child)) rmSync(child, { recursive: true, force: true }) } catch { /* guarded: nothing to clean */ }
        }
      })
    }
  }

  it('a lookalike sibling and the tests\' own temp dirs are NOT protected (a guard that denies everything proves nothing)', () => {
    for (const name of TMP_DAEMON_BASE_NAMES) {
      assert.equal(SANDBOX_IS_PROTECTED(join(lexicalRoot, `${name}-lookalike`)), false, `${name}-lookalike`)
      assert.equal(SANDBOX_IS_PROTECTED(join(lexicalRoot, name.replace('chroxy-', 'chroxy-x-'))), false)
    }
    assert.equal(SANDBOX_IS_PROTECTED(join(lexicalRoot, 'chroxy-test-daemon-base-abc', 'chroxy-claude-tui')), false)
  })

  it('tmpDaemonBaseRoots spells each base lexically AND through realpath', () => {
    const roots = tmpDaemonBaseRoots(lexicalRoot)
    for (const name of TMP_DAEMON_BASE_NAMES) {
      assert.ok(roots.includes(join(lexicalRoot, name)), `${name} lexical`)
      assert.ok(roots.includes(join(realRoot, name)), `${name} realpath`)
    }
  })
})

describe('pinTmpDaemonBase (#8352)', () => {
  it('redirects the getter to a writable temp base with the same leaf, and restores it', () => {
    const before = Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'SINK_BASE')
    const realBase = ClaudeTuiSession.SINK_BASE
    const unpin = pinTmpDaemonBase(ClaudeTuiSession, 'SINK_BASE')
    const pinned = ClaudeTuiSession.SINK_BASE
    try {
      assert.notEqual(pinned, realBase)
      assert.equal(basename(pinned), basename(realBase), 'leaf preserved')
      assert.equal(SANDBOX_IS_PROTECTED(pinned), false)
      mkdirSync(join(pinned, 's-x'), { recursive: true }) // allowed: not the real base
      assert.ok(existsSync(join(pinned, 's-x')))
    } finally {
      unpin()
    }
    assert.equal(ClaudeTuiSession.SINK_BASE, realBase, 'getter restored')
    assert.equal(Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'SINK_BASE').get, before.get)
    assert.equal(existsSync(dirname(pinned)), false, 'temp root removed')
    unpin() // idempotent
  })

  it('refuses a property that is not an own static getter', () => {
    assert.throws(() => pinTmpDaemonBase(ClaudeTuiSession, 'NOT_A_THING'), /not an own static getter/)
  })
})
