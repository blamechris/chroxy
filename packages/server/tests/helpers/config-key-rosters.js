// The ONE parse of the config sub-key rosters CONFIG.md and config.js both
// carry (#7449).
//
// Every function here REFUSES — throws, with the anchor it lost — rather than
// returning an empty or partial result. A doc gate that quantifies over an
// empty set is the "cannot check treated as nothing to check" failure from
// docs/false-safety-guards.md, and it is the specific way a roster guard dies:
// a heading gets renamed, the table stops parsing, and the comparison passes
// vacuously forever.
//
// Consumed by packages/server/tests/config-supported-keys-docs.test.js. The
// producer sets themselves are IMPORTED (real runtime Sets) by that test — the
// source parse here exists only to enumerate the DECLARATIONS (so a new roster
// cannot escape the registry) and to cross-check that the enumeration agrees
// with the runtime values.

import { parse as acornParse } from 'acorn'

/** A `{ name?: type, ... }` member list, e.g. `{ watch?: boolean }`. */
const SHAPE_MEMBER_RE = /^\s*([A-Za-z_$][\w$]*)\??\s*:\s*\S[\s\S]*$/

/**
 * Every `const <X>_SUPPORTED_KEYS = new Set([...])` declaration in a source
 * file, as constName -> string[] of the literal keys.
 *
 * @param {string} src - File contents
 * @param {string} label - File label used in refusal messages
 * @returns {Map<string, string[]>}
 */
export function parseSupportedKeySets(src, label) {
  return parseKeySets(src, label, '_SUPPORTED_KEYS')
}

/**
 * Every `const <X><suffix> = new Set([...])` declaration in a source file.
 * `parseSupportedKeySets` is this with the block-roster suffix; the provider
 * ENTRY rosters use `_ENTRY_KEYS` (#7547).
 *
 * @param {string} src - File contents
 * @param {string} label - File label used in refusal messages
 * @param {string} suffix - e.g. '_SUPPORTED_KEYS' or '_ENTRY_KEYS'
 * @returns {Map<string, string[]>}
 */
export function parseKeySets(src, label, suffix) {
  if (!/^_[A-Z0-9_]+$/.test(suffix)) throw new Error(`REFUSE: parseKeySets: bad suffix ${JSON.stringify(suffix)}`)
  const re = new RegExp(`(?:export\\s+)?const\\s+([A-Z0-9_]+${suffix})\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`, 'g')
  const out = new Map()
  for (const m of src.matchAll(re)) {
    const [, name, rawBody] = m
    // Strip comments FIRST. Three of these Sets carry `//` notes between their
    // entries, so one apostrophe ("don't") inside one would otherwise be read
    // as a string delimiter and the roster would come back wrong — failing
    // loudly, but with a message that sends the reader hunting a stale export
    // rather than a comment (#7510 review, nitpick 1).
    const body = rawBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    if (body.includes('...')) {
      throw new Error(`REFUSE: ${label}: ${name} is declared with a spread — its literal roster cannot be read`)
    }
    const keys = [...body.matchAll(/'([^']*)'/g)].map(k => k[1])
    if (keys.length === 0) {
      throw new Error(`REFUSE: ${label}: ${name} parsed to zero keys (declaration shape changed?)`)
    }
    if (out.has(name)) throw new Error(`REFUSE: ${label}: ${name} declared twice`)
    out.set(name, keys)
  }
  // A declaration the strict pattern above could not read (`Object.freeze(new
  // Set([...]))`, a plain array, a computed Set) must not be skipped — in a file
  // that also holds a readable roster the strict pattern still "finds
  // something", so the zero-declarations refusal below would never fire (#7547
  // review N3). Any `const <X><suffix> =` the strict pattern missed is a REFUSE.
  const loose = [...src.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([A-Z0-9_]+${suffix})\\s*=`, 'g'))].map(m => m[1])
  const unread = loose.filter(name => !out.has(name))
  if (unread.length > 0) {
    throw new Error(
      `REFUSE: ${label}: ${unread.join(', ')} is declared in a form other than a literal new Set([...]) — its roster cannot be read`
    )
  }
  if (out.size === 0) {
    throw new Error(`REFUSE: ${label}: found no *${suffix} declarations (the naming convention changed?)`)
  }
  return out
}

/**
 * Split a call's argument text on TOP-LEVEL commas — the discord call site
 * passes `new Set([...A, ...B])` as one argument, so a naive `.split(',')`
 * shreds it and silently mis-reads which set the doc advertises.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitTopLevelArgs(text) {
  const args = []
  let depth = 0
  let quote = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) { args.push(text.slice(start, i)); start = i + 1 }
  }
  args.push(text.slice(start))
  return args.map(a => a.trim()).filter(a => a.length > 0)
}

/**
 * Every `warnUnknownKeys(obj, knownSet, 'prefix', warnings[, hintSet])` CALL
 * site (never the declaration), as { block, setName }.
 *
 * `block` is the dotted config path the warning names, which is exactly the
 * name CONFIG.md's "Recognised sub-keys" table uses for its row — so the
 * producer supplies the doc mapping rather than a hand-written table.
 * `setName` is the set the warning ADVERTISES (the optional 5th argument when
 * present, else the known set), because that is what an operator is told is
 * supported and therefore what the doc must match.
 *
 * @param {string} src - config.js contents
 * @returns {Array<{ block: string, setName: string }>}
 */
export function parseWarnUnknownKeysCallSites(src) {
  const needle = 'warnUnknownKeys('
  const sites = []
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
    if (src.slice(Math.max(0, i - 9), i) === 'function ') continue
    let depth = 0
    let end = -1
    for (let j = i + needle.length - 1; j < src.length; j++) {
      if (src[j] === '(') depth++
      else if (src[j] === ')') { depth--; if (depth === 0) { end = j; break } }
    }
    if (end === -1) throw new Error('REFUSE: config.js: unbalanced warnUnknownKeys( call — cannot read its arguments')
    const args = splitTopLevelArgs(src.slice(i + needle.length, end))
    if (args.length < 4) {
      throw new Error(`REFUSE: config.js: warnUnknownKeys call with ${args.length} args — expected at least 4`)
    }
    const blockLiteral = /^'([^']+)'$/.exec(args[2])
    if (!blockLiteral) {
      throw new Error(`REFUSE: config.js: warnUnknownKeys prefix argument is not a string literal: ${args[2]}`)
    }
    const advertised = args[4] ?? args[1]
    if (!/^[A-Z0-9_]+_SUPPORTED_KEYS$/.test(advertised)) {
      throw new Error(
        `REFUSE: config.js: warnUnknownKeys for '${blockLiteral[1]}' advertises ` +
          `\`${advertised}\`, which is not a bare *_SUPPORTED_KEYS identifier — the doc gate cannot tell which roster it names`
      )
    }
    sites.push({ block: blockLiteral[1], setName: advertised })
  }
  if (sites.length === 0) {
    throw new Error('REFUSE: config.js: found no warnUnknownKeys call sites')
  }
  return sites
}

