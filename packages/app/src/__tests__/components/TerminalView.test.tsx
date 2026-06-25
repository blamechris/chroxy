/**
 * TerminalView postMessage bridge tests (#5519)
 *
 * The mobile TerminalView delivers batched terminal writes to the embedded
 * xterm WebView via `webViewRef.postMessage(...)` rather than serializing into
 * a JS string and `injectJavaScript`-evaluating it. This test proves:
 *
 *  1. writes are delivered through postMessage (not injectJavaScript),
 *  2. clear() is delivered through postMessage,
 *  3. escaping-sensitive content (quotes, backticks, backslashes, ANSI escape
 *     sequences, emoji / UTF-16 surrogate pairs) round-trips byte-identical
 *     across the RN -> WebView bridge — the class of bug that string-eval
 *     injection invites,
 *  4. writes arriving before the WebView signals `ready` are queued and
 *     flushed (in order) once ready, with no data loss.
 *
 * The WebView is mocked in jest.setup.js. The mock captures every postMessage
 * payload and lets the test drive the WebView -> RN bridge (the `ready`
 * handshake) by invoking the onMessage prop. The page-side parse is exactly
 * `JSON.parse(e.data)` (see xterm-html.ts handleMsg), so we decode captured
 * payloads the same way to assert the terminal would have received identical
 * bytes.
 */
import React from 'react';
import { create, act, ReactTestRenderer } from 'react-test-renderer';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import {
  TerminalView,
  TerminalHandle,
  shouldAllowTerminalNavigation,
} from '../../components/TerminalView';

interface MockWebViewInstance {
  postMessage: jest.Mock;
  injectJavaScript: jest.Mock;
  emitMessage: (data: string) => void;
}

function getWebView(): MockWebViewInstance {
  return (global as unknown as { __lastWebViewInstance: MockWebViewInstance })
    .__lastWebViewInstance;
}

// Decode a captured RN->WebView postMessage payload the way the embedded
// xterm page does (handleMsg: JSON.parse(e.data)).
function decode(payload: string): { type: string; data?: string } {
  return JSON.parse(payload);
}

function renderTerminal(): {
  renderer: ReactTestRenderer;
  handleRef: React.RefObject<TerminalHandle | null>;
} {
  const handleRef = React.createRef<TerminalHandle>();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<TerminalView ref={handleRef} />);
  });
  return { renderer, handleRef };
}

function markReady(): void {
  act(() => {
    getWebView().emitMessage(
      JSON.stringify({ type: 'ready', cols: 80, rows: 24 }),
    );
  });
}

describe('TerminalView postMessage bridge (#5519)', () => {
  it('delivers writes via postMessage, not injectJavaScript', () => {
    const { handleRef } = renderTerminal();
    markReady();
    const wv = getWebView();
    wv.postMessage.mockClear();

    act(() => {
      handleRef.current!.write('hello world');
    });

    expect(wv.injectJavaScript).not.toHaveBeenCalled();
    expect(wv.postMessage).toHaveBeenCalledTimes(1);
    const msg = decode(wv.postMessage.mock.calls[0][0]);
    expect(msg).toEqual({ type: 'write', data: 'hello world' });
  });

  it('delivers clear via postMessage', () => {
    const { handleRef } = renderTerminal();
    markReady();
    const wv = getWebView();
    wv.postMessage.mockClear();

    act(() => {
      handleRef.current!.clear();
    });

    expect(wv.injectJavaScript).not.toHaveBeenCalled();
    expect(wv.postMessage).toHaveBeenCalledTimes(1);
    expect(decode(wv.postMessage.mock.calls[0][0])).toEqual({ type: 'clear' });
  });

  describe('escaping-sensitive content round-trips byte-identical', () => {
    const cases: Array<[string, string]> = [
      ['double quotes', 'echo "hello"'],
      ['single quotes', "echo 'world'"],
      ['backticks', 'echo `whoami` and ```fence```'],
      ['backslashes', 'C:\\path\\to\\file and \\n literal'],
      ['dollar template', 'price is ${value} and $HOME'],
      ['newlines and tabs', 'line1\nline2\tcol\r\n'],
      ['ANSI color sequence', '\x1b[31mred\x1b[0m \x1b[1;32mgreen\x1b[0m'],
      ['ANSI cursor + clear', '\x1b[2J\x1b[H\x1b[?25l'],
      ['emoji surrogate pairs', 'done 🎉 fire 🔥 family 👨‍👩‍👧‍👦'],
      ['lone-ish high codepoints', '𝕳𝖊𝖑𝖑𝖔 \u{1F600}'],
      ['null and control bytes', 'a\x00b\x07c\x08d'],
      ['mixed shell + ansi + emoji', '\x1b[33m$ git commit -m "fix: \\`bug\\`"\x1b[0m 🚀'],
      ['html-ish injection attempt', '</script><script>alert(1)</script>'],
      ['unicode whitespace', 'a b c d'],
    ];

    it.each(cases)('round-trips: %s', (_label, input) => {
      const { handleRef } = renderTerminal();
      markReady();
      const wv = getWebView();
      wv.postMessage.mockClear();

      act(() => {
        handleRef.current!.write(input);
      });

      expect(wv.postMessage).toHaveBeenCalledTimes(1);
      const decoded = decode(wv.postMessage.mock.calls[0][0]);
      expect(decoded.type).toBe('write');
      // Byte-identical: the terminal receives exactly what we wrote.
      expect(decoded.data).toBe(input);
      // Code-unit-level equality guard against any silent normalization.
      expect([...(decoded.data ?? '')].map((c) => c.codePointAt(0))).toEqual(
        [...input].map((c) => c.codePointAt(0)),
      );
    });
  });

  it('queues writes before ready and flushes them in order once ready', () => {
    const { handleRef } = renderTerminal();
    const wv = getWebView();

    // No ready yet — these must be buffered, not sent.
    act(() => {
      handleRef.current!.write('first ');
      handleRef.current!.write('"second" ');
      handleRef.current!.write('🔥 third');
    });
    expect(wv.postMessage).not.toHaveBeenCalled();
    expect(wv.injectJavaScript).not.toHaveBeenCalled();

    // Ready handshake flushes the queue.
    markReady();

    expect(wv.postMessage).toHaveBeenCalledTimes(1);
    const decoded = decode(wv.postMessage.mock.calls[0][0]);
    expect(decoded).toEqual({ type: 'write', data: 'first "second" 🔥 third' });
  });

  it('drops queued writes on clear before ready', () => {
    const { handleRef } = renderTerminal();
    const wv = getWebView();

    act(() => {
      handleRef.current!.write('buffered');
      handleRef.current!.clear();
    });

    markReady();

    // clear() emptied the pending buffer; nothing to flush, and clear() before
    // ready does not post (matches existing semantics).
    expect(wv.postMessage).not.toHaveBeenCalled();
  });
});

