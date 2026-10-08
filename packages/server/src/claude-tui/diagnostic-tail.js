/**
 * Readable text out of a raw claude-TUI PTY tail (#8252).
 *
 * The tail is a diagnostic: it goes to the daemon log, never to the chat. It
 * used to be built from `ANSI_STRIP`, which is tuned for the readiness and
 * auth-failure SCANS (it deletes cursor moves so a banner re-assembles for a
 * pattern match). As text for a person it left three kinds of debris:
 *
 *   - private-mode CSI sequences (`ESC [ > 0 q`, `ESC [ > 4 m`, `ESC [ < u`).
 *     The `>` / `<` parameter bytes are outside the `[0-9;?]` set `ANSI_STRIP`
 *     accepts, so only the lone ESC was removed and `[>0q` stayed in the text;
 *   - `ESC 7` / `ESC 8` (save / restore cursor), which became a bare `78`;
 *   - cursor-forward (`ESC [ 2 C`) deleted outright, which is how claude spaces
 *     words on a redraw, so `the single` read `thesingle`;
 *   - the startup banner's block-element and box-drawing glyphs.
 *
 * `ANSI_STRIP` is NOT changed: the auth scans depend on its exact behaviour.
 * This is a separate, display-only pass, applied to the raw bytes when the
 * session has them and to the already-stripped tail otherwise.
 */

// One alternation, longest grammar first. Group 1/2 are only set by the CSI
// arm, so the replacer can tell a cursor move from a colour change.
//   OSC            ESC ] ... ( BEL | ST )          unterminated runs to the next ESC
//   DCS/SOS/PM/APC ESC ( P | X | ^ | _ ) ... ST
//   CSI            ESC [ <0x30-3F>* <0x20-2F>* <0x40-7E>
//   CSI cut off    ESC [ ... at the very end of the buffer
//   other          ESC <0x20-2F>* <0x30-7E>        ESC 7, ESC 8, ESC ( B, ESC =
//   lone ESC       a sequence cut off at the end of the buffer
const ESCAPE_SEQUENCE = new RegExp(
  [
    '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?',
    '\\x1b[PX^_][^\\x1b]*(?:\\x1b\\\\)?',
    '\\x1b\\[([0-?]*)[ -/]*([@-~])',
    '\\x1b\\[[0-?]*[ -/]*$',
    '\\x1b[ -/]*[0-~]',
    '\\x1b',
  ].join('|'),
  'g',
)

// CSI final bytes that MOVE the cursor to another place on the screen. The
// redraw is not reproduced, so a move across is a word gap and a move down or
// to an absolute position is a line break.
const CURSOR_ACROSS = new Set(['C', 'G', '`', 'a'])
const CURSOR_DOWN_OR_HOME = new Set(['A', 'B', 'E', 'F', 'H', 'f', 'd', 'e'])

// The remains of a sequence a byte cap cut in half at the START of the buffer
// (`[2Cthe line`). Only ever trusted when the caller says the start was cut:
// anywhere else a bracket run is ordinary text (`[3D model]`, `[<filepath>]`,
// `[=value]`, `[>file]`, `[?help]`), and a pass that guesses deletes real words.
// A tail whose escapes were already stripped (the `_outputTail` fallback) gets no
// remnant pass for the same reason: a remnant cannot be told from text.
const ORPHAN_LEADING_CSI = /^\s*\[[0-9;]+[A-HJKSTfhlmnsu]/

// Block elements, box drawing, geometric shapes and braille: the startup logo
// and the spinner. Replaced by a space so neighbouring words stay apart.
const DRAWING_GLYPHS = /[\u2500-\u259f\u25a0-\u25ff\u2800-\u28ff]/g

// Everything below 0x20 except tab and newline, DEL, the C1 controls, and the
// replacement character a byte cap leaves where it cut a multi-byte sequence.
const STRAY_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\ufffd]/g

/**
 * @param {string} text - raw PTY output (escapes intact) or an already-stripped tail
 * @param {{ truncatedStart?: boolean }} [opts] - `truncatedStart`: the buffer's
 *   first bytes were cut by a size cap, so a half sequence may open it
 * @returns {string} readable text with cursor-control debris removed
 */
export function scrubTerminalText(text, { truncatedStart = false } = {}) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const cleaned = text
    .replace(ESCAPE_SEQUENCE, (_match, _params, final) => {
      if (final === undefined) return ''
      if (CURSOR_ACROSS.has(final)) return ' '
      if (CURSOR_DOWN_OR_HOME.has(final)) return '\n'
      return ''
    })
    .replace(/\r\n?/g, '\n')
    .replace(STRAY_CONTROLS, '')
  return (truncatedStart ? cleaned.replace(ORPHAN_LEADING_CSI, '') : cleaned)
    .replace(DRAWING_GLYPHS, ' ')
}
