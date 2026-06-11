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
import { TerminalView, TerminalHandle } from '../../components/TerminalView';

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