describe('TerminalView interactive input (#6003)', () => {
  // Find a captured RN->WebView bridge message of a given type.
  function findPosted(type: string): Record<string, unknown> | undefined {
    return getWebView()
      .postMessage.mock.calls.map((c) => JSON.parse(c[0] as string))
      .find((m) => m.type === type);
  }

  it('enables stdin on ready when interactive (posts set-interactive:true)', () => {
    act(() => {
      create(<TerminalView interactive />);
    });
    markReady();
    expect(findPosted('set-interactive')).toEqual({ type: 'set-interactive', enabled: true });
  });

  it('does NOT enable stdin on ready when read-only (default)', () => {
    act(() => {
      create(<TerminalView />);
    });
    markReady();
    const setTrue = getWebView()
      .postMessage.mock.calls.map((c) => JSON.parse(c[0] as string))
      .find((m) => m.type === 'set-interactive' && m.enabled === true);
    expect(setTrue).toBeUndefined();
  });

  it('forwards xterm input (onData → {type:\'input\'}) to onInput', () => {
    const onInput = jest.fn();
    act(() => {
      create(<TerminalView interactive onInput={onInput} />);
    });
    markReady();
    act(() => {
      getWebView().emitMessage(JSON.stringify({ type: 'input', data: 'ls -la\r' }));
    });
    expect(onInput).toHaveBeenCalledWith('ls -la\r');
  });

  it('IGNORES an input message when read-only (defense vs unexpected WebView messages)', () => {
    const onInput = jest.fn();
    act(() => {
      create(<TerminalView onInput={onInput} />); // not interactive
    });
    markReady();
    act(() => {
      getWebView().emitMessage(JSON.stringify({ type: 'input', data: 'rm -rf /\r' }));
    });
    expect(onInput).not.toHaveBeenCalled();
  });

  it('focus() is a no-op when read-only (does not summon the keyboard)', () => {
    const handleRef = React.createRef<TerminalHandle>();
    act(() => {
      create(<TerminalView ref={handleRef} />); // not interactive
    });
    markReady();
    const wv = getWebView();
    wv.postMessage.mockClear();
    act(() => {
      handleRef.current!.focus();
    });
    expect(wv.postMessage).not.toHaveBeenCalled();
  });

  it('focus() posts a focus bridge message', () => {
    const handleRef = React.createRef<TerminalHandle>();
    act(() => {
      create(<TerminalView ref={handleRef} interactive />);
    });
    markReady();
    const wv = getWebView();
    wv.postMessage.mockClear();
    act(() => {
      handleRef.current!.focus();
    });
    expect(JSON.parse(wv.postMessage.mock.calls[0][0] as string)).toEqual({ type: 'focus' });
  });

  it('pushes interactivity changes after ready (read-only → interactive toggle)', () => {
    const handleRef = React.createRef<TerminalHandle>();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<TerminalView ref={handleRef} interactive={false} />);
    });
    markReady();
    const wv = getWebView();
    wv.postMessage.mockClear();
    act(() => {
      renderer.update(<TerminalView ref={handleRef} interactive />);
    });
    expect(findPosted('set-interactive')).toEqual({ type: 'set-interactive', enabled: true });
  });

  it('re-applies interactive state on a crash-recovery reload (second ready)', () => {
    act(() => {
      create(<TerminalView interactive />);
    });
    markReady();
    const wv = getWebView();
    wv.postMessage.mockClear();
    // Simulate the WebView content process being killed and the page reloading:
    // it re-emits `ready`, and the handler must re-enable stdin (the reloaded
    // page reset to disableStdin: true).
    markReady();
    expect(findPosted('set-interactive')).toEqual({ type: 'set-interactive', enabled: true });
  });

  it('gates textInteractionEnabled + keyboardDisplayRequiresUserAction on interactive', () => {
    let roRenderer!: ReactTestRenderer;
    act(() => {
      roRenderer = create(<TerminalView />);
    });
    const roWebView = roRenderer.root.findByProps({ testID: 'webview' });
    expect(roWebView.props.textInteractionEnabled).toBe(false);
    // Read-only keeps the pre-PR behavior (prop left undefined, not forced false).
    expect(roWebView.props.keyboardDisplayRequiresUserAction).toBeUndefined();

    let intRenderer!: ReactTestRenderer;
    act(() => {
      intRenderer = create(<TerminalView interactive />);
    });
    const intWebView = intRenderer.root.findByProps({ testID: 'webview' });
    expect(intWebView.props.textInteractionEnabled).toBe(true);
    expect(intWebView.props.keyboardDisplayRequiresUserAction).toBe(false);
  });
});

