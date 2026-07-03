# @chroxy/store-core

Shared, client-agnostic store logic and crypto used by **both** the web
dashboard and the mobile app — so the two clients parse the WebSocket protocol,
build chat-view messages, and encrypt/decrypt identically. Keeping this logic in
one package is what prevents the two clients from drifting.

## What's here

- **Message handlers** (`src/handlers/`, `src/dispatch-table.ts`) — the wire
  path that turns server messages into store state.
- **Chat/activity reducers** — `buildChatViewMessages`, `activity-reducer`.
- **Syntax tokenizer** (`src/syntax.ts`) — the 15+-language highlighter the file
  viewer and code blocks use.
- **Crypto** (`src/crypto.ts`) — the E2E encryption primitives; the one part that
  is prebuilt to `dist/`.

## Scripts

```bash
npm run typecheck   -w packages/store-core   # tsc --noEmit  ← use this to verify TS
npm test            -w packages/store-core   # vitest run (build:crypto runs first via pretest)
```

## Gotcha — never run bare `tsc`

The `.` export is the TypeScript **source** (`src/index.ts`); consumers (the
dashboard's Vite build, the app's Metro bundler) compile it themselves. Only
`./crypto` is prebuilt: `npm run build:crypto` emits the **committed**
`dist/crypto.js`. A bare `tsc` in this package will overwrite `dist/crypto.js`
with a corrupted build — always use `npm run typecheck` (which is `tsc --noEmit`)
to type-check, and restore an accidental clobber with
`git checkout packages/store-core/dist/crypto.js`.
