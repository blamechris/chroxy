import { COLORS } from '../../constants/colors';

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
  | 'diff_remove';

/** Maps each token type to its display color. */
export const SYNTAX_COLORS: Record<TokenType, string> = {
  keyword: COLORS.syntaxKeyword,
  string: COLORS.syntaxString,
  comment: COLORS.syntaxComment,
  number: COLORS.syntaxNumber,
  function: COLORS.syntaxFunction,
  operator: COLORS.syntaxOperator,
  punctuation: COLORS.syntaxPunctuation,
  type: COLORS.syntaxType,
  property: COLORS.syntaxProperty,
  plain: COLORS.syntaxPlain,
  diff_add: COLORS.syntaxDiffAdd,
  diff_remove: COLORS.syntaxDiffRemove,
};
