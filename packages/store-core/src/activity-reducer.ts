/**
 * Control Room activity reducer — public entry point (#5162, epic #5159).
 *
 * Split into a STATE (mutation) layer (`activity-state.ts`) and a SELECTOR
 * (query) layer (`activity-selectors.ts`) for SRP + tree-shaking; this barrel
 * re-exports both so the historical `./activity-reducer` import path (used by
 * `index.ts` and tests) keeps working unchanged. The shared null-prototype map
 * helpers live in `activity-internal.ts` and are intentionally NOT re-exported.
 */
export * from './activity-state'
export * from './activity-selectors'
