/**
 * #9235 — the privacy boundary for stored and copied dashboard error reports.
 *
 * Pattern-scrubbing free error text cannot be proven safe: a `JSON.parse` error quotes
 * its payload, a `data:` URL carries prompt text verbatim, and URL, encoding, path and
 * truncation bypasses are endless. So this module never scrubs. It ALLOWLISTS:
 *
 *   - a message survives only if the WHOLE string matches a known JavaScript-engine error
 *     template, and every variable slot in it is a word-shaped identifier (below);
 *   - a stack frame survives only as `name @ basename:line:col`, where the name is a
 *     word-shaped identifier and the basename is one of the caller's own loaded scripts;
 *   - everything else becomes `[message omitted]` / `<anonymous>` / `<unknown>`.
 *
 * No output string is ever a substring of the input except a validated slot.
 *
 * Guarantees, stated honestly:
 *   - FAIL CLOSED for diagnostics. Anything not recognised is dropped, even if that loses a
 *     useful report. A minified or unusual name that does not look like words is masked.
 *   - BEST EFFORT for credentials. The word-shape admission rule is a conservative positive
 *     allowlist: an identifier is kept only if it reads like words (bounded length, few
 *     digits, vowel-bearing lowercase chunks, short acronyms, not hex). Known credential
 *     prefixes are masked first, then the shared redaction rules run. This rejects random
 *     tokens; it cannot be proven to reject every possible secret.
 *   - ACCEPTED RESIDUAL. An identifier-shaped slot can still carry session content, e.g.
 *     `PatientAliceHIVPositive` used as a property key: nothing can tell that from a real
 *     identifier. The model accepts it, and PR 3's Copy flow shows the report for review
 *     before anything is copied.
 *   - File locations are kept only when their basename is in the caller-supplied
 *     `assetBasenames` set, which is a TRUSTED input (see `StackOptions`).
 *
 * Linear time: every regex here is anchored, uses simple character classes and has no
 * nested or overlapping quantifier. The identifier class excludes `.`, so a dotted path
 * is unambiguous. All input is cut to a fixed size BEFORE any regex sees it, and the
 * stack walkers use `indexOf`/`slice`, never a split of the whole input.
 *
 * Pure: no storage, no DOM, never throws. Storage and UI are layered on top elsewhere.
 */
import { redactValue } from '@chroxy/protocol/redaction'

export const MESSAGE_OMITTED = '[message omitted]'
const REDACTED = '[REDACTED]'
const ANONYMOUS = '<anonymous>'
const UNKNOWN = '<unknown>'

const MAX_STACK_LINES = 200
/** A line longer than this is cut before parsing, and any frame it holds is dropped to anonymous/unknown. */
const MAX_LINE_CHARS = 512
const DEFAULT_MAX_FRAMES = 12
const DEFAULT_MAX_COMPONENTS = 15
const MAX_DIGITS = 7

/** Constructors whose NAME is kept; anything else (a subclass, a payload) becomes `Error`. */
const ERROR_NAMES: ReadonlySet<string> = new Set([
  'Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'EvalError',
  'AggregateError', 'InternalError', 'DOMException', 'AbortError', 'NotFoundError', 'SecurityError', 'NetworkError',
  'QuotaExceededError', 'InvalidStateError', 'TimeoutError',
])

// ---------------------------------------------------------------------------
// Slot shapes
// ---------------------------------------------------------------------------

const ID_SRC = '[A-Za-z_$][A-Za-z0-9_$]{0,63}'
/** A dotted member path of at most 4 identifiers (`this.a.b.c`). `.` is not in the identifier class. */
const PATH_SRC = `${ID_SRC}(?:\\.${ID_SRC}){0,3}`
const REDACTED_SRC = '\\[REDACTED\\]'

const ID_RE = new RegExp(`^${ID_SRC}$`)
const PATH_RE = new RegExp(`^${PATH_SRC}$`)
const DIGITS_RE = /^\d{1,10}$/