describe('TerminalView navigation allow-list (#5645)', () => {
  // The xterm document loads from an inline `source={{ html }}` with no baseUrl,
  // so RN WebView reports the document URL as `about:blank` on iOS
  // (loadHTMLString:baseURL:about:blank) and as the empty string '' on Android
  // (loadDataWithBaseURL("", ...)). The crash-recovery reload() reloads that
  // same document. Only those two exact URLs may proceed; any other navigation
  // — including other `about:` pseudo-pages — is blocked.
  function makeRequest(
    overrides: Partial<ShouldStartLoadRequest>,
  ): ShouldStartLoadRequest {
    return {
      url: '',
      navigationType: 'other',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      lockIdentifier: 0,
      ...overrides,
    } as ShouldStartLoadRequest;
  }

  it('allows the initial inline document load (about:blank)', () => {
    expect(
      shouldAllowTerminalNavigation(
        makeRequest({ url: 'about:blank', navigationType: 'other' }),
      ),
    ).toBe(true);
  });

  it('allows an empty-url inline load (Android loadDataWithBaseURL "")', () => {
    expect(
      shouldAllowTerminalNavigation(makeRequest({ url: '' })),
    ).toBe(true);
  });

  it('allows the crash-recovery reload of the inline document', () => {
    expect(
      shouldAllowTerminalNavigation(
        makeRequest({ url: 'about:blank', navigationType: 'reload' }),
      ),
    ).toBe(true);
  });

  it('blocks an external https navigation (server-controlled ANSI / link tap)', () => {
    expect(
      shouldAllowTerminalNavigation(
        makeRequest({ url: 'https://evil.example', navigationType: 'click' }),
      ),
    ).toBe(false);
  });

  it('blocks http, data:, and deep-link navigations', () => {
    expect(
      shouldAllowTerminalNavigation(makeRequest({ url: 'http://evil.example' })),
    ).toBe(false);
    expect(
      shouldAllowTerminalNavigation(
        makeRequest({ url: 'data:text/html,<script>alert(1)</script>' }),
      ),
    ).toBe(false);
    expect(
      shouldAllowTerminalNavigation(makeRequest({ url: 'chroxy://pair?token=x' })),
    ).toBe(false);
  });

  it('blocks other about: pseudo-pages (only about:blank is the inline doc)', () => {
    // The guard must allow ONLY the exact inline-load URLs, not any about:* URL —
    // about:srcdoc / about:version etc. are not the terminal document.
    expect(
      shouldAllowTerminalNavigation(makeRequest({ url: 'about:srcdoc' })),
    ).toBe(false);
    expect(
      shouldAllowTerminalNavigation(makeRequest({ url: 'about:version' })),
    ).toBe(false);
    expect(
      shouldAllowTerminalNavigation(makeRequest({ url: 'about:blank#evil' })),
    ).toBe(false);
  });

  it('wires the guard onto the WebView with a permissive originWhitelist', () => {
    const handleRef = React.createRef<TerminalHandle>();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<TerminalView ref={handleRef} />);
    });
    const webView = renderer.root.findByProps({ testID: 'webview' });
    // originWhitelist stays `['*']` so RN's whitelist never rejects the Android
    // empty ('') inline-load origin (see "RN whitelist wrapper" below). The real
    // containment is onShouldStartLoadWithRequest, asserted next.
    expect(webView.props.originWhitelist).toEqual(['*']);
    expect(webView.props.onShouldStartLoadWithRequest).toBe(
      shouldAllowTerminalNavigation,
    );
    // The guard, as wired, blocks an external nav and allows the inline doc.
    expect(
      webView.props.onShouldStartLoadWithRequest(
        makeRequest({ url: 'https://evil.example' }),
      ),
    ).toBe(false);
    expect(
      webView.props.onShouldStartLoadWithRequest(
        makeRequest({ url: 'about:blank' }),
      ),
    ).toBe(true);
  });
});

