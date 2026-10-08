import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
// The session first: pty-driver.js and claude-tui-session.js import each other,
// and entering the cycle from pty-driver.js leaves a mixin uninitialised.
import '../src/claude-tui-session.js'
import { scrubTerminalText } from '../src/claude-tui/diagnostic-tail.js'
import { ANSI_STRIP } from '../src/claude-tui/pty-driver.js'

/**
 * #8252: the terminal tail that diagnostics show. The fixture is what a real
 * claude 2.1.x redraw looks like on the wire: private-mode CSI (`ESC[>0q`,
 * `ESC[>4m`, `ESC[<u`), save/restore cursor (`ESC7`/`ESC8`), cursor-forward
 * (`ESC[2C`) standing in for the space between words, and the startup banner's
 * block glyphs.
 */
const REAL_TAIL =
  '\x1b[?2004h\x1b7\x1b8\x1b[>0q\x1b[>4m\x1b[<u\x1b]0;claude\x07' +
  ' \x1b[38;5;174m▐▛███▜▌\x1b[39m   Claude Code v2.1.289\r\n' +
  '\x1b[38;5;174m▝▜█████▛▘\x1b[39m  Haiku 4.5 · Claude Max\r\n' +
  '\x1b[2C▘▘ ▝▝   ~/Projects/chroxy\r\n' +
  '\x1b[2CTry "refactor <filepath>"\r\n' +
  'Use\x1b[2Cthe\x1b[2Csingle\x1b[2Cline\x1b[1;1H\x1b[2K\x1b[0m'

describe('scrubTerminalText (#8252)', () => {
  it('leaves no escape debris from a real-looking tail', () => {
    const out = scrubTerminalText(REAL_TAIL)
    assert.equal(/\x1b/.test(out), false, 'no ESC byte survives')
    assert.equal(/\[[<>=?]?[0-9;]*[A-Za-z]/.test(out), false, `no bracket-run remnant in: ${JSON.stringify(out)}`)
    assert.equal(out.includes('[>0q'), false)
    assert.equal(out.includes('[>4m'), false)
    assert.equal(out.includes('[<u'), false)
    assert.equal(out.includes('[2C'), false)
    assert.equal(/^78|\b78[^0-9]/.test(out), false, 'save/restore cursor does not leave a bare 78')
  })

  it('drops the banner glyphs but keeps the words', () => {
    const out = scrubTerminalText(REAL_TAIL)
    assert.equal(/[▐▛█▜▌▝▘]/.test(out), false, 'no block glyph')
    assert.ok(out.includes('Claude Code v2.1.289'))
    assert.ok(out.includes('Haiku 4.5'))
  })

  it('turns a cursor-forward into the word gap it stood for', () => {
    const out = scrubTerminalText(REAL_TAIL)
    assert.ok(out.includes('Use the single line'), `words stay apart: ${JSON.stringify(out)}`)
    // The old stripper deletes the move, which is how `the single` read `thesingle`.
    assert.ok(REAL_TAIL.replace(ANSI_STRIP, '').includes('Usethesingleline'), 'control: ANSI_STRIP glues them')
  })

  it('removes an OSC title and keeps text around it', () => {
    assert.equal(scrubTerminalText('a\x1b]0;title\x07b'), 'ab')
    assert.equal(scrubTerminalText('a\x1b]0;title\x1b\\b'), 'ab')
  })

  it('handles an escape cut off by the end of the buffer', () => {
    assert.equal(scrubTerminalText('ok\x1b[>'), 'ok')
    assert.equal(scrubTerminalText('ok\x1b'), 'ok')
  })

  it('strips the half of a sequence a byte cap cut off at the START', () => {
    assert.equal(scrubTerminalText('[2Cthe line'), 'the line')
    assert.equal(scrubTerminalText('�[>0qthe line'), 'the line')
  })

  it('removes bracket remnants of sequences whose ESC was already stripped', () => {
    // What `_outputTail` holds: ANSI_STRIP removed the lone ESC and left the rest.
    const stripped = '78[>0q[>4m[<u[?2004hClaude Code'
    const out = scrubTerminalText(stripped)
    assert.equal(out.includes('[>'), false)
    assert.equal(out.includes('[<'), false)
    assert.equal(out.includes('[?'), false)
    assert.ok(out.endsWith('Claude Code'))
  })

  it('does NOT eat ordinary bracketed text', () => {
    const text = 'see [1] and [x] and [2025-10-04] and a[0] = 3'
    assert.equal(scrubTerminalText(text), text)
  })

  it('normalises CRLF and drops stray control bytes', () => {
    assert.equal(scrubTerminalText('a\r\nb\rc\x00\x07d'), 'a\nb\ncd')
  })

  it('returns an empty string for non-strings', () => {
    assert.equal(scrubTerminalText(undefined), '')
    assert.equal(scrubTerminalText(null), '')
    assert.equal(scrubTerminalText(''), '')
  })
})