/**
 * Credential markers. A slot, name or basename that CONTAINS one is masked whole, because
 * the shared patterns need a trailing word boundary (`ghp_<36>_suffix` slips past them).
 *
 * Plain substrings (identifier-safe): ghp_, gho_, ghu_, ghs_, ghr_, github_pat_, AIza,
 * sk_live_, sk_test_, rk_live_, rk_test_, pk_live_, ya29., whsec_, shpat_, dckr_pat_, glsa_.
 * Shape-gated, so ordinary names such as `npm_config_cache` or `ASIANMarketData` survive:
 * `npm_` + 20 alphanumerics, `hf_` + 20 alphanumerics, `oauth_` + 16 alphanumerics,
 * `AKIA`/`ASIA` + 16 of [A-Z0-9].
 */
const CREDENTIAL_PREFIXES: readonly string[] = [
  'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'AIza',
  'sk_live_', 'sk_test_', 'rk_live_', 'rk_test_', 'pk_live_', 'ya29.',
  'whsec_', 'shpat_', 'dckr_pat_', 'glsa_',
]
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /npm_[A-Za-z0-9]{20}/,
  /hf_[A-Za-z0-9]{20}/,
  /oauth_[A-Za-z0-9]{16}/,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/,
]
/**
 * Hyphenated families. They cannot occur in an identifier, so they are checked on BASENAMES
 * only (which allow `-`): glpat-, xoxb-, xoxp-, xoxa-, xoxs-, and `sk-` (which covers
 * sk-ant- and sk-proj-) at the start of a name or after `.`, `_` or `-`.
 */
const HYPHEN_PREFIXES: readonly string[] = ['glpat-', 'xoxb-', 'xoxp-', 'xoxa-', 'xoxs-']

function hasCredentialMarker(s: string, hyphenated: boolean): boolean {
  for (const p of CREDENTIAL_PREFIXES) if (s.includes(p)) return true
  for (const re of CREDENTIAL_SHAPES) if (re.test(s)) return true
  if (hyphenated) {
    for (const p of HYPHEN_PREFIXES) if (s.includes(p)) return true
    for (let i = s.indexOf('sk-'); i >= 0; i = s.indexOf('sk-', i + 1)) {
      if (i === 0 || '._-'.includes(s.charAt(i - 1))) return true
    }
  }
  return false
}

const isLower = (c: number) => c >= 97 && c <= 122
const isUpper = (c: number) => c >= 65 && c <= 90
const isDigitCode = (c: number) => c >= 48 && c <= 57
const isHexCode = (c: number) => isDigitCode(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)
const VOWELS = 'aeiouyAEIOUY'
/**
 * Vowelless web abbreviations, exempt from the vowel and consonant-run clauses. Compared
 * case-insensitively and only as a WHOLE chunk (`Http`, `https`, `Html`), so `Httpx` or
 * `Htmlzq` are not exempt. Shorter ones (btn, src, svg, xml, url) are never vowel-checked.
 */
const VOWELLESS_ABBREVIATIONS: ReadonlySet<string> = new Set(['html', 'http', 'https', 'xhtml', 'ctrl', 'rgba'])

/**
 * The word-shape admission rule for ONE identifier segment (no `.`). Conservative and
 * positive: a segment is kept only if ALL hold.
 *   - 1 to 40 characters, only [A-Za-z0-9_$];
 *   - at most 4 digits in total and no digit run longer than 3;
 *   - not hex-only (8 or more characters, all [0-9a-fA-F]);
 *   - split into chunks: a lowercase run optionally led by ONE uppercase letter
 *     (`Session`), a run of 2+ uppercase letters (an acronym; when a lowercase letter
 *     follows, its last uppercase goes to the next chunk: `HTTPStream` = `HTTP` + `Stream`),
 *     digit runs and `_`/`$` separators; then
 *       - every chunk with a lowercase letter and 4+ characters contains a vowel [aeiouy],
 *         except the whole-chunk abbreviations html, http, https, xhtml, ctrl, rgba (any case);
 *       - no chunk with a lowercase letter is longer than 14 or holds a run of 5 or more
 *         consecutive consonants (a vowel is [aeiouy]);
 *       - no uppercase-only chunk is longer than 5;
 *       - at most 2 one-letter alphabetic chunks (`i`, `x`), and at most 2 chunks of 1-2
 *         letters in all (the "short fragments" rule: random mixed-case strings are mostly
 *         1-2 letter fragments, real camelCase has few; added to the base rule after
 *         measuring that without it about 18% of random base62 24-mers were admitted).
 * Random hex, base62, base36 and base64url tokens fail one of these with overwhelming
 * probability (see the corpus tests); real camelCase, snake_case and PascalCase names pass.
 */
