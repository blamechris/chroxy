import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Text, ScrollView, StyleSheet, Platform, NativeSyntheticEvent, NativeScrollEvent, View } from 'react-native';
import { COLORS } from '../constants/colors';


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
  const isSelectingRef = useRef(false);
  const interactTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  /** Track when user starts selecting text (long press on selectable Text). */
  const handleTextTouchStart = useCallback(() => {
    isSelectingRef.current = true;
    if (selectTimerRef.current) clearTimeout(selectTimerRef.current);
  }, []);

  /** Re-enable auto-scroll after user finishes text selection. */
  const handleTextTouchEnd = useCallback(() => {
    if (selectTimerRef.current) clearTimeout(selectTimerRef.current);
    selectTimerRef.current = setTimeout(() => {
      isSelectingRef.current = false;
    }, USER_INTERACT_IDLE_MS);
  }, []);

  /** Clean up pending timers on unmount. */
  useEffect(() => {
    return () => {
      if (interactTimerRef.current) clearTimeout(interactTimerRef.current);
      if (selectTimerRef.current) clearTimeout(selectTimerRef.current);
    };
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
        if (isAtBottomRef.current && !userInteractingRef.current && !isSelectingRef.current) {
          scrollViewRef.current?.scrollToEnd();
        }
      }}
    >
      <View
        onStartShouldSetResponder={() => true}
        onResponderGrant={handleTextTouchStart}
        onResponderRelease={handleTextTouchEnd}
        onResponderTerminate={handleTextTouchEnd}
      >
        <Text selectable style={styles.terminalText}>{processed || 'Connected. Terminal output will appear here...'}</Text>
      </View>
    </ScrollView>
  );
}

// -- Styles --

const styles = StyleSheet.create({
  terminalContainer: {
    flex: 1,
    backgroundColor: COLORS.backgroundTerminal,
  },
  terminalContent: {
    padding: 12,
  },
  terminalText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    color: COLORS.textTerminal,
    lineHeight: 16,
  },
});
