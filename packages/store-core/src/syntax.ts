/**
 * Shared syntax highlighting tokenizer.
 *
 * Supports 15+ languages with regex-based tokenization using sticky patterns.
 * Used by both the mobile app and the web dashboard.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Token types produced by the syntax tokenizer. */
export type TokenType =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  | 'operator'
  | 'punctuation'
  | 'type'
  | 'property'
  | 'plain'
  | 'diff_add'
  | 'diff_remove'

/** A single token with text and type. */
export interface Token {
  text: string
  type: TokenType
}

/** A single syntax rule: a sticky regex pattern and the token type it produces. */
export interface SyntaxRule {
  pattern: RegExp
  type: TokenType
}

/** Language definition: ordered array of rules (first match wins). */
export type LanguageDef = SyntaxRule[]

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/** Maps each token type to its display color. */
export const SYNTAX_COLORS: Record<TokenType, string> = {
  keyword: '#c4a5ff',
  string: '#4eca6a',
  comment: '#7a7a7a',
  number: '#ff9a52',
  function: '#4a9eff',
  operator: '#e0e0e0',
  punctuation: '#888888',
  type: '#4a9eff',
  property: '#4eca6a',
  plain: '#a0d0ff',
  diff_add: '#4eca6a',
  diff_remove: '#ff5b5b',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a sticky regex from a non-sticky source pattern, preserving all original flags. */
function s(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes('y') ? pattern.flags : pattern.flags + 'y'
  return new RegExp(pattern.source, flags)
}

// ---------------------------------------------------------------------------
// Language definitions
// ---------------------------------------------------------------------------

const javascript: LanguageDef = [
  { pattern: s(/\/\/[^\n]*/), type: 'comment' },
  { pattern: s(/\/\*[\s\S]*?\*\//), type: 'comment' },
  { pattern: s(/(["'`])(?:(?!\1|\\).|\\.)*\1/), type: 'string' },
  { pattern: s(/\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|of|package|private|protected|public|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield)\b/), type: 'keyword' },
  { pattern: s(/\b(?:true|false|null|undefined|NaN|Infinity)\b/), type: 'keyword' },
  { pattern: s(/\b(?:Array|Boolean|Date|Error|Function|JSON|Map|Math|Number|Object|Promise|Proxy|RegExp|Set|String|Symbol|WeakMap|WeakSet|console|window|document|global|globalThis|process)\b/), type: 'type' },
  { pattern: s(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/), type: 'number' },
  { pattern: s(/\b0[oO][0-7][0-7_]*\b/), type: 'number' },
  { pattern: s(/\b0[bB][01][01_]*\b/), type: 'number' },
  { pattern: s(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?\b/), type: 'number' },
  { pattern: s(/[a-zA-Z_$][\w$]*(?=\s*\()/), type: 'function' },
  { pattern: s(/=>|[+\-*/%=!<>&|^~?:]+/), type: 'operator' },
  { pattern: s(/[{}()\[\];,.]/), type: 'punctuation' },
]

const typescript: LanguageDef = [
  { pattern: s(/\/\/[^\n]*/), type: 'comment' },
  { pattern: s(/\/\*[\s\S]*?\*\//), type: 'comment' },
  { pattern: s(/(["'`])(?:(?!\1|\\).|\\.)*\1/), type: 'string' },
  { pattern: s(/\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|is|keyof|let|module|namespace|never|new|of|override|package|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|try|type|typeof|var|void|while|with|yield)\b/), type: 'keyword' },
  { pattern: s(/\b(?:true|false|null|undefined|NaN|Infinity)\b/), type: 'keyword' },
  { pattern: s(/\b(?:any|bigint|boolean|number|object|string|symbol|unknown|void|never)\b/), type: 'type' },
  { pattern: s(/\b(?:Array|Boolean|Date|Error|Function|JSON|Map|Math|Number|Object|Promise|Proxy|Record|Partial|Required|Readonly|Pick|Omit|Exclude|Extract|NonNullable|ReturnType|Parameters|RegExp|Set|String|Symbol|WeakMap|WeakSet|console)\b/), type: 'type' },
  { pattern: s(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/), type: 'number' },
  { pattern: s(/\b0[oO][0-7][0-7_]*\b/), type: 'number' },
  { pattern: s(/\b0[bB][01][01_]*\b/), type: 'number' },
  { pattern: s(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?\b/), type: 'number' },
  { pattern: s(/[a-zA-Z_$][\w$]*(?=\s*[<(])/), type: 'function' },
  { pattern: s(/=>|[+\-*/%=!<>&|^~?:]+/), type: 'operator' },
  { pattern: s(/[{}()\[\];,.]/), type: 'punctuation' },
]

const python: LanguageDef = [
  { pattern: s(/#[^\n]*/), type: 'comment' },
  { pattern: s(/"""[\s\S]*?"""/), type: 'string' },
  { pattern: s(/'''[\s\S]*?'''/), type: 'string' },
  { pattern: s(/[fFrRbBuU]?(["'])(?:(?!\1|\\).|\\.)*\1/), type: 'string' },
  { pattern: s(/\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/), type: 'keyword' },
  { pattern: s(/\b(?:True|False|None)\b/), type: 'keyword' },
  { pattern: s(/\b(?:int|float|str|bool|list|dict|tuple|set|frozenset|bytes|bytearray|type|object|range|complex|memoryview|Exception|TypeError|ValueError|KeyError|IndexError|AttributeError|RuntimeError|StopIteration)\b/), type: 'type' },
  { pattern: s(/\b(?:print|len|range|enumerate|zip|map|filter|sorted|reversed|isinstance|issubclass|hasattr|getattr|setattr|super|property|staticmethod|classmethod|open|input)\b(?=\s*\()/), type: 'function' },
  { pattern: s(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/), type: 'number' },
  { pattern: s(/\b0[oO][0-7][0-7_]*\b/), type: 'number' },
  { pattern: s(/\b0[bB][01][01_]*\b/), type: 'number' },
  { pattern: s(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?\b/), type: 'number' },
  { pattern: s(/[a-zA-Z_]\w*(?=\s*\()/), type: 'function' },
  { pattern: s(/[-+*/%=!<>&|^~@:]+/), type: 'operator' },
  { pattern: s(/[{}()\[\];,.]/), type: 'punctuation' },
]

const bash: LanguageDef = [
  { pattern: s(/#[^\n]*/), type: 'comment' },
  { pattern: s(/(["'])(?:(?!\1|\\).|\\.)*\1/), type: 'string' },
  { pattern: s(/\$\{[^}]*\}/), type: 'string' },
  { pattern: s(/\$[a-zA-Z_]\w*/), type: 'string' },
  { pattern: s(/\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|local|export|source|alias|unalias|declare|typeset|readonly|shift|break|continue|exit|eval|exec|trap|set|unset)\b/), type: 'keyword' },
  { pattern: s(/\b(?:echo|printf|cd|ls|cat|grep|sed|awk|find|xargs|sort|uniq|wc|head|tail|cut|tr|tee|mkdir|rmdir|rm|cp|mv|ln|chmod|chown|chgrp|touch|test|read|write|kill|ps|bg|fg|jobs|wait|nohup|true|false)\b/), type: 'function' },
  { pattern: s(/\b\d+\b/), type: 'number' },
  { pattern: s(/[|&;><!=]+/), type: 'operator' },
  { pattern: s(/[{}()\[\]]/), type: 'punctuation' },
]

const json: LanguageDef = [
  { pattern: s(/"(?:[^"\\]|\\.)*"\s*(?=:)/), type: 'property' },
  { pattern: s(/"(?:[^"\\]|\\.)*"/), type: 'string' },
  { pattern: s(/\b(?:true|false|null)\b/), type: 'keyword' },
  { pattern: s(/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/), type: 'number' },
  { pattern: s(/:/), type: 'operator' },
  { pattern: s(/[{}()\[\],]/), type: 'punctuation' },
]

const diff: LanguageDef = [
  { pattern: s(/^\+\+\+[^\n]*/m), type: 'keyword' },
  { pattern: s(/^---[^\n]*/m), type: 'keyword' },
  { pattern: s(/^@@[^\n]*@@[^\n]*/m), type: 'keyword' },
  { pattern: s(/^\+[^\n]*/m), type: 'diff_add' },
  { pattern: s(/^-[^\n]*/m), type: 'diff_remove' },
]

const html: LanguageDef = [
  { pattern: s(/<!--[\s\S]*?-->/), type: 'comment' },
  { pattern: s(/(["'])(?:(?!\1|\\).|\\.)*\1/), type: 'string' },
  { pattern: s(/<\/?[a-zA-Z][\w-]*/), type: 'keyword' },
  { pattern: s(/\/?>/), type: 'keyword' },
  { pattern: s(/[a-zA-Z][\w-]*(?=\s*=)/), type: 'property' },
  { pattern: s(/[=]/), type: 'operator' },
]

const css: LanguageDef = [
  { pattern: s(/\/\*[\s\S]*?\*\//), type: 'comment' },
  { pattern: s(/(["'])(?:(?!\1|\\).|\\.)*\1/), type: 'string' },
  { pattern: s(/@[a-zA-Z][\w-]*/), type: 'keyword' },
  { pattern: s(/\b(?:important|inherit|initial|unset|revert)\b/), type: 'keyword' },
  { pattern: s(/#[0-9a-fA-F]{3,8}\b/), type: 'number' },
  { pattern: s(/\b\d[\d_]*(?:\.[\d_]*)?(?:px|em|rem|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc|deg|rad|grad|turn|s|ms|Hz|kHz|fr)?\b/), type: 'number' },
  { pattern: s(/[a-zA-Z][\w-]*(?=\s*\()/), type: 'function' },
  { pattern: s(/[a-zA-Z-]+(?=\s*:)/), type: 'property' },
  { pattern: s(/[.#][a-zA-Z][\w-]*/), type: 'type' },
  { pattern: s(/[:;{}(),>+~*=]/), type: 'punctuation' },
]

const yaml: LanguageDef = [
  { pattern: s(/#[^\n]*/), type: 'comment' },
  { pattern: s(/(["'])(?:(?!\1|\\).|\\.)*\1/), type: 'string' },
  { pattern: s(/[a-zA-Z_][\w.-]*(?=\s*:)/), type: 'property' },
  { pattern: s(/\b(?:true|false|null|yes|no|on|off)\b/i), type: 'keyword' },
  { pattern: s(/\b\d[\d_]*(?:\.[\d_]*)?\b/), type: 'number' },
  { pattern: s(/[:\-|>]/), type: 'operator' },
]

const go: LanguageDef = [
  { pattern: s(/\/\/[^\n]*/), type: 'comment' },
  { pattern: s(/\/\*[\s\S]*?\*\//), type: 'comment' },
  { pattern: s(/(["'`])(?:(?!\1|\\).|\\.)*\1/), type: 'string' },
  { pattern: s(/\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/), type: 'keyword' },
  { pattern: s(/\b(?:true|false|nil|iota)\b/), type: 'keyword' },
  { pattern: s(/\b(?:bool|byte|complex64|complex128|error|float32|float64|int|int8|int16|int32|int64|rune|string|uint|uint8|uint16|uint32|uint64|uintptr)\b/), type: 'type' },
  { pattern: s(/\b(?:append|cap|close|copy|delete|len|make|new|panic|print|println|recover)\b(?=\s*\()/), type: 'function' },
  { pattern: s(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/), type: 'number' },
  { pattern: s(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?\b/), type: 'number' },
  { pattern: s(/[a-zA-Z_]\w*(?=\s*\()/), type: 'function' },
  { pattern: s(/:=|[+\-*/%=!<>&|^~]+/), type: 'operator' },
  { pattern: s(/[{}()\[\];,.]/), type: 'punctuation' },
]

const rust: LanguageDef = [
  { pattern: s(/\/\/[^\n]*/), type: 'comment' },
  { pattern: s(/\/\*[\s\S]*?\*\//), type: 'comment' },
  { pattern: s(/(["'])(?:(?!\1|\\).|\\.)*\1/), type: 'string' },
  { pattern: s(/\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|type|unsafe|use|where|while|yield)\b/), type: 'keyword' },
  { pattern: s(/\b(?:true|false)\b/), type: 'keyword' },
  { pattern: s(/\b(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|bool|char|str|String|Vec|Option|Result|Box|Rc|Arc|Cell|RefCell|HashMap|HashSet|BTreeMap|BTreeSet)\b/), type: 'type' },
  { pattern: s(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/), type: 'number' },
  { pattern: s(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?\b/), type: 'number' },
  { pattern: s(/[a-zA-Z_]\w*(?=\s*[!(<])/), type: 'function' },
  { pattern: s(/=>|->|[+\-*/%=!<>&|^~?:]+/), type: 'operator' },
  { pattern: s(/[{}()\[\];,.#]/), type: 'punctuation' },
]

const java: LanguageDef = [
  { pattern: s(/\/\/[^\n]*/), type: 'comment' },
  { pattern: s(/\/\*[\s\S]*?\*\//), type: 'comment' },
  { pattern: s(/(["'])(?:(?!\1|\\).|\\.)*\1/), type: 'string' },
  { pattern: s(/\b(?:abstract|assert|break|case|catch|class|const|continue|default|do|else|enum|extends|final|finally|for|goto|if|implements|import|instanceof|interface|native|new|package|private|protected|public|return|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while)\b/), type: 'keyword' },
  { pattern: s(/\b(?:true|false|null)\b/), type: 'keyword' },
  { pattern: s(/\b(?:boolean|byte|char|double|float|int|long|short|var|String|Integer|Long|Double|Float|Boolean|Character|Object|Class|System|List|Map|Set|ArrayList|HashMap|HashSet|Optional|Stream)\b/), type: 'type' },
  { pattern: s(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*[lL]?\b/), type: 'number' },
  { pattern: s(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?[lLfFdD]?\b/), type: 'number' },
  { pattern: s(/[a-zA-Z_]\w*(?=\s*\()/), type: 'function' },
  { pattern: s(/[+\-*/%=!<>&|^~?:]+/), type: 'operator' },
  { pattern: s(/[{}()\[\];,.@]/), type: 'punctuation' },
]

const ruby: LanguageDef = [
  { pattern: s(/#[^\n]*/), type: 'comment' },
  { pattern: s(/(["'])(?:(?!\1|\\).|\\.)*\1/), type: 'string' },
  { pattern: s(/\bdefined\?/), type: 'keyword' },
  { pattern: s(/\b(?:alias|and|begin|break|case|class|def|do|else|elsif|end|ensure|for|if|in|module|next|nil|not|or|redo|require|rescue|retry|return|self|super|then|undef|unless|until|when|while|yield)\b/), type: 'keyword' },
  { pattern: s(/\b(?:true|false|nil)\b/), type: 'keyword' },
  { pattern: s(/:[a-zA-Z_]\w*/), type: 'string' },
  { pattern: s(/\b\d[\d_]*(?:\.[\d_]*)?\b/), type: 'number' },
  { pattern: s(/[a-zA-Z_]\w*(?=\s*[({])/), type: 'function' },
  { pattern: s(/[+\-*/%=!<>&|^~?:]+/), type: 'operator' },
  { pattern: s(/[{}()\[\];,.@]/), type: 'punctuation' },
]

const c: LanguageDef = [
  { pattern: s(/\/\/[^\n]*/), type: 'comment' },
  { pattern: s(/\/\*[\s\S]*?\*\//), type: 'comment' },
  { pattern: s(/(["'])(?:(?!\1|\\).|\\.)*\1/), type: 'string' },
  { pattern: s(/#\s*(?:include|define|ifdef|ifndef|endif|if|else|elif|undef|pragma|error|warning)[^\n]*/), type: 'keyword' },
  { pattern: s(/\b(?:auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while|_Bool|_Complex|_Imaginary)\b/), type: 'keyword' },
  { pattern: s(/\b(?:NULL|true|false)\b/), type: 'keyword' },
  { pattern: s(/\b(?:size_t|ptrdiff_t|int8_t|int16_t|int32_t|int64_t|uint8_t|uint16_t|uint32_t|uint64_t|FILE|bool)\b/), type: 'type' },
  { pattern: s(/\b0[xX][0-9a-fA-F][0-9a-fA-F]*[uUlL]*\b/), type: 'number' },
  { pattern: s(/\b\d[\d]*(?:\.[\d]*)?(?:[eE][+-]?\d+)?[uUlLfF]*\b/), type: 'number' },
  { pattern: s(/[a-zA-Z_]\w*(?=\s*\()/), type: 'function' },
  { pattern: s(/->|[+\-*/%=!<>&|^~?:]+/), type: 'operator' },
  { pattern: s(/[{}()\[\];,.]/), type: 'punctuation' },
]

const sql: LanguageDef = [
  { pattern: s(/--[^\n]*/), type: 'comment' },
  { pattern: s(/\/\*[\s\S]*?\*\//), type: 'comment' },
  { pattern: s(/'(?:[^'\\]|\\.)*'/), type: 'string' },
  { pattern: s(/\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|DATABASE|SCHEMA|JOIN|INNER|LEFT|RIGHT|OUTER|CROSS|ON|AND|OR|NOT|IN|IS|NULL|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|CASE|WHEN|THEN|ELSE|END|EXISTS|BETWEEN|LIKE|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|CHECK|DEFAULT|CONSTRAINT|BEGIN|COMMIT|ROLLBACK|TRANSACTION|GRANT|REVOKE|WITH|RECURSIVE|RETURNING|CONFLICT|REPLACE|EXPLAIN|ANALYZE|VACUUM|PRAGMA|IF|TRIGGER|FUNCTION|PROCEDURE|DECLARE|CURSOR|FETCH|CLOSE|OPEN|ASC|DESC)\b/i), type: 'keyword' },
  { pattern: s(/\b(?:INT|INTEGER|BIGINT|SMALLINT|TINYINT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|CHAR|VARCHAR|TEXT|BLOB|BOOLEAN|BOOL|DATE|TIME|TIMESTAMP|DATETIME|SERIAL|UUID|JSON|JSONB|ARRAY|BYTEA)\b/i), type: 'type' },
  { pattern: s(/\b(?:COUNT|SUM|AVG|MIN|MAX|COALESCE|NULLIF|CAST|CONVERT|TRIM|UPPER|LOWER|LENGTH|SUBSTR|SUBSTRING|REPLACE|CONCAT|NOW|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|ROW_NUMBER|RANK|DENSE_RANK|LAG|LEAD|FIRST_VALUE|LAST_VALUE|OVER|PARTITION)\b(?=\s*\()/i), type: 'function' },
  { pattern: s(/\b\d+(?:\.\d+)?\b/), type: 'number' },
  { pattern: s(/[=<>!]+|[+\-*/%]/), type: 'operator' },
  { pattern: s(/[();,.]/), type: 'punctuation' },
]

// ---------------------------------------------------------------------------
// Language registry
// ---------------------------------------------------------------------------

const LANGUAGES: Record<string, LanguageDef> = {
  javascript,
  typescript,
  jsx: javascript,
  tsx: typescript,
  python,
  bash,
  json,
  diff,
  html,
  xml: html,
  css,
  yaml,
  go,
  rust,
  java,
  ruby,
  c,
  cpp: c,
  sql,
}

/** Aliases map short names to canonical names.
 *  Some aliases map to a different language family for approximate highlighting
 *  (e.g., kt/kotlin/scala → java, swift → c). These get reasonable keyword and
 *  structure coloring but miss language-specific syntax. */
const ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  htm: 'html',
  rb: 'ruby',
  rs: 'rust',
  'c++': 'cpp',
  'objective-c': 'c',
  objc: 'c',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  patch: 'diff',
  mysql: 'sql',
  postgresql: 'sql',
  postgres: 'sql',
  sqlite: 'sql',
  plsql: 'sql',
  kt: 'java',
  kotlin: 'java',
  scala: 'java',
  groovy: 'java',
  cs: 'java',
  csharp: 'java',
  swift: 'c',
  jsonc: 'json',
  json5: 'json',
  toml: 'yaml',
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Maximum code length to tokenize. Longer code falls back to a single plain token. */
const MAX_CODE_LENGTH = 5000

/** Look up the language definition for a given language identifier. Returns undefined if unknown. */
export function getLanguage(lang: string): LanguageDef | undefined {
  const key = lang.toLowerCase()
  return LANGUAGES[key] ?? LANGUAGES[ALIASES[key] ?? '']
}

/**
 * Returns the syntax rules for a given language identifier, or null if unknown.
 * Alias for getLanguage that returns null instead of undefined for convenience.
 */
export function getSyntaxRules(lang: string): LanguageDef | null {
  if (!lang) return null
  return getLanguage(lang) ?? null
}

/** Append a token, merging with the previous if the same type. */
function pushToken(tokens: Token[], text: string, type: TokenType): void {
  const last = tokens[tokens.length - 1]
  if (last && last.type === type) {
    last.text += text
  } else {
    tokens.push({ text, type })
  }
}

/**
 * Tokenize source code into an array of typed tokens.
 *
 * Uses an ordered "first match wins" regex scanner. At each position, rules
 * are tried in order using sticky regexes. Unmatched characters accumulate
 * as `plain` tokens.
 *
 * Returns a single `plain` token if:
 * - The language is unknown
 * - The code exceeds MAX_CODE_LENGTH
 */
export function tokenize(code: string, lang: string): Token[] {
  if (!lang || code.length > MAX_CODE_LENGTH) {
    return [{ text: code, type: 'plain' }]
  }

  const rules = getLanguage(lang)
  if (!rules) {
    return [{ text: code, type: 'plain' }]
  }

  const tokens: Token[] = []
  let pos = 0
  let plainStart = 0

  while (pos < code.length) {
    let matched = false

    for (const rule of rules) {
      rule.pattern.lastIndex = pos
      const m = rule.pattern.exec(code)
      if (m) {
        if (pos > plainStart) pushToken(tokens, code.slice(plainStart, pos), 'plain')
        pushToken(tokens, m[0], rule.type)
        pos += m[0].length
        plainStart = pos
        matched = true
        break
      }
    }

    if (!matched) pos++
  }

  if (pos > plainStart) pushToken(tokens, code.slice(plainStart, pos), 'plain')
  return tokens
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Tokenize source code and return an HTML string with color spans.
 * Intended for web/dashboard use where HTML output is needed.
 */
export function highlightCode(code: string, lang: string): string {
  const tokens = tokenize(code, lang)
  let out = ''
  for (const token of tokens) {
    const color = SYNTAX_COLORS[token.type] ?? SYNTAX_COLORS.plain
    out += `<span style="color:${color}">${escapeHtml(token.text)}</span>`
  }
  return out
}
