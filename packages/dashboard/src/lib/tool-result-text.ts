/**
 * tool-result-text — re-export shim (#5800).
 *
 * `unwrapToolResultText` (and its private `streamsToText`) was hoisted into
 * `@chroxy/store-core` (`packages/store-core/src/tool-result-text.ts`) so the
 * app gains the same `{stdout,stderr}` → terminal-text unwrap as the dashboard.
 * This shim re-exports it under the original path so existing dashboard
 * importers keep working unchanged. Zero behavior change.
 */
export { unwrapToolResultText } from '@chroxy/store-core'
