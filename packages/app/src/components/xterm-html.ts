import { COLORS } from '../constants/colors';
import { XTERM_CSS, XTERM_JS, FIT_ADDON_JS } from './xterm-bundle.generated';

/**
 * Builds an inline HTML string that hosts xterm.js inside a WebView.
 *
 * xterm.js + FitAddon are bundled locally (inlined from node_modules via
 * scripts/bundle-xterm.js) so the terminal works offline without CDN access.
 *
 * The terminal starts display-only (disableStdin: true). For a chat session,
 * input goes through InputBar. For an interactive user-shell PTY (#6003), RN
 * sends {type:'set-interactive', enabled:true} to enable stdin; xterm's onData
 * then streams keystrokes back to RN as {type:'input', data} → terminal_input.
 *
 * Bridge protocol:
 *   RN → WebView (postMessage): {type:'write', data:string}, {type:'clear'}, {type:'reset'},
 *                               {type:'set-interactive', enabled:boolean}, {type:'focus'}
 *   WebView → RN (postMessage): {type:'ready', cols:number, rows:number},
 *                               {type:'resize', cols:number, rows:number},
 *                               {type:'input', data:string}  (interactive only)
 */
export function buildXtermHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: ${COLORS.backgroundTerminal}; }
  #terminal { width: 100%; height: 100%; }
</style>
<style>${XTERM_CSS}</style>
</head>
<body>
<div id="terminal"></div>
<script>${XTERM_JS}<\/script>
<script>${FIT_ADDON_JS}<\/script>
<script>
(function() {
  var fitAddon = new FitAddon.FitAddon();
  var term = new Terminal({
    disableStdin: true,
    convertEol: true,
    scrollback: 5000,
    cursorBlink: false,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, Courier New, monospace',
    theme: {
      background: '${COLORS.backgroundTerminal}',
      foreground: '${COLORS.textTerminal}',
      cursor: '${COLORS.textTerminal}',
      selectionBackground: '${COLORS.accentBlueSubtle}',
      black: '#000000',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#6272a4',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#555555',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff'
    }
  });

  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));

  // #6003: stream keystrokes to RN. onData only fires while stdin is enabled
  // (set-interactive below), so this is inert for read-only chat/mirror
  // terminals. Covers typed keys, pasted text (bracketed paste — one onData),
  // and xterm-synthesized control sequences.
  term.onData(function(data) {
    // Read-only safety belt: onData should only fire while stdin is enabled, but
    // enforce it here too so a future xterm version that emits onData for
    // programmatic writes can never leak input from a read-only terminal.
    if (term.options.disableStdin) return;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'input', data: data }));
  });

  // #6003: tapping an interactive terminal focuses xterm's hidden textarea,
  // which summons the soft keyboard (the focus must happen inside the user
  // gesture for iOS to show the keyboard). No-op while read-only.
  document.getElementById('terminal').addEventListener('click', function() {
    if (!term.options.disableStdin) { try { term.focus(); } catch(e) {} }
  });

  // Debounced resize notification (250ms) — avoids flooding during animations/rotations
  var _resizeTimer = null;
  function notifyResize() {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(function() {
      _resizeTimer = null;
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'resize', cols: term.cols, rows: term.rows
      }));
    }, 250);
  }

  // Fit after open and on resize
  try { fitAddon.fit(); } catch(e) {}

  var resizeObserver = new ResizeObserver(function() {
    try { fitAddon.fit(); notifyResize(); } catch(e) {}
  });
  resizeObserver.observe(document.getElementById('terminal'));

  // Notify RN that terminal is ready
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'ready',
    cols: term.cols,
    rows: term.rows
  }));

  // Listen for messages from RN
  window.addEventListener('message', function(e) {
    handleMsg(e);
  });
  // Android uses document.addEventListener
  document.addEventListener('message', function(e) {
    handleMsg(e);
  });

  // Handles RN -> WebView messages delivered via webViewRef.postMessage(...).
  // e.data is the raw string RN sent; we JSON.parse it back to the bridge
  // message. This makes terminal writes round-trip byte-identical (quotes,
  // backticks, backslashes, ANSI escapes, emoji/UTF-16 surrogates) without the
  // string-eval escaping hazards injectJavaScript invited (#5519).
  function handleMsg(e) {
    try {
      var msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'write':
          term.write(msg.data);
          break;
        case 'clear':
          term.clear();
          break;
        case 'reset':
          term.reset();
          break;
        case 'set-interactive':
          // #6003: toggle stdin for an interactive user-shell PTY. When enabling,
          // focus so onData starts flowing (and the keyboard can appear).
          term.options.disableStdin = !msg.enabled;
          if (msg.enabled) { try { term.focus(); } catch(e) {} }
          break;
        case 'focus':
          try { term.focus(); } catch(e) {}
          break;
      }
    } catch(err) {
      // Ignore malformed messages
    }
  }
})();
<\/script>
</body>
</html>`;
}
