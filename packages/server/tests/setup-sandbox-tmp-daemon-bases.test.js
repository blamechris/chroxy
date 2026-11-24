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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
// parses each file with acorn and works on the AST. In a file that touches
// `tmpdir` EVERY `chroxy-…` string must be either
//   - a base: the 2nd argument of a `join`/`resolve` whose 1st argument is
//     tmpdir-derived (a `tmpdir()` call, directly or via a local alias), given
//     literally or through a local `const` string, or
//   - listed in EXEMPT_LITERALS with a reason.
// Anything else — a template or `+` concatenation, a value reached through
// `this.x` or a parameter, a destructure or dynamic import of `tmpdir` the scan
// cannot follow, a file acorn cannot parse — is reported, never skipped
// (#7273: a check that matches nothing).
//
// Keyed `<file>|<literal text>`. Each is a `chroxy-*` string that shares a file
// with `tmpdir` but is not a tmpdir base. A stale entry fails the roster test.
// Each entry binds the exemption to its usage site (#9212): `site` is the AST
// shape from `siteShape` and `count` the number of occurrences at that shape
// (default 1). Both are enforced, so a second occurrence, or one at a different
// kind of site (a real `join(tmpdir(), 'chroxy-byok-')`), is reported.
const ex = (reason, site, count = 1) => ({ reason, site, count })
const EXEMPT_LITERALS = new Map([
  // `chroxy-pr-body-<random>.md` — a per-call random FILE written and read back
  // inside one request; not a base a daemon validates or sweeps.
  ['ws-file-ops/git.js|chroxy-pr-body-', ex('per-call random temp file, not a daemon base', 'TemplateElement>TemplateLiteral[1]>call:join@1>decl:bodyFile>VariableDeclaration')],
  ['checkpoint-manager.js|chroxy-checkpoint/', ex('git tag name, not a path', 'TemplateElement>TemplateLiteral[1]>decl:tagName>VariableDeclaration')],
  ['checkpoint-manager.js|chroxy-snapshot/', ex('git commit message, not a path', 'TemplateElement>TemplateLiteral[1]>ArrayExpression>call:execFileAsync@1>AwaitExpression>decl:ObjectPattern>VariableDeclaration')],
  ['docker-byok-session.js|/tmp/.chroxy-post-create-', ex('path inside the container, not the host tmpdir', 'Literal>decl:POST_CREATE_MARKER_PREFIX>VariableDeclaration')],
  ['docker-byok-session.js|chroxy-byok-snap:', ex('docker image tag', 'TemplateElement>TemplateLiteral[2]>return')],
  ['docker-byok-session.js|chroxy-byok-build:', ex('docker image tag', 'TemplateElement>TemplateLiteral[1]>return')],
  ['docker-byok-session.js|chroxy-byok-', ex('compose project name', 'TemplateElement>TemplateLiteral[1]>assign:_composeProject>ExpressionStatement')],
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

const isOsSpecifier = (n) => n && n.type === 'Literal' && OS_MODULES.has(n.value)
const isRequireOs = (n) => n && n.type === 'CallExpression' && n.callee.type === 'Identifier' &&
  n.callee.name === 'require' && n.arguments.length === 1 && isOsSpecifier(n.arguments[0])
const isImportOs = (n) => n && n.type === 'ImportExpression' && isOsSpecifier(n.source)
const isAwaitImportOs = (n) => n && n.type === 'AwaitExpression' && isImportOs(n.argument)
const REASON_FOLLOW = 'tmpdir reached in a form the scan cannot follow'

/**
 * The shape of the site a string node sits at, as a `>`-joined chain from the
 * node outwards to its first enclosing statement, e.g.
 * `TemplateElement>TemplateLiteral>return`. A call contributes its callee name
 * and the argument position the node is in (`call:join@1`), a declarator its
 * bound name, an assignment its target, a property its key. Exemptions are
 * bound to this (#9212) so a literal reused at a different kind of site —
 * `join(tmpdir(), 'chroxy-byok-')` where the exempt one is a template in a
 * `const` — does not inherit the exemption. A template contributes its
 * expression count (`TemplateLiteral[1]`) so a fixed name (no `${}`) at a
 * random-suffixed site is a different shape.
 *
 * Shapes are EXACT ancestor chains up to the first enclosing statement, so a
 * refactor of an exempt call site fails with the expected and found shapes. The
 * fix is to update that entry's `site` after checking the use is still not a
 * real tmpdir base.
 */
function siteShape (node, ancestors) {
  const calleeName = (c) => c.type === 'Identifier' ? c.name
    : (c.type === 'MemberExpression' && !c.computed ? c.property.name : c.type)
  const parts = [node.type]
  let child = node
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i]
    if (a.type === 'TemplateLiteral') parts.push(`TemplateLiteral[${a.expressions.length}]`)
    else if (a.type === 'CallExpression' || a.type === 'NewExpression') {
      const idx = a.arguments.indexOf(child)
      parts.push(idx >= 0 ? `call:${calleeName(a.callee)}@${idx}` : 'callee')
    } else if (a.type === 'VariableDeclarator') parts.push(`decl:${a.id.type === 'Identifier' ? a.id.name : a.id.type}`)
    else if (a.type === 'AssignmentExpression') {
      const l = a.left
      parts.push(`assign:${l.type === 'MemberExpression' && !l.computed ? l.property.name : (l.name || l.type)}`)
    } else if (a.type === 'Property') parts.push(`prop:${a.key.name ?? a.key.value}`)
    else if (a.type === 'ReturnStatement') { parts.push('return'); break } else if (/(Statement|Declaration)$/.test(a.type)) { parts.push(a.type); break } else parts.push(a.type)
    child = a
  }
  return parts.join('>')
}
const REASON_CLASSIFY = 'chroxy-* string in a file that touches tmpdir, in a shape the scan cannot classify'