export const SUBKEY_TABLE_HEADER = '| Block | Recognised sub-keys |'

/**
 * CONFIG.md's "Recognised sub-keys" table, as block -> string[].
 *
 * @param {string} md - CONFIG.md contents
 * @returns {Map<string, string[]>}
 */
export function parseRecognisedSubKeys(md) {
  const lines = md.split('\n')
  const headerAt = lines.findIndex(l => l.trim() === SUBKEY_TABLE_HEADER)
  if (headerAt === -1) {
    throw new Error(`REFUSE: CONFIG.md: could not find the "${SUBKEY_TABLE_HEADER}" header`)
  }
  if (!/^\|[\s|:-]+\|$/.test(lines[headerAt + 1] ?? '')) {
    throw new Error('REFUSE: CONFIG.md: the Recognised sub-keys header is not followed by a table separator row')
  }
  const out = new Map()
  for (let i = headerAt + 2; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('|')) break
    const cells = line.split('|').slice(1, -1)
    if (cells.length !== 2) {
      throw new Error(`REFUSE: CONFIG.md: Recognised sub-keys row has ${cells.length} cells, expected 2: ${line}`)
    }
    const block = /`([^`]+)`/.exec(cells[0])
    if (!block) throw new Error(`REFUSE: CONFIG.md: Recognised sub-keys row has no backticked block name: ${line}`)
    const keys = [...cells[1].matchAll(/`([^`]+)`/g)].map(m => m[1])
    if (keys.length === 0) {
      throw new Error(`REFUSE: CONFIG.md: Recognised sub-keys row for \`${block[1]}\` lists no keys: ${line}`)
    }
    if (out.has(block[1])) throw new Error(`REFUSE: CONFIG.md: duplicate Recognised sub-keys row for \`${block[1]}\``)
    out.set(block[1], keys)
  }
  if (out.size === 0) {
    throw new Error('REFUSE: CONFIG.md: the Recognised sub-keys table parsed to zero rows')
  }
  return out
}

/**
 * The block's row in one of CONFIG.md's per-key configuration tables
 * (`| key | type | flag | env | description |`), or null when the block has no
 * top-level row — nested blocks such as `environments.k8s` never do.
 *
 * The >= 5 cell requirement is what separates these rows from the 2-cell
 * Recognised sub-keys rows, which start with the same `| \`block\` |` text.
 *
 * @param {string} md
 * @param {string} block
 * @returns {string | null}
 */
export function findConfigTableRow(md, block) {
  const rows = md.split('\n').filter(l => l.startsWith('| `' + block + '` |') && l.split('|').length - 2 >= 5)
  if (rows.length > 1) {
    throw new Error(`REFUSE: CONFIG.md: \`${block}\` has ${rows.length} per-key table rows — ambiguous doc region`)
  }
  return rows[0] ?? null
}

/**
 * The `###` section whose heading carries `` `block` `` verbatim, or null.
 * Body runs to the next heading at any level.
 *
 * @param {string} md
 * @param {string} block
 * @returns {string | null}
 */
