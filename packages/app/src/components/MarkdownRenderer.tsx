import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Platform, Linking, StyleProp, TextStyle, ScrollView } from 'react-native';
import { COLORS } from '../constants/colors';


// -- Content Block Types --

type ContentBlock =
  | { kind: 'code'; lang: string; content: string }
  | { kind: 'text'; content: string };

/** Split content into alternating text and fenced code blocks.
 *  Code fences must start at the beginning of a line -- triple backticks
 *  inside prose (e.g. "Code blocks (```)") are NOT treated as fences. */
function splitContentBlocks(rawContent: string): ContentBlock[] {
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

/** Parse markdown table: | col1 | col2 | ... */
function parseTable(lines: string[], startIndex: number): { headers: string[]; rows: string[][]; endIndex: number } | null {
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
  if (!sepLine.match(/^\s*\|?\s*[-:]+\s*(\|\s*[-:]+\s*)*\|?\s*$/)) return null;

  // Parse data rows - preserve empty cells and normalize row length
  const rows: string[][] = [];
  let i = startIndex + 2;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.includes('|')) break;
    // Split and trim, preserving empty cells between pipes
    const rawCells = line.split('|').map(cell => cell.trim());
    // Remove leading/trailing empty cells (from leading/trailing pipes)
    const cellStart = rawCells[0] === '' ? 1 : 0;
    const cellEnd = rawCells[rawCells.length - 1] === '' ? rawCells.length - 1 : rawCells.length;
    const cells = rawCells.slice(cellStart, cellEnd);
    if (cells.length === 0) break;
    // Normalize row length to match header count (pad with empty strings or truncate)
    while (cells.length < headers.length) cells.push('');
    rows.push(cells.slice(0, headers.length));
    i++;
  }

  return { headers, rows, endIndex: i - 1 };
}

/** Render a markdown table */
function renderTable(headers: string[], rows: string[][], keyBase: string, messageTextStyle: StyleProp<TextStyle>): React.ReactNode {
  return (
    <ScrollView 
      key={keyBase} 
      horizontal 
      showsHorizontalScrollIndicator={true}
      style={md.tableScrollContainer}
    >
      <View style={md.table}>
        {/* Header row */}
        <View style={md.tableRow}>
          {headers.map((header, idx) => (
            <View key={`${keyBase}-h${idx}`} style={[md.tableCell, md.tableHeaderCell]}>
              <Text selectable style={md.tableHeaderText}>{renderInline(header, `${keyBase}-h${idx}`)}</Text>
            </View>
          ))}
        </View>
        {/* Data rows */}
        {rows.map((row, rowIdx) => (
          <View key={`${keyBase}-r${rowIdx}`} style={md.tableRow}>
            {headers.map((_, cellIdx) => (
              <View key={`${keyBase}-r${rowIdx}-c${cellIdx}`} style={md.tableCell}>
                <Text selectable style={messageTextStyle}>{renderInline(row[cellIdx] || '', `${keyBase}-r${rowIdx}-c${cellIdx}`)}</Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
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

      // Table: | col1 | col2 | (check for table starting at this line)
      const tableData = parseTable(lines, i);
      if (tableData) {
        hasViewChildren = true;
        elements.push(renderTable(tableData.headers, tableData.rows, lk, messageTextStyle));
        i = tableData.endIndex; // Skip processed lines
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
        const indent = tlm[1].length;
        const nestLevel = Math.floor(indent / 2);
        const leftMargin = 2 + nestLevel * 16;
        const checked = tlm[2].toLowerCase() === 'x';
        elements.push(<Text key={lk} selectable style={[messageTextStyle, { marginLeft: leftMargin }]}>{checked ? '  \u2611 ' : '  \u2610 '}{renderInline(tlm[3], lk)}</Text>);
        continue;
      }

      // Unordered list with nesting support: - or * (capture leading whitespace for indentation)
      const ulm = line.match(/^(\s*)[-*]\s+(.+)/);
      if (ulm) {
        const indent = ulm[1].length;
        const nestLevel = Math.floor(indent / 2); // 2 spaces = 1 nesting level
        const leftMargin = 2 + nestLevel * 16; // Base 2 + 16px per level
        elements.push(<Text key={lk} selectable style={[messageTextStyle, { marginLeft: leftMargin }]}>{'  \u2022 '}{renderInline(ulm[2], lk)}</Text>);
        continue;
      }

      // Ordered list with nesting support: 1. 2. etc (capture leading whitespace for indentation)
      const olm = line.match(/^(\s*)(\d+)\.\s+(.+)/);
      if (olm) {
        const indent = olm[1].length;
        const nestLevel = Math.floor(indent / 2); // 2 spaces = 1 nesting level
        const leftMargin = 2 + nestLevel * 16; // Base 2 + 16px per level
        elements.push(<Text key={lk} style={{ marginLeft: leftMargin }}>{'  '}{olm[2]}{'. '}{renderInline(olm[3], lk)}</Text>);
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
  // Instead, group consecutive Text-only paragraphs together for cross-paragraph selection
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
        flushTextGroup();
        grouped.push(
          <View key={`para-${idx}`}>
            {para.elements}
          </View>
        );
      } else {
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
    minWidth: 80,
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
});
