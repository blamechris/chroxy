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
  const re = /(?:export\s+)?const\s+([A-Z0-9_]+_SUPPORTED_KEYS)\s*=\s*new Set\(\[([\s\S]*?)\]\)/g
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
  if (out.size === 0) {
    throw new Error(`REFUSE: ${label}: found no *_SUPPORTED_KEYS declarations (the naming convention changed?)`)
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
