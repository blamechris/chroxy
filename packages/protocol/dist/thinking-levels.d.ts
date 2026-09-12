/**
 * Thinking / reasoning-effort levels — the ONE place the vocabulary is written
 * down, and the ONE place that decides which levels a given model offers.
 *
 * #7730. Before this module the level vocabulary was a frozen literal at SIX
 * independent sites (a Zod enum, a store-core Set that silently COERCED an
 * unknown value, a dashboard union type, a server-side Set, and two TS casts).
 * Every one of them was written when `default | high | max` was the whole
 * world — i.e. when Claude was the only provider with a reasoning control.
 *
 * It is not. Codex's `model/list` advertises `supportedReasoningEfforts`
 * PER MODEL, the protocol types that field as a free non-empty STRING, and six
 * distinct values are already in the wild (`low`, `medium`, `high`, `xhigh`,
 * `max`, `ultra`) with the set differing per model and moving with releases.
 * A hardcoded list beside a set that grows is this repo's single most recurring
 * defect class (`docs/false-safety-guards.md`, cause #1), so the vocabulary is
 * not widened here — it is REPLACED by two questions asked separately:
 *
 *   1. Is this string well FORMED?  `isWellFormedThinkingLevel` — a bounded
 *      syntactic guard (charset + length). The value lands in a JSON-RPC param,
 *      so charset and length still matter even though the roster does not.
 *   2. Is this level OFFERED by the model in hand?  `resolveThinkingLevels` —
 *      the authoritative membership question, answered from the model's own
 *      catalog row (`reasoningLevels`, put on the wire by #7723/#7726).
 *
 * `LEGACY_THINKING_LEVELS` is the fallback for a row that advertises none —
 * the Claude family today, whose providers map these three onto a
 * `maxThinkingTokens` budget and have no per-model roster to read. It is a
 * FALLBACK, not the vocabulary: `scripts/lint-thinking-level-roster.sh` fails
 * the build on a second copy of it anywhere in non-test source.
 *
 * Zod-free on purpose (like `./codex.ts`): the server, store-core, the
 * dashboard and the mobile app all import it, and the JSON-RPC-facing schema in
 * `./schemas/client.ts` composes the predicate rather than restating it.
 */
/**
 * The three levels the Claude providers accept, in picker order. The ONLY
 * literal roster of levels in non-test source — see the lint named above.
 *
 * `default` is Claude's "let the model decide" setting and renders as "Auto";
 * `high` / `max` map to the escalating `maxThinkingTokens` budgets in
 * `base-session.js`. A provider whose catalog row carries `reasoningLevels`
 * never reaches this list.
 */
export declare const LEGACY_THINKING_LEVELS: readonly string[];
/** The level assumed when a message carries none, and the legacy fallback's default. */
export declare const LEGACY_DEFAULT_THINKING_LEVEL = "default";
/**
 * Hard cap on a level string's length. Generous next to the longest value
 * observed in the wild (`medium`, 6 chars) and well under any sane JSON-RPC
 * param budget — the point is that an unbounded roster must not imply an
 * unbounded STRING.
 */
export declare const THINKING_LEVEL_MAX_LENGTH = 32;
/**
 * True when `value` is a syntactically acceptable level string. This is a
 * FORM check only — it says nothing about whether any model offers the level.
 * The membership decision is `resolveThinkingLevels`, and both are required:
 * a check that denies nothing and a check that denies everything both pass a
 * naive negative test (#7273).
 */
