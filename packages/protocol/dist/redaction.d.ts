/**
 * Redact secret-shaped substrings from a string value. This is the logger's
 * existing redaction behavior, hoisted so the tool-broadcast path reuses the
 * exact same patterns and replacement rules.
 *
 * - `SENSITIVE_PATTERNS` keep the key name and redact only the value.
 * - `API_KEY_PATTERNS` redact the whole match (bare `[REDACTED]`).
 *
 * @param {string} msg
 * @returns {string}
 */
export function redactValue(msg: string): string;
/**
 * The part of `text` the patterns are handed when no more than `scanMax` characters
 * may be scanned. Text within the bound is returned whole. Longer text is cut at the
 * last whitespace inside the bound, and a run with no whitespace to stop at is
 * discarded, never half-kept, so the cut does not leave the front of a token that the
 * patterns can no longer recognise. This is the only lossy step in redaction, and it
 * applies only past the admission ceiling.
 *
 * @param {string} text
 * @param {number} scanMax
 * @returns {{ text: string, clipped: boolean }}
 */
export function scanWindow(text: string, scanMax: number): {
    text: string;
    clipped: boolean;
};
/** `text` without the last {@link REDACT_SCAN_MARGIN} characters. */
export function withoutUnsafeTail(text: any): any;
/**
 * The one rule for every cut of redacted text. Keep at most `max` characters of
 * `redacted`, drop the last {@link REDACT_SCAN_MARGIN} of those, and append `marker`.
 * Callers use it whenever the result is clipped, whether by length or because the
 * tail of the raw text was discarded at the ceiling; unclipped text is returned as it
 * is, without calling this.
 *
 * @param {string} redacted
 * @param {number} max
 * @param {string} [marker]
 * @returns {string}
 */
export function clipRedacted(redacted: string, max: number, marker?: string): string;
/**
 * Redact the whole of `text`, up to the admission ceiling. `clipped` says the text
 * was longer than the ceiling and its tail was discarded (see {@link scanWindow});
 * the redacted text can then end in a fragment of a match that the discarded tail
 * would have completed, and the caller cuts it with {@link clipRedacted}.
 *
 * @param {unknown} text
 * @param {number} [ceiling]
 * @returns {{ text: string, clipped: boolean }}
 */
export function redactWhole(text: unknown, ceiling?: number): {
    text: string;
    clipped: boolean;
};
/**
 * Redact the whole of `text` (up to the admission ceiling) and return it, for
 * callers that cut the result themselves. Only text past the ceiling loses its tail
 * first, and then the end of what remains is dropped as well
 * ({@link withoutUnsafeTail}): a fragment of a match the discarded text would have
 * completed is not kept. `max`, when given, is an OUTPUT budget: the redacted result
 * is sliced to it, which keeps the readable prefix and cannot expose a matched secret.
 *
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function redactBounded(text: unknown, max?: number): string;
/**
 * The identifying field of a RAW tool input that a permission prompt is
 * described by, redacted and clipped to `RECORD_DESCRIPTION_MAX`; `undefined`
 * when the input has none. Read from the raw input on purpose: the broadcast
 * copy of a large input is replaced by a truncation wrapper that no longer has
 * the field. Redacted before it is clipped, never after.
 *
 * @param {unknown} rawInput
 * @returns {string|undefined}
 */
export function describeByNamedField(rawInput: unknown): string | undefined;
/**
 * The human-readable `description` of a permission prompt, derived from its
 * tool input. The ONE place a producer (in-process sdk/byok/codex, hook-routed
 * claude-tui/claude-cli) builds it, so what a description may carry is decided
 * once.
 *
 * - An input with an identifying field (command, file_path, ...) is described by
 *   that field, redacted whole, then clipped.
 * - Anything else is described by a structurally redacted copy of the input
 *   (`redactedForDescription`), serialized: a value under a sensitive key reads
 *   `[REDACTED]` exactly as it does in the prompt's `input`, and secrets in
 *   property names are redacted too. The raw input is never serialized, and the
 *   sanitizer's size-clipped summary is never used: this walk reads the input
 *   itself, redacting each string whole before it is shortened.
 *
 * The serialization is scanned once more (defence in depth), then clipped to the
 * length a client shows.
 *
 * @param {unknown} rawInput
 * @param {string} [emptyFallback] returned when the input has nothing to describe
 * @returns {string}
 */
export function describeToolInput(rawInput: unknown, emptyFallback?: string): string;
/**
 * A prompt description composed by a producer from its own fields (not derived
 * from a tool input): redacted whole, then clipped to the length
 * a client shows. The MCP trust prompt uses it, so every description follows one
 * policy.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function describeComposedText(text: unknown): string;
/**
 * How many characters of redacted text the callers that keep a field for display
 * or for a record keep: an OUTPUT budget, applied after the whole text is redacted.
 */
export const REDACT_KEEP_MAX: 8192;
/**
 * The most text the pattern redactor is ever handed in one call, in characters. It
 * is an admission ceiling for pathological sizes, far above any text a caller shows
 * or keeps: matching is linear, so text up to the ceiling is redacted WHOLE and the
 * caller cuts the redacted result afterwards, which cannot expose a secret.
 */
