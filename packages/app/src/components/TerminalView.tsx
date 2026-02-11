import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { buildXtermHtml } from './xterm-html';
import { COLORS } from '../constants/colors';

// -- Public handle --

export interface TerminalHandle {
  write: (data: string) => void;
  clear: () => void;
}

// -- Component --

export const TerminalView = forwardRef<TerminalHandle>(function TerminalView(_props, ref) {
  const webViewRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  const pendingWritesRef = useRef<string[]>([]);

  const html = useMemo(() => buildXtermHtml(), []);

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
        // Flush any pending writes
        const pending = pendingWritesRef.current;
        pendingWritesRef.current = [];
        if (pending.length > 0) {
          injectWrite(pending.join(''));
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }, [injectWrite]);

  return (
    <WebView
      ref={webViewRef}
      source={{ html }}
      style={styles.container}
      originWhitelist={['*']}
      onMessage={handleMessage}
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
  );
});

// -- Styles --

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.backgroundTerminal,
  },
});