export function findSection(md, block) {
  const lines = md.split('\n')
  const marker = '`' + block + '`'
  const starts = lines
    .map((l, i) => (/^#{2,4} /.test(l) && l.includes(marker) ? i : -1))
    .filter(i => i !== -1)
  if (starts.length > 1) {
    throw new Error(`REFUSE: CONFIG.md: \`${block}\` heads ${starts.length} sections — ambiguous doc region`)
  }
  if (starts.length === 0) return null
  let end = lines.length
  for (let i = starts[0] + 1; i < lines.length; i++) {
    if (/^#{1,6} /.test(lines[i])) { end = i; break }
  }
  return lines.slice(starts[0], end).join('\n')
}

/**
 * Every `{ name: type, ... }` group in `text` whose members ALL have the
 * `name: type` form, as arrays of member names.
 *
 * Entry shapes like `{ id, label?, baseUrl }` (no types) are deliberately not
 * type shapes — they describe an ARRAY ENTRY, not the block's sub-keys, and
 * treating them as a roster would compare `providers`' entry fields against
 * its block keys.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function extractTypeShapes(text) {
  const shapes = []
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    const members = m[1].split(',').map(s => s.trim()).filter(Boolean)
    if (members.length === 0) continue
    if (!members.every(mem => SHAPE_MEMBER_RE.test(mem))) continue
    shapes.push(members.map(mem => SHAPE_MEMBER_RE.exec(mem)[1]))
  }
  return shapes
}

/** A bare entry-shape member: `name` or `name?` — NO type annotation, no quotes. */
const ENTRY_MEMBER_RE = /^([A-Za-z_$][\w$]*)(\?)?$/

/**
 * Every `{ name, name?, ... }` group in `text` whose members ALL are bare
 * identifiers (optionally `?`-suffixed), as { names, optional } — the shape a
 * provider ARRAY ENTRY is documented in (`{ id, label?, baseUrl, ... }`, #7547).
 *
 * This is the complement of `extractTypeShapes`: that one wants every member
 * typed (`name: type`) and deliberately rejects these; this one rejects typed
 * and quoted members, so a JSON example (`{ "url": ..., "format": ... }`) or a
 * type shape in the same region is not mistaken for an entry shape. Callers
 * scope `text` to one segment (see `sliceBetween`) and assert how many shapes
 * it carries, because two groups in one segment is ambiguous, not "pick one".
 *
 * @param {string} text
 * @returns {Array<{ names: string[], optional: string[] }>}
 */
export function extractEntryShapes(text) {
  const shapes = []
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    const members = m[1].split(',').map(s => s.trim()).filter(Boolean)
    if (members.length < 2) continue
    const parsed = members.map(mem => ENTRY_MEMBER_RE.exec(mem))
    if (parsed.some(p => p === null)) continue
    shapes.push({ names: parsed.map(p => p[1]), optional: parsed.filter(p => p[2]).map(p => p[1]) })
  }
  return shapes
}

/**
 * The text from the first occurrence of `from` up to (not including) the first
 * occurrence of `to` after it. REFUSES when either anchor is missing, or `to`
 * does not follow `from` — a renamed anchor must stop the gate, not shrink the
 * segment to nothing and let an empty shape list pass.
 *
 * @param {string} text
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function sliceBetween(text, from, to) {
  const a = text.indexOf(from)
  if (a === -1) throw new Error(`REFUSE: CONFIG.md: anchor ${JSON.stringify(from)} not found`)
  const b = text.indexOf(to, a + from.length)
  if (b === -1) throw new Error(`REFUSE: CONFIG.md: anchor ${JSON.stringify(to)} not found after ${JSON.stringify(from)}`)
  return text.slice(a, b)
}

/**
 * The `//` comment block immediately above `  <block>: '<type>',` in config.js's
 * CONFIG_SCHEMA, as PROSE (the `//` markers stripped), or null when the key has
 * no comment.
 *
 * Stripping matters: a type shape that wraps across comment lines reads as
 * `{ a?: boolean, b?:\n// number }`, and leaving the marker in makes the
 * wrapped member unparseable — the shape is then silently skipped and its
 * check disappears, which is precisely the failure this gate exists to catch.
 *
 * @param {string} src - config.js contents
 * @param {string} block - a DOTLESS top-level key
 * @returns {string | null}
 */
export function findSchemaComment(src, block) {
  const lines = src.split('\n')
  const at = lines.findIndex(l => new RegExp('^  ' + block + ": '[^']+',$").test(l))
  if (at === -1) {
    throw new Error(`REFUSE: config.js: no CONFIG_SCHEMA entry for '${block}'`)
  }
  const comment = []
  for (let i = at - 1; i >= 0 && /^\s*\/\//.test(lines[i]); i--) comment.unshift(lines[i].replace(/^\s*\/\/ ?/, ''))
  return comment.length > 0 ? comment.join('\n') : null
}

/**
 * Word tokens of `text`, for the loose "the key is mentioned here at all"
 * containment direction. `providers.anthropicCompatible` yields both halves.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function wordTokens(text) {
  return new Set(text.split(/[^A-Za-z0-9_]+/).filter(Boolean))
}

/**
 * Backticked tokens in a doc region that READ AS sub-key claims (#7514).
 *
 * The reverse-containment check ("everything the prose cites as a key must
 * still exist on the producer") cannot run over every backticked token — a
 * region legitimately backticks paths, env vars, dotted config addresses,
 * JSON examples and literal values. A token counts as a KEY CLAIM only when
 * it is a bare lower-camel identifier, which is exactly the shape every
 * *_SUPPORTED_KEYS member has and none of the other backtick uses do.
 * Generic literals that share the shape are excluded by the roster below —
 * grow it deliberately, with the doc line in hand, never pre-emptively.
 */
export const GENERIC_BACKTICK_LITERALS = new Set([
  // Every entry here must appear backticked in at least one gated region —
  // the gate asserts that, so an entry whose doc line disappears fails as
  // stale instead of quietly widening the evasion surface (#7545 review F1:
  // this roster shipped with four members that appeared NOWHERE in the doc,
  // one of which — `auto` — was a live phantom-sub-key evasion).
  'true', 'false', 'gh',
])

export function claimedSubKeyTokens(regionText) {
  const out = new Set()
  for (const m of regionText.matchAll(/`([a-z][a-zA-Z0-9]*)`/g)) {
    if (!GENERIC_BACKTICK_LITERALS.has(m[1])) out.add(m[1])
  }
  return out
}

// ---- the `features` inventory (#7032) ------------------------------------
//
// CONFIG.md lists the opt-in `features` flags in THREE places (the `features`
// per-key table row, the "Opt-in features" table, and the "Direct reads"
// env-var list) and counts them in prose ("All four are fail-closed", "the four
// `features` gates"). #6997 and #7010 each added an inventory and merged ~33
// minutes apart; the result on main was two inventories each missing a flag the
// other had, and a numeral that no longer matched. These functions are the
// parse the gate in config-supported-keys-docs.test.js compares against the
// producer. Same contract as everything above: REFUSE rather than return an
// empty result.

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/** Depth-first walk keeping the ancestor chain. `visit(node, ancestors)`; ancestors[0] is the Program. */
function walkAst(node, ancestors, visit) {
  visit(node, ancestors)
  ancestors.push(node)
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue
    const v = node[key]
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') walkAst(c, ancestors, visit)
    } else if (v && typeof v.type === 'string') {
      walkAst(v, ancestors, visit)
    }
  }
  ancestors.pop()
}

/**
 * Returned by `memberName` for a computed access whose key is not a plain
 * string literal (a variable, a template literal, a call, a number). It equals
 * no property name, so a name comparison against it is false — which is exactly
 * how such an access used to vanish. Callers that must fail closed test for it
 * explicitly (#8564).
 */
const COMPUTED_KEY = Symbol('computed-key')

/** A member's property name when it is spelled `.name` or `['name']`, COMPUTED_KEY for any other computed key, else null. */
function memberName(m) {
  if (!m.computed && m.property.type === 'Identifier') return m.property.name
  if (m.computed && m.property.type === 'Literal' && typeof m.property.value === 'string') return m.property.value
  if (m.computed) return COMPUTED_KEY
  return null
}

const isLiteralTrue = n => n.type === 'Literal' && n.value === true

// A node that opens its own scope for the purpose of "what does this gate read":
// a function, a class field initializer, or a static block.
const SCOPE_TYPES = new Set([...FUNCTION_TYPES, 'PropertyDefinition', 'StaticBlock'])

/**
 * Every `process.env.CHROXY_*` read inside `root`'s OWN scope. A nested
 * function, class field initializer or static block is a different scope: a
 * closure may never run, so an env read inside one does not prove the gate
 * reads it (#8564 — descending into them erred toward green). `root` itself is
 * always walked, whatever its type.
 */
function collectChroxyEnvReads(root) {
  const envs = new Set()
  const visit = (node, top) => {
    if (!top && SCOPE_TYPES.has(node.type)) return
    if (node.type === 'MemberExpression') {
      const name = memberName(node)
      const o = node.object
      if (typeof name === 'string' && name.startsWith('CHROXY_') && o.type === 'MemberExpression' && memberName(o) === 'env' &&
          o.object.type === 'Identifier' && o.object.name === 'process') envs.add(name)
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue
      const v = node[key]
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === 'string') visit(c, false)
      } else if (v && typeof v.type === 'string') {
        visit(v, false)
      }
    }
  }
  visit(root, true)
  return [...envs].sort()
}

