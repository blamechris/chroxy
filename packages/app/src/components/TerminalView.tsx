import React, { useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, Platform } from 'react-native';

// -- Props --

export interface TerminalViewProps {
  content: string;
  scrollViewRef: React.RefObject<ScrollView | null>;
}

// -- Helpers --

/**
 * Process raw terminal buffer for plain-text display.
 * Handles \r\n line endings and standalone \r (carriage return)
 * which overwrites the current line in a real terminal.
 */
function processTerminalBuffer(buffer: string): string {
  // Normalize \r\n to \n first
  let text = buffer.replace(/\r\n/g, '\n');
  // For each line, keep only content after the last \r (simulates CR overwrite)
  return text
    .split('\n')
    .map((line) => {
      const lastCR = line.lastIndexOf('\r');
      return lastCR >= 0 ? line.substring(lastCR + 1) : line;
    })
    .join('\n');
}

// -- Component --

export function TerminalView({ content, scrollViewRef }: TerminalViewProps) {
  const processed = useMemo(() => processTerminalBuffer(content), [content]);

  return (
    <ScrollView
      ref={scrollViewRef}
      style={styles.terminalContainer}
      contentContainerStyle={styles.terminalContent}
      keyboardDismissMode="on-drag"
      onContentSizeChange={() => scrollViewRef.current?.scrollToEnd()}
    >
      <Text style={styles.terminalText}>{processed || 'Connected. Terminal output will appear here...'}</Text>
    </ScrollView>
  );
}

// -- Styles --

const styles = StyleSheet.create({
  terminalContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  terminalContent: {
    padding: 12,
  },
  terminalText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    color: '#00ff00',
    lineHeight: 16,
  },
});
