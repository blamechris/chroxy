import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
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
  /** #6003 — focus the terminal (summons the soft keyboard when interactive). */
  focus: () => void;
}

export interface TerminalViewProps {
  onResize?: (cols: number, rows: number) => void;
  onReady?: () => void;
  // #6003 — when true, xterm stdin is enabled (interactive user-shell PTY) and
  // keystrokes/paste stream back via onInput. Defaults to read-only (chat /
  // claude-tui mirror) so existing behavior is unchanged.
  interactive?: boolean;
  onInput?: (data: string) => void;
  // #6329 — when provided, render a manual "refresh terminal" control that forces a
  // resync repaint (the auto-resync on (re)subscribe is already wired in
  // SessionScreen). Omitted (no button) when there's no resync-eligible session —
  // e.g. a claude-tui mirror or an observer — so the affordance only appears where it
  // works. The server still enforces resync authority, so this is a UX gate.
  onRefresh?: () => void;
}

// -- Component --

export const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(function TerminalView({ onResize, onReady, interactive, onInput, onRefresh }, ref) {
  const webViewRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  const pendingWritesRef = useRef<string[]>([]);
  const [recovering, setRecovering] = useState(false);
  const recoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // #6003 — keep onInput + interactive in refs so the (stable) message handler
  // and the ready path read the latest without re-subscribing.
  const onInputRef = useRef(onInput);
  const interactiveRef = useRef(interactive);
  useEffect(() => { onInputRef.current = onInput; }, [onInput]);
  useEffect(() => { interactiveRef.current = interactive; }, [interactive]);

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

  // #6003 — toggle xterm stdin / focus the terminal via the bridge.
  const postSetInteractive = useCallback((enabled: boolean) => {
    webViewRef.current?.postMessage(JSON.stringify({ type: 'set-interactive', enabled }));
  }, []);
  const postFocus = useCallback(() => {
    webViewRef.current?.postMessage(JSON.stringify({ type: 'focus' }));
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
    focus() {
      // Only an interactive terminal should summon the soft keyboard.
      if (readyRef.current && interactiveRef.current) postFocus();
    },
  }), [postWrite, postClear, postFocus]);

  // #6003 — push interactivity changes once the page is ready. The ready handler
  // (below) applies the initial state via interactiveRef, so this only fires for
  // post-ready toggles (e.g. switching to/from a user-shell session).
  useEffect(() => {
    if (readyRef.current) postSetInteractive(!!interactive);
  }, [interactive, postSetInteractive]);

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
        // #6003 — apply the current interactivity state to the freshly-loaded
        // page (initial mount and after a crash-recovery reload).
        if (interactiveRef.current) postSetInteractive(true);
        onReady?.();
        // Forward initial dimensions so the PTY is sized correctly on mount/reload
        if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          onResize?.(msg.cols, msg.rows);
        }
      } else if (msg.type === 'resize') {
        onResize?.(msg.cols, msg.rows);
      } else if (msg.type === 'input') {
        // #6003 — a keystroke/paste from an interactive terminal. Guard on
        // interactivity too (not just the WebView's disableStdin) so an
        // unexpected/malicious 'input' message can't drive a read-only terminal.
        if (interactiveRef.current && typeof msg.data === 'string') onInputRef.current?.(msg.data);
      }
    } catch {
      // Ignore malformed messages
    }
  }, [postWrite, postSetInteractive, onReady, onResize]);

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
      {/* #6329 — manual resync: force a fresh repaint if the live mirror looks
          out of sync (the auto-resync on resubscribe is the primary recovery). */}
      {onRefresh && (
        <TouchableOpacity
          style={styles.refreshButton}
          onPress={onRefresh}
          testID="terminal-resync-button"
          accessibilityRole="button"
          accessibilityLabel="Refresh terminal"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.refreshGlyph}>⟳</Text>
        </TouchableOpacity>
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
        // #6003 — allow text interaction (tap-to-focus → soft keyboard) only for
        // an interactive user-shell terminal; a read-only chat/mirror terminal
        // stays selection-free as before.
        textInteractionEnabled={!!interactive}
        // #6003 — for an interactive terminal, let a tap inside the WebView
        // summon the keyboard without an extra user gesture (the tap itself is
        // the gesture). Left undefined for a read-only terminal so its behavior
        // is unchanged from before this PR. iOS-only prop.
        keyboardDisplayRequiresUserAction={interactive ? false : undefined}
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
  // #6329 — small top-right corner control, mirrors the dashboard's ⟳ resync button.
  refreshButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 2,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(26, 26, 46, 0.85)',
  },
  refreshGlyph: {
    color: COLORS.textDim,
    fontSize: 16,
    lineHeight: 18,
    fontWeight: '600',
  },
});