/**
 * Pure: classify one file's source. `exempt` maps each literal text exempt in
 * this file to `{ site, count }` (#9212): the SHAPE of the usage site the
 * literal is allowed at (see `siteShape`) and how many times it occurs there.
 * An exempt literal at any other shape, or more/fewer times than expected, is a
 * problem, so reusing an exempted literal for a real tmpdir base in the same
 * file is no longer hidden. Returns { bases, problems, exemptUsed } where each
 * problem is a `line: reason` string. Self-tested below.
 */
function scanSourceText (source, { exempt = new Map() } = {}) {
  let ast
  try { ast = parseSource(source) } catch (e) {
    return { bases: [], problems: [`1: unparseable source (${e.message}) — the scan cannot see this file`], exemptUsed: [] }
  }
  const bases = []
  const problems = []
  const exemptUsed = new Set()
  const aliases = new Set(['tmpdir']) // local names that ARE os.tmpdir
  const tainted = new Set() // local names holding a tmpdir-derived value
  const consts = new Map() // local `const N = 'chroxy-…'` -> [literal nodes]
  const line = (n) => n.loc.start.line
  let touches = false

  const constString = (n) => {
    if (n.type === 'Literal' && typeof n.value === 'string') return n.value
    if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked
    return null
  }
  // Pass 1: local names bound to os.tmpdir, and local string constants.
  forEachNode(ast, null, (n, parent) => {
    if (n.type === 'ImportSpecifier' && n.imported.name === 'tmpdir') aliases.add(n.local.name)
    if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern') {
      const followable = isRequireOs(n.init) || isAwaitImportOs(n.init) || (n.init && n.init.type === 'Identifier')
      for (const p of n.id.properties) {
        if (p.type !== 'Property' || p.computed || p.key.name !== 'tmpdir') continue
        touches = true
        if (followable && p.value.type === 'Identifier') aliases.add(p.value.name)
        else problems.push(`${line(p)}: ${REASON_FOLLOW} (destructured tmpdir)`)
      }
    } else if (n.type === 'ObjectPattern') {
      // A pattern outside a declarator (a parameter, an assignment target).
      for (const p of n.properties) {
        if (p.type === 'Property' && !p.computed && p.key.name === 'tmpdir') {
          touches = true
          problems.push(`${line(p)}: ${REASON_FOLLOW} (destructured tmpdir)`)
        }
      }
    }
    if (isImportOs(n)) {
      touches = true
      const okUse = parent && ((parent.type === 'AwaitExpression' && parent.argument === n) || false)
      if (!okUse) problems.push(`${line(n)}: ${REASON_FOLLOW} (dynamic import of os)`)
    }
    if (n.type === 'VariableDeclarator' && n.init && n.init.type === 'Identifier' && aliases.has(n.init.name) &&
        n.id.type === 'Identifier') aliases.add(n.id.name) // const t = tmpdir
  })
  forEachNode(ast, null, (n, parent) => {
    if (n.type === 'VariableDeclarator' && parent.kind === 'const' && n.id.type === 'Identifier' && n.init) {
      const text = constString(n.init)
      if (text !== null) consts.set(n.id.name, [...(consts.get(n.id.name) || []), { node: n.init, text }])
    }
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
    if (isTmpCall(n)) touches = true
    const bare = n.type === 'Identifier' && n.name === 'tmpdir'
    const prop = n.type === 'MemberExpression' && ((!n.computed && n.property.name === 'tmpdir') ||
      (n.computed && n.property.type === 'Literal' && n.property.value === 'tmpdir'))
    if (prop) {
      touches = true
      if (!(parent && parent.type === 'CallExpression' && parent.callee === n && !n.computed)) {
        problems.push(`${line(n)}: ${REASON_FOLLOW} (computed or not called)`)
      }
    }
    if (bare && parent) {
      touches = true
      const ok = parent.type === 'ImportSpecifier' ||
        (parent.type === 'CallExpression' && parent.callee === n) ||
        (parent.type === 'MemberExpression' && parent.property === n && !parent.computed) ||
        (parent.type === 'Property' && parent.key === n) || // `{ tmpdir }` pattern: handled in pass 1
        (parent.type === 'VariableDeclarator' && parent.init === n) // `const t = tmpdir`: aliased in pass 1
      if (!ok) problems.push(`${line(n)}: ${REASON_FOLLOW}`)
    }
  })

  // Pass 4: which chroxy-* literals are bases. A join/resolve whose 1st arg is
  // tmpdir-derived and whose 2nd is a literal, or a local const holding one.
  const classified = new Set()
  forEachNode(ast, null, (n) => {
    if (n.type !== 'CallExpression') return
    const c = n.callee
    const fname = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' && !c.computed ? c.property.name : null)
    if ((fname !== 'join' && fname !== 'resolve') || n.arguments.length < 2 || !derived(n.arguments[0])) return
    const arg = n.arguments[1]
    const hits = arg.type === 'Identifier' ? (consts.get(arg.name) || []) : (constString(arg) !== null ? [{ node: arg, text: constString(arg) }] : [])
    for (const h of hits) {
      if (/^chroxy-[\w-]*\w$/.test(h.text)) { bases.push(h.text); classified.add(h.node) }
    }
  })

  // Pass 5: in a file that touches tmpdir, every chroxy-* string is a base,
  // exempt, or reported.
  if (touches) {
    const atSite = new Map() // exempt text -> occurrences at its bound site
    const mismatched = new Set() // texts already reported at a wrong shape
    forEachNode(ast, null, (n, parent, ancestors) => {
      const isStr = n.type === 'Literal' && typeof n.value === 'string'
      const isTpl = n.type === 'TemplateElement'
      if (!(isStr || isTpl) || classified.has(n)) return
      const text = isStr ? n.value : (n.value.cooked ?? n.value.raw)
      if (!/chroxy-/.test(text)) return
      const rule = exempt.get(text)
      if (!rule) { problems.push(`${line(n)}: ${REASON_CLASSIFY}: ${JSON.stringify(text)}`); return }
      exemptUsed.add(text)
      const shape = siteShape(n, ancestors)
      if (shape === rule.site) atSite.set(text, (atSite.get(text) || 0) + 1)
      else {
        mismatched.add(text)
        problems.push(`${line(n)}: exempt literal ${JSON.stringify(text)} at a site other than the exempted one — found ${shape}, expected ${rule.site}; a real tmpdir base reusing an exempted literal is hidden otherwise`)
      }
    })
    for (const [text, rule] of exempt) {
      const got = atSite.get(text) || 0
      if (exemptUsed.has(text) && !mismatched.has(text) && got !== rule.count) {
        problems.push(`1: exempt literal ${JSON.stringify(text)} expected ${rule.count} occurrence(s) at ${rule.site}, found ${got}`)
      }
    }
    // A site bound to `const NAME = <exempt literal>` binds the declaration
    // only: a later `join(tmpdir(), NAME)` (or `${NAME}` inside one) would build
    // a real base from the exempt literal through the const (#9212).
    const names = new Set()
    for (const [, rule] of exempt) {
      const m = /decl:([\w$]+)>VariableDeclaration$/.exec(rule.site)
      if (m) names.add(m[1])
    }
    if (names.size) {
      forEachNode(ast, null, (n) => {
        if (n.type !== 'CallExpression') return
        const c = n.callee
        const fname = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' && !c.computed ? c.property.name : null)
        if ((fname !== 'join' && fname !== 'resolve') || n.arguments.length < 2 || !derived(n.arguments[0])) return
        for (const arg of n.arguments.slice(1)) {
          forEachNode(arg, null, (r) => {
            if (r.type === 'Identifier' && names.has(r.name)) {
              problems.push(`${line(r)}: exempt const ${r.name} used as a tmpdir base argument of ${fname}() — the exemption binds its declaration, not this use`)
            }
          })
        }
      })
    }
  }
  return { bases, problems, exemptUsed: [...exemptUsed] }
}

