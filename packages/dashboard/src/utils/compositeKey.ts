/**
 * Build an unambiguous key from several string parts (#7103).
 *
 * The dashboard needs a stable single-string identity in two places: the React
 * `key` for the mission-control external-session list (identity is
 * `(source, sessionId)`) and the billing-canary change signature (identity is
 * the full warning content). Both used to flatten their parts with a LITERAL
 * NUL byte written into the source file, which was wrong twice over:
 *
 *   1. **Search visibility.** A raw NUL makes the whole file invisible to any
 *      code search that passes grep's `-I` or otherwise sniffs for NUL — and
 *      it fails SILENTLY, returning an empty result indistinguishable from
 *      "the string isn't there". That is how a sweep over
 *      `store/message-handler.ts` — the dashboard's central message switch —
 *      concluded a handler did not exist (#7086).
 *      `scripts/lint-no-nul-bytes.sh` now guards against a new one landing.
 *
 *   2. **Aliasing.** `a + SEP + b` is only injective while no part can contain
 *      SEP, which is an invariant on data arriving from the server that the
 *      dashboard cannot enforce. Two distinct external sessions that collapse
 *      onto one React key make React reuse the wrong DOM node; two distinct
 *      warning sets that collapse onto one signature leave a dismissed billing
 *      banner stale — exactly the bug the signature exists to prevent.
 *
 * The encoding is length-prefixed — `<len>:<part>` per part, joined with `|`:
 *
 *     compositeKey('claude-hooks', 'abc')  ->  '12:claude-hooks|3:abc'
 *
 * Decoding is deterministic (read the digit run, take exactly that many chars,
 * expect `|` or end-of-string), so the encoding is injective for ANY part
 * contents — including parts containing `:`, `|`, digits, or a NUL. Mirrors
 * `packages/server/src/utils/composite-key.js`; the two are independent by
 * necessity (no shared runtime package spans the dashboard and the daemon) and
 * nothing decodes either, so they are free to drift in format.
 *
 * Keys are in-memory only: never persisted, never sent on the wire.
 */
export function compositeKey(...parts: unknown[]): string {
  return parts
    .map((part) => {
      const s = String(part)
      return `${s.length}:${s}`
    })
    .join('|')
}