const describeNode = n => (n.operator ? `${n.type}(${n.operator})` : n.type)

/** The name of the function a node lives in, for exemptions and messages. */
function enclosingFunctionName(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const f = ancestors[i]
    if (!FUNCTION_TYPES.has(f.type)) continue
    if (f.id) return f.id.name
    const p = ancestors[i - 1]
    if (p?.type === 'VariableDeclarator' && p.id.type === 'Identifier') return p.id.name
    if ((p?.type === 'Property' || p?.type === 'MethodDefinition' || p?.type === 'PropertyDefinition') && p.key.type === 'Identifier') return p.key.name
    return '<anonymous>'
  }
  return '<module>'
}

/**
 * Parse one source file, or REFUSE naming it. Never skip a file: a file the
 * parser cannot read is a file whose gates nothing can see.
 */
function parseSource(src, label) {
  try {
    return acornParse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true })
  } catch (err) {
    throw new Error(`REFUSE: ${label}: cannot parse (${err.message}) — its features gates, if any, are invisible to this sweep`)
  }
}

/**
 * Every use of `features` in one source file, classified from the AST (#8563:
 * the first two versions of this were lexical — a comment/string stripper and a
 * text window for "the enclosing function" — and both silently blanked real code
 * on a regex literal containing a quote or backtick).
 *
 *  - `gates`: a BinaryExpression `<x>.features.<flag> === true` (optional
 *    chaining accepted, `.flag` spelled non-computed, `true` on the right), with
 *    `envs` = every `process.env.CHROXY_*` read in the INNERMOST enclosing scope
 *    (function, class field initializer or static block; the enclosing top-level
 *    statement if there is none), NOT descending into nested functions, field
 *    initializers or static blocks of that scope (#8564: a closure may never
 *    run). Comments are not in the AST, so a commented-out read cannot count.
 *  - `unrecognised`: every OTHER use — a read in any other spelling (`!!`,
 *    `Boolean()`, destructure, alias, bracket, `true ===`, `!== false`, a bare
 *    `features` identifier), and a WRITE that could enable a flag:
 *    `x.features.f = true`, `x.features = <anything but {}>`, a compound
 *    assignment. Writes of any other right-hand side (`= enabled`,
 *    `= enabled === true`) are not gates and are not reported. Each entry has a
 *    structural `descriptor` and the enclosing function name as `context`, which
 *    is what exemptions key on. A computed access with a non-literal key
 *    (`c[`features`].u`, `c[k].u === true`, `c[k].u = true`) is reported as
 *    `computed-key:*` rather than ignored (#8564); ordinary `map[k]` access is not.
 *    BOUNDARY of that rule, stated so the comment claims no more than the code
 *    checks: a computed link followed by a further member is reported ONLY as
 *    `<chain> === true`, `== true`, `true === <chain>` (optional chaining
 *    accepted) or `<chain> = true`. It is NOT reported in a truthiness test
 *    (`if (c[k].ide)`), `!`, `!== false`, `Boolean()`, a ternary, `&&`, or a
 *    destructure. A static template key (`c[`features`]`) IS reported in any
 *    position. Pinned by a negative test; widening it is a deliberate change.
 *
 * @param {string} src
 * @param {string} label
 * @returns {{
 *   gates: {flag: string, line: number, envs: string[]}[],
 *   unrecognised: {line: number, descriptor: string, context: string}[],
 * }}
 */