export const REDACT_ADMISSION_MAX: number;
/**
 * How much of the end of a clipped, redacted result is not kept. A pattern fragment
 * that straddled a cut (the front of a key, an unterminated quoted value) is at most
 * this far from the end of the kept text: the quoted-value bound is 1024 characters
 * and every other pattern needs far less, and replacements before the fragment only
 * shorten the text ahead of it.
 */
export const REDACT_SCAN_MARGIN: 2048;
/**
 * How much of a permission prompt's identifying field the permission transcript
 * keeps. Applied where the field is produced (so the copy held with a pending
 * prompt is bounded too), and again by the history layer as it records.
 */
export const RECORD_DESCRIPTION_MAX: 500;
/**
 * Shared secret-redaction primitives.
 *
 * Single source of truth for the value-SHAPE patterns (#6029). Previously the
 * tool-broadcast sanitizer (ws-permissions.js) redacted by KEY NAME only, so a
 * secret embedded in a value under a benign key — e.g.
 * `{ command: 'export TOKEN=sk-ant-api03-…' }` or
 * `{ url: 'https://discord.com/api/webhooks/…' }` — was broadcast verbatim to
 * every subscribed client. The value patterns lived only in logger.js; this
 * module hoists them so the broadcast path and the logger share one definition.
 *
 * - `SENSITIVE_PATTERNS` / `API_KEY_PATTERNS` — the value-shape regexes.
 * - `redactValue(str)` — apply both pattern sets to a string (the logger's
 *   existing redaction behavior, hoisted verbatim).
 * - `SENSITIVE_KEY_NAMES` — the key-NAME set used by the broadcast sanitizer.
 */
export const SENSITIVE_PATTERNS: RegExp[];
export const API_KEY_PATTERNS: (RegExp | {
    global: boolean;
    lastIndex: number;
    exec(s: any): any[] | null;
    test(s: any): boolean;
    [Symbol.replace](s: any, replacement: any): any;
})[];
/**
 * The JWT matcher, shaped like a global RegExp for the two ways the patterns are
 * used: `string.replace(pattern, '[REDACTED]')` (the replacement is literal text)
 * and the `lastIndex` / `exec` loop in the logger's escape-aware pass.
 */
export const JWT_PATTERN: {
    global: boolean;
    lastIndex: number;
    exec(s: any): any[] | null;
    test(s: any): boolean;
    [Symbol.replace](s: any, replacement: any): any;
};
/**
 * Key NAMES whose VALUE is always a secret (the broadcast sanitizer redacts
 * these wholesale regardless of value shape). Kept here so the broadcast path
 * and any other consumer share one list.
 */
export const SENSITIVE_KEY_NAMES: Set<string>;
/**
 * Sanitize tool input for broadcast: redact sensitive fields and truncate large
 * values. Two passes (#6029): a KEY-NAME pass redacts values under sensitive
 * keys wholesale, and a VALUE-SHAPE pass runs every string value (at ANY depth)
 * through `redactValue` so a secret embedded under a benign key — e.g.
 * `{ command: 'export TOKEN=sk-ant-…' }`, `{ url: 'https://discord.com/api/webhooks/…' }`,
 * or nested in `{ env: { TOKEN: 'sk-ant-…' } }` / `{ args: ['--token', 'sk-ant-…'] }`
 * — is redacted before it reaches any client. Both passes recurse through nested
 * objects and arrays.
 *
 * The `maxChars` cap governs BOTH the per-string truncation and the whole-object
 * summary fallback. It defaults to `MAX_INPUT_CHARS` (the ~10K broadcast cap), so
 * every existing broadcast caller is byte-for-byte unchanged. The pull path
 * (#6543 `get_permission_input`, which needs the FULL content to build a
 * pre-write diff) passes a larger `maxChars` (`PULL_MAX_INPUT_CHARS`) — for an
 * object input (which every real tool_input is), the secret-stripping passes
 * (KEY-NAME + VALUE-SHAPE) run on every value regardless of the cap, so a higher
 * cap never weakens redaction, only the truncation threshold. Bare strings also
 * use the bounded per-string path (#8416): they are redacted before truncation,
 * subject to the same admission ceiling and unsafe-tail rule as string properties.
 * This intentionally changes oversized root strings from pass-through to bounded
 * output. Other non-object inputs are returned as-is.
 *
 * @param {*} input
 * @param {{ maxChars?: number }} [opts]
 * @returns {*}
 */
export function sanitizeToolInput(input: any, { maxChars }?: {
    maxChars?: number;
}): any;
/** @param {unknown} value @returns {boolean} true only for an object `sanitizeToolInput` returned (this process, not a copy of it) */
export function isSanitizedToolInput(value: unknown): boolean;
/**
 * #6543: the truncation cap for the `get_permission_input` PULL path — the
 * client needs the un-broadcast-truncated (but still secret-redacted) tool input
 * to build a full pre-write diff. Generous enough for any realistic file edit,
 * bounded so a pathological input can't blast the wire (the diff falls back to a
 * whole-file view past `computeHunks`'s own line guard anyway).
 */
export const PULL_MAX_INPUT_CHARS: number;
export const MAX_INPUT_CHARS: 10240;