export function isWordShaped(seg: string): boolean {
  const n = seg.length
  if (n === 0 || n > 40) return false
  let digits = 0
  let run = 0
  let hexOnly = true
  for (let i = 0; i < n; i++) {
    const c = seg.charCodeAt(i)
    if (isDigitCode(c)) {
      digits++
      run++
      if (run > 3) return false
    } else {
      run = 0
      if (!isLower(c) && !isUpper(c) && c !== 95 && c !== 36) return false
    }
    if (!isHexCode(c)) hexOnly = false
  }
  if (digits > 4) return false
  if (n >= 8 && hexOnly) return false

  let singles = 0
  let shorts = 0
  // Judge one alphabetic chunk [s, e); `upperOnly` when it has no lowercase letter.
  const chunk = (s0: number, e: number): boolean => {
    const len = e - s0
    const exempt = len <= 5 && VOWELLESS_ABBREVIATIONS.has(seg.slice(s0, e).toLowerCase())
    let hasLower = false
    let hasVowel = false
    let consonants = 0
    let maxConsonants = 0
    for (let k = s0; k < e; k++) {
      if (isLower(seg.charCodeAt(k))) hasLower = true
      if (VOWELS.includes(seg.charAt(k))) {
        hasVowel = true
        consonants = 0
      } else if (++consonants > maxConsonants) maxConsonants = consonants
    }
    if (hasLower) {
      if (len > 14) return false
      if (!exempt && len >= 4 && !hasVowel) return false
      if (!exempt && maxConsonants > 4) return false
    } else if (len > 5) return false
    if (len === 1) singles++
    if (len <= 2) shorts++
    return singles <= 2 && shorts <= 2
  }
  // An uppercase-only run. One longer than 5 is allowed only if it starts with an exempt
  // abbreviation (`HTMLLI` in `HTMLLIElement` = HTML + LI) followed by at most 2 more letters, which are judged
  // as their own chunk.
  const acronym = (s0: number, e: number): boolean => {
    if (e - s0 > 5) {
      for (const abbr of VOWELLESS_ABBREVIATIONS) {
        if (seg.slice(s0, s0 + abbr.length).toLowerCase() === abbr && e - s0 - abbr.length <= 2) {
          return chunk(s0, s0 + abbr.length) && chunk(s0 + abbr.length, e)
        }
      }
    }
    return chunk(s0, e)
  }
  let i = 0
  while (i < n) {
    const c = seg.charCodeAt(i)
    if (isLower(c)) {
      let j = i
      while (j < n && isLower(seg.charCodeAt(j))) j++
      if (!chunk(i, j)) return false
      i = j
    } else if (isUpper(c)) {
      let u = i
      while (u < n && isUpper(seg.charCodeAt(u))) u++
      if (u - i === 1) {
        let j = u
        while (j < n && isLower(seg.charCodeAt(j))) j++
        if (!chunk(i, j)) return false
        i = j
      } else if (u < n && isLower(seg.charCodeAt(u))) {
        if (!acronym(i, u - 1)) return false
        let j = u
        while (j < n && isLower(seg.charCodeAt(j))) j++
        if (!chunk(u - 1, j)) return false
        i = j
      } else {
        if (!acronym(i, u)) return false
        i = u
      }
    } else {
      i++ // digit run or `_` / `$` separator
    }
  }
  return true
}

/** Every dotted segment must be word-shaped. */
function isWordShapedPath(path: string): boolean {
  let start = 0
  for (;;) {
    const dot = path.indexOf('.', start)
    const end = dot < 0 ? path.length : dot
    if (!isWordShaped(path.slice(start, end))) return false
    if (dot < 0) return true
    start = dot + 1
  }
}

