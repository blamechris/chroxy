import {
  splitContentBlocks,
  parseTable,
  isValidTableRow,
  indent,
} from '../../components/MarkdownRenderer';

// -- splitContentBlocks --

describe('splitContentBlocks', () => {
  it('returns plain text as a single text block', () => {
    const blocks = splitContentBlocks('Hello world');
    expect(blocks).toEqual([{ kind: 'text', content: 'Hello world' }]);
  });

  it('extracts a fenced code block with language', () => {
    const input = 'Before\n```js\nconst x = 1;\n```\nAfter';
    const blocks = splitContentBlocks(input);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ kind: 'text', content: 'Before' });
    expect(blocks[1]).toEqual({ kind: 'code', lang: 'js', content: 'const x = 1;' });
    expect(blocks[2]).toEqual({ kind: 'text', content: 'After' });
  });

  it('handles code block without language', () => {
    const input = '```\nhello\n```';
    const blocks = splitContentBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: 'code', lang: '', content: 'hello' });
  });

  it('normalizes CRLF to LF', () => {
    const input = 'text\r\n```\r\ncode\r\n```\r\nmore';
    const blocks = splitContentBlocks(input);
    expect(blocks.some((b) => b.content.includes('\r'))).toBe(false);
    expect(blocks).toHaveLength(3);
  });

  it('handles consecutive code blocks', () => {
    const input = '```js\na\n```\n```py\nb\n```';
    const blocks = splitContentBlocks(input);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ kind: 'code', lang: 'js', content: 'a' });
    expect(blocks[1]).toEqual({ kind: 'code', lang: 'py', content: 'b' });
  });

  it('does not treat inline backticks as fences', () => {
    const input = 'Use triple backticks (```) to create code blocks.';
    const blocks = splitContentBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('text');
  });

  it('handles empty input', () => {
    expect(splitContentBlocks('')).toEqual([]);
  });
});

// -- parseTable --

describe('parseTable', () => {
  it('parses a basic table', () => {
    const lines = [
      '| Name | Age |',
      '| --- | --- |',
      '| Alice | 30 |',
      '| Bob | 25 |',
    ];
    const result = parseTable(lines, 0);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(['Name', 'Age']);
    expect(result!.rows).toEqual([['Alice', '30'], ['Bob', '25']]);
    expect(result!.endIndex).toBe(3);
  });

  it('returns null when separator row is missing', () => {
    const lines = [
      '| Name | Age |',
      '| Alice | 30 |',
    ];
    expect(parseTable(lines, 0)).toBeNull();
  });

  it('pads short rows to match header count', () => {
    const lines = [
      '| A | B | C |',
      '| --- | --- | --- |',
      '| 1 |',
    ];
    const result = parseTable(lines, 0);
    expect(result).not.toBeNull();
    expect(result!.rows[0]).toEqual(['1', '', '']);
  });

  it('returns null for startIndex beyond array length', () => {
    expect(parseTable(['| A |'], 5)).toBeNull();
  });

  it('returns null for non-table content', () => {
    expect(parseTable(['just text'], 0)).toBeNull();
  });

  it('computes column widths based on content length', () => {
    const lines = [
      '| X | LongHeader |',
      '| --- | --- |',
      '| ab | c |',
    ];
    const result = parseTable(lines, 0);
    expect(result).not.toBeNull();
    // X=1 char but min 1, LongHeader=10 chars
    expect(result!.columnWidths[0]).toBe(2); // max('X'.length=1, 'ab'.length=2)
    expect(result!.columnWidths[1]).toBe(10); // 'LongHeader'.length=10
  });
});

// -- isValidTableRow --

describe('isValidTableRow', () => {
  it('returns true for rows with pipe separators', () => {
    expect(isValidTableRow('| hello | world |')).toBe(true);
  });

  it('returns false for lines without pipes', () => {
    expect(isValidTableRow('no pipes here')).toBe(false);
  });

  it('returns true for minimal table row', () => {
    expect(isValidTableRow('a|b')).toBe(true);
  });
});

// -- indent --

describe('indent', () => {
  it('returns empty string for level 0', () => {
    expect(indent(0)).toBe('');
  });

  it('returns 3 spaces for level 1', () => {
    expect(indent(1)).toBe('   ');
  });

  it('caps at max indent level (3)', () => {
    expect(indent(3)).toBe(indent(5));
    expect(indent(10)).toBe('         '); // 3 * 3 = 9 spaces
  });
});
