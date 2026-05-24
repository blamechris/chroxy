/**
 * Tests for `tryParseCompleteJson` (#4242).
 *
 * The helper amortises `JSON.parse` over long `tool_input_delta`
 * streams by skipping the parse when the buffer's tail proves it
 * can't yet be a complete JSON document.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { tryParseCompleteJson } from './partial-json'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tryParseCompleteJson', () => {
  it('returns undefined for empty input', () => {
    expect(tryParseCompleteJson('')).toBeUndefined()
  })

  it('returns undefined for whitespace-only input', () => {
    expect(tryParseCompleteJson('   \n\t')).toBeUndefined()
  })

  it('parses a complete JSON object', () => {
    expect(tryParseCompleteJson('{"command":"ls"}')).toEqual({ command: 'ls' })
  })

  it('parses a complete JSON array', () => {
    expect(tryParseCompleteJson('[1,2,3]')).toEqual([1, 2, 3])
  })

  it('tolerates trailing whitespace', () => {
    expect(tryParseCompleteJson('{"a":1}\n  ')).toEqual({ a: 1 })
  })

  it('returns undefined when the buffer cannot structurally be complete', () => {
    // Mid-stream: an unterminated string. Tail doesn't end in } or ].
    expect(tryParseCompleteJson('{"command":"rm -rf /tmp/')).toBeUndefined()
  })

  it('returns undefined when the buffer is the empty opener', () => {
    expect(tryParseCompleteJson('{')).toBeUndefined()
    expect(tryParseCompleteJson('[')).toBeUndefined()
  })

  it('returns undefined when the tail looks complete but parse fails', () => {
    // Tail ends in } but the document is malformed — gate is a fast
    // reject, not a validator, so we still rely on try/catch for the
    // final word.
    expect(tryParseCompleteJson('{"a":}')).toBeUndefined()
    // Unbalanced brackets that happen to end in `]`.
    expect(tryParseCompleteJson('foo]')).toBeUndefined()
  })

  it('rejects top-level scalars to keep the gate cheap', () => {
    // Tool inputs are always objects or arrays in practice. Top-level
    // strings/numbers/bools/null are intentionally rejected by the
    // structural gate so we don't have to scan the whole buffer.
    expect(tryParseCompleteJson('"a string"')).toBeUndefined()
    expect(tryParseCompleteJson('42')).toBeUndefined()
    expect(tryParseCompleteJson('true')).toBeUndefined()
    expect(tryParseCompleteJson('null')).toBeUndefined()
  })

  it('skips JSON.parse entirely when the gate rejects (perf contract)', () => {
    // This is the whole point of the optimisation: for the N-1 chunks
    // that obviously can't be complete JSON, we must NOT call
    // JSON.parse. Spy on the global to pin the contract.
    const parseSpy = vi.spyOn(JSON, 'parse')
    tryParseCompleteJson('{"command":"rm -rf')
    tryParseCompleteJson('{"command":"rm -rf /tm')
    tryParseCompleteJson('{"command":"rm -rf /tmp')
    expect(parseSpy).not.toHaveBeenCalled()
  })

  it('calls JSON.parse exactly once when the gate accepts', () => {
    const parseSpy = vi.spyOn(JSON, 'parse')
    tryParseCompleteJson('{"command":"ls"}')
    expect(parseSpy).toHaveBeenCalledTimes(1)
  })

  it('over an N-chunk Bash stream, only the final chunk reaches JSON.parse', () => {
    // Simulates the real `tool_input_delta` accumulator: chunks land
    // one at a time and the renderer re-parses on every delta. With
    // the gate, only the final chunk — the one whose tail is `}` —
    // should trigger the actual JSON.parse call.
    const final = '{"command":"echo hello world && ls -la /tmp"}'
    const chunks: string[] = []
    // Synthesise 9 mid-stream prefixes + 1 complete buffer.
    for (let i = 6; i < final.length; i += 4) {
      chunks.push(final.slice(0, i))
    }
    chunks.push(final)

    const parseSpy = vi.spyOn(JSON, 'parse')
    let last: unknown
    for (const chunk of chunks) {
      last = tryParseCompleteJson(chunk)
    }
    expect(parseSpy).toHaveBeenCalledTimes(1)
    expect(last).toEqual({ command: 'echo hello world && ls -la /tmp' })
  })
})