/**
 * Admit one validated identifier slot: credential markers first, then the word-shape rule,
 * then the shared redaction rules. Anything refused is masked whole.
 */
function redactSlot(slot: string): string {
  try {
    if (hasCredentialMarker(slot, false)) return REDACTED
    if (!isWordShapedPath(slot)) return REDACTED
    return redactValue(slot) === slot ? slot : REDACTED
  } catch {
    return REDACTED
  }
}

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

/**
 * `{id}` an identifier, `{path}` a dotted path of at most 4 identifiers, `{key}` an
 * identifier or a digit-only property key of at most 10 digits (`reading '0'`), `{nullish}`
 * the literal `undefined` or `null`. Everything else is literal text. `{id}`/`{path}` also
 * accept the literal `[REDACTED]`, so that already-classified text re-validates to itself.
 */
export const ERROR_TEMPLATE_PATTERNS: ReadonlyArray<readonly [id: string, pattern: string]> = [
  // V8
  ['read-props-of', "Cannot read properties of {nullish} (reading '{key}')"],
  ['cannot-set-props-of', "Cannot set properties of {nullish} (setting '{key}')"],
  ['not-a-function', '{path} is not a function'],
  ['not-a-constructor', '{path} is not a constructor'],
  ['not-iterable', '{path} is not iterable'],
  ['not-defined', '{path} is not defined'],
  ['cannot-access-before-init', "Cannot access '{id}' before initialization"],
  ['cannot-access-before-init', "Cannot access '{id}' before initialization."],
  ['max-call-stack', 'Maximum call stack size exceeded'],
  ['invalid-array-length', 'Invalid array length'],
  ['assignment-to-constant', 'Assignment to constant variable.'],
  ['cannot-convert-to-object', 'Cannot convert undefined or null to object'],
  ['json-unexpected-end', 'Unexpected end of JSON input'],
  // JavaScriptCore (Safari / WKWebView, the macOS Tauri shell)
  ['not-an-object', "{nullish} is not an object (evaluating '{path}')"],
  ['not-defined', "Can't find variable: {id}"],
  ['max-call-stack', 'Maximum call stack size exceeded.'],
  // SpiderMonkey (Firefox)
  ['cannot-access-property', "can't access property \"{key}\", {path} is {nullish}"],
  ['cannot-access-before-init', "can't access lexical declaration '{id}' before initialization"],
  ['assignment-to-constant', "invalid assignment to const '{id}'"],
  ['cannot-convert-to-object', "can't convert {nullish} to object"],
  ['max-call-stack', 'too much recursion'],
  ['invalid-array-length', 'invalid array length'],
  // Fixed strings with no variable part
  ['fetch-failed', 'Failed to fetch'],
  ['fetch-failed', 'Load failed'],
  ['fetch-failed', 'NetworkError when attempting to fetch resource.'],
  ['resize-observer-loop', 'ResizeObserver loop completed with undelivered notifications.'],
  ['resize-observer-loop', 'ResizeObserver loop limit exceeded'],
]

interface CompiledTemplate {
  id: string
  re: RegExp
  /** The pieces between placeholders, `parts.length === kinds.length + 1`. */
  parts: string[]
  kinds: Array<'id' | 'path' | 'key' | 'nullish'>
}

function escapeLiteral(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
}

function compile([id, pattern]: readonly [string, string]): CompiledTemplate {
  const parts: string[] = []
  const kinds: CompiledTemplate['kinds'] = []
  let src = '^'
  let last = 0
  const placeholder = /\{(id|path|key|nullish)\}/g
  for (let m = placeholder.exec(pattern); m; m = placeholder.exec(pattern)) {
    const lit = pattern.slice(last, m.index)
    parts.push(lit)
    src += escapeLiteral(lit)
    const kind = m[1] as 'id' | 'path' | 'key' | 'nullish'
    kinds.push(kind)
    src += kind === 'id' ? `(${ID_SRC}|${REDACTED_SRC})`
      : kind === 'path' ? `(${PATH_SRC}|${REDACTED_SRC})`
        : kind === 'key' ? `(${ID_SRC}|\\d{1,10}|${REDACTED_SRC})`
          : '(undefined|null)'
    last = m.index + m[0].length
  }
  const tail = pattern.slice(last)
  parts.push(tail)
  src += `${escapeLiteral(tail)}$`
  return { id, re: new RegExp(src), parts, kinds }
}

