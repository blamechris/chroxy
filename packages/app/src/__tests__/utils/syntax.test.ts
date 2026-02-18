import { tokenize, getLanguage } from '../../utils/syntax';
import type { Token } from '../../utils/syntax';

// -- Helpers --

/** Extract token types from a tokenize result. */
function types(tokens: Token[]): string[] {
  return tokens.map((t) => t.type);
}

/** Find the first token of a given type. */
function firstOfType(tokens: Token[], type: string): Token | undefined {
  return tokens.find((t) => t.type === type);
}

// -- getLanguage --

describe('getLanguage', () => {
  it('resolves canonical names', () => {
    expect(getLanguage('javascript')).toBeDefined();
    expect(getLanguage('python')).toBeDefined();
    expect(getLanguage('bash')).toBeDefined();
    expect(getLanguage('json')).toBeDefined();
  });

  it('resolves aliases', () => {
    expect(getLanguage('js')).toBe(getLanguage('javascript'));
    expect(getLanguage('ts')).toBe(getLanguage('typescript'));
    expect(getLanguage('py')).toBe(getLanguage('python'));
    expect(getLanguage('sh')).toBe(getLanguage('bash'));
    expect(getLanguage('yml')).toBe(getLanguage('yaml'));
    expect(getLanguage('rs')).toBe(getLanguage('rust'));
  });

  it('is case-insensitive', () => {
    expect(getLanguage('JavaScript')).toBe(getLanguage('javascript'));
    expect(getLanguage('JSON')).toBe(getLanguage('json'));
  });

  it('returns undefined for unknown languages', () => {
    expect(getLanguage('brainfuck')).toBeUndefined();
    expect(getLanguage('')).toBeUndefined();
  });
});

// -- tokenize fallbacks --

describe('tokenize fallbacks', () => {
  it('returns single plain token for unknown language', () => {
    const tokens = tokenize('const x = 1;', 'unknown_lang');
    expect(tokens).toEqual([{ text: 'const x = 1;', type: 'plain' }]);
  });

  it('returns single plain token for empty language', () => {
    const tokens = tokenize('hello', '');
    expect(tokens).toEqual([{ text: 'hello', type: 'plain' }]);
  });

  it('returns single plain token for code exceeding 5KB', () => {
    const longCode = 'x'.repeat(5001);
    const tokens = tokenize(longCode, 'js');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('plain');
  });

  it('tokenizes code at exactly 5000 chars', () => {
    const code = 'const ' + 'x'.repeat(4994);
    const tokens = tokenize(code, 'js');
    // Should actually tokenize (not fallback)
    expect(tokens.length).toBeGreaterThan(1);
  });
});

// -- JavaScript --

describe('tokenize JavaScript', () => {
  it('highlights keywords', () => {
    const tokens = tokenize('const x = 1', 'js');
    expect(tokens[0]).toEqual({ text: 'const', type: 'keyword' });
  });

  it('highlights strings', () => {
    const tokens = tokenize("const s = 'hello'", 'js');
    const str = firstOfType(tokens, 'string');
    expect(str).toBeDefined();
    expect(str!.text).toBe("'hello'");
  });

  it('highlights template literals', () => {
    const tokens = tokenize('const s = `hi`', 'js');
    const str = firstOfType(tokens, 'string');
    expect(str).toBeDefined();
    expect(str!.text).toBe('`hi`');
  });

  it('highlights numbers', () => {
    const tokens = tokenize('const n = 42', 'js');
    const num = firstOfType(tokens, 'number');
    expect(num).toBeDefined();
    expect(num!.text).toBe('42');
  });

  it('highlights hex numbers', () => {
    const tokens = tokenize('const n = 0xFF', 'js');
    const num = firstOfType(tokens, 'number');
    expect(num!.text).toBe('0xFF');
  });

  it('highlights function calls', () => {
    const tokens = tokenize('console.log(x)', 'js');
    const fn = firstOfType(tokens, 'function');
    expect(fn).toBeDefined();
    expect(fn!.text).toBe('log');
  });

  it('highlights single-line comments', () => {
    const tokens = tokenize('// comment\nconst x = 1', 'js');
    expect(tokens[0]).toEqual({ text: '// comment', type: 'comment' });
  });

  it('highlights multi-line comments', () => {
    const tokens = tokenize('/* block\ncomment */\nconst x = 1', 'js');
    expect(tokens[0]).toEqual({ text: '/* block\ncomment */', type: 'comment' });
  });

  it('highlights arrow functions', () => {
    const tokens = tokenize('const f = () => 1', 'js');
    const op = tokens.find((t) => t.text === '=>');
    expect(op).toBeDefined();
    expect(op!.type).toBe('operator');
  });

  it('highlights boolean/null keywords', () => {
    const tokens = tokenize('true false null undefined', 'js');
    const kwTypes = tokens.filter((t) => t.type === 'keyword');
    expect(kwTypes).toHaveLength(4);
  });

  it('highlights built-in types', () => {
    const tokens = tokenize('new Map()', 'js');
    const typeToken = firstOfType(tokens, 'type');
    expect(typeToken).toBeDefined();
    expect(typeToken!.text).toBe('Map');
  });
});

