/**
 * User input/voice settings + the VoiceInputMode runtime guard.
 *
 * Re-exported via ../types (barrel) — see ./index.ts.
 */

/**
 * Voice input behaviour. `'continuous'` keeps the mic open across silence
 * gaps until the user explicitly clicks stop (the hook restarts Web Speech
 * recognition on each silence-triggered `onend`). `'auto-pause'` lets the
 * browser auto-stop on silence — the previous behaviour, kept for users who
 * prefer it (#4785). Defaults to `'continuous'` so new users get the
 * click-to-start / click-to-stop experience by default.
 *
 * #4825: consolidated here so the mobile `useSpeechRecognition` hook, the
 * dashboard `useVoiceInput` hook, the dashboard `SettingsPanel` change
 * handler, and the mobile `SettingsScreen` picker all share one declaration.
 *
 * Compile-time enforcement is only as strong as the consuming pattern: sites
 * that exhaustively key a `Record<VoiceInputMode, …>` (e.g. the dashboard
 * `SettingsPanel` change handler, the mobile `SettingsScreen` picker tuple
 * typed as `{ value: VoiceInputMode; … }[]`) will be flagged by TS when the
 * union widens. Sites that validate untrusted runtime input (localStorage
 * rehydrate, SecureStore rehydrate, wire payloads) MUST use the
 * {@link isVoiceInputMode} guard below — it is keyed off the same exhaustive
 * `Record<VoiceInputMode, true>` map, so widening the union to a new mode
 * without updating that map is a TS error (missing property). Canonical
 * rehydrate-path consumers:
 * - `packages/dashboard/src/store/connection.ts` — localStorage (#4853)
 * - `packages/app/src/store/connection.ts` — SecureStore (#4872)
 */
export type VoiceInputMode = 'continuous' | 'auto-pause';

/**
 * #4853 — exhaustive `Record<VoiceInputMode, true>` map driving
 * {@link isVoiceInputMode}. Adding a new variant to the `VoiceInputMode`
 * union without listing it here is a TS error (missing property), so the
 * guard cannot silently drop a new mode the way a hand-written `===`
 * chain would. The same pattern is used inline by the dashboard
 * `SettingsPanel` change handler (#4825); the guard centralises it for
 * every other validation site (localStorage rehydrate, wire payload
 * validation, etc.) so they all share one source of truth.
 *
 * Module-scope `const` rather than a closure-local literal so the
 * underlying object identity is stable and the V8 hidden class doesn't
 * thrash on hot rehydrate paths.
 */
const VOICE_INPUT_MODES: Record<VoiceInputMode, true> = {
  continuous: true,
  'auto-pause': true,
};

/**
 * #4853 — runtime type-guard for `VoiceInputMode`. Returns `true` only
 * when `value` is exactly one of the union members declared above; every
 * non-string input (undefined, null, number, object, array) returns
 * `false` without throwing. Use at boundary sites that accept untrusted
 * input — localStorage rehydrate, JSON.parse of a wire payload, etc.
 *
 * The narrowing predicate (`value is VoiceInputMode`) lets callers
 * assign directly without an unsafe cast once the guard passes.
 */
export function isVoiceInputMode(value: unknown): value is VoiceInputMode {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(VOICE_INPUT_MODES, value);
}

export interface InputSettings {
  chatEnterToSend: boolean;
  terminalEnterToSend: boolean;
  voiceInputMode: VoiceInputMode;
}