export declare function isWellFormedThinkingLevel(value: unknown): value is string;
/** The shape `resolveThinkingLevels` reads — satisfied by store-core's `ModelInfo` and by the server's model-metadata entries alike. */
export interface ThinkingLevelSource {
    reasoningLevels?: unknown;
    defaultReasoningLevel?: unknown;
}
/** One picker option: the wire value plus its display label. */
export interface ThinkingLevelOption {
    id: string;
    label: string;
}
export interface ResolvedThinkingLevels {
    /** The levels this model offers, in the order the provider advertised them. */
    levels: string[];
    /** The level to show when the session has none of its own. Always a member of `levels`. */
    defaultLevel: string;
    /**
     * `model` when the roster came from the model's own catalog row, `legacy`
     * when it fell back to `LEGACY_THINKING_LEVELS`, `none` when the row
     * advertised nothing and the caller declared that this provider has no
     * fallback roster (`legacyFallback: false`). Callers log it; the point is
     * that "this model advertised nothing" stays distinguishable from "this model
     * advertised exactly the Claude three" — and, since #7784, from "this model
     * advertised nothing and nothing stands in for it".
     */
    source: 'model' | 'legacy' | 'none';
}
/** Options for `resolveThinkingLevels` / `thinkingLevelOptions`. */
export interface ThinkingLevelResolveOptions {
    /**
     * #7784 — does `LEGACY_THINKING_LEVELS` stand in for a row that advertised
     * nothing?
     *
     * The fallback is the CLAUDE family's real roster, not a neutral default, so
     * the answer is a per-provider fact that only the server can derive
     * (`isClaudeProvider`, one derivation, shipped to clients as the
     * `thinkingLevelLegacyFallback` capability). Passing it here is what lets the
     * picker and the server's gate call this ONE function with the SAME inputs
     * and therefore get the same roster — before #7784 the client always took the
     * fallback and the gate refused it on any non-Claude provider, so a
     * pre-catalog codex session was offered three levels of which the gate
     * accepted none.
     *
     * Defaults to `true`, which is every pre-#7784 caller's behaviour: a caller
     * that has no provider fact in hand (store-core's replay, the dropdown's own
     * empty-list fallback) keeps the Claude path exactly as it was.
     */
    legacyFallback?: boolean;
}
/**
 * Resolve the levels a model offers.
 *
 * A row whose `reasoningLevels` is a non-empty array of well-formed strings
 * wins outright — that is the provider's own answer about its own model, and
 * it is the whole point of #7730. Anything else (no row, no field, a field of
 * the wrong shape, an array that survives no element) falls back to
 * `LEGACY_THINKING_LEVELS` — unless `legacyFallback: false` says this provider
 * has no fallback roster, in which case the answer is an EMPTY list.
 *
 * The fallback is deliberate rather than fail-closed where it applies: it is
 * the Claude family's REAL roster, and returning an empty list there would take
 * the working control away from every provider that has one today. Where it
 * does NOT apply the empty list is the honest answer, and it is what stops the
 * picker from offering levels the model has never claimed (#7784).
 *
 * `defaultLevel` is the row's `defaultReasoningLevel` when that value is
 * actually one of the offered levels, else the first offered level. Never a
 * value outside `levels`: the picker renders it as the selected option, and a
 * selected option that is not in the list renders as blank. With no levels at
 * all it is the empty string — there is no level to name.
 */
export declare function resolveThinkingLevels(row?: ThinkingLevelSource | null, opts?: ThinkingLevelResolveOptions | null): ResolvedThinkingLevels;
/**
 * Display label for a level id. `default` is Claude's "let the model decide"
 * setting and has always rendered as "Auto"; every other value is shown as
 * itself with an initial capital, because the roster is open — there is no list
 * of pretty names to look a new provider's level up in, and inventing one would
 * reintroduce exactly the hardcoded-roster defect this module removes. A level
 * nobody has seen yet therefore renders legibly instead of not at all.
 */
export declare function formatThinkingLevelLabel(level: string): string;
/**
 * `resolveThinkingLevels` + labels, ready for a `<select>`.
 *
 * This is the PICKER's producer, and `resolveThinkingLevels` is the GATE's, so
 * the two answer the same membership question from the same code on the same
 * inputs. `packages/server/tests/thinking-level-roster-parity.test.js` drives a
 * roster row through both and compares the sets in both directions (#7784).
 */
export declare function thinkingLevelOptions(row?: ThinkingLevelSource | null, opts?: ThinkingLevelResolveOptions | null): ThinkingLevelOption[];
