import type { TokenType } from './theme';
import type { LanguageDef } from './languages';
import { getLanguage } from './languages';

/** A single token with text and type. */
export interface Token {
  text: string;
  type: TokenType;
}

/** Maximum code length to tokenize. Longer code falls back to a single plain token. */
const MAX_CODE_LENGTH = 5000;

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
    return [{ text: code, type: 'plain' }];
  }

  const rules = getLanguage(lang);
  if (!rules) {
    return [{ text: code, type: 'plain' }];
  }

  return scan(code, rules);
}

/** Core scanner: walk through code matching rules at each position. */
function scan(code: string, rules: LanguageDef): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let plainStart = pos;

  while (pos < code.length) {
    let matched = false;

    for (const rule of rules) {
      rule.pattern.lastIndex = pos;
      const m = rule.pattern.exec(code);
      if (m) {
        // Flush accumulated plain text
        if (pos > plainStart) {
          pushToken(tokens, code.slice(plainStart, pos), 'plain');
        }
        pushToken(tokens, m[0], rule.type);
        pos += m[0].length;
        plainStart = pos;
        matched = true;
        break;
      }
    }

    if (!matched) {
      pos++;
    }
  }

  // Flush remaining plain text
  if (pos > plainStart) {
    pushToken(tokens, code.slice(plainStart, pos), 'plain');
  }

  return tokens;
}

/** Append a token, merging with the previous if the same type. */
function pushToken(tokens: Token[], text: string, type: TokenType): void {
  const last = tokens[tokens.length - 1];
  if (last && last.type === type) {
    last.text += text;
  } else {
    tokens.push({ text, type });
  }
}