// -- TypeScript --

describe('tokenize TypeScript', () => {
  it('highlights TS-specific keywords', () => {
    const tokens = tokenize('interface Foo { readonly x: string }', 'ts');
    const kws = tokens.filter((t) => t.type === 'keyword');
    const kwTexts = kws.map((t) => t.text);
    expect(kwTexts).toContain('interface');
    expect(kwTexts).toContain('readonly');
  });

  it('highlights built-in utility types', () => {
    const tokens = tokenize('type X = Partial<Foo>', 'ts');
    const fn = tokens.find((t) => t.text === 'Partial');
    expect(fn).toBeDefined();
  });

  it('highlights primitive types', () => {
    const tokens = tokenize('let x: number = 1', 'ts');
    const typeToken = tokens.find((t) => t.text === 'number');
    expect(typeToken).toBeDefined();
    expect(typeToken!.type).toBe('type');
  });
});

// -- Python --

describe('tokenize Python', () => {
  it('highlights def keyword and function name', () => {
    const tokens = tokenize('def hello():', 'py');
    expect(tokens[0]).toEqual({ text: 'def', type: 'keyword' });
    const fn = firstOfType(tokens, 'function');
    expect(fn!.text).toBe('hello');
  });

  it('highlights triple-quoted strings', () => {
    const tokens = tokenize('x = """multi\nline"""', 'py');
    const str = firstOfType(tokens, 'string');
    expect(str).toBeDefined();
    expect(str!.text).toContain('multi\nline');
  });

  it('highlights f-strings', () => {
    const tokens = tokenize('x = f"hello {name}"', 'py');
    const str = firstOfType(tokens, 'string');
    expect(str).toBeDefined();
  });

  it('highlights comments', () => {
    const tokens = tokenize('# comment\nx = 1', 'py');
    expect(tokens[0]).toEqual({ text: '# comment', type: 'comment' });
  });
});

// -- Bash --

describe('tokenize Bash', () => {
  it('highlights keywords', () => {
    const tokens = tokenize('if [ -f file ]; then echo ok; fi', 'bash');
    const kws = tokens.filter((t) => t.type === 'keyword').map((t) => t.text);
    expect(kws).toContain('if');
    expect(kws).toContain('then');
    expect(kws).toContain('fi');
  });

  it('highlights variable expansion', () => {
    const tokens = tokenize('echo $HOME', 'bash');
    const str = tokens.find((t) => t.text === '$HOME');
    expect(str).toBeDefined();
    expect(str!.type).toBe('string');
  });

  it('highlights brace expansion', () => {
    const tokens = tokenize('echo ${PATH}', 'bash');
    const str = tokens.find((t) => t.text === '${PATH}');
    expect(str).toBeDefined();
    expect(str!.type).toBe('string');
  });

  it('highlights built-in commands as functions', () => {
    const tokens = tokenize('echo hello', 'bash');
    const fn = firstOfType(tokens, 'function');
    expect(fn!.text).toBe('echo');
  });
});

// -- JSON --

describe('tokenize JSON', () => {
  it('highlights keys as properties', () => {
    const tokens = tokenize('{"name": "value"}', 'json');
    const prop = firstOfType(tokens, 'property');
    expect(prop).toBeDefined();
    expect(prop!.text).toBe('"name"');
  });

  it('highlights string values', () => {
    const tokens = tokenize('{"key": "val"}', 'json');
    const strings = tokens.filter((t) => t.type === 'string');
    expect(strings).toHaveLength(1);
    expect(strings[0].text).toBe('"val"');
  });

  it('highlights booleans and null', () => {
    const tokens = tokenize('{"a": true, "b": false, "c": null}', 'json');
    const kws = tokens.filter((t) => t.type === 'keyword');
    expect(kws.map((t) => t.text)).toEqual(['true', 'false', 'null']);
  });

  it('highlights numbers', () => {
    const tokens = tokenize('{"n": 42, "f": -3.14}', 'json');
    const nums = tokens.filter((t) => t.type === 'number');
    expect(nums.map((t) => t.text)).toEqual(['42', '-3.14']);
  });
});

// -- Diff --

