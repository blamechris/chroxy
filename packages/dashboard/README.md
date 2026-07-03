# @chroxy/dashboard

The web dashboard — a React + Vite single-page app that the Chroxy **server**
builds and serves at `/dashboard`. It's the desktop client surface (the Tauri
tray app wraps it) and the primary way to drive sessions from a browser: chat +
terminal views, session tabs, Control Room, the opt-in IDE navigator, and
provider/credential management.

## Stack

React 18 · Vite · TypeScript (strict) · Zustand (state) · shares logic with the
mobile app via [`@chroxy/store-core`](../store-core) and types via
[`@chroxy/protocol`](../protocol).

## Scripts

```bash
npm run dev        -w packages/dashboard   # Vite dev server (hot reload)
npm run build      -w packages/dashboard   # production build → dist/ (served by the server)
npm run typecheck  -w packages/dashboard   # tsc --noEmit
npm test           -w packages/dashboard   # vitest run
npm run generate-tokens -w packages/dashboard   # regenerate the theme from design tokens
```

For a normal daemon run you don't build the dashboard by hand — `npm install`
and the server serves it. Rebuild (`npm run build`) only when you want a running
daemon to pick up dashboard source changes.

## Theming — generated, don't hand-edit

`src/theme/theme.css` and `src/theme/tokens.ts` are **generated** from
[`@chroxy/design-tokens`](../design-tokens) via `npm run generate-tokens`
(`scripts/generate-theme-tokens.mjs`). Edit the token source and regenerate —
never hand-edit the generated files. `src/theme/components.css` is hand-authored
and safe to edit directly.

## Verifying UI changes

Component/logic changes are covered by the vitest suite (`npm test`). For a
full-render check, the server ships a Playwright dashboard smoke test — see
[docs/setup-and-smoke-test.md](../../docs/setup-and-smoke-test.md) §7c.
