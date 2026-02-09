# Expo Expert Audit: Mobile App Update Strategy

**Agent**: Expo Expert -- React Native and Expo specialist
**Overall Rating**: 3.0 / 5
**Date**: 2026-02-09

---

## Executive Summary

The architecture demonstrates solid conceptual understanding but contains significant technical inaccuracies in the expo-updates details. Biggest issues: (1) the claimed dynamic URL capability doesn't exist in the API, (2) Expo Go → dev client transition is never mentioned, (3) manifest serving is substantially more complex than described.

Connection Persistence (Section 5) is materially stronger than Mobile App Updates (Section 6).

---

## Section Ratings

| Section | Rating | Summary |
|---------|:------:|---------|
| Named Tunnels | 4/5 | Sound approach. Missing `cloudflared tunnel route dns` step. |
| Reconnection State Machine | 4/5 | `connectionPhase` enum is excellent. `slow_polling` wastes battery. |
| Device Pairing / SecureStore | 4/5 | Correct. Already implemented. The "critical fix" is real. |
| Message Queue | 3/5 | Per-type TTL smart. 10-message limit may be tight. |
| Local Network Fallback | 3/5 | IP instability, ATS violations for `ws://`, no failover listener. |
| Approach Selection | 3/5 | Self-hosted is correct call. Two table rows are the same thing. |
| Server-Side Bundle Serving | 2/5 | Missing: manifest format, runtimeVersion, asset content-types, metro config. |
| Dynamic Tunnel URL | 1/5 | `Updates.fetchUpdateAsync()` does NOT accept a URL parameter. |
| App Update Flow | 3/5 | UX correct in concept. 2-3s timing estimate wrong (5-10s realistic). |
| Rollback | 4/5 | expo-updates auto-reverts on crash. Server-side "last 3 bundles" is good. |

---

## Critical Findings

### 1. `Updates.fetchUpdateAsync()` Has No URL Parameter
The doc proposes using runtime URL construction to bypass static config. This API does not exist. The function takes no arguments -- it fetches from the URL in `app.json`. Named Tunnels solve the URL problem, making this workaround unnecessary.

### 2. expo-updates Does NOT Work in Expo Go
The current app has no `expo-dev-client`. `expo-updates` requires either a production build or dev client build. Adding it means switching the entire development workflow from `expo start` to `expo start --dev-client` with native rebuild. Not "Small" effort.

### 3. Monorepo Bundle Export Issues
`expo-secure-store` is installed at root `package.json`, not `packages/app/`. No `metro.config.js` exists. `npx expo export` will fail to resolve hoisted dependencies. Needs custom metro config with `watchFolders` and `nodeModulesPaths`.

### 4. Missing Expo Updates Protocol v1 Manifest
`npx expo export` does NOT produce an Expo Updates manifest. It produces bundles + metadata. The server must dynamically generate a conformant manifest with `id`, `createdAt`, `runtimeVersion`, `launchAsset`, `assets[]`, and serve it with `expo-protocol-version: 1` header.

### 5. ConnectScreen Flash on Reload
`Updates.reloadAsync()` kills JS runtime. On restart, `isConnected` is `false`, so user sees ConnectScreen before auto-connect fires. Need a loading/splash state, not a binary navigation guard.

---

## Real-World Gotchas the Doc Misses

1. **Monorepo + expo export**: Hoisted deps not resolved without custom metro.config.js
2. **Missing babel.config.js**: Expo Go provides default; custom builds need explicit config
3. **runtimeVersion management**: Must bump when native deps change or OTA crashes app
4. **Bundle export takes 15-60s**: Not the "instant" the doc implies
5. **`expo-secure-store` in root package.json**: Must move to `packages/app/` before native builds
6. **Cloudflare HTTPS required**: expo-updates rejects HTTP in production. Local fallback won't work for updates.
7. **iOS ATS**: Local IP fallback needs `Info.plist` ATS exceptions

---

## Corrected Design Recommendation

### Phase A (immediate, no native rebuild): Server-Triggered Full Rebuild
Simple: Claude modifies code → server notifies "rebuild required" → user runs `npx expo run:ios` on Mac.

### Phase B (after dev client transition): Proper expo-updates OTA

Prerequisites:
1. Add `metro.config.js` with monorepo resolution
2. Add `babel.config.js` explicitly
3. Move `expo-secure-store` to `packages/app/package.json`
4. Install `expo-dev-client` and `expo-updates`
5. Convert `app.json` to `app.config.ts`
6. Build dev client on phone
7. Set `runtimeVersion` with fingerprint policy

The `app.config.ts`:
```typescript
export default {
  expo: {
    runtimeVersion: { policy: "fingerprint" },
    updates: {
      enabled: true,
      url: "https://YOUR-NAMED-TUNNEL/update/manifest",
      checkAutomatically: "ON_ERROR_RECOVERY",
    },
  },
};
```

Server must serve Expo Updates Protocol v1 manifest (not just static files).