function scanSourceForTmpBases () {
  const found = new Set()
  const unrecognised = []
  const exemptUsed = new Set()
  for (const file of walk(SRC)) {
    // EXEMPT_LITERALS is keyed with '/' (POSIX); on Windows the walk yields '\\'.
    const rel = file.slice(SRC.length + 1).replace(/\\/g, '/')
    const exempt = new Map([...EXEMPT_LITERALS].filter(([k]) => k.startsWith(`${rel}|`)).map(([k, v]) => [k.slice(rel.length + 1), v]))
    const { bases, problems, exemptUsed: used } = scanSourceText(readFileSync(file, 'utf8'), { exempt })
    bases.forEach((b) => found.add(b))
    used.forEach((t) => exemptUsed.add(`${rel}|${t}`))
    problems.forEach((p) => unrecognised.push(`${rel}:${p}`))
  }
  return { found, unrecognised, exemptUsed }
}

describe('tmpdir daemon-base roster (#8352)', () => {
  const { found, unrecognised, exemptUsed } = scanSourceForTmpBases()

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

  it('no chroxy-* string in a tmpdir-touching src/ file is left unclassified', () => {
    assert.deepEqual(unrecognised, [],
      'add the base to TMP_DAEMON_BASE_NAMES, or list the literal in EXEMPT_LITERALS with a reason')
  })

  it('every EXEMPT_LITERALS entry still matches a literal in src/ (stale exemption check)', () => {
    const stale = [...EXEMPT_LITERALS.keys()].filter((k) => !exemptUsed.has(k))
    assert.deepEqual(stale, [], `an exemption that matches nothing hides the next real base: ${stale}`)
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

    it('a local const string is resolved to the base it names', () => {
      assert.deepEqual(bases("const N = 'chroxy-zzz-const'\nconst b = join(tmpdir(), N)"), ['chroxy-zzz-const'])
    })
    it('a const string that no join uses is reported', () => {
      assert.match(problems("const N = 'chroxy-zzz-unused'")[0] ?? '', /^\d+: .*cannot classify.*chroxy-zzz-unused/)
    })
    it('a trailing-hyphen name is not a base (a mkdtemp prefix) and is reported', () => {
      assert.match(problems("const b = join(tmpdir(), 'chroxy-sess-')")[0] ?? '', /cannot classify/)
    })
    it('destructure from an os namespace, a dynamic import and require all resolve', () => {
      assert.deepEqual(bases("const { tmpdir: t } = os\nconst b = join(t(), 'chroxy-d1')", "import os from 'os'\nimport { join } from 'path'\n"), ['chroxy-d1'])
      assert.deepEqual(bases("const { tmpdir: t } = await import('node:os')\nconst b = join(t(), 'chroxy-d2')", "import { join } from 'path'\n"), ['chroxy-d2'])
      assert.deepEqual(bases("const os = await import('node:os')\nconst b = join(os.tmpdir(), 'chroxy-d3')", "import { join } from 'path'\n"), ['chroxy-d3'])
    })

    it('template literal is reported with its line and the literal', () => {
      const p = problems("\nconst b = `${tmpdir()}/chroxy-zzz-tpl`")
      assert.equal(p.length, 1)
      assert.match(p[0], /^4: chroxy-\* string in a file that touches tmpdir, in a shape the scan cannot classify: "\/chroxy-zzz-tpl"$/)
    })
    it('string concatenation is reported as cannot-classify', () => {
      assert.match(problems("const b = tmpdir() + '/chroxy-zzz-cat'")[0] ?? '', /cannot classify.*chroxy-zzz-cat/)
    })
    it('a base routed through a local helper is still found', () => {
      assert.deepEqual(bases("const g = () => tmpdir()\nconst b = join(g(), 'chroxy-zzz-fn')"), ['chroxy-zzz-fn'])
    })
    it('a value held in this.x or a parameter is reported as cannot-classify', () => {
      assert.match(problems("class A { m () { this.r = tmpdir(); return join(this.r, 'chroxy-zzz-this') } }")[0] ?? '', /cannot classify.*chroxy-zzz-this/)
      assert.match(problems("function mk (base) { return join(base, 'chroxy-zzz-param') }\nmk(tmpdir())")[0] ?? '', /cannot classify.*chroxy-zzz-param/)
    })
    it('tmpdir passed around as a value is reported as cannot-follow', () => {
      assert.match(problems('use(tmpdir)')[0] ?? '', /^\d+: tmpdir reached in a form the scan cannot follow$/)
    })
    it('computed os["tmpdir"] is reported as cannot-follow', () => {
      assert.match(problems("const b = os['tmpdir']()", "import os from 'os'\n")[0] ?? '', /cannot follow \(computed or not called\)/)
    })
    it('a destructure the scan cannot follow is reported as cannot-follow', () => {
      assert.match(problems("const { tmpdir: t } = getOs()\nconst b = join(t(), 'chroxy-zzz-d')", "import { join } from 'path'\n")[0] ?? '', /cannot follow \(destructured tmpdir\)/)
      assert.match(problems("function f ({ tmpdir: t }) { return join(t(), 'chroxy-zzz-p') }", "import { join } from 'path'\n")[0] ?? '', /cannot follow \(destructured tmpdir\)/)
    })
    it('a dynamic import of os that is not awaited into a binding is reported', () => {
      assert.match(problems("import('node:os').then((m) => join(m.tmpdir(), 'chroxy-zzz-dyn'))", "import { join } from 'path'\n")[0] ?? '', /cannot follow \(dynamic import of os\)/)
    })
    it('unparseable source is reported', () => {
      assert.match(scanSourceText('const = (').problems[0] ?? '', /^1: unparseable source/)
    })
    it('a chroxy-* string in a file with no tmpdir is ignored', () => {
      assert.deepEqual(scanSourceText("const n = 'chroxy-claude-tui'").problems, [])
    })
    it('an exempt literal at its bound site is accepted and reported as used; an unlisted one is not', () => {
      const body = "const t = tmpdir()\nconst tag = `chroxy-tag:${t}`\n"
      const exempt = new Map([['chroxy-tag:', ex('image tag', 'TemplateElement>TemplateLiteral[1]>decl:tag>VariableDeclaration')]])
      const r = scanSourceText(IMPORT + body, { exempt })
      assert.deepEqual(r.problems, [])
      assert.deepEqual(r.exemptUsed, ['chroxy-tag:'])
      assert.equal(scanSourceText(IMPORT + body).problems.length, 1)
    })

    describe('exemptions bind to the usage site (#9212)', () => {
      const SITE = 'TemplateElement>TemplateLiteral[1]>decl:tag>VariableDeclaration'
      const exempt = (count = 1) => new Map([['chroxy-tag:', ex('image tag', SITE, count)]])
      const EXEMPT_SITE = "const tag = `chroxy-tag:${tmpdir()}`\n"
      const run = (body, e = exempt()) => scanSourceText(IMPORT + body, { exempt: e }).problems

      it('clean: the exempt site in its exact shape', () => assert.deepEqual(run(EXEMPT_SITE), []))
      it('reported: the exempted literal reused as a real tmpdir base in the same file', () => {
        const p = run(EXEMPT_SITE + "const d = mkdtemp(join(tmpdir(), 'chroxy-tag:'))")
        assert.ok(p.some((x) => /exempt literal "chroxy-tag:" at a site other than the exempted one/.test(x) && x.includes('call:join@1')), p.join('\n'))
      })
      it('reported: a second identical occurrence at the same site exceeds the count', () => {
        const p = run(EXEMPT_SITE + "{ const tag = `chroxy-tag:${1}` }\n")
        assert.ok(p.some((x) => x.includes('"chroxy-tag:"') && x.includes('expected 1 occurrence(s)') && x.includes('found 2')), p.join('\n'))
      })
      it('reported: fewer occurrences than the count (one site vanished, the other remains)', () => {
        const p = run(EXEMPT_SITE, exempt(2))
        assert.ok(p.some((x) => x.includes('expected 2 occurrence(s)') && x.includes('found 1')), p.join('\n'))
      })
      it('reported: the exempt site changed shape (same literal, different enclosing site)', () => {
        const p = run("const other = `chroxy-tag:${tmpdir()}`\n")
        assert.ok(p.some((x) => x.includes('found TemplateElement>TemplateLiteral[1]>decl:other')), p.join('\n'))
      })
      it('reported: a fixed name (no interpolation) at the random-suffixed site', () => {
        const p = run("const tag = 'chroxy-tag:'\nconst t = tmpdir()")
        assert.ok(p.some((x) => x.includes('found Literal>decl:tag')), p.join('\n'))
        const q = run("const tag = `chroxy-tag:`\nconst t = tmpdir()")
        assert.ok(q.some((x) => x.includes('found TemplateElement>TemplateLiteral[0]>decl:tag')), q.join('\n'))
      })
      it('two exempt literals sharing one site shape are told apart by their exact text keys', () => {
        const both = new Map([
          ['chroxy-a:', ex('tag', 'TemplateElement>TemplateLiteral[1]>return')],
          ['chroxy-b:', ex('tag', 'TemplateElement>TemplateLiteral[1]>return')]])
        const body = 'const t = tmpdir()\nfunction a () { return `chroxy-a:${t}` }\nfunction b () { return `chroxy-b:${t}` }\n'
        assert.deepEqual(run(body, both), [])
        assert.ok(run(body + 'function c () { return `chroxy-c:${t}` }', both).some((x) => x.includes('"chroxy-c:"')))
      })
      describe('an exempt const is not a base through its uses', () => {
        const CSITE = 'Literal>decl:P>VariableDeclaration'
        const cex = new Map([['chroxy-x-', ex('container path', CSITE)]])
        const crun = (body) => run(body, cex)
        it('clean: the declaration and a non-base use', () => {
          assert.deepEqual(crun("const P = 'chroxy-x-'\nconst t = tmpdir()\nconst m = `${P}${t}`\nconst q = join('/x', P)"), [])
        })
        it('reported: join(tmpdir(), P)', () => {
          const p = crun("const P = 'chroxy-x-'\nconst b = join(tmpdir(), P)")
          assert.ok(p.some((x) => x.includes('exempt const P used as a tmpdir base')), p.join('\n'))
        })
        it('reported: P interpolated inside such a call', () => {
          const p = crun("const P = 'chroxy-x-'\nconst b = join(tmpdir(), `${P}abc`)")
          assert.ok(p.some((x) => x.includes('exempt const P used as a tmpdir base')), p.join('\n'))
        })
      })
      it('stale: the exempted literal is gone, so it is not reported as used', () => {
        const r = scanSourceText(IMPORT + 'const t = tmpdir()', { exempt: exempt() })
        assert.deepEqual(r.exemptUsed, [])
      })
    })
    it('comments are not code', () => {
      assert.deepEqual(scanSourceText(IMPORT + "// join(tmpdir(), 'chroxy-in-comment')\nconst x = tmpdir()").bases, [])
    })
  })

  it('walk() returns .js, .mjs and .cjs files and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-test-walk-8354-'))
    try {
      mkdirSync(join(dir, 'sub'))
      for (const f of ['a.js', 'b.mjs', 'sub/c.cjs', 'd.json', 'e.md']) writeFileSync(join(dir, f), '')
      const got = walk(dir).map((p) => p.slice(dir.length + 1).replace(/\\/g, '/')).sort()
      assert.deepEqual(got, ['a.js', 'b.mjs', 'sub/c.cjs'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