describe('TerminalView originWhitelist passes RN whitelist for both inline-load origins (#5645)', () => {
  // Regression guard for the latent Android-blanking trap: the previous PR
  // narrowed originWhitelist to ['about:*'], which RN WebView's REAL whitelist
  // does NOT pass for Android's empty-string ('') inline-load origin — only a
  // future Android navigation routed through the whitelist would expose it, and
  // it would blank the terminal with no recovery. Here we run RN WebView
  // 13.15.0's actual compileWhitelist/passesWhitelist (replicated verbatim from
  // react-native-webview/src/WebViewShared.tsx, with the real escape-string-regexp
  // semantics) against the originWhitelist the component ships, and assert BOTH
  // the iOS ('about:blank') and Android ('') inline-load URLs pass. If a future
  // change re-narrows originWhitelist in a way that rejects '', this fails.

  // --- escape-string-regexp@4 (RN webview's dep) ---
  const escapeStringRegexp = (s: string): string =>
    s.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&').replace(/-/g, '\\x2d');

  // --- verbatim from react-native-webview@13.15.0 WebViewShared.tsx ---
  const extractOrigin = (url: string): string => {
    const result = /^[A-Za-z][A-Za-z0-9+\-.]+:(\/\/)?[^/]*/.exec(url);
    return result === null ? '' : result[0];
  };
  const originWhitelistToRegex = (ow: string): string =>
    `^${escapeStringRegexp(ow).replace(/\\\*/g, '.*')}`;
  const passesWhitelist = (compiled: readonly string[], url: string): boolean => {
    const origin = extractOrigin(url);
    return compiled.some((x) => new RegExp(x).test(origin));
  };
  const compileWhitelist = (ow: readonly string[]): readonly string[] =>
    ['about:blank', ...(ow || [])].map(originWhitelistToRegex);
  // --- end verbatim ---

  function shippedOriginWhitelist(): string[] {
    const handleRef = React.createRef<TerminalHandle>();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<TerminalView ref={handleRef} />);
    });
    const webView = renderer.root.findByProps({ testID: 'webview' });
    return webView.props.originWhitelist as string[];
  }

  it('passes both about:blank (iOS) and "" (Android) through the real RN filter', () => {
    const ow = shippedOriginWhitelist();
    const compiled = compileWhitelist(ow);
    expect(passesWhitelist(compiled, 'about:blank')).toBe(true);
    expect(passesWhitelist(compiled, '')).toBe(true);
  });

  it('sanity-check: ["about:*"] would NOT pass the Android "" origin', () => {
    // Proves the test has teeth — the narrowed value the reviewer flagged fails.
    const compiled = compileWhitelist(['about:*']);
    expect(passesWhitelist(compiled, 'about:blank')).toBe(true);
    expect(passesWhitelist(compiled, '')).toBe(false);
  });
});

/**
 * #6329 — manual "refresh terminal" resync button. The button is presentation-only;
 * SessionScreen passes `onRefresh` (= requestTerminalResync(activeSessionId)) only
 * when the active session is a resync-eligible PTY mirror and not an observer. These
 * pin the wiring: the button renders + fires onRefresh when the prop is supplied, and
 * is absent (the gated-off case) when it isn't.
 */
describe('TerminalView — #6329 manual resync button', () => {
  it('renders the ⟳ button and calls onRefresh on press when onRefresh is provided', () => {
    const onRefresh = jest.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<TerminalView onRefresh={onRefresh} />);
    });
    const button = renderer.root.findByProps({ testID: 'terminal-resync-button' });
    act(() => {
      button.props.onPress();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not render the resync button when onRefresh is omitted (gated-off case)', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<TerminalView />);
    });
    expect(renderer.root.findAllByProps({ testID: 'terminal-resync-button' })).toHaveLength(0);
  });
});
