import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { buildXtermHtml } from './xterm-html';
import { COLORS } from '../constants/colors';

/**
 * Navigation allow-list for the embedded xterm WebView (#5645).
 *
 * The terminal is rendered from an inline `source={{ html }}` document with no
 * `baseUrl`. RN WebView's native code falls back to `about:blank` as the base
 * URL on iOS (RNCWebViewImpl.m: `loadHTMLString:baseURL:about:blank`) and loads
 * via `loadDataWithBaseURL("", ...)` on Android — so the document's request URL
 * is reported as `about:blank` (iOS) or the empty string (Android). That
 * document is purely display-only — it never navigates. The crash-recovery
 * `reload()` path simply re-loads the *same* inline document, which again
 * surfaces as `about:blank` / `''`.
 *
 * Defense-in-depth: server-controlled ANSI (or a future xterm web-links addon /
 * regression) must never be able to trigger a navigation away from that
 * document. So we allow ONLY the inline document load (and its reload) and block
 * everything else — http/https, link taps, data: URLs, deep links, `about:`
 * pseudo-pages like `about:srcdoc`/`about:version`, etc.
 *
 * `originWhitelist` is the coarse origin pre-filter; `onShouldStartLoadWithRequest`
 * (this guard) is the precise per-request gate and the *real* containment control —
 * it is consulted for every real navigation. We deliberately keep `originWhitelist`
 * at the permissive `['*']`: RN WebView's own `compileWhitelist`/`passesWhitelist`
 * (WebViewShared.tsx) compute `extractOrigin('') === ''`, and ONLY the compiled
 * `'*'` -> `^.*` regex matches that empty origin. A narrower value such as
 * `['about:*']` rejects Android's empty (`''`) inline-load origin, which would
 * blank the terminal with no recovery the moment any Android navigation is routed
 * through the whitelist. The narrowing lives in this guard instead, where it can't
 * break the legitimate inline load on either platform. (Empirically verified
 * against the real RN filter — see TerminalView.test.tsx "RN whitelist wrapper".)
 */
function isInlineDocumentRequest(request: ShouldStartLoadRequest): boolean {
  // The inline `source={{ html }}` with no baseUrl resolves to exactly
  // `about:blank` on iOS (loadHTMLString:baseURL:about:blank) and to the empty
  // string `''` on Android (loadDataWithBaseURL("", ...)). Allow ONLY those two
  // exact URLs — nothing else, including other `about:` pseudo-pages.
  const url = request.url ?? '';
  return url === '' || url === 'about:blank';
}

export function shouldAllowTerminalNavigation(request: ShouldStartLoadRequest): boolean {
  return isInlineDocumentRequest(request);
}

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

  // Deliver a write to the embedded xterm page via postMessage. The page's
  // `message` listener (see xterm-html.ts handleMsg) parses the payload with
  // JSON.parse(e.data), so JSON.stringify here makes the data round-trip
  // byte-identical — quotes, backticks, backslashes, ANSI escapes and
  // emoji/UTF-16 surrogate pairs survive without the string-eval escaping
  // hazards of injectJavaScript (#5519).
  const postWrite = useCallback((data: string) => {
    webViewRef.current?.postMessage(JSON.stringify({ type: 'write', data }));
  }, []);

  const postClear = useCallback(() => {
    webViewRef.current?.postMessage(JSON.stringify({ type: 'clear' }));
  }, []);

  useImperativeHandle(ref, () => ({
    write(data: string) {
      if (readyRef.current) {
        postWrite(data);
      } else {
        pendingWritesRef.current.push(data);
      }
    },
    clear() {
      if (readyRef.current) {
        postClear();
      }
      pendingWritesRef.current = [];
    },
  }), [postWrite, postClear]);

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
          postWrite(pending.join(''));
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
  }, [postWrite, onReady, onResize]);

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
    <View style={styles.wrapper} testID="terminal-view">
      {recovering && (
        <View style={styles.recoveryBanner}>
          <Text style={styles.recoveryText}>Terminal recovering...</Text>
        </View>
      )}
      <WebView
        ref={webViewRef}
        source={{ html }}
        style={styles.container}
        // Containment (#5645): only the inline xterm document may load; block
        // any server-/ANSI-triggered navigation. The real gate is
        // onShouldStartLoadWithRequest below (consulted for every navigation).
        // originWhitelist stays `['*']` because RN's whitelist rejects Android's
        // empty (`''`) inline-load origin for any narrower glob — narrowing it
        // would blank the terminal. See shouldAllowTerminalNavigation.
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={shouldAllowTerminalNavigation}
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
