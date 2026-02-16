import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { buildXtermHtml } from './xterm-html';
import { COLORS } from '../constants/colors';

// -- Public handle --

export interface TerminalHandle {
  write: (data: string) => void;
  clear: () => void;
}

export interface TerminalViewProps {
  onResize?: (cols: number, rows: number) => void;
  onReady?: () => void;
}

// -- Component --

export const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(function TerminalView({ onResize, onReady }, ref) {
  const webViewRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  const pendingWritesRef = useRef<string[]>([]);
  const [recovering, setRecovering] = useState(false);
  const recoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const html = useMemo(() => buildXtermHtml(), []);

  // Cleanup safety timer on unmount
  useEffect(() => {
    return () => {
      if (recoverTimerRef.current) clearTimeout(recoverTimerRef.current);
    };
  }, []);

  const injectWrite = useCallback((data: string) => {
    if (!webViewRef.current) return;
    // Escape for safe injection into JS string literal
    const escaped = JSON.stringify(data);
    webViewRef.current.injectJavaScript(
      `try{handleMsg({data:JSON.stringify({type:'write',data:${escaped}})})}catch(e){};true;`
    );
  }, []);

  const injectClear = useCallback(() => {
    if (!webViewRef.current) return;
    webViewRef.current.injectJavaScript(
      `try{handleMsg({data:JSON.stringify({type:'clear'})})}catch(e){};true;`
    );
  }, []);

  useImperativeHandle(ref, () => ({
    write(data: string) {
      if (readyRef.current) {
        injectWrite(data);
      } else {
        pendingWritesRef.current.push(data);
      }
    },
    clear() {
      if (readyRef.current) {
        injectClear();
      }
      pendingWritesRef.current = [];
    },
  }), [injectWrite, injectClear]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'ready') {
        readyRef.current = true;
        setRecovering(false);
        if (recoverTimerRef.current) {
          clearTimeout(recoverTimerRef.current);
          recoverTimerRef.current = null;
        }
        // Flush any pending writes
        const pending = pendingWritesRef.current;
        pendingWritesRef.current = [];
        if (pending.length > 0) {
          injectWrite(pending.join(''));
        }
        onReady?.();
        // Forward initial dimensions so the PTY is sized correctly on mount/reload
        if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          onResize?.(msg.cols, msg.rows);
        }
      } else if (msg.type === 'resize') {
        onResize?.(msg.cols, msg.rows);
      }
    } catch {
      // Ignore malformed messages
    }
  }, [injectWrite, onReady, onResize]);

  // Crash recovery: reload WebView when the OS kills the content process
  const handleWebViewCrash = useCallback(() => {
    readyRef.current = false;
    pendingWritesRef.current = [];
    setRecovering(true);
    // Safety timeout: auto-clear in case reload fails silently
    if (recoverTimerRef.current) clearTimeout(recoverTimerRef.current);
    recoverTimerRef.current = setTimeout(() => setRecovering(false), 10000);
    webViewRef.current?.reload();
  }, []);

  return (
    <View style={styles.wrapper}>
      {recovering && (
        <View style={styles.recoveryBanner}>
          <Text style={styles.recoveryText}>Terminal recovering...</Text>
        </View>
      )}
      <WebView
        ref={webViewRef}
        source={{ html }}
        style={styles.container}
        originWhitelist={['*']}
        onMessage={handleMessage}
        onContentProcessDidTerminate={handleWebViewCrash}
        onRenderProcessGone={handleWebViewCrash}
        scrollEnabled={false}
        bounces={false}
        javaScriptEnabled={true}
        androidLayerType="hardware"
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        // Prevent text selection in WebView (display-only terminal)
        textInteractionEnabled={false}
      />
    </View>
  );
});

// -- Styles --

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: COLORS.backgroundTerminal,
  },
  recoveryBanner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
    backgroundColor: COLORS.accentOrangeMedium,
    paddingVertical: 6,
    alignItems: 'center',
  },
  recoveryText: {
    color: COLORS.accentOrange,
    fontSize: 13,
    fontWeight: '600',
  },
});