describe('tokenize Diff', () => {
  it('highlights added lines', () => {
    const tokens = tokenize('+added line', 'diff');
    expect(tokens[0].type).toBe('diff_add');
  });

  it('highlights removed lines', () => {
    const tokens = tokenize('-removed line', 'diff');
    expect(tokens[0].type).toBe('diff_remove');
  });

  it('highlights hunk headers', () => {
    const tokens = tokenize('@@ -1,3 +1,4 @@ context', 'diff');
    expect(tokens[0].type).toBe('keyword');
  });

  it('highlights file headers', () => {
    const tokens = tokenize('--- a/file.txt\n+++ b/file.txt', 'diff');
    const kws = tokens.filter((t) => t.type === 'keyword');
    expect(kws.length).toBeGreaterThanOrEqual(2);
  });
});

// -- Go --

describe('tokenize Go', () => {
  it('highlights func keyword and function name', () => {
    const tokens = tokenize('func main() {', 'go');
    expect(tokens[0]).toEqual({ text: 'func', type: 'keyword' });
    const fn = firstOfType(tokens, 'function');
    expect(fn!.text).toBe('main');
  });

  it('highlights Go types', () => {
    const tokens = tokenize('var x int64', 'go');
    const typeToken = tokens.find((t) => t.text === 'int64');
    expect(typeToken!.type).toBe('type');
  });

  it('highlights := operator', () => {
    const tokens = tokenize('x := 5', 'go');
    const op = tokens.find((t) => t.text === ':=');
    expect(op).toBeDefined();
    expect(op!.type).toBe('operator');
  });
});

// -- Rust --

describe('tokenize Rust', () => {
  it('highlights fn keyword', () => {
    const tokens = tokenize('fn main() {', 'rust');
    expect(tokens[0]).toEqual({ text: 'fn', type: 'keyword' });
  });

  it('highlights Rust types', () => {
    const tokens = tokenize('let x: Vec<String> = Vec::new()', 'rs');
    const typeTokens = tokens.filter((t) => t.type === 'type');
    const typeTexts = typeTokens.map((t) => t.text);
    expect(typeTexts).toContain('Vec');
    expect(typeTexts).toContain('String');
  });

  it('highlights arrow operator', () => {
    const tokens = tokenize('fn foo() -> i32', 'rust');
    const op = tokens.find((t) => t.text === '->');
    expect(op).toBeDefined();
    expect(op!.type).toBe('operator');
  });
});

// -- SQL --

describe('tokenize SQL', () => {
  it('highlights SQL keywords case-insensitively', () => {
    const tokens = tokenize('SELECT * FROM users WHERE id = 1', 'sql');
    const kws = tokens.filter((t) => t.type === 'keyword').map((t) => t.text);
    expect(kws).toContain('SELECT');
    expect(kws).toContain('FROM');
    expect(kws).toContain('WHERE');
  });

  it('highlights string literals', () => {
    const tokens = tokenize("SELECT * FROM users WHERE name = 'alice'", 'sql');
    const str = firstOfType(tokens, 'string');
    expect(str!.text).toBe("'alice'");
  });

  it('highlights aggregate functions', () => {
    const tokens = tokenize('SELECT COUNT(*) FROM t', 'sql');
    const fn = firstOfType(tokens, 'function');
    expect(fn!.text).toBe('COUNT');
  });
});

// -- Token merging --

describe('token merging', () => {
  it('merges adjacent plain tokens', () => {
    const tokens = tokenize('abc def', 'js');
    // 'abc def' should be a single plain token (no rules match it)
    const plain = tokens.filter((t) => t.type === 'plain');
    expect(plain.length).toBeLessThanOrEqual(1);
  });
});

// -- Edge cases --

describe('edge cases', () => {
  it('handles empty string', () => {
    const tokens = tokenize('', 'js');
    expect(tokens).toEqual([]);
  });

  it('handles single newline', () => {
    const tokens = tokenize('\n', 'js');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('plain');
  });

  it('preserves all original text', () => {
    const code = 'const x = "hello"; // comment\nfunction foo() { return 42; }';
    const tokens = tokenize(code, 'js');
    const reconstructed = tokens.map((t) => t.text).join('');
    expect(reconstructed).toBe(code);
  });

  it('preserves text for all supported languages', () => {
    const code = 'x = 1 + 2; // test';
    for (const lang of ['js', 'ts', 'py', 'bash', 'json', 'go', 'rust', 'java', 'ruby', 'c', 'sql', 'css', 'html', 'yaml', 'diff']) {
      const tokens = tokenize(code, lang);
      const reconstructed = tokens.map((t) => t.text).join('');
      expect(reconstructed).toBe(code);
    }
  });
});