export function scanFeatureReads(src, label) {
  const ast = parseSource(src, label)
  const gates = []
  const unrecognised = []
  const seenIdentifiers = new Set()
  const report = (node, ancestors, descriptor) => {
    unrecognised.push({ line: node.loc.start.line, descriptor, context: enclosingFunctionName(ancestors) })
  }
  // The node a member chain ends in, past any ChainExpression wrapper, plus its parent.
  const outward = (node, ancestors) => {
    let top = node
    let i = ancestors.length - 1
    while (ancestors[i]?.type === 'ChainExpression') { top = ancestors[i]; i-- }
    return { top, parent: ancestors[i], index: i }
  }

  // #8564: a computed access with a non-literal key is neither a gate nor
  // reported by the branches below (memberName used to answer null for it), so
  // `c[`features`].u === true` was invisible rather than fail-closed. Two shapes
  // are reported, both descriptors prefixed `computed-key:`:
  //  - a template literal with no substitutions, which is a string literal in
  //    all but spelling and is therefore spelled out as `c[`features`]`;
  //  - a computed link (variable, call, ...) anywhere in a member chain that is
  //    used as a gate or an enable (`=== true`, `= true`). Computed access in any
  //    OTHER position (`arr[i].name`) is ordinary code and is not reported.
  const isStaticTemplate = m => m.computed && m.property.type === 'TemplateLiteral' && m.property.expressions.length === 0
  const reportComputedKey = (node, ancestors) => {
    if (isStaticTemplate(node)) {
      report(node, ancestors, `computed-key:template-literal(${node.property.quasis[0].value.cooked})`)
      return
    }
    // Only the OUTERMOST member of a chain decides the position.
    const { top, parent } = outward(node, ancestors)
    if (parent?.type === 'MemberExpression' && parent.object === top) return
    // A computed link must have a further member AFTER it (`c[k].flag`): a flag is
    // a property of an object, so the last link of a chain is never the flag's
    // parent. `seen[k] === true` / `seen[k] = true` is a set-membership idiom (8
    // sites in src/ at the time of writing) and `features[k]` is already reported
    // through the bare `features` identifier.
    let chain = node.object
    let hasComputedLink = false
    for (;;) {
      if (chain.type === 'ChainExpression') { chain = chain.expression; continue }
      if (chain.type !== 'MemberExpression') break
      if (memberName(chain) === COMPUTED_KEY && !isStaticTemplate(chain)) hasComputedLink = true
      chain = chain.object
    }
    if (!hasComputedLink) return
    // The two positions that ARE a gate or an enable: `<chain> === true` (either
    // side) and `<chain> = true`. The weaker read spellings (`!x`, `!== false`,
    // `Boolean(x)`) are deliberately not matched: with an unresolvable key they
    // fire on ~20 ordinary `map[id]`-style reads in src/, and a gate that noisy is
    // exempted wholesale and then guards nothing. Those spellings are already
    // reported when the chain spells `.features` literally.
    const inPosition =
      (parent?.type === 'BinaryExpression' && (parent.operator === '===' || parent.operator === '==') && (isLiteralTrue(parent.left) || isLiteralTrue(parent.right))) ||
      (parent?.type === 'AssignmentExpression' && parent.left === top && isLiteralTrue(parent.right))
    if (inPosition) report(node, ancestors, `computed-key:chain-in-${describeNode(parent)}`)
  }

  walkAst(ast, [], (node, ancestors) => {
    // Every member is offered; the chain check inside only fires on the OUTERMOST one.
    if (node.type === 'MemberExpression') reportComputedKey(node, ancestors)
    if (node.type === 'MemberExpression' && memberName(node) === 'features') {
      const { top, parent, index } = outward(node, ancestors)
      if (parent?.type === 'MemberExpression' && parent.object === top) {
        // `<x>.features.<something>`
        const flag = !parent.computed && parent.property.type === 'Identifier' ? parent.property.name : null
        const up = outward(parent, ancestors.slice(0, index))
        const p = up.parent
        if (flag && p?.type === 'BinaryExpression' && p.operator === '===' && p.left === up.top && isLiteralTrue(p.right)) {
          const fn = [...ancestors].reverse().find(a => SCOPE_TYPES.has(a.type)) ?? ancestors[1]
          gates.push({ flag, line: node.loc.start.line, envs: collectChroxyEnvReads(fn) })
        } else if (p?.type === 'AssignmentExpression' && p.left === up.top) {
          if (p.operator !== '=' || isLiteralTrue(p.right)) report(node, ancestors, `write:features.${flag ?? '<computed>'} ${p.operator} ${p.operator === '=' ? 'true' : '...'}`)
        } else {
          report(node, ancestors, `flag-access:${p ? describeNode(p) : 'none'}`)
        }
      } else if (parent?.type === 'AssignmentExpression' && parent.left === top) {
        const empty = parent.operator === '=' && parent.right.type === 'ObjectExpression' && parent.right.properties.length === 0
        if (!empty) report(node, ancestors, 'write:features = <not an empty object literal>')
      } else {
        report(node, ancestors, `member:${parent ? describeNode(parent) : 'none'}`)
      }
      return
    }
    if (node.type === 'Identifier' && node.name === 'features') {
      const parent = ancestors[ancestors.length - 1]
      if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return // handled above
      if (seenIdentifiers.has(node.start)) return // a shorthand property visits key and value
      seenIdentifiers.add(node.start)
      let kind = parent ? parent.type : 'none'
      if (parent?.type === 'VariableDeclarator' && parent.id === node) kind = 'declaration'
      else if (parent?.type === 'Property') {
        const inPattern = ancestors[ancestors.length - 2]?.type === 'ObjectPattern'
        kind = (parent.shorthand ? 'shorthand-' : 'key-') + (inPattern ? 'destructure' : 'property')
      } else if (parent?.type === 'MemberExpression' && parent.object === node) kind = 'member-object'
      report(node, ancestors, `identifier:${kind}`)
    }
  })
  return { gates, unrecognised }
}

