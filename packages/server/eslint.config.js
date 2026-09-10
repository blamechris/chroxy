// The Node globals `src/` and `tests/` share. Hoisted rather than copied: the
// tests block below needs the same set, and a second literal is the copy that
// drifts — this package's own test helpers carry three separate corrections for
// exactly that shape (#7664).
const NODE_GLOBALS = {
  console: 'readonly',
  process: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Buffer: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  DOMException: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  crypto: 'readonly',
  structuredClone: 'readonly',
  fetch: 'readonly',
  Response: 'readonly',
  Headers: 'readonly',
  EventSource: 'readonly',
  WebSocket: 'readonly',
  Blob: 'readonly',
  FormData: 'readonly',
  performance: 'readonly',
  globalThis: 'readonly',
  // Node's own `global`, used by tests that stub a global for a single case.
  global: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
}

/**
 * The rules `src/` has always had. `tests/` is now held to exactly these — the
 * same severities, so the tree that was unlinted is not held to a DIFFERENT
 * standard than the tree that was.
 */
const SHARED_RULES = {
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'error',
  'no-console': 'off',
}

export default [
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: NODE_GLOBALS },
    rules: SHARED_RULES,
  },
  {
    // `tests/` was in the ignore list until #7664, so NOTHING linted it — while
    // the CI-guard work of 2026-09 alone added roughly a thousand lines of new
    // logic to `tests/helpers/`. `no-undef` is the rule that earns its place
    // here: in a test file an undefined identifier is a missing import or a
    // typo, and the suite can still pass around it when the line sits in a
    // branch no case reaches.
    files: ['tests/**/*.js', 'tests/**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: NODE_GLOBALS },
    rules: SHARED_RULES,
  },
  {
    // `tests/smoke-test.mjs` hands functions to Playwright's `page.evaluate`,
    // which runs them in the BROWSER — `document` there is correct, not a bug.
    files: ['tests/smoke-test.mjs'],
    languageOptions: { globals: { document: 'readonly', window: 'readonly', navigator: 'readonly' } },
  },
  {
    files: ['src/dashboard/**/*.js'],
    languageOptions: {
      globals: {
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        WebSocket: 'readonly',
        Notification: 'readonly',
        HTMLElement: 'readonly',
        Element: 'readonly',
        Event: 'readonly',
        KeyboardEvent: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        navigator: 'readonly',
        Blob: 'readonly',
        // xterm.js globals (loaded via separate script tags)
        Terminal: 'readonly',
        FitAddon: 'readonly',
      },
    },
  },
  {
    // `src/dashboard-next/` is a Vite-built static bundle served by the
    // server; its `dist/assets/*.js` is minified browser code that would
    // otherwise trip every `no-undef` rule for `window`, `document`, etc.
    //
    // `tests/fixtures/` holds files that are DELIBERATELY malformed — the IDE
    // go-to-definition fixture references a symbol that does not exist, on
    // purpose. Linting a fixture asserts the opposite of what it is for.
    ignores: ['node_modules/', 'src/dashboard-next/', 'tests/fixtures/'],
  },
]
