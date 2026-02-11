import { COLORS } from '../constants/colors';
import { XTERM_CSS, XTERM_JS, FIT_ADDON_JS } from './xterm-bundle.generated';

/**
 * Builds an inline HTML string that hosts xterm.js inside a WebView.
 *
 * xterm.js + FitAddon are bundled locally (inlined from node_modules via
 * scripts/bundle-xterm.js) so the terminal works offline without CDN access.
 *
 * The terminal is display-only (disableStdin: true) — input goes through InputBar.
 *
 * Bridge protocol:
 *   RN → WebView (postMessage): {type:'write', data:string}, {type:'clear'}, {type:'reset'}
 *   WebView → RN (postMessage): {type:'ready', cols:number, rows:number}, {type:'resize', cols:number, rows:number}
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
      }
    } catch(err) {
      // Ignore malformed messages
    }
  }

  // Expose handleMsg globally so injectJavaScript can call it from RN
  window.handleMsg = handleMsg;
})();
<\/script>
</body>
</html>`;
}