const NUMBER_WORDS = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6],
  ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12],
])

/** A prose count — "four" or "4" — as a number. REFUSES on a word it does not know. */
function proseNumeral(word, where) {
  const n = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS.get(word.toLowerCase())
  if (n === undefined) throw new Error(`REFUSE: CONFIG.md: ${where} counts the gates with "${word}", which is not a numeral this parser reads`)
  return n
}

/**
 * Everything CONFIG.md says about the `features` flags, from its three
 * inventories plus the two prose counts.
 *
 * @param {string} md
 * @returns {{
 *   keyRow: { flags: Set<string>, envs: Set<string> },
 *   optIn: { flags: Set<string>, envs: Set<string>, pairs: Map<string, string[]>, numeral: number },
 *   directReads: { envs: Set<string>, numeral: number },
 * }}
 */
export function parseFeaturesInventories(md) {
  // 1. The `features` row of the per-key table. Flags are the bare lower-camel
  //    backtick tokens of its description cell (the same token shape
  //    claimedSubKeyTokens already reads), envs the CHROXY_* tokens of its env
  //    cell.
  const row = findConfigTableRow(md, 'features')
  if (row === null) throw new Error('REFUSE: CONFIG.md: no per-key table row for `features`')
  const cells = row.split('|').slice(1, -1)
  const keyRow = {
    flags: claimedSubKeyTokens(cells[4]),
    envs: new Set([...cells[3].matchAll(/`(CHROXY_[A-Z0-9_]+)`/g)].map(m => m[1])),
  }

  // 2. The "Opt-in features (`features`)" section: a `features.<flag>` table and
  //    the "All N are fail-closed" sentence.
  const section = findSection(md, 'features')
  if (section === null) throw new Error('REFUSE: CONFIG.md: no "Opt-in features (`features`)" section')
  const optIn = { flags: new Set(), envs: new Set(), pairs: new Map(), numeral: NaN }
  for (const line of section.split('\n')) {
    const m = /^\| `features\.([A-Za-z_$][\w$]*)` \|(.*)$/.exec(line)
    if (!m) continue
    if (optIn.flags.has(m[1])) throw new Error(`REFUSE: CONFIG.md: the Opt-in features table lists features.${m[1]} twice`)
    optIn.flags.add(m[1])
    const rowEnvs = [...m[2].matchAll(/`(CHROXY_[A-Z0-9_]+)=/g)].map(e => e[1]).sort()
    optIn.pairs.set(m[1], rowEnvs)
    for (const e of rowEnvs) optIn.envs.add(e)
  }
  const counted = [...section.matchAll(/\bAll (\w+) (?:are )?\*\*fail-closed\*\*/g)]
  if (counted.length !== 1) {
    throw new Error(`REFUSE: CONFIG.md: expected exactly one "All N are **fail-closed**" sentence in the Opt-in features section, found ${counted.length}`)
  }
  optIn.numeral = proseNumeral(counted[0][1], 'the "All N are fail-closed" sentence')

  // 3. The "Direct reads" list: `CHROXY_ENABLE_IDE` / `...` (the four
  //    [`features` gates](#...)).
  const direct = /((?:`CHROXY_[A-Z0-9_]+`\s*\/?\s*)+)\(the (\w+) \[`features` gates\]/.exec(md)
  if (direct === null) {
    throw new Error('REFUSE: CONFIG.md: the "Direct reads" paragraph no longer reads "`CHROXY_…` / … (the N [`features` gates](…))"')
  }
  const directReads = {
    envs: new Set([...direct[1].matchAll(/`(CHROXY_[A-Z0-9_]+)`/g)].map(m => m[1])),
    numeral: proseNumeral(direct[2], 'the "Direct reads" list'),
  }

  for (const [name, flags] of [['`features` table row', keyRow.flags], ['Opt-in features table', optIn.flags]]) {
    if (flags.size === 0) throw new Error(`REFUSE: CONFIG.md: the ${name} parsed to zero flags`)
  }
  if (directReads.envs.size === 0) throw new Error('REFUSE: CONFIG.md: the "Direct reads" features list parsed to zero env vars')
  return { keyRow, optIn, directReads }
}

// ---- #8564: schema rows + types, table and anchor integrity ----------------

/**
 * `CONFIG_SCHEMA` from config.js source, as key -> type string. Parsed from the
 * AST (the object is not exported, and the runtime check must not depend on
 * exporting it). REFUSES on anything it cannot read as `name: 'literal'`: a
 * spread, a computed key or a non-string value would make the key set
 * incomplete, and a schema check over a partial schema passes vacuously.
 *
 * @param {string} src
 * @param {string} label
 * @returns {Map<string, string>}
 */
export function parseConfigSchema(src, label) {
  const ast = parseSource(src, label)
  let obj = null
  walkAst(ast, [], node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'CONFIG_SCHEMA') {
      if (obj) throw new Error(`REFUSE: ${label}: CONFIG_SCHEMA is declared twice`)
      if (node.init?.type !== 'ObjectExpression') throw new Error(`REFUSE: ${label}: CONFIG_SCHEMA is not an object literal`)
      obj = node.init
    }
  })
  if (!obj) throw new Error(`REFUSE: ${label}: no \`const CONFIG_SCHEMA = { ... }\` declaration`)
  const schema = new Map()
  for (const p of obj.properties) {
    const key = p.type === 'Property' && !p.computed
      ? (p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' && typeof p.key.value === 'string' ? p.key.value : null)
      : null
    if (key === null || p.value.type !== 'Literal' || typeof p.value.value !== 'string') {
      throw new Error(`REFUSE: ${label}:${p.loc.start.line}: CONFIG_SCHEMA entry is not a plain \`name: 'type'\` pair (${p.type}) — the schema is not fully readable`)
    }
    if (schema.has(key)) throw new Error(`REFUSE: ${label}: CONFIG_SCHEMA key ${key} appears twice`)
    schema.set(key, p.value.value)
  }
  if (schema.size === 0) throw new Error(`REFUSE: ${label}: CONFIG_SCHEMA parsed to zero keys`)
  return schema
}

/** Cells of one table line, split on UNESCAPED pipes (GFM: a pipe inside a code span still splits). */
function tableCells(line) {
  const t = line.trim()
  const inner = t.slice(t.startsWith('|') ? 1 : 0, t.endsWith('|') && !t.endsWith('\\|') ? -1 : undefined)
  return inner.split(/(?<!\\)\|/)
}

/** The lines of `md` outside fenced code blocks, with their 1-based line numbers. REFUSES on an unclosed fence. */
function proseLines(md) {
  const out = []
  let fence = null
  md.split('\n').forEach((line, i) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (m) {
      if (fence === null) fence = m[1][0]
      else if (m[1][0] === fence) fence = null
      return
    }
    if (fence === null) out.push({ n: i + 1, text: line })
  })
  if (fence !== null) throw new Error('REFUSE: CONFIG.md: a fenced code block is never closed — everything after it would be skipped')
  return out
}

/** GitHub's heading slug: lowercase, drop punctuation except `-` and `_`, spaces to `-`. */
function githubSlug(heading) {
  return heading.toLowerCase().replace(/[^\p{L}\p{N}\p{M} _-]/gu, '').replace(/ /g, '-')
}

/**
 * Structural integrity of CONFIG.md. LINK SCOPE: only inline `](#fragment)` links
 * are checked. Reference-style links (`[x][ref]`), `<a name>` / `id=` anchors and
 * relative file links (`](../x.md)`) are NOT checked, and a heading's slug is
 * computed the GitHub way without emoji or HTML-heading handling.
 *
 * What it checks: every table has the same number of cells in
 * every row as its header and separator, and every `](#fragment)` link resolves
 * to a heading. Returns problems (never throws on a defect); REFUSES only when
 * it cannot read the document at all (no tables, no headings, no links, or an
 * unclosed fence), because a count over zero tables or links is the vacuous pass.
 *
 * @param {string} md
 * @returns {{ problems: {kind: string, message: string}[], tables: number, links: number, headings: number }}
 */
export function checkMarkdownIntegrity(md) {
  const lines = proseLines(md)
  const problems = []
  const add = (kind, message) => problems.push({ kind, message })

  // Tables: maximal runs of consecutive prose lines that start with `|`.
  let tables = 0
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].text.startsWith('|')) continue
    const run = [lines[i]]
    while (i + 1 < lines.length && lines[i + 1].n === run[run.length - 1].n + 1 && lines[i + 1].text.startsWith('|')) run.push(lines[++i])
    tables++
    const width = tableCells(run[0].text).length
    if (run.length < 2 || !tableCells(run[1].text).every(c => /^\s*:?-{3,}:?\s*$/.test(c))) {
      add('table', `CONFIG.md:${run[0].n}: the table has no \`|---|\` separator row under its header`)
      continue
    }
    for (const row of run) {
      const got = tableCells(row.text).length
      if (got !== width) add('table', `CONFIG.md:${row.n}: table row has ${got} cells but its header (line ${run[0].n}) has ${width} — an unescaped \`|\` inside a cell splits it`)
    }
  }

  // Anchors: heading slugs (with GitHub's -1, -2 suffix for repeats) vs `](#x)`.
  const slugs = new Set()
  const seen = new Map()
  let headings = 0
  for (const { text } of lines) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(text)
    if (!h) continue
    headings++
    const base = githubSlug(h[1])
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    slugs.add(n === 0 ? base : `${base}-${n}`)
  }
  let links = 0
  for (const { n, text } of lines) {
    for (const m of text.matchAll(/\]\(#([^)\s]*)\)/g)) {
      links++
      if (!slugs.has(m[1])) add('anchor', `CONFIG.md:${n}: link \`(#${m[1]})\` matches no heading anchor`)
    }
  }
  if (tables === 0 || headings === 0 || links === 0) {
    throw new Error(`REFUSE: CONFIG.md: integrity parse found ${tables} tables, ${headings} headings, ${links} anchor links — it is not reading the document`)
  }
  return { problems, tables, links, headings }
}

