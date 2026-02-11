import { COLORS } from '../constants/colors';

/**
 * Builds an inline HTML string that hosts xterm.js inside a WebView.
 *
 * xterm.js + FitAddon are loaded from jsdelivr CDN (pinned versions).
 * The terminal is display-only (disableStdin: true) — input goes through InputBar.
 *
 * Bridge protocol:
 *   RN → WebView (postMessage): {type:'write', data:string}, {type:'clear'}, {type:'reset'}
 *   WebView → RN (postMessage): {type:'ready', cols:number, rows:number}
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
  #error {
    display: none;
    color: ${COLORS.textMuted};
    font-family: monospace;
    font-size: 14px;
    padding: 20px;
    text-align: center;
  }
</style>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
</head>
<body>
<div id="terminal"></div>
<div id="error">Terminal renderer unavailable. Check your internet connection.</div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script>
(function() {
  // Guard against CDN load failure
  if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') {
    document.getElementById('terminal').style.display = 'none';
    document.getElementById('error').style.display = 'block';
    return;
  }

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

  // Fit after open and on resize
  try { fitAddon.fit(); } catch(e) {}

  var resizeObserver = new ResizeObserver(function() {
    try { fitAddon.fit(); } catch(e) {}
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
})();
</script>
</body>
</html>`;
}
