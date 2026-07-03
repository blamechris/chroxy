# @chroxy/protocol

The shared protocol contract — Zod schemas and TypeScript types for every
WebSocket message and shared enum, imported by the server, dashboard, mobile app,
and store-core. It's the single source of truth for the client↔server wire
format (and for shared constants like `DEFAULT_PROVIDER`).

## What's here

- `src/schemas/client.ts` — Client→Server message schemas + `ClientMessageSchema`.
- `src/schemas/server/` — Server→Client message schemas (one file per domain).
- `src/index.ts` — barrel exports + shared constants (`DEFAULT_PROVIDER`, etc.).
- A Zod-free `./project` subpath so `@chroxy/claude-hooks` can depend on it
  without pulling in Zod.

## Scripts

```bash
npm run build   -w packages/protocol   # tsc → dist/  (also runs on `prepare`)
npm test        -w packages/protocol   # node --test (tsx loader)
```

## Gotcha — new schema files need their dist committed

`dist/` is prebuilt and committed. After editing `src/schemas`, rebuild and stage
the dist:

```bash
npm run build -w packages/protocol
git add -u packages/protocol/dist/
```

A **new** schema file's compiled `dist/*.js` is gitignored + untracked, so it
won't be picked up by `git add -u` — `git add -f` it by name. Making a
dashboard-only or app-only message type "both-clients" trips three coverage
guards (protocol handler-coverage + store-core coverage-lint + protocol
type-coverage); run the full store-core (`vitest run`) and protocol (`npm test`)
suites when you do.