/**
 * Compare CONFIG.md's per-key tables (everything under "## Configuration Keys")
 * with the CONFIG_SCHEMA key -> type map, both ways.
 *
 * @param {Map<string, string>} schema
 * @param {string} md
 * @returns {{ problems: {kind: string, message: string}[], rows: Map<string, string> }}
 */
export function checkSchemaRows(schema, md) {
  const lines = proseLines(md)
  const start = lines.findIndex(l => l.text === '## Configuration Keys')
  if (start === -1) throw new Error('REFUSE: CONFIG.md: no "## Configuration Keys" heading')
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l.text))
  if (end === -1) end = lines.length
  const rows = new Map() // key -> documented type, normalised
  const problems = []
  const add = (kind, message) => problems.push({ kind, message })
  // Only tables headed `| Key | Type | CLI Flag | Environment Variable | Description |`
  // are per-key tables; the PVC / quota / ConfigMap tables below carry other rows.
  const isKeyHeader = cells => cells.length === 5 && cells.map(c => c.trim()).join('|') === 'Key|Type|CLI Flag|Environment Variable|Description'
  // The per-key region ends at "### Environment variable names"; every table before
  // it must carry the key header. A table whose header was renamed or reshaped is
  // REPORTED (not skipped): skipping it would hide a phantom or mistyped row in it.
  const regionEnd = lines.findIndex((l, i) => i > start && l.text === '### Environment variable names')
  if (regionEnd === -1 || regionEnd >= end) throw new Error('REFUSE: CONFIG.md: no "### Environment variable names" heading closing the per-key tables')
  let inKeyTable = false
  let keyTables = 0
  let prevPipe = false
  for (const [idx, { n, text }] of lines.slice(start, end).entries()) {
    const isPipe = text.startsWith('|')
    const tableStart = isPipe && !prevPipe
    prevPipe = isPipe
    if (!isPipe) { inKeyTable = false; continue }
    const cells = tableCells(text)
    if (isKeyHeader(cells)) { inKeyTable = true; keyTables++; continue }
    if (tableStart) {
      if (start + idx < regionEnd) add('unrecognised-table', `CONFIG.md:${n}: a table in the per-key section has header \`${text.slice(0, 80)}\`, not the expected \`| Key | Type | CLI Flag | Environment Variable | Description |\` — its rows are not compared with CONFIG_SCHEMA`)
      continue
    }
    if (!inKeyTable || cells.length < 5) continue
    const m = /^\s*`([A-Za-z_$][\w$]*)`\s*$/.exec(cells[0])
    if (!m) continue // header, separator, `_(env-only)_` rows
    if (rows.has(m[1])) throw new Error(`REFUSE: CONFIG.md:${n}: \`${m[1]}\` has two per-key table rows`)
    rows.set(m[1], cells[1].replace(/\\\|/g, '|').replace(/\s+/g, ''))
  }
  if (keyTables === 0 || rows.size === 0) throw new Error(`REFUSE: CONFIG.md: found ${keyTables} per-key tables and ${rows.size} rows under "## Configuration Keys" — the header row may have changed`)
  for (const [key, type] of schema) {
    if (!rows.has(key)) add('missing-row', `CONFIG_SCHEMA key \`${key}\` has no row in CONFIG.md's per-key tables`)
    else if (rows.get(key) !== type) add('type', `CONFIG.md documents \`${key}\` as \`${rows.get(key)}\` but CONFIG_SCHEMA says \`${type}\``)
  }
  for (const key of rows.keys()) {
    if (!schema.has(key)) add('phantom-row', `CONFIG.md has a per-key row for \`${key}\`, which is not a CONFIG_SCHEMA key`)
  }
  return { problems, rows }
}