const COMPILED: readonly CompiledTemplate[] = ERROR_TEMPLATE_PATTERNS.map(compile)

/** Longest slot text each placeholder can match: an id is 64, a path 4x64+3, `undefined` is 9. */
const SLOT_MAX = { id: 64, path: 4 * 64 + 3, key: 64, nullish: 9 } as const

/**
 * The longest message any template can match, computed from the table so it cannot drift:
 * a longer message is not a template, and is never handed to a regex.
 */
export const MAX_MESSAGE_CHARS: number = Math.max(...COMPILED.map(t =>
  t.parts.reduce((sum, p) => sum + p.length, 0) + t.kinds.reduce((sum, k) => sum + SLOT_MAX[k], 0)))

/** The set of stable template ids, for tests and for the Diagnostics UI. */
export const ERROR_TEMPLATE_IDS: readonly string[] = Array.from(new Set(ERROR_TEMPLATE_PATTERNS.map(t => t[0])))

export interface ClassifiedError {
  name: string
  /** Stable id of the matched engine template, or null when the message was omitted. */
  template: string | null
  /** The re-rendered template, or the literal `[message omitted]`. Never a raw substring of the input. */
  text: string
}

/**
 * Keep an error's name and message only when they are known-safe. Never throws.
 */
export function classifyErrorMessage(name: unknown, message: unknown): ClassifiedError {
  const safeName = typeof name === 'string' && ERROR_NAMES.has(name) ? name : 'Error'
  const omitted: ClassifiedError = { name: safeName, template: null, text: MESSAGE_OMITTED }
  if (typeof message !== 'string' || message.length === 0 || message.length > MAX_MESSAGE_CHARS) return omitted
  for (const t of COMPILED) {
    const m = t.re.exec(message)
    if (!m) continue
    let text = t.parts[0] ?? ''
    for (let i = 0; i < t.kinds.length; i++) {
      const raw = m[i + 1] ?? ''
      const kind = t.kinds[i]
      // `{nullish}` is a fixed two-word alternation, not a free slot. Id/path slots are
      // re-checked against their shape (the regex already guarantees it; this keeps the
      // invariant visible and local) and then redacted.
      const slot = kind === 'nullish' ? raw
        : raw === REDACTED ? REDACTED
          : kind === 'key' && DIGITS_RE.test(raw) ? raw
            : (kind === 'path' ? PATH_RE : ID_RE).test(raw) ? redactSlot(raw) : null
      if (slot === null) return omitted
      text += slot + (t.parts[i + 1] ?? '')
    }
    return { name: safeName, template: t.id, text }
  }
  return omitted
}

// ---------------------------------------------------------------------------
// Stack normalisation
// ---------------------------------------------------------------------------

/** `http(s)` bundle assets only: `index-abc123.js`. */
const BUNDLE_BASENAME_RE = /^[A-Za-z0-9_.-]{1,80}\.(?:js|mjs|cjs)$/
/** The dashboard's own loaded script basenames, supplied by the caller. Absent or empty: every location is `<unknown>`. */
export type AssetBasenames = ReadonlySet<string>

export interface StackOptions {
  maxFrames?: number
  /**
   * The basenames of the dashboard's OWN loaded scripts (`document.scripts`, the module's
   * `import.meta.url`), captured at report time by the caller. This is a TRUSTED input:
   * it must never be read from a stored entry, a report or anything else that came from
   * outside the running dashboard, because membership is the only thing that lets a
   * location through. Absent or empty, every location is `<unknown>` (fail closed). A
   * member is still refused if it carries a credential marker or is changed by redaction.
   */
  assetBasenames?: AssetBasenames
}

