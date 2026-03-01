/**
 * Syntax highlighting tokenizer.
 *
 * Ported from dashboard-app.js. Supports 15+ languages with
 * regex-based tokenization using sticky patterns.
 */

export interface Token {
  text: string
  type: string
}

interface Rule {
  p: RegExp
  t: string
}

const SYNTAX_COLORS: Record<string, string> = {
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

function stickyRe(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes('y') ? pattern.flags : pattern.flags + 'y'
  return new RegExp(pattern.source, flags)
}

// ---------------------------------------------------------------------------
// Language definitions
// ---------------------------------------------------------------------------

const LANG_JS: Rule[] = [
  { p: stickyRe(/\/\/[^\n]*/), t: 'comment' },
  { p: stickyRe(/\/\*[\s\S]*?\*\//), t: 'comment' },
  { p: stickyRe(/(["'`])(?:(?!\1|\\).|\\.)*.?\1/), t: 'string' },
  { p: stickyRe(/\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|of|package|private|protected|public|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:true|false|null|undefined|NaN|Infinity)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:Array|Boolean|Date|Error|Function|JSON|Map|Math|Number|Object|Promise|Proxy|RegExp|Set|String|Symbol|WeakMap|WeakSet|console|window|document|global|globalThis|process)\b/), t: 'type' },
  { p: stickyRe(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/), t: 'number' },
  { p: stickyRe(/\b0[oO][0-7][0-7_]*\b/), t: 'number' },
  { p: stickyRe(/\b0[bB][01][01_]*\b/), t: 'number' },
  { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?\b/), t: 'number' },
  { p: stickyRe(/[a-zA-Z_$][\w$]*(?=\s*\()/), t: 'function' },
  { p: stickyRe(/=>|[+\-*/%=!<>&|^~?:]+/), t: 'operator' },
  { p: stickyRe(/[{}()\[\];,.]/), t: 'punctuation' },
]

const LANG_TS: Rule[] = [
  { p: stickyRe(/\/\/[^\n]*/), t: 'comment' },
  { p: stickyRe(/\/\*[\s\S]*?\*\//), t: 'comment' },
  { p: stickyRe(/(["'`])(?:(?!\1|\\).|\\.)*.?\1/), t: 'string' },
  { p: stickyRe(/\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|is|keyof|let|module|namespace|never|new|of|override|package|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|try|type|typeof|var|void|while|with|yield)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:true|false|null|undefined|NaN|Infinity)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:any|bigint|boolean|number|object|string|symbol|unknown|void|never)\b/), t: 'type' },
  { p: stickyRe(/\b(?:Array|Boolean|Date|Error|Function|JSON|Map|Math|Number|Object|Promise|Proxy|Record|Partial|Required|Readonly|Pick|Omit|Exclude|Extract|NonNullable|ReturnType|Parameters|RegExp|Set|String|Symbol|WeakMap|WeakSet|console)\b/), t: 'type' },
  { p: stickyRe(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/), t: 'number' },
  { p: stickyRe(/\b0[oO][0-7][0-7_]*\b/), t: 'number' },
  { p: stickyRe(/\b0[bB][01][01_]*\b/), t: 'number' },
  { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?\b/), t: 'number' },
  { p: stickyRe(/[a-zA-Z_$][\w$]*(?=\s*[<(])/), t: 'function' },
  { p: stickyRe(/=>|[+\-*/%=!<>&|^~?:]+/), t: 'operator' },
  { p: stickyRe(/[{}()\[\];,.]/), t: 'punctuation' },
]

const LANG_PY: Rule[] = [
  { p: stickyRe(/#[^\n]*/), t: 'comment' },
  { p: stickyRe(/"""[\s\S]*?"""/), t: 'string' },
  { p: stickyRe(/'''[\s\S]*?'''/), t: 'string' },
  { p: stickyRe(/[fFrRbBuU]?(["'])(?:(?!\1|\\).|\\.)*\1/), t: 'string' },
  { p: stickyRe(/\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:True|False|None)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:int|float|str|bool|list|dict|tuple|set|frozenset|bytes|bytearray|type|object|range|complex|memoryview|Exception|TypeError|ValueError|KeyError|IndexError|AttributeError|RuntimeError|StopIteration)\b/), t: 'type' },
  { p: stickyRe(/\b(?:print|len|range|enumerate|zip|map|filter|sorted|reversed|isinstance|issubclass|hasattr|getattr|setattr|super|property|staticmethod|classmethod|open|input)\b(?=\s*\()/), t: 'function' },
  { p: stickyRe(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/), t: 'number' },
  { p: stickyRe(/\b0[oO][0-7][0-7_]*\b/), t: 'number' },
  { p: stickyRe(/\b0[bB][01][01_]*\b/), t: 'number' },
  { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?\b/), t: 'number' },
  { p: stickyRe(/[a-zA-Z_]\w*(?=\s*\()/), t: 'function' },
  { p: stickyRe(/[-+*/%=!<>&|^~@:]+/), t: 'operator' },
  { p: stickyRe(/[{}()\[\];,.]/), t: 'punctuation' },
]

const LANG_BASH: Rule[] = [
  { p: stickyRe(/#[^\n]*/), t: 'comment' },
  { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: 'string' },
  { p: stickyRe(/\$\{[^}]*\}/), t: 'string' },
  { p: stickyRe(/\$[a-zA-Z_]\w*/), t: 'string' },
  { p: stickyRe(/\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|local|export|source|alias|unalias|declare|typeset|readonly|shift|break|continue|exit|eval|exec|trap|set|unset)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:echo|printf|cd|ls|cat|grep|sed|awk|find|xargs|sort|uniq|wc|head|tail|cut|tr|tee|mkdir|rmdir|rm|cp|mv|ln|chmod|chown|chgrp|touch|test|read|write|kill|ps|bg|fg|jobs|wait|nohup|true|false)\b/), t: 'function' },
  { p: stickyRe(/\b\d+\b/), t: 'number' },
  { p: stickyRe(/[|&;><!=]+/), t: 'operator' },
  { p: stickyRe(/[{}()\[\]]/), t: 'punctuation' },
]

const LANG_JSON: Rule[] = [
  { p: stickyRe(/"(?:[^"\\]|\\.)*"\s*(?=:)/), t: 'property' },
  { p: stickyRe(/"(?:[^"\\]|\\.)*"/), t: 'string' },
  { p: stickyRe(/\b(?:true|false|null)\b/), t: 'keyword' },
  { p: stickyRe(/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/), t: 'number' },
  { p: stickyRe(/:/), t: 'operator' },
  { p: stickyRe(/[{}()\[\],]/), t: 'punctuation' },
]

const LANG_DIFF: Rule[] = [
  { p: stickyRe(/^\+\+\+[^\n]*/m), t: 'keyword' },
  { p: stickyRe(/^---[^\n]*/m), t: 'keyword' },
  { p: stickyRe(/^@@[^\n]*@@[^\n]*/m), t: 'keyword' },
  { p: stickyRe(/^\+[^\n]*/m), t: 'diff_add' },
  { p: stickyRe(/^-[^\n]*/m), t: 'diff_remove' },
]

const LANG_HTML: Rule[] = [
  { p: stickyRe(/<!--[\s\S]*?-->/), t: 'comment' },
  { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: 'string' },
  { p: stickyRe(/<\/?[a-zA-Z][\w-]*/), t: 'keyword' },
  { p: stickyRe(/\/?>/), t: 'keyword' },
  { p: stickyRe(/[a-zA-Z][\w-]*(?=\s*=)/), t: 'property' },
  { p: stickyRe(/[=]/), t: 'operator' },
]

const LANG_CSS: Rule[] = [
  { p: stickyRe(/\/\*[\s\S]*?\*\//), t: 'comment' },
  { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: 'string' },
  { p: stickyRe(/@[a-zA-Z][\w-]*/), t: 'keyword' },
  { p: stickyRe(/\b(?:important|inherit|initial|unset|revert)\b/), t: 'keyword' },
  { p: stickyRe(/#[0-9a-fA-F]{3,8}\b/), t: 'number' },
  { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?(?:px|em|rem|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc|deg|rad|s|ms|Hz|kHz|fr)?\b/), t: 'number' },
  { p: stickyRe(/[a-zA-Z][\w-]*(?=\s*\()/), t: 'function' },
  { p: stickyRe(/[a-zA-Z-]+(?=\s*:)/), t: 'property' },
  { p: stickyRe(/[.#][a-zA-Z][\w-]*/), t: 'type' },
  { p: stickyRe(/[:;{}(),>+~*=]/), t: 'punctuation' },
]

const LANG_YAML: Rule[] = [
  { p: stickyRe(/#[^\n]*/), t: 'comment' },
  { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: 'string' },
  { p: stickyRe(/[a-zA-Z_][\w.-]*(?=\s*:)/), t: 'property' },
  { p: stickyRe(/\b(?:true|false|null|yes|no|on|off)\b/i), t: 'keyword' },
  { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?\b/), t: 'number' },
  { p: stickyRe(/[:\-|>]/), t: 'operator' },
]

const LANG_GO: Rule[] = [
  { p: stickyRe(/\/\/[^\n]*/), t: 'comment' },
  { p: stickyRe(/\/\*[\s\S]*?\*\//), t: 'comment' },
  { p: stickyRe(/(["'`])(?:(?!\1|\\).|\\.)*.?\1/), t: 'string' },
  { p: stickyRe(/\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:true|false|nil|iota)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:bool|byte|complex64|complex128|error|float32|float64|int|int8|int16|int32|int64|rune|string|uint|uint8|uint16|uint32|uint64|uintptr)\b/), t: 'type' },
  { p: stickyRe(/\b(?:append|cap|close|copy|delete|len|make|new|panic|print|println|recover)\b(?=\s*\()/), t: 'function' },
  { p: stickyRe(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/), t: 'number' },
  { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?\b/), t: 'number' },
  { p: stickyRe(/[a-zA-Z_]\w*(?=\s*\()/), t: 'function' },
  { p: stickyRe(/:=|[+\-*/%=!<>&|^~]+/), t: 'operator' },
  { p: stickyRe(/[{}()\[\];,.]/), t: 'punctuation' },
]

const LANG_RUST: Rule[] = [
  { p: stickyRe(/\/\/[^\n]*/), t: 'comment' },
  { p: stickyRe(/\/\*[\s\S]*?\*\//), t: 'comment' },
  { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: 'string' },
  { p: stickyRe(/\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|type|unsafe|use|where|while|yield)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:true|false)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|bool|char|str|String|Vec|Option|Result|Box|Rc|Arc|Cell|RefCell|HashMap|HashSet|BTreeMap|BTreeSet)\b/), t: 'type' },
  { p: stickyRe(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/), t: 'number' },
  { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?\b/), t: 'number' },
  { p: stickyRe(/[a-zA-Z_]\w*(?=\s*[!(<])/), t: 'function' },
  { p: stickyRe(/=>|->|[+\-*/%=!<>&|^~?:]+/), t: 'operator' },
  { p: stickyRe(/[{}()\[\];,.#]/), t: 'punctuation' },
]

const LANG_JAVA: Rule[] = [
  { p: stickyRe(/\/\/[^\n]*/), t: 'comment' },
  { p: stickyRe(/\/\*[\s\S]*?\*\//), t: 'comment' },
  { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: 'string' },
  { p: stickyRe(/\b(?:abstract|assert|break|case|catch|class|const|continue|default|do|else|enum|extends|final|finally|for|goto|if|implements|import|instanceof|interface|native|new|package|private|protected|public|return|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:true|false|null)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:boolean|byte|char|double|float|int|long|short|var|String|Integer|Long|Double|Float|Boolean|Character|Object|Class|System|List|Map|Set|ArrayList|HashMap|HashSet|Optional|Stream)\b/), t: 'type' },
  { p: stickyRe(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*[lL]?\b/), t: 'number' },
  { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?[lLfFdD]?\b/), t: 'number' },
  { p: stickyRe(/[a-zA-Z_]\w*(?=\s*\()/), t: 'function' },
  { p: stickyRe(/[+\-*/%=!<>&|^~?:]+/), t: 'operator' },
  { p: stickyRe(/[{}()\[\];,.@]/), t: 'punctuation' },
]

const LANG_RUBY: Rule[] = [
  { p: stickyRe(/#[^\n]*/), t: 'comment' },
  { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: 'string' },
  { p: stickyRe(/\bdefined\?/), t: 'keyword' },
  { p: stickyRe(/\b(?:alias|and|begin|break|case|class|def|do|else|elsif|end|ensure|for|if|in|module|next|nil|not|or|redo|require|rescue|retry|return|self|super|then|undef|unless|until|when|while|yield)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:true|false|nil)\b/), t: 'keyword' },
  { p: stickyRe(/:[a-zA-Z_]\w*/), t: 'string' },
  { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?\b/), t: 'number' },
  { p: stickyRe(/[a-zA-Z_]\w*(?=\s*[({])/), t: 'function' },
  { p: stickyRe(/[+\-*/%=!<>&|^~?:]+/), t: 'operator' },
  { p: stickyRe(/[{}()\[\];,.@]/), t: 'punctuation' },
]

const LANG_C: Rule[] = [
  { p: stickyRe(/\/\/[^\n]*/), t: 'comment' },
  { p: stickyRe(/\/\*[\s\S]*?\*\//), t: 'comment' },
  { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: 'string' },
  { p: stickyRe(/#\s*(?:include|define|ifdef|ifndef|endif|if|else|elif|undef|pragma|error|warning)[^\n]*/), t: 'keyword' },
  { p: stickyRe(/\b(?:auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while|_Bool|_Complex|_Imaginary)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:NULL|true|false)\b/), t: 'keyword' },
  { p: stickyRe(/\b(?:size_t|ptrdiff_t|int8_t|int16_t|int32_t|int64_t|uint8_t|uint16_t|uint32_t|uint64_t|FILE|bool)\b/), t: 'type' },
  { p: stickyRe(/\b0[xX][0-9a-fA-F][0-9a-fA-F]*[uUlL]*\b/), t: 'number' },
  { p: stickyRe(/\b\d[\d]*(?:\.[\d]*)?(?:[eE][+-]?\d+)?[uUlLfF]*\b/), t: 'number' },
  { p: stickyRe(/[a-zA-Z_]\w*(?=\s*\()/), t: 'function' },
  { p: stickyRe(/->|[+\-*/%=!<>&|^~?:]+/), t: 'operator' },
  { p: stickyRe(/[{}()\[\];,.]/), t: 'punctuation' },
]

const LANG_SQL: Rule[] = [
  { p: stickyRe(/--[^\n]*/), t: 'comment' },
  { p: stickyRe(/\/\*[\s\S]*?\*\//), t: 'comment' },
  { p: stickyRe(/'(?:[^'\\]|\\.)*'/), t: 'string' },
  { p: stickyRe(/\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|DATABASE|SCHEMA|JOIN|INNER|LEFT|RIGHT|OUTER|CROSS|ON|AND|OR|NOT|IN|IS|NULL|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|CASE|WHEN|THEN|ELSE|END|EXISTS|BETWEEN|LIKE|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|CHECK|DEFAULT|CONSTRAINT|BEGIN|COMMIT|ROLLBACK|TRANSACTION|WITH|RETURNING|ASC|DESC)\b/i), t: 'keyword' },
  { p: stickyRe(/\b(?:INT|INTEGER|BIGINT|SMALLINT|TINYINT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|CHAR|VARCHAR|TEXT|BLOB|BOOLEAN|BOOL|DATE|TIME|TIMESTAMP|DATETIME|SERIAL|UUID|JSON|JSONB|ARRAY|BYTEA)\b/i), t: 'type' },
  { p: stickyRe(/\b(?:COUNT|SUM|AVG|MIN|MAX|COALESCE|NULLIF|CAST|TRIM|UPPER|LOWER|LENGTH|SUBSTR|SUBSTRING|REPLACE|CONCAT|NOW|ROW_NUMBER|RANK|DENSE_RANK|LAG|LEAD|OVER|PARTITION)\b(?=\s*\()/i), t: 'function' },
  { p: stickyRe(/\b\d+(?:\.\d+)?\b/), t: 'number' },
  { p: stickyRe(/[=<>!]+|[+\-*/%]/), t: 'operator' },
  { p: stickyRe(/[();,.]/), t: 'punctuation' },
]

// ---------------------------------------------------------------------------
// Language map + aliases
// ---------------------------------------------------------------------------

const SYNTAX_LANGS: Record<string, Rule[]> = {
  javascript: LANG_JS, typescript: LANG_TS, jsx: LANG_JS, tsx: LANG_TS,
  python: LANG_PY, bash: LANG_BASH, json: LANG_JSON, diff: LANG_DIFF,
  html: LANG_HTML, xml: LANG_HTML, css: LANG_CSS, yaml: LANG_YAML,
  go: LANG_GO, rust: LANG_RUST, java: LANG_JAVA, ruby: LANG_RUBY,
  c: LANG_C, cpp: LANG_C, sql: LANG_SQL,
}

const SYNTAX_ALIASES: Record<string, string> = {
  js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash',
  shell: 'bash', zsh: 'bash', yml: 'yaml', htm: 'html', rb: 'ruby',
  rs: 'rust', 'c++': 'cpp', h: 'c', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  patch: 'diff', mysql: 'sql', postgresql: 'sql', postgres: 'sql',
  sqlite: 'sql', kt: 'java', kotlin: 'java', scala: 'java',
  cs: 'java', csharp: 'java', swift: 'c', jsonc: 'json', json5: 'json',
  toml: 'yaml',
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MAX_HIGHLIGHT_LENGTH = 5000

export function getSyntaxRules(lang: string): Rule[] | null {
  if (!lang) return null
  const key = lang.toLowerCase()
  return SYNTAX_LANGS[key] || SYNTAX_LANGS[SYNTAX_ALIASES[key] || ''] || null
}

function pushToken(tokens: Token[], text: string, type: string): void {
  const last = tokens.length > 0 ? tokens[tokens.length - 1] : null
  if (last && last.type === type) {
    last.text += text
  } else {
    tokens.push({ text, type })
  }
}

export function tokenize(code: string, lang: string): Token[] {
  if (!lang || code.length > MAX_HIGHLIGHT_LENGTH) return [{ text: code, type: 'plain' }]
  const rules = getSyntaxRules(lang)
  if (!rules) return [{ text: code, type: 'plain' }]

  const tokens: Token[] = []
  let pos = 0
  let plainStart = 0

  while (pos < code.length) {
    let matched = false
    for (let ri = 0; ri < rules.length; ri++) {
      rules[ri].p.lastIndex = pos
      const m = rules[ri].p.exec(code)
      if (m) {
        if (pos > plainStart) pushToken(tokens, code.slice(plainStart, pos), 'plain')
        pushToken(tokens, m[0], rules[ri].t)
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

export function highlightCode(code: string, lang: string): string {
  const tokens = tokenize(code, lang)
  let out = ''
  for (const token of tokens) {
    const color = SYNTAX_COLORS[token.type] || SYNTAX_COLORS.plain
    out += `<span style="color:${color}">${escapeHtml(token.text)}</span>`
  }
  return out
}
