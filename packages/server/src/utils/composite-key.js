/**
 * Build an unambiguous Map key from several string parts (#7103).
 *
 * Two aggregates key their in-memory Maps on `(source, sessionId)`
 * ({@link TurnTracker}, {@link ExternalSessionRegistry}). Both used to flatten
 * the pair with a single separator, and both wrote that separator as a LITERAL
 * NUL byte in the source file. That was wrong twice over:
 *
 *   1. **Search visibility.** A raw NUL makes the whole file invisible to any
 *      code search that passes grep's `-I` or otherwise sniffs for NUL — and
 *      it fails SILENTLY, returning an empty result indistinguishable from
 *      "the string isn't there". `scripts/lint-no-nul-bytes.sh` now guards it.
 *
 *   2. **Aliasing.** `a + SEP + b` is only injective while no part can contain
 *      SEP. That held for these two callers by accident — `IngestEventSchema`
 *      charset-restricts `source` to `[a-zA-Z0-9._-]` — but it is a
 *      CALLER-side invariant neither aggregate can enforce, and `sessionId` is
 *      NOT charset-restricted. Under a bare separator, `('a<SEP>b', 'c')` and
 *      `('a', 'b<SEP>c')` collapse onto one entry: one session's stop clears
 *      another's turn, and one `session_end` evicts the wrong registry row.
 *
 * The encoding is length-prefixed — `<len>:<part>` per part, joined with `|`:
 *
 *     compositeKey('claude-hooks', 'abc')  ->  '12:claude-hooks|3:abc'
 *
 * Decoding is deterministic (read the digit run, take exactly that many chars,
 * expect `|` or end-of-string), so the encoding is injective for ANY part
 * contents — including parts that contain `:`, `|`, digits, or a NUL. The
 * delimiters are plain ASCII, so the key is also readable in a log line or a
 * debugger, which a control-character separator never was.
 *
 * Keys are in-memory only and never persisted or sent on the wire, so the
 * format is free to change; nothing decodes it today.
 *
 * @param {...unknown} parts - Key components, coerced to string.
 * @returns {string} Collision-free key for the ordered part list.
 */
export function compositeKey(...parts) {
  return parts
    .map((part) => {
      const s = String(part)
      return `${s.length}:${s}`
    })
    .join('|')
}
