/**
 * #4875 — shared typed predicate for the "Other / freeform" answer payload
 * emitted by AskUserQuestion single-question prompts (mobile #4755 / dashboard
 * #4651). Previously the same 5-condition shape check was duplicated inline
 * in both `packages/app/src/store/connection.ts` and
 * `packages/dashboard/src/store/connection.ts`, plus a *looser* 2-condition
 * variant in `packages/app/src/screens/SessionScreen.tsx` `handleSelectOption`.
 *
 * The divergence was harmless today because the call-site type
 * (`SelectOptionValue = string | OtherFreeformAnswer`) constrained the input
 * shape to exactly those two cases. But if `SelectOptionValue` ever grows to
 * include a third object shape (e.g. mobile multi-question support), the
 * loose 2-condition check would silently misclassify it as freeform — the
 * footgun called out in the original review.
 *
 * Centralising the type AND the runtime guard here means:
 *   - Wire-payload boundary sites (store layer in both clients) and UI
 *     branching sites (screen layer) all narrow the same way.
 *   - A future widening of `SelectOptionValue` only needs to update this
 *     guard once.
 *   - The predicate enforces the tightest possible shape (exactly two named
 *     keys, both `string` values, no array, no `null`) so a multi-question
 *     `Record<string, string | string[]>` whose keys happen to literally be
 *     `"otherLabel"` and `"freeformText"` cannot be misrouted into the
 *     freeform branch.
 */

/**
 * Payload shape emitted when the user picks the synthesized "Other" option
 * on a single-question AskUserQuestion and types freeform text. The store
 * forwards this to the server as a two-stage `user_question_response`
 * (`answer: <otherLabel>, freeformText: <typed>`), so the server can drive
 * the two-stage TUI write (Other digit → text-input prompt → freeform text
 * + Enter). Older servers that ignore `freeformText` fall through to the
 * legacy path and type the label literally — a clean degradation.
 *
 * Both `packages/dashboard/src/components/QuestionPrompt.tsx` (#4901) and
 * `packages/app/src/components/chat/MessageBubble.tsx` (#4875) now re-
 * export this declaration as a type-only re-export, so all three call
 * sites (mobile store, mobile screen, dashboard store) converge on the
 * single source of truth here.
 */
export interface OtherFreeformAnswer {
  otherLabel: string;
  freeformText: string;
}

/**
 * #4875 — runtime type-guard for {@link OtherFreeformAnswer}. Returns `true`
 * only for objects that have EXACTLY the two named keys with `string`
 * values; every other input (`undefined`, `null`, arrays, primitives,
 * objects with extra/missing keys, objects with non-string values) returns
 * `false` without throwing.
 *
 * The narrowing predicate (`value is OtherFreeformAnswer`) lets callers
 * drop the `as string` / `as OtherFreeformAnswer` casts at the call site
 * once the guard passes.
 *
 * The tight 5-condition shape (object + non-null + non-array + exactly two
 * keys + both string values) is deliberate: it mirrors the original store-
 * layer detector and rejects a multi-question `Record<string, string |
 * string[]>` whose keys happen to be literally `"otherLabel"` and
 * `"freeformText"` — a rare but possible misroute if the model phrases a
 * question that way.
 *
 * `unknown` rather than the narrower `SelectOptionValue` union so wire-
 * payload boundary sites (where the input is untrusted) and UI branching
 * sites (where the input is already `SelectOptionValue`) can both share
 * the same guard. The narrowing target (`OtherFreeformAnswer`) is the
 * same in both cases.
 */
export function isFreeformAnswer(value: unknown): value is OtherFreeformAnswer {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  // Use Object.keys to enforce the exact-two-keys constraint; `in` checks
  // would accept supersets, which is what made the old loose variant a
  // footgun.
  const keys = Object.keys(value);
  if (keys.length !== 2) return false;
  // `hasOwnProperty.call` rather than `'key' in value` so an object with
  // two unrelated OWN keys but `otherLabel` / `freeformText` inherited
  // from its prototype (e.g.
  // `Object.create({ otherLabel: 'x', freeformText: 'y' })`) cannot slip
  // through. The `in` operator walks the prototype chain — that breaks
  // the stated "exactly two named keys" guarantee and would let a
  // prototype-pollution payload misroute as freeform. Same defence the
  // `isVoiceInputMode` guard uses (#4853).
  if (!Object.prototype.hasOwnProperty.call(value, 'otherLabel')) return false;
  if (!Object.prototype.hasOwnProperty.call(value, 'freeformText')) return false;
  const record = value as Record<string, unknown>;
  return typeof record.otherLabel === 'string'
    && typeof record.freeformText === 'string';
}
