# Minimalist's Audit: Chroxy v0.6.0 Tech Debt

**Agent**: Minimalist
**Overall Rating**: 2.4/5
**Date**: 2026-03-18

## Perspective

The Minimalist looks for unnecessary complexity, over-abstraction, and code that exists without justifying its cost. Asks: *what can we delete?*

---

## 1. Duplicate Store Code (~4,480 lines) (1.5/5)

### The message handler fork
The single most deletable duplication in the codebase:
- `packages/app/src/store/message-handler.ts` — 2,271 lines
- `packages/server/src/dashboard-next/src/store/message-handler.ts` — 2,209 lines

These files share approximately 80% of their logic. The remaining 20% consists of platform-specific concerns (plan mode in app, enriched tabs in dashboard) that could be handled via configuration or composition. A shared `@chroxy/message-handler` package would eliminate ~1,800 lines of pure duplication.

### Store layer duplication
Beyond the message handler, the app and dashboard duplicate:
- Connection state management (~400 lines each)
- Session state types and factories (~200 lines each)
- WebSocket send/receive wrappers (~150 lines each)
- Cost calculation logic (~100 lines each)

Total estimated duplication across all store code: ~4,480 lines (app) mirrored in ~4,705 lines (dashboard). A shared store-core package could reduce this by 60-70%.

---

## 2. Over-Abstracted Patterns (2.5/5)

### Tunnel base class with one implementation
`tunnel-base.js` defines an abstract base class. `cloudflare-tunnel.js` is the only implementation. The base class adds indirection without enabling polymorphism — there is no second tunnel provider and no plan for one. The `tunnel.js` shim adds a third layer of indirection.

**Cost**: 3 files and an inheritance chain for what should be 1 file.

### Provider registry for 4 providers
`providers.js` implements a registry pattern with dynamic registration, lookup, and factory methods. There are exactly 4 providers, all known at compile time, all imported statically. A simple switch statement or object literal would be clearer and more maintainable.

### ALLOWED_MODEL_IDS Proxy
`models.js` uses a JavaScript `Proxy` to make the allowed model IDs set appear as an object with dynamic properties. This is clever but unnecessary — a Set or Array with `.includes()` is clearer and equally functional.

---

## 3. Config Sprawl (2.5/5)

### 27 environment variables
`config.js` reads 27 environment variables with a 4-layer precedence system (CLI flags > env vars > config file > defaults). At least 3 env vars are unused:
- `CHROXY_TRANSFORMS` — no code reads this
- `CHROXY_SANDBOX` — no code reads this
- `CHROXY_PTY_SHELL` — PTY mode was removed in v0.2.0

The `mergeConfig` function (4-layer merge) adds complexity that would be unnecessary if unused options were removed.

### Config file format
The config file (`~/.chroxy/config.json`) supports nested objects with dot-notation keys. This is non-standard and makes it harder to validate. A flat key-value format or standard TOML/YAML would be simpler.

---

## 4. Backward-Compat Shims (2.0/5)

### Files that should be deleted

| File | Lines | Purpose | Consumers |
|------|-------|---------|-----------|
| `tunnel.js` | 5 | Re-exports cloudflare-tunnel.js | 0 internal |
| `ws-file-ops.js` | 2 | Re-exports split file modules | 0 internal |
| `ws-schemas.js` | 105 | Validation schemas | Tests only |

Total: 112 lines of code that exists solely for backward compatibility with import paths that nothing uses.

### Dead re-exports in ws-message-handlers.js
Symbols exported from `ws-message-handlers.js` that are not imported anywhere:
- `handleLegacyMessage`
- `handleFileOpsMessage`
- `handlePermissionMessage` (moved to WsPermissions)

These inflate the module's API surface and create false dependency impressions.

---

## 5. Dependency Misclassification (3.0/5)

### Dashboard-only deps in server prod
These packages are used exclusively by the Vite-bundled dashboard but listed in the server's `dependencies` (not `devDependencies`):
- `zustand` — dashboard state management
- `dompurify` — dashboard HTML sanitization
- `xterm` / `xterm-addon-fit` — dashboard terminal

Since Vite bundles them into static assets at build time, they are build-time dependencies. Listing them as prod deps inflates `npm install --production` and Docker image size.

### expo-secure-store in root
As noted by the Skeptic — this native module belongs only in `packages/app/package.json`.

---

## Summary

The codebase has grown features without proportionally retiring abstractions. The message handler duplication is the largest single source of unnecessary complexity. The over-abstraction patterns (tunnel base class, provider registry, Proxy model IDs) add indirection without flexibility. The backward-compat shims are trivial to delete but their persistence signals a pattern of incomplete cleanup.

**If I could make one change**: extract `@chroxy/store-core` with the shared message handler, connection state, and session types. This eliminates ~3,000 lines and makes every future protocol change a single-edit operation.

| Area | Rating | Priority |
|------|--------|----------|
| Duplicate store code | 1.5/5 | **Critical** |
| Over-abstraction | 2.5/5 | Medium |
| Config sprawl | 2.5/5 | Low |
| Backward-compat shims | 2.0/5 | Medium |
| Dependency misclassification | 3.0/5 | Low |
