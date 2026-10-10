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

/**
 * Every `<x>.features?.<flag> === true` gate in one source file's text.
 * Comment-only lines and block comments are dropped first, so a doc comment that
 * quotes a gate is not counted as one; a trailing comment is left alone (a
 * phantom gate there fails LOUDLY as "documented flag has no gate").
 *
 * Returns [] for a file with no gate — the caller aggregates across `src/` and
 * REFUSES on zero in total, because most files legitimately have none.
 *
 * @param {string} src
 * @returns {string[]} flag names, in source order (duplicates preserved)
 */
export function parseFeatureGates(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  return [...code.matchAll(/\bfeatures\??\.([A-Za-z_$][\w$]*)\s*===\s*true\b/g)].map(m => m[1])
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
 *   optIn: { flags: Set<string>, envs: Set<string>, numeral: number },
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
  const optIn = { flags: new Set(), envs: new Set(), numeral: NaN }
  for (const line of section.split('\n')) {
    const m = /^\| `features\.([A-Za-z_$][\w$]*)` \|(.*)$/.exec(line)
    if (!m) continue
    if (optIn.flags.has(m[1])) throw new Error(`REFUSE: CONFIG.md: the Opt-in features table lists features.${m[1]} twice`)
    optIn.flags.add(m[1])
    for (const e of m[2].matchAll(/`(CHROXY_[A-Z0-9_]+)=/g)) optIn.envs.add(e[1])
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
