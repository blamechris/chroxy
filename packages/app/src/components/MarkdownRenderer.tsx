import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Platform, Linking, StyleProp, TextStyle, ScrollView } from 'react-native';
import { ICON_BULLET, ICON_CHECKBOX_CHECKED, ICON_CHECKBOX_UNCHECKED } from '../constants/icons';
import { COLORS } from '../constants/colors';


// -- Constants --

/** Minimum width for markdown table cells in logical pixels.
 *  80dp keeps short headers/values readable on small screens without
 *  forcing excessive horizontal scrolling. */
const TABLE_CELL_MIN_WIDTH = 80;

/** Regex pattern for matching markdown table separator rows (e.g., |---|---|)
 *  Matches lines with optional leading/trailing pipes and dashes/colons. */
const TABLE_SEPARATOR_RE = /^\s*\|?\s*[-:]+\s*(\|\s*[-:]+\s*)*\|?\s*$/;

/** Number of spaces added per indentation level in nested lists.
 *  Reduces visual depth to fit narrow mobile screens. */
const SPACES_PER_INDENT_LEVEL = 3;

/** Maximum nesting level for list indentation.
 *  Levels deeper than this render with the same indentation to prevent
 *  consuming excessive horizontal space on small screens. */
const MAX_LIST_INDENT_LEVEL = 3;

/** Bullet character used for deeply nested list items (level 4+).
 *  A small triangle distinguishes deep nesting from MAX_LIST_INDENT_LEVEL items. */
const DEEP_NEST_BULLET = '\u25E6'; // White bullet ◦

// -- Content Block Types --

type ContentBlock =
  | { kind: 'code'; lang: string; content: string }
  | { kind: 'text'; content: string };

/** Split content into alternating text and fenced code blocks.
 *  Code fences must start at the beginning of a line -- triple backticks
 *  inside prose (e.g. "Code blocks (```)") are NOT treated as fences. */
export function splitContentBlocks(rawContent: string): ContentBlock[] {
  // Normalize CRLF -> LF so fence regex works on all line endings
  const content = rawContent.replace(/\r\n/g, '\n');
  const blocks: ContentBlock[] = [];
  // Require ``` at line start (or string start), followed by optional language + newline.
  // Closing fence uses lookahead so the \n isn't consumed -- allows consecutive code blocks.
  const regex = /(?:^|\n)```(\w*)\n([\s\S]*?)(?:\n```(?=\s*\n|$)|$)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(content)) !== null) {
    // Adjust: if we matched a leading \n, the fence starts 1 char into the match
    const fenceStart = content[match.index] === '\n' ? match.index + 1 : match.index;
    if (fenceStart > lastIndex) {
      const text = content.slice(lastIndex, fenceStart).trim();
      if (text) blocks.push({ kind: 'text', content: text });
    }
    const code = match[2].trimEnd();
    if (code) blocks.push({ kind: 'code', lang: match[1] || '', content: code });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trim();
    if (text) blocks.push({ kind: 'text', content: text });
  }

  return blocks;
}

/** Safe URL opener with scheme validation and error handling */
function openURL(url: string) {
  // Strip trailing punctuation that shouldn't be part of the URL
  const cleanUrl = url.replace(/[.,;!?)\]]+$/, '');

  // Only allow http/https schemes
  if (!/^https?:\/\//i.test(cleanUrl)) {
    console.warn('Invalid URL scheme:', cleanUrl);
    return;
  }

  void Linking.openURL(cleanUrl).catch((err) => {
    console.error('Failed to open URL:', cleanUrl, err);
  });
}

/** Generate indentation whitespace based on nesting level.
 *  `level` is 0-based (e.g., 0 = top-level). Each level adds `SPACES_PER_INDENT_LEVEL` spaces.
 *  Levels deeper than `MAX_LIST_INDENT_LEVEL` are rendered with the same indentation as the
 *  maximum level to save space on small screens. */
