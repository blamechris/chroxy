import React, { useCallback, useMemo, useRef } from 'react';
import { Text, ScrollView, StyleSheet, Platform, NativeSyntheticEvent, NativeScrollEvent } from 'react-native';

// -- Props --

export interface TerminalViewProps {
  content: string;
  scrollViewRef: React.RefObject<ScrollView | null>;
}

// -- Constants --

/** Distance (px) from the bottom edge within which we consider the user "at bottom". */
const SCROLL_BOTTOM_THRESHOLD = 50;

/** How long (ms) after a user drag before auto-scroll re-engages. */
const USER_INTERACT_IDLE_MS = 3000;

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
  const isAtBottomRef = useRef(true);
  const userInteractingRef = useRef(false);
  const interactTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    isAtBottomRef.current =
      contentOffset.y + layoutMeasurement.height >=
      contentSize.height - SCROLL_BOTTOM_THRESHOLD;
  }, []);

  /** Mark user as interacting when they begin dragging (scrolling or selecting). */
  const handleScrollBeginDrag = useCallback(() => {
    userInteractingRef.current = true;
    if (interactTimerRef.current) clearTimeout(interactTimerRef.current);
  }, []);

  /** Re-enable auto-scroll after idle period once user stops dragging. */
  const handleScrollEndDrag = useCallback(() => {
    if (interactTimerRef.current) clearTimeout(interactTimerRef.current);
    interactTimerRef.current = setTimeout(() => {
      userInteractingRef.current = false;
    }, USER_INTERACT_IDLE_MS);
  }, []);

  return (
    <ScrollView
      ref={scrollViewRef}
      style={styles.terminalContainer}
      contentContainerStyle={styles.terminalContent}
      keyboardDismissMode="on-drag"
      onScroll={handleScroll}
      scrollEventThrottle={16}
      onScrollBeginDrag={handleScrollBeginDrag}
      onScrollEndDrag={handleScrollEndDrag}
      onContentSizeChange={() => {
        if (isAtBottomRef.current && !userInteractingRef.current) {
          scrollViewRef.current?.scrollToEnd();
        }
      }}
    >
      <Text selectable style={styles.terminalText}>{processed || 'Connected. Terminal output will appear here...'}</Text>
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