const NORMALIZED_LOC_RE = /^([A-Za-z0-9_.-]{1,80}\.(?:js|mjs|cjs)):(\d{1,7}):(\d{1,7})$/

function isDigits(s: string): boolean {
  if (s.length === 0 || s.length > MAX_DIGITS) return false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 48 || c > 57) return false
  }
  return true
}

interface SplitLocation { base: string; line: string; col: string }

/**
 * Structure only: an http(s) URL with a path, ending `:line:col` (digits, at most 7 each).
 * Returns the basename after the last `/` of the part before any `?` or `#`; userinfo, host,
 * directories, query and fragment are never copied. Whether the basename may be kept is
 * `keepLocation`'s job.
 */
function splitLocation(loc: string): SplitLocation | null {
  const colIdx = loc.lastIndexOf(':')
  if (colIdx < 0) return null
  const lineIdx = loc.lastIndexOf(':', colIdx - 1)
  if (lineIdx < 0) return null
  const col = loc.slice(colIdx + 1)
  const line = loc.slice(lineIdx + 1, colIdx)
  if (!isDigits(line) || !isDigits(col)) return null
  const url = loc.slice(0, lineIdx)
  let rest: string
  if (url.startsWith('http://')) rest = url.slice(7)
  else if (url.startsWith('https://')) rest = url.slice(8)
  else return null
  const q = rest.search(/[?#]/)
  if (q >= 0) rest = rest.slice(0, q)
  const slash = rest.lastIndexOf('/')
  if (slash < 0) return null // host only, no path
  return { base: rest.slice(slash + 1), line, col }
}

/** `basename:line:col` for one of the caller's own assets, else `<unknown>`. */
function normalizeLocation(loc: string, assets: AssetBasenames | undefined): string {
  const parts = splitLocation(loc)
  return parts ? keepLocation(parts.base, parts.line, parts.col, assets) : UNKNOWN
}

/**
 * The ONE validator for a `basename:line:col` location, used for raw URLs and for stored
 * `name @ loc` output alike: the basename must be a member of the caller's asset set, be
 * bundle-shaped, carry no credential marker (including the hyphenated families, which
 * basenames may contain) and survive redaction unchanged. The word-shape rule is NOT applied
 * here: bundler hashes such as `index-BkL3mZ9x.js` are legitimate, and set membership is the
 * gate.
 */
function keepLocation(base: string, line: string, col: string, assets: AssetBasenames | undefined): string {
  if (!assets || typeof assets.has !== 'function' || !assets.has(base)) return UNKNOWN
  if (!BUNDLE_BASENAME_RE.test(base) || hasCredentialMarker(base, true)) return UNKNOWN
  try {
    if (redactValue(base) !== base) return UNKNOWN
  } catch {
    return UNKNOWN
  }
  return `${base}:${line}:${col}`
}

/** An identifier path, redacted; `<anonymous>` for anything else. */
function normalizeName(raw: string): string {
  let name = raw
  // `new X` and `async X` prefixes are normalised away (at most two, any order).
  for (let i = 0; i < 2; i++) {
    if (name.startsWith('async ')) name = name.slice(6)
    else if (name.startsWith('new ')) name = name.slice(4)
  }
  if (name === REDACTED) return REDACTED
  if (!PATH_RE.test(name)) return ANONYMOUS
  return redactSlot(name)
}

/**
 * Walk the first MAX_STACK_LINES lines of `text` without splitting the whole input.
 * Each line is cut to MAX_LINE_CHARS+1 characters BEFORE the callback sees it.
 */
function forEachLine(text: string, fn: (line: string, truncated: boolean) => boolean | void): void {
  let pos = 0
  for (let n = 0; n < MAX_STACK_LINES && pos <= text.length; n++) {
    let nl = text.indexOf('\n', pos)
    if (nl < 0) nl = text.length
    const end = Math.min(nl, pos + MAX_LINE_CHARS + 1)
    const truncated = nl - pos > MAX_LINE_CHARS
    const line = text.slice(pos, end).replace(/\r$/, '')
    if (fn(line, truncated) === false) return
    pos = nl + 1
  }
}

/** `name @ location` for a line, or null when the line is not a frame. */
function parseFrame(rawLine: string, truncated: boolean, assets: AssetBasenames | undefined): string | null {
  const line = rawLine.trim()
  // 1. Our own output: `name @ basename.js:1:2`, so normalisation is idempotent.
  const sp = line.indexOf(' @ ')
  if (sp > 0 && !truncated) {
    const loc = line.slice(sp + 3)
    const m = loc === UNKNOWN ? null : NORMALIZED_LOC_RE.exec(loc)
    if (loc === UNKNOWN || m) {
      const name = line.slice(0, sp)
      const kept = m ? keepLocation(m[1] ?? '', m[2] ?? '', m[3] ?? '', assets) : UNKNOWN
      return `${name === ANONYMOUS ? ANONYMOUS : normalizeName(name)} @ ${kept}`
    }
  }
  // 2. V8: `at fn (loc)`, `at loc`, `at async fn (loc)`.
  if (line.startsWith('at ')) {
    if (truncated) return `${ANONYMOUS} @ ${UNKNOWN}`
    const rest = line.slice(3)
    let name = ANONYMOUS
    let loc = rest
    if (rest.endsWith(')')) {
      const open = rest.lastIndexOf(' (')
      if (open >= 0) {
        name = normalizeName(rest.slice(0, open))
        loc = rest.slice(open + 2, -1)
      }
    }
    return `${name} @ ${normalizeLocation(loc, assets)}`
  }
  // 3. JSC / SpiderMonkey: `fn@loc`. No whitespace is allowed before the `@`, so a
  // message line such as `Error: a@b` is never mistaken for a frame.
  const at = line.indexOf('@')
  if (at >= 0) {
    let nameOk = true
    for (let i = 0; i < at; i++) {
      const c = line.charCodeAt(i)
      if (c === 32 || c === 9) { nameOk = false; break }
    }
    if (!nameOk) return null
    // A frame only if the part after the `@` is a structurally valid http(s) location with
    // line:col; anything else (`alice@example.com`, `fn@[native code]`, a truncated line) is
    // not a frame and is skipped entirely.
    if (truncated) return null
    const parts = splitLocation(line.slice(at + 1))
    if (!parts) return null
    return `${at === 0 ? ANONYMOUS : normalizeName(line.slice(0, at))} @ ${keepLocation(parts.base, parts.line, parts.col, assets)}`
  }
  return null
}

/**
 * Reduce an `Error.stack` to `name @ basename:line:col` frames. Header and message lines
 * are never included. Never throws.
 */
export function normalizeStack(stack: unknown, opts?: StackOptions): string[] {
  const out: string[] = []
  try {
    if (typeof stack !== 'string') return out
    const max = clampCount(opts?.maxFrames, DEFAULT_MAX_FRAMES)
    forEachLine(stack, (line, truncated) => {
      if (out.length >= max) return false
      const frame = parseFrame(line, truncated, opts?.assetBasenames)
      if (frame !== null) out.push(frame)
      return undefined
    })
  } catch {
    // fall through with whatever was collected: every pushed entry is already validated
  }
  return out
}

function clampCount(v: unknown, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt
  return Math.max(0, Math.min(200, Math.floor(v)))
}

// ---------------------------------------------------------------------------
// Component stack
// ---------------------------------------------------------------------------

/**
 * Reduce a React `componentStack` to component names. Location-only entries and anything
 * that is not identifier-shaped are dropped. Never throws.
 */
export function normalizeComponentStack(stack: unknown, opts?: { maxFrames?: number }): string[] {
  const out: string[] = []
  try {
    if (typeof stack !== 'string') return out
    const max = clampCount(opts?.maxFrames, DEFAULT_MAX_COMPONENTS)
    forEachLine(stack, (rawLine, truncated) => {
      if (out.length >= max) return false
      if (truncated) return undefined
      let rest = rawLine.trim()
      if (rest.startsWith('at ')) rest = rest.slice(3)
      // The name runs to the first space or `@`, and must be the whole entry or be followed by
      // ` (location)` / `@location`.
      let end = 0
      while (end < rest.length && rest.charCodeAt(end) !== 32 && rest.charCodeAt(end) !== 64) end++
      const name = rest.slice(0, end)
      const tail = rest.slice(end)
      const tailOk = tail === '' || tail.startsWith('@') || tail.startsWith(' (')
      if (!tailOk || !(PATH_RE.test(name) || name === REDACTED)) return undefined
      out.push(name === REDACTED ? REDACTED : redactSlot(name))
      return undefined
    })
  } catch {
    // keep what was validated
  }
  return out
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ErrorReportEntry {
  /** Epoch milliseconds or an ISO-8601 UTC string. */
  time: number | string
  version: string
  platform: string
  category: string
  count: number
  name: string
  /** The classified (or raw — it is re-validated) message. */
  message: string
  stack: string[] | string
  componentStack: string[] | string
}

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const PLATFORMS: ReadonlySet<string> = new Set(['tauri', 'web'])
const CATEGORIES: ReadonlySet<string> = new Set(['render', 'window-error', 'unhandled-rejection'])

function safeEnum(v: unknown, allowed: ReadonlySet<string>): string {
  return typeof v === 'string' && allowed.has(v) ? v : 'unknown'
}

function safeVersion(v: unknown): string {
  return typeof v === 'string' && VERSION_RE.test(v) ? v : 'unknown'
}

function safeTime(v: unknown): string {
  let ms: number
  if (typeof v === 'number' && Number.isFinite(v)) ms = v
  else if (typeof v === 'string' && v.length <= 24 && ISO_RE.test(v)) {
    ms = Date.parse(v)
    // Round-trip through Date: a calendar-invalid date (2026-99-99T99:99:99Z, Feb 30) never reaches the report.
    const want = v.includes('.') ? v : v.replace('Z', '.000Z')
    if (Number.isNaN(ms) || new Date(ms).toISOString() !== want) return 'unknown'
  } else return 'unknown'
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString()
}

function safeCount(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1
  return Math.max(1, Math.min(9_999_999, Math.floor(v)))
}

/** Join a stored array of lines (bounded) back into text for the normalisers. */
function toLines(v: unknown): string {
  if (typeof v === 'string') return v
  if (!Array.isArray(v)) return ''
  const parts: string[] = []
  for (let i = 0; i < v.length && i < MAX_STACK_LINES; i++) {
    const item: unknown = v[i]
    if (typeof item === 'string') parts.push(item.length > MAX_LINE_CHARS + 1 ? item.slice(0, MAX_LINE_CHARS + 1) : item)
  }
  return parts.join('\n')
}

/**
 * Render the plain-text Copy report. Every field is re-validated here, so a poisoned
 * stored entry cannot reach the clipboard raw.
 */
export function formatErrorReport(entry: ErrorReportEntry, opts?: { assetBasenames?: AssetBasenames }): string {
  try {
    const e: Partial<Record<keyof ErrorReportEntry, unknown>> = entry && typeof entry === 'object' ? entry : {}
    const cls = classifyErrorMessage(e.name, e.message)
    const frames = normalizeStack(toLines(e.stack), { assetBasenames: opts?.assetBasenames })
    const comps = normalizeComponentStack(toLines(e.componentStack))
    const lines = [
      'Chroxy dashboard error report',
      `Time: ${safeTime(e.time)}`,
      `Version: ${safeVersion(e.version)}`,
      `Platform: ${safeEnum(e.platform, PLATFORMS)}`,
      `Category: ${safeEnum(e.category, CATEGORIES)}`,
      `Count: ${safeCount(e.count)}`,
      `Error: ${cls.name}`,
      `Message: ${cls.text}`,
    ]
    if (cls.template) lines.push(`Template: ${cls.template}`)
    lines.push('Stack:')
    if (frames.length === 0) lines.push('  (none)')
    for (const f of frames) lines.push(`  ${f}`)
    if (comps.length > 0) {
      lines.push('Component stack:')
      for (const c of comps) lines.push(`  ${c}`)
    }
    return lines.join('\n')
  } catch {
    return 'Chroxy dashboard error report\nMessage: [message omitted]'
  }
}