export function indent(level: number): string {
  const cappedLevel = Math.min(level, MAX_LIST_INDENT_LEVEL);
  return ' '.repeat(cappedLevel * SPACES_PER_INDENT_LEVEL);
}

/** Render inline markdown: **bold**, `code`, and links within a line */
export function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Combined regex: bold, inline code, markdown links, or URLs
  // Order matters: match markdown links before bare URLs to avoid breaking [text](url)
  // URL regex captures trailing punctuation separately to handle "Visit https://example.com."
  const regex = /(\*\*(.+?)\*\*|`([^`\n]+)`|\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/[^\s<>]+?)([.,;!?)\]]*(?:\s|$)))/g;
  let lastIdx = 0;
  let key = 0;
  let m;

  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    if (m[2]) {
      // Bold **text**
      parts.push(<Text key={`${keyBase}-b${key++}`} style={md.bold}>{m[2]}</Text>);
    } else if (m[3]) {
      // Inline code `text`
      parts.push(<Text key={`${keyBase}-c${key++}`} style={md.inlineCode}>{m[3]}</Text>);
    } else if (m[4] && m[5]) {
      // Markdown link [text](url)
      const linkText = m[4];
      const url = m[5];
      parts.push(
        <Text
          key={`${keyBase}-l${key++}`}
          style={md.link}
          onPress={() => openURL(url)}
        >
          {linkText}
        </Text>
      );
    } else if (m[6]) {
      // Bare URL (m[6] is URL without trailing punctuation, m[7] is trailing punctuation)
      const url = m[6];
      const trailing = m[7] || '';
      parts.push(
        <Text
          key={`${keyBase}-u${key++}`}
          style={md.link}
          onPress={() => openURL(url)}
        >
          {url}
        </Text>
      );
      // Add trailing punctuation as plain text
      if (trailing.trim()) {
        parts.push(trailing);
      }
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

/** Check if a line is a valid table row (has pipe separators and at least one non-empty cell) */
export function isValidTableRow(line: string): boolean {
  if (!line.includes('|')) return false;
  const rawCells = line.split('|').map(cell => cell.trim());
  // Remove leading/trailing empty cells (from leading/trailing pipes)
  const cellStart = rawCells[0] === '' ? 1 : 0;
  const cellEnd = rawCells[rawCells.length - 1] === '' ? rawCells.length - 1 : rawCells.length;
  const cells = rawCells.slice(cellStart, cellEnd);
  return cells.length > 0;
}

/** Parse markdown table: | col1 | col2 | ... */
export function parseTable(lines: string[], startIndex: number): { headers: string[]; rows: string[][]; columnWidths: number[]; endIndex: number } | null {
  if (startIndex >= lines.length) return null;

  // Check for table header row (must contain | separators)
  const headerLine = lines[startIndex];
  if (!headerLine.includes('|')) return null;

  // Parse header row - preserve empty cells between pipes
  const rawHeaders = headerLine.split('|').map(cell => cell.trim());
  // Remove leading/trailing empty cells (from leading/trailing pipes like |col1|col2|)
  const headerStart = rawHeaders[0] === '' ? 1 : 0;
  const headerEnd = rawHeaders[rawHeaders.length - 1] === '' ? rawHeaders.length - 1 : rawHeaders.length;
  const headers = rawHeaders.slice(headerStart, headerEnd);
  if (headers.length === 0) return null;

  // Check for separator row (e.g., |---|---|)
  if (startIndex + 1 >= lines.length) return null;
  const sepLine = lines[startIndex + 1];
  if (!sepLine.match(TABLE_SEPARATOR_RE)) return null;

  // Parse data rows - preserve empty cells and normalize row length
  const rows: string[][] = [];
  let i = startIndex + 2;
  while (i < lines.length) {
    const line = lines[i];
    if (!isValidTableRow(line)) break;
    // Split and trim, preserving empty cells between pipes
    const rawCells = line.split('|').map(cell => cell.trim());
    // Remove leading/trailing empty cells (from leading/trailing pipes)
    const cellStart = rawCells[0] === '' ? 1 : 0;
    const cellEnd = rawCells[rawCells.length - 1] === '' ? rawCells.length - 1 : rawCells.length;
    const cells = rawCells.slice(cellStart, cellEnd);
    // Normalize row length to match header count (pad with empty strings or truncate)
    while (cells.length < headers.length) cells.push('');
    rows.push(cells.slice(0, headers.length));
    i++;
  }

  // Compute max content length per column (across headers + all rows)
  // Used as flex weights so wider-content columns get more space
  const columnWidths = headers.map((header, colIdx) => {
    let maxLen = header.length;
    for (const row of rows) {
      const cellLen = (row[colIdx] || '').length;
      if (cellLen > maxLen) maxLen = cellLen;
    }
    // Minimum weight of 1 so narrow columns aren't invisible
    return Math.max(maxLen, 1);
  });

  return { headers, rows, columnWidths, endIndex: i - 1 };
}

/** Memoized table component that parses and renders markdown tables.
 *  Parsing is wrapped in useMemo to prevent re-computation on every render.
 *  The component itself is wrapped in React.memo to prevent re-renders when props haven't changed. */
const TableBlock = React.memo(({
  paragraphText,
  startIndex,
  keyBase,
  messageTextStyle
}: {
  paragraphText: string;
  startIndex: number;
  keyBase: string;
  messageTextStyle: StyleProp<TextStyle>;
}) => {
  // Memoize the lines array split - stable string input prevents unnecessary re-computation
  const lines = useMemo(() => paragraphText.split('\n'), [paragraphText]);

  // Memoize table parsing - only re-parse when lines or startIndex changes
  const tableData = useMemo(() => {
    return parseTable(lines, startIndex);
  }, [lines, startIndex]);

  if (!tableData) return null;

  const { headers, rows, columnWidths } = tableData;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={true}
      accessibilityHint="Swipe left or right to view more columns"
      style={md.tableScrollContainer}
    >
      <View style={md.table}>
        {/* Header row */}
        <View style={md.tableRow}>
          {headers.map((header, idx) => (
            <View key={`${keyBase}-h${idx}`} style={[md.tableCell, md.tableHeaderCell, { flex: columnWidths[idx] }]}>
              <Text selectable style={md.tableHeaderText}>{renderInline(header, `${keyBase}-h${idx}`)}</Text>
            </View>
          ))}
        </View>
        {/* Data rows */}
        {rows.map((row, rowIdx) => (
          <View key={`${keyBase}-r${rowIdx}`} style={md.tableRow}>
            {headers.map((_, cellIdx) => (
              <View key={`${keyBase}-r${rowIdx}-c${cellIdx}`} style={[md.tableCell, { flex: columnWidths[cellIdx] }]}>
                <Text selectable style={messageTextStyle}>{renderInline(row[cellIdx] || '', `${keyBase}-r${rowIdx}-c${cellIdx}`)}</Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
});

/** Check if an element is a View component (HR, blockquote, table).
 *  These are the elements that force paragraph splitting for selectability. */
function isViewElement(element: React.ReactNode): element is React.ReactElement {
  if (!React.isValidElement(element)) return false;
  return element.type === View || element.type === TableBlock;
}

/** Group paragraph elements into selectable text runs and View blocks.
 *  Within a paragraph, consecutive Text elements are wrapped in <Text selectable>,
 *  View elements (HR, blockquote, table) are rendered as-is (selection stops at boundaries). */
function groupParagraphElements(
  elements: React.ReactNode[],
  paraKey: string,
  messageTextStyle: StyleProp<TextStyle>,
): React.ReactNode[] {
  const grouped: React.ReactNode[] = [];
  let textGroup: React.ReactNode[] = [];
  let groupIdx = 0;

  const flushTextGroup = () => {
    if (textGroup.length > 0) {
      grouped.push(
        <Text key={`${paraKey}-tg${groupIdx++}`} selectable style={messageTextStyle}>
          {textGroup}
        </Text>
      );
      textGroup = [];
    }
  };

  elements.forEach((elem) => {
    if (isViewElement(elem)) {
      flushTextGroup();
      grouped.push(elem);
    } else {
      textGroup.push(elem);
    }
  });

  flushTextGroup();
  return grouped;
}

/** Render a text block with headers, lists, bold, and inline code.
 *  Enables cross-paragraph selection by wrapping entire text content in a single
 *  selectable Text component where possible.
 *
 *  The `messageTextStyle` prop is applied to selectable text runs so the
 *  caller can control font size / color without duplicating the stylesheet. */
export function FormattedTextBlock({ text, keyBase, messageTextStyle }: { text: string; keyBase: string; messageTextStyle: StyleProp<TextStyle> }) {
  // Split into paragraphs on blank lines for visual spacing
  const paragraphs = text.split(/\n{2,}/);

  // First pass: process all paragraphs and determine if we have View-only elements
  const processedParagraphs: Array<{ elements: React.ReactNode[]; hasViewChildren: boolean }> = [];
  let anyHasViewChildren = false;

  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p].trim();
    if (!para) continue;

    const lines = para.split('\n');
    const elements: React.ReactNode[] = [];
    // Track if we have any View children (HR/blockquote/table), which require View wrapper instead of Text
    let hasViewChildren = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lk = `${keyBase}-P${p}-L${i}`;
      if (i > 0) elements.push(<Text key={`${lk}-nl`}>{'\n'}</Text>);

      if (!line.trim()) continue;

      // Table: | col1 | col2 | (lightweight check for table pattern)
      // Full parsing happens inside TableBlock's useMemo
      if (line.includes('|') && i + 1 < lines.length &&
          lines[i + 1].match(TABLE_SEPARATOR_RE)) {
        hasViewChildren = true;
        elements.push(
          <TableBlock
            key={lk}
            paragraphText={para}
            startIndex={i}
            keyBase={lk}
            messageTextStyle={messageTextStyle}
          />
        );
        // Lightweight scan to find table end - use same validity check as parseTable
        let j = i + 2;
        while (j < lines.length && isValidTableRow(lines[j])) {
          j++;
        }
        i = j - 1; // Skip processed lines
        continue;
      }

      // Header: # ## ###
      const hm = line.match(/^(#{1,3})\s+(.+)/);
      if (hm) {
        const lvl = hm[1].length;
        const hStyle = lvl === 1 ? md.h1 : lvl === 2 ? md.h2 : md.h3;
        elements.push(<Text key={lk} style={hStyle}>{renderInline(hm[2], lk)}</Text>);
        continue;
      }

      // Horizontal rule: ---, ***, or ___
      if (line.match(/^[-*_]{3,}$/)) {
        hasViewChildren = true;
        elements.push(<View key={lk} style={md.horizontalRule} />);
        continue;
      }

      // Blockquote: > text (group consecutive lines)
      if (line.match(/^>\s?/)) {
        hasViewChildren = true;
        // Collect all consecutive blockquote lines
        const quoteLines: string[] = [];
        let j = i;
        while (j < lines.length && lines[j].match(/^>\s?/)) {
          quoteLines.push(lines[j].replace(/^>\s?/, ''));
          j++;
        }
        // Render the blockquote as a styled View
        const quoteContent = quoteLines.map((qLine, qIdx) =>
          <Text key={`${lk}-q${qIdx}`} selectable style={messageTextStyle}>{renderInline(qLine, `${lk}-q${qIdx}`)}</Text>
        );
        elements.push(
          <View key={lk} style={md.blockquote}>
            {quoteContent}
          </View>
        );
        i = j - 1; // Skip processed lines
        continue;
      }

      // Task list: - [x] or - [ ]
      const tlm = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.+)/);
      if (tlm) {
        const indentSpaces = tlm[1].length;
        const nestLevel = Math.floor(indentSpaces / 2);
        const checked = tlm[2].toLowerCase() === 'x';
        const indentStr = indent(nestLevel);
        const isDeep = nestLevel > MAX_LIST_INDENT_LEVEL;
        elements.push(
          <Text key={lk} selectable style={messageTextStyle}>
            {indentStr}
            {isDeep && <Text style={md.depthIndicator}>{'\u00B7'.repeat(nestLevel - MAX_LIST_INDENT_LEVEL)}{' '}</Text>}
            {checked ? `${ICON_CHECKBOX_CHECKED} ` : `${ICON_CHECKBOX_UNCHECKED} `}{renderInline(tlm[3], lk)}
          </Text>
        );
        continue;
      }

      // Unordered list with nesting support: - or * (capture leading whitespace for indentation)
      const ulm = line.match(/^(\s*)[-*]\s+(.+)/);
      if (ulm) {
        const indentSpaces = ulm[1].length;
        const nestLevel = Math.floor(indentSpaces / 2); // 2 spaces = 1 nesting level
        const indentStr = indent(nestLevel);
        const isDeep = nestLevel > MAX_LIST_INDENT_LEVEL;
        const bullet = isDeep ? DEEP_NEST_BULLET : ICON_BULLET;
        elements.push(
          <Text key={lk} selectable style={messageTextStyle}>
            {indentStr}
            {isDeep && <Text style={md.depthIndicator}>{'\u00B7'.repeat(nestLevel - MAX_LIST_INDENT_LEVEL)}{' '}</Text>}
            {`${bullet} `}{renderInline(ulm[2], lk)}
          </Text>
        );
        continue;
      }

      // Ordered list with nesting support: 1. 2. etc (capture leading whitespace for indentation)
      const olm = line.match(/^(\s*)(\d+)\.\s+(.+)/);
      if (olm) {
        const indentSpaces = olm[1].length;
        const nestLevel = Math.floor(indentSpaces / 2); // 2 spaces = 1 nesting level
        const indentStr = indent(nestLevel);
        const isDeep = nestLevel > MAX_LIST_INDENT_LEVEL;
        elements.push(
          <Text key={lk} selectable style={messageTextStyle}>
            {indentStr}
            {isDeep && <Text style={md.depthIndicator}>{'\u00B7'.repeat(nestLevel - MAX_LIST_INDENT_LEVEL)}{' '}</Text>}
            {olm[2]}{'. '}{renderInline(olm[3], lk)}
          </Text>
        );
        continue;
      }

      // Regular line with inline formatting
      const inlineElements = renderInline(line, lk);
      if (inlineElements.length > 0) {
        elements.push(<Text key={lk}>{inlineElements}</Text>);
      }
    }

    if (elements.length > 0) {
      processedParagraphs.push({ elements, hasViewChildren });
      if (hasViewChildren) anyHasViewChildren = true;
    }
  }

  // If no content, return nothing
  if (processedParagraphs.length === 0) return null;

  // If we have any View children (HR/blockquote/table), we can't use a single Text wrapper
  // Instead, group consecutive Text-only paragraphs together for cross-paragraph selection,
  // and within mixed paragraphs, group text runs around View children
  if (anyHasViewChildren) {
    const grouped: React.ReactNode[] = [];
    let textGroup: React.ReactNode[] = [];
    let textGroupKey = 0;

    const flushTextGroup = () => {
      if (textGroup.length > 0) {
        grouped.push(
          <Text key={`textgroup-${textGroupKey++}`} selectable style={messageTextStyle}>
            {textGroup}
          </Text>
        );
        textGroup = [];
      }
    };

    processedParagraphs.forEach((para, idx) => {
      if (para.hasViewChildren) {
        // Mixed paragraph with View children - flush any accumulated text-only paragraphs,
        // then group elements within this paragraph to preserve text selectability
        flushTextGroup();
        const paraElements = groupParagraphElements(para.elements, `para-${idx}`, messageTextStyle);
        grouped.push(
          <View key={`para-${idx}`}>
            {paraElements}
          </View>
        );
      } else {
        // Text-only paragraph - accumulate for cross-paragraph selection
        // Add paragraph separator if not the first in the group
        if (textGroup.length > 0) {
          textGroup.push('\n\n');
        }
        textGroup.push(...para.elements);
      }
    });

    flushTextGroup();

    // Return with paragraph spacing
    return <View style={md.paragraphs}>{grouped}</View>;
  }

  // No View children — wrap everything in a single selectable Text for cross-paragraph selection
  const allElements: React.ReactNode[] = [];
  processedParagraphs.forEach((para, idx) => {
    if (idx > 0) allElements.push('\n\n');
    allElements.push(...para.elements);
  });

  return (
    <Text selectable style={messageTextStyle}>
      {allElements}
    </Text>
  );
}

/** Formatted response -- renders Claude's markdown as styled blocks.
 *
 *  `messageTextStyle` is threaded through to FormattedTextBlock so the
 *  parent can control the base text appearance. */
export function FormattedResponse({ content, messageTextStyle }: { content: string; messageTextStyle: StyleProp<TextStyle> }) {
  const blocks = useMemo(() => splitContentBlocks(content.trim()), [content]);

  if (blocks.length === 0) return null;

  return (
    <View style={md.container}>
      {blocks.map((block, i) => {
        if (block.kind === 'code') {
          return (
            <View key={`b${i}`} style={md.codeBlock}>
              {block.lang ? <Text style={md.codeLang}>{block.lang}</Text> : null}
              <Text selectable style={md.codeText}>{block.content}</Text>
            </View>
          );
        }
        return <FormattedTextBlock key={`b${i}`} text={block.content} keyBase={`b${i}`} messageTextStyle={messageTextStyle} />;
      })}
    </View>
  );
}

export const md = StyleSheet.create({
  container: {
    gap: 8,
  },
  paragraphs: {
    gap: 10,
  },
  bold: {
    fontWeight: '700',
  },
  inlineCode: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: COLORS.backgroundCard,
    color: COLORS.accentPurpleCode,
    fontSize: 13,
    paddingHorizontal: 3,
    borderRadius: 3,
  },
  h1: {
    fontSize: 17,
    fontWeight: '700',
    color: COLORS.headerText1,
    lineHeight: 24,
  },
  h2: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.headerText2,
    lineHeight: 22,
  },
  h3: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.headerText3,
    lineHeight: 22,
  },
  codeBlock: {
    backgroundColor: COLORS.backgroundCodeBlock,
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
  },
  codeLang: {
    color: COLORS.textDim,
    fontSize: 10,
    marginBottom: 4,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    textTransform: 'uppercase',
  },
  codeText: {
    color: COLORS.textCodeBlock,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    lineHeight: 18,
  },
  link: {
    color: COLORS.accentBlue,
    textDecorationLine: 'underline',
  },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accentBlueTransparent40,
    paddingLeft: 12,
    marginVertical: 4,
    opacity: 0.9,
  },
  horizontalRule: {
    height: 1,
    backgroundColor: COLORS.borderPrimary,
    marginVertical: 8,
  },
  tableScrollContainer: {
    marginVertical: 8,
  },
  table: {
    borderWidth: 1,
    borderColor: '#2a2a4e',
    borderRadius: 6,
    overflow: 'hidden',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a4e',
  },
  tableCell: {
    minWidth: TABLE_CELL_MIN_WIDTH,
    padding: 8,
    borderRightWidth: 1,
    borderRightColor: '#2a2a4e',
    justifyContent: 'center',
  },
  tableHeaderCell: {
    backgroundColor: '#1a1a2e',
  },
  tableHeaderText: {
    color: '#4a9eff',
    fontSize: 13,
    fontWeight: '600',
  },
  depthIndicator: {
    color: COLORS.textDim,
    fontSize: 11,
  },
});
