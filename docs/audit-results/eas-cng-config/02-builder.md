# Builder's Audit: EAS / Expo / CNG Configuration

**Agent**: Builder — pragmatic full-stack dev, revises effort estimates, lives in concrete file changes
**Overall Rating**: 2.6 / 5
**Date**: 2026-04-11

---

## TL;DR

The setup works, barely. Today's five-build failure cascade proves the config is under-specified and under-tested. The hybrid native strategy (committed `ios/`, CNG `android/`) is defensible because of the LiveActivity Swift code, but it's completely undocumented in `app.json` — nothing guards against drift. There's no CI step that would have caught today's breakage. The good news: the blast radius of every recommended fix is small. `@expo/vector-icons` is used in exactly **one** file. `bump-version.sh` already does most of what it needs. The CNG decision is a 1-line `app.json` plugin change, not a rewrite.

---

## Section Ratings

### eas.json build profiles — 2 / 5

`packages/app/eas.json` is 21 lines. After the PR #2801 revert, it contains *no* prebuild step, *no* cache config, *no* env vars, *no* resource-class hints, and the three profiles (`development`/`preview`/`production`) are nearly identical. That's not "minimalist", that's "we haven't learned anything from the last failure". We rely on implicit EAS defaults + `prepare` scripts in workspaces. One typo breaks the cloud.

**Missing concretely:**
- No `env` block pinning `EAS_NO_VCS` / `NODE_ENV` / `EXPO_PUBLIC_*`
- No `cache.key` to invalidate when workspace deps change
- No `node: "22.x"` pin — EAS defaults to 18 on some images
- No `resourceClass` hint (preview on `m-medium` is fine, but explicit > implicit)
- No `channel` mapping for OTA (not urgent — app isn't shipping OTA yet)

### app.json Expo config — 2 / 5

Three concrete bugs (per `expo-doctor`):
1. `packages/app/app.json:33` — `softwareKeyboardLayoutMode` lives under `android` but in Expo 54 SDK this key moved. Doctor flags it as invalid.
2. The `plugins` array at `packages/app/app.json:43-60` has **no plugin configuring the LiveActivity target** even though `ios/LiveActivity/` is committed. If someone ever runs `expo prebuild --clean`, the LiveActivity files get wiped. This is a **silent trap**.
3. No `ios.buildNumber` or `android.versionCode` — which is *fine* under `appVersionSource: "remote"` but undocumented, so a future dev will "fix" it and break EAS auto-increment.

### Dependency management — 2 / 5

`packages/app/package.json`:
- Line 45: `@expo/vector-icons: ~14.0.4` — duplicated in the tree because an indirect dep (`@react-navigation/*` or `expo` itself) pulls `15.1.1`. Verified in `package-lock.json:2961` and `:15990` (two copies in the store).
- Line 82: `@types/jest: ^30.0.0` — Doctor expects `29.5.14`. `jest-expo@54.0.17` is on Jest 29, so types are mismatched at the type level. Not a runtime break, but `tsc --noEmit` will lie about Jest types.
- Line 85: `jest-expo: ^54.0.17` — correct for SDK 54. Good.

The actual `@expo/vector-icons` import footprint: **exactly one file** — `packages/app/src/components/Icon.tsx` (89 lines). All other components use the wrapper `Icon` component. So the "dozens of components" concern from the prompt is wrong — it's a single-file migration.

### Native project strategy — 2 / 5

`git ls-files packages/app/ios/` → **37 committed files**, including `LiveActivity/*.swift` and a full `Chroxy.xcodeproj/project.pbxproj`. `git ls-files packages/app/android/` → **0 files**. `packages/app/.gitignore:26` now reads `/android/` — per #2801.

This is the worst of both worlds right now:
- **CNG Android**: any `app.json` change rebuilds cleanly on EAS. Good.
- **Committed iOS**: any Expo SDK upgrade requires hand-merging the generated pbxproj with the LiveActivity additions. Bad.
- **No config plugin** exists to regenerate the LiveActivity target via CNG. There's no `expo-build-properties`, no custom plugin in `packages/app/plugins/`, no mention in `app.json`.

If a dev runs `npx expo prebuild --clean` today, LiveActivity dies silently.

### Cross-workspace build — 3 / 5

The chain: EAS runs `npm ci --include=dev` at repo root → npm runs `prepare` scripts in `@chroxy/protocol` (`tsc`) and `@chroxy/store-core` (`build:crypto`) → app's `postinstall` runs `scripts/bundle-xterm.js` → Metro bundles from `packages/protocol/dist/index.js` and `packages/store-core/src/index.ts`.

What works: CI on GitHub Actions does essentially the same thing in `.github/workflows/ci.yml:32-35` (explicit `npm run build -w packages/protocol`). Verified by reading the CI file.

What's fragile:
- **Metro is told to transform `@chroxy/store-core` from source** (`jest.transformIgnorePatterns` in `package.json:19` includes it). That means store-core's `prepare` → `dist/crypto.js` only matters for the `./crypto` export, not the main entry. An accidental TypeScript syntax error in `store-core/src/*.ts` will only surface at Metro bundle time, not at `npm ci`.
- **Protocol resolves via `main: "./dist/index.js"`** — if `tsc` fails silently (e.g. type error downgraded to warning), `dist/` is stale and EAS happily bundles yesterday's protocol.
- **No verification step** after `npm ci` confirms `packages/protocol/dist/index.js` and `packages/store-core/dist/crypto.js` actually exist.

### Resilience / CI coverage — 1 / 5

Zero EAS-facing CI. `ci.yml` has 9 jobs but none of them run:
- `npx expo-doctor`
- `npx expo prebuild --no-install --platform android` (dry-run — catches config plugin errors)
- `eas build --local` or `eas build --profile preview --dry-run`
- A smoke test that `packages/protocol/dist/index.js` exists after `npm ci`

Today's cascade failed five times because **no CI job ever tried to prebuild**. Every fix was a blind retry. That's the single biggest risk in this audit.

---

## Fix Plan for the 4 Doctor Warnings

### 1. `softwareKeyboardLayoutMode` invalid

**File**: `packages/app/app.json:33`
**Change**: Remove the key from `android` and add the `expo-build-properties` plugin:
```json
[
  "expo-build-properties",
  { "android": { "softwareKeyboardLayoutMode": "adjustResize" } }
]
```
**Effort**: **S** (1 file, 3-line change, +1 dep)
**Verify**: `cd packages/app && npx expo-doctor` — warning should drop.
**Coupled changes**: `npx expo install expo-build-properties` (adds to `package.json` deps, auto-matched to SDK 54).

### 2. Duplicate `@expo/vector-icons` (14.0.4 vs 15.1.1)

**File**: `packages/app/package.json:45`
**Change**: `"@expo/vector-icons": "~14.0.4"` → `"@expo/vector-icons": "^15.0.3"`, then `cd packages/app && npx expo install --fix && rm -rf node_modules && cd ../.. && npm install`.
**Effort**: **S** (1 dep bump, verify `packages/app/src/components/Icon.tsx` still compiles)
**Blast radius**: `Grep @expo/vector-icons packages/app/src` → **1 file**: `Icon.tsx`. Every other component uses the wrapper. Icon glyph names (`camera-outline`, `search-outline`, etc.) are stable between Ionicons versions — v15 added glyphs, didn't rename. Low risk.
**Verify**: `npm run test -w @chroxy/app` + `npx tsc --noEmit` in `packages/app` + visual check of Icon renders on boot.

### 3. Mixed CNG + committed `ios/`

**Files**: `packages/app/app.json` (add plugin config), `packages/app/plugins/with-live-activity.js` (new, ~60 lines)
**Change**: See "CNG vs Committed-Native Strategy" below. Recommended: **Option C (document + guard)** as immediate fix, **Option A (full CNG)** as follow-up.
**Effort (immediate guard)**: **S** — add one comment block + a README note.
**Effort (full CNG migration)**: **L** — see below.

### 4. Version mismatches

**File**: `packages/app/package.json:82`
**Change**: `"@types/jest": "^30.0.0"` → `"@types/jest": "29.5.14"`. Run `npm install` at root to regenerate lockfile.
**Coupled change**: `@expo/vector-icons` handled in #2 above.
**Effort**: **S** (1 line)
**Verify**: `cd packages/app && npx tsc --noEmit`.

---

## CNG vs Committed-Native Decision

### Option A — Full CNG (recommended long-term)

1. Write `packages/app/plugins/with-live-activity.js` — a Config Plugin that copies Swift sources from `packages/app/plugins/live-activity/` into the generated iOS project, adds the `LiveActivity` target to `project.pbxproj`, and updates entitlements.
2. Move `packages/app/ios/LiveActivity/*.swift` → `packages/app/plugins/live-activity/*.swift` (source of truth).
3. Delete `packages/app/ios/` from git: `git rm -rf packages/app/ios`.
4. Add `/ios/` to `packages/app/.gitignore` (mirrors `/android/`).
5. Register plugin in `packages/app/app.json:plugins`: `"./plugins/with-live-activity"`.
6. Verify `npx expo prebuild --clean --platform ios` produces a building project with LiveActivity intact.

**Effort**: **L** — 3-5 files changed + 37 files deleted + 1 new plugin (60-120 LOC) + significant iOS Xcode knowledge to get the pbxproj mutation right. Realistically 1-2 days of focused work with heavy testing. Config plugins that mutate `pbxproj` are notorious.
**Risk**: High during migration, low after. The LiveActivity target configuration (entitlements, Push tokens, Info.plist) must be replicated in plugin code.
**Rollback**: `git revert` the whole sequence; the 37 ios files return.

### Option B — Full committed-native

1. Run `npx expo prebuild --platform android` locally.
2. Remove `/android/` from `packages/app/.gitignore:26`.
3. `git add packages/app/android/` (~200 files including Gradle wrappers).
4. Remove `plugins` config entries that only exist to generate native code (`expo-camera`, `expo-speech-recognition` still needed for JS bindings but their Android manifest additions must be verified).
5. Every Expo SDK upgrade now requires `expo prebuild --clean` + manual merge for both platforms.

**Effort**: **M** — mechanically simple (~200 new files, ~2 config edits) but ongoing cost is high. Every SDK bump becomes a 2-3 hour merge job instead of a `package.json` line change.
**Risk**: Low now, high over 12 months.
**Rollback**: trivial until next SDK bump.

### Option C — Keep hybrid + document (recommended immediate)

1. Add a comment block to `packages/app/app.json` (JSON doesn't support comments — use `app.config.js` or a separate `HYBRID_NATIVE.md`).
2. Better: rename `packages/app/app.json` → `packages/app/app.config.js` and add a top-of-file comment explaining the hybrid strategy.
3. Add an `assert` to `scripts/bundle-xterm.js` (or a new `scripts/verify-native.js`) that fails `npm ci` if `packages/app/ios/LiveActivity/` is missing — catches `expo prebuild --clean` foot-guns.
4. Add a CI step that runs `npx expo prebuild --no-install --platform android` and asserts `packages/app/android/` is gitignored output (not a config crash).

**Effort**: **S-M** — 1-2 new files (~30 LOC each) + `.github/workflows/ci.yml` addition.
**Risk**: Lowest.
**Rollback**: trivial.

**My recommendation: Option C now, Option A in a dedicated follow-up PR** with its own swarm audit. The LiveActivity plugin work is non-trivial enough that it deserves its own review cycle. Don't try to bundle it with the immediate EAS unblock.

---

## Cross-Workspace Build Derisk

**Current chain**: `npm ci` at root → workspace hoisting → `prepare` scripts run → `postinstall` bundles xterm → EAS runs `expo prebuild` → Metro bundles.

**Failure modes I verified can happen:**

1. **`npm install` cache differs from `npm ci`**: `npm ci` honors `devDependencies` by default (no `--production`), so `prepare` scripts run. But a dev who runs `npm install --omit=dev` locally will skip `prepare` entirely and see broken types. EAS uses `npm ci --include=dev` (confirmed by build logs) — safe. Document it.
2. **Workspace `prepare` fails silently**: `tsc` in `@chroxy/protocol` can produce no output on success AND on certain errors (when `noEmitOnError` is unset). Check `packages/protocol/tsconfig.json`. If `noEmitOnError: true` is missing, a type error emits stale `dist/` and nobody notices until runtime.
3. **Metro-incompatible output**: `@chroxy/store-core`'s `prepare` only builds `./crypto` (`build:crypto` script). Main entry resolves to `src/index.ts` — Metro transforms it directly via `transformIgnorePatterns`. If a future dev adds a new export that requires a build step, Metro will fail to resolve it on EAS but work in local dev because of stale local `dist/`.

**Proposed verification step — new file `scripts/verify-workspace-outputs.js`:**

```js
#!/usr/bin/env node
// Fail fast if EAS is about to bundle stale/missing workspace outputs
const { existsSync, statSync } = require('fs')
const { resolve } = require('path')

const required = [
  ['packages/protocol/dist/index.js', 'packages/protocol/src/index.ts'],
  ['packages/protocol/dist/index.d.ts', null],
  ['packages/store-core/dist/crypto.js', 'packages/store-core/src/crypto.ts'],
  ['packages/app/src/components/xterm-bundle.generated.ts', null],
]

for (const [out, src] of required) {
  const outPath = resolve(__dirname, '..', out)
  if (!existsSync(outPath)) {
    console.error(`MISSING: ${out} — did prepare/postinstall run?`)
    process.exit(1)
  }
  if (src) {
    const srcPath = resolve(__dirname, '..', src)
    if (statSync(srcPath).mtimeMs > statSync(outPath).mtimeMs) {
      console.error(`STALE: ${out} is older than ${src}`)
      process.exit(1)
    }
  }
}
console.log('workspace outputs OK')
```

**Effort**: **S** — 1 new file (~30 LOC), 1 line added to `packages/app/eas.json` as a pre-build hook... except EAS doesn't support arbitrary pre-build hooks in the profile. Instead: add to `packages/app/package.json:postinstall` so it runs as part of `npm ci`. Actual line: `"postinstall": "node scripts/bundle-xterm.js && node ../../scripts/verify-workspace-outputs.js"`.

---

## `bump-version.sh` Gap Analysis

Read `scripts/bump-version.sh` (170 lines). What it handles: server, app, app.json, root, desktop, protocol, store-core, dashboard package.json + tauri.conf.json + Cargo.toml + 2 package-lock.json + Cargo.lock. Solid.

**What it misses (priority ordered):**

1. **P0 — `packages/app/ios/Chroxy/Info.plist`** — `CFBundleShortVersionString` and `CFBundleVersion`. Because `ios/` is committed, these drift from `app.json:version`. However, with `appVersionSource: "remote"` in `eas.json:4`, EAS overrides these at build time, so for cloud builds it's a non-issue. For LOCAL `expo run:ios` builds, the Info.plist is authoritative. Fix with `PlistBuddy` (macOS native) or a node script using `plist` npm package.

2. **P1 — LiveActivity `Info.plist`** — `packages/app/ios/LiveActivity/Info.plist` has its own version. Must match the main app's `CFBundleShortVersionString` or iOS rejects the build at submit time. Same fix as above.

3. **P2 — `packages/app/eas.json` build number floor** — if `autoIncrement: true` in `production` profile, EAS manages build numbers. But if a dev ever disables it, there's no fallback. Not critical now.

4. **P3 — `packages/dashboard/package-lock.json`** — script handles root and server lockfiles but not dashboard or app. Verify if those workspaces have their own lockfiles (they shouldn't — workspaces use root lockfile — but check).

5. **P4 — Expo `extra.runtimeVersion`** — not currently used, but if OTA updates ever ship, needs bumping in sync.

6. **P5 — Android `versionCode`** — N/A because `android/` is CNG, regenerated per build.

**Recommended patch**: Add a `bump_ios_plist` function using PlistBuddy, apply to both `ios/Chroxy/Info.plist` and `ios/LiveActivity/Info.plist`. Effort: **S** (~20 LOC added to `scripts/bump-version.sh`).

---

## CI Coverage Proposal

Add a new job to `.github/workflows/ci.yml` (after `app-typecheck`):

```yaml
app-expo-doctor:
  name: App Expo Doctor + Prebuild Dry Run
  runs-on: ubuntu-24.04
  timeout-minutes: 10
  defaults:
    run:
      working-directory: packages/app
  steps:
    - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
    - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
      with:
        node-version: 22
        cache: npm
        cache-dependency-path: '**/package-lock.json'
    - run: npm ci
      working-directory: .
    - run: npm run build
      working-directory: packages/protocol
    - run: npx expo-doctor
    - run: npx expo prebuild --no-install --platform android --clean
    - run: npx expo config --type public
```

**Why this would have caught today's cascade**: `expo prebuild --no-install` runs the exact CNG pipeline EAS uses during the PREBUILD phase, including parsing `eas.json` profile commands. A malformed `prebuildCommand` would fail here in <2 minutes instead of 8-10 min of EAS build time.

**Why not `eas build --local`**: requires macOS runner ($$$) AND Xcode AND ~20 min per build. Not a good CI investment.

**Effort**: **S** — 1 YAML job (~25 lines), no new deps.
**Cost**: ~2 min per PR.

---

## Top 5 Implementable Findings

| # | Finding | Effort | Files | Risk |
|---|---------|--------|-------|------|
| 1 | Add `app-expo-doctor` CI job running `expo-doctor` + `expo prebuild --no-install --platform android` | **S** | `.github/workflows/ci.yml` (+25 lines) | Low — detects regressions cheaply |
| 2 | Bump `@expo/vector-icons` to `^15.0.3` and fix `@types/jest` to `29.5.14` | **S** | `packages/app/package.json` (2 lines), lockfile regenerate | Low — only 1 source file imports vector-icons |
| 3 | Fix `softwareKeyboardLayoutMode` via `expo-build-properties` plugin | **S** | `packages/app/app.json` (+5 lines, -1 line), +1 dep | Low |
| 4 | Add `scripts/verify-workspace-outputs.js` + wire into `packages/app/package.json:postinstall` | **S** | 1 new file (~30 LOC), 1 line edit | Low — catches silent `prepare` failures |
| 5 | Add `bump_ios_plist` function to `scripts/bump-version.sh` for Info.plist sync | **S** | `scripts/bump-version.sh` (~20 lines) | Low |

**Deferred to follow-up PR (too large for immediate fix):**
- CNG Option A — full migration away from committed `ios/`. **L** effort, separate audit cycle.
- `eas.json` profile hardening — env vars, cache keys, resource classes. **M** effort, low urgency.

---

## Ordered Action Plan

**Step 1 — CI safety net (blocks everything else from regressing)**
- Add `app-expo-doctor` CI job to `.github/workflows/ci.yml`.
- Expect it to **fail initially** because of the 4 Doctor warnings — that's fine, run as `continue-on-error: true` for the first PR, flip to hard-fail after step 2.
- **Dependency**: none. Ship this first.

**Step 2 — Fix the 4 Doctor warnings in one PR**
- `packages/app/package.json` — update `@expo/vector-icons` to `^15.0.3`, `@types/jest` to `29.5.14`, add `expo-build-properties` as a dep via `npx expo install`.
- `packages/app/app.json` — remove `android.softwareKeyboardLayoutMode`, add `expo-build-properties` plugin config.
- Regenerate `package-lock.json` via `npm install` at root.
- Run `npm run test -w @chroxy/app` and `npx tsc --noEmit` in `packages/app`.
- Visually verify `Icon.tsx` renders one icon on boot via `npx expo start`.
- **Dependency**: Step 1 (so CI catches anything we miss). Flip the CI job to hard-fail in this PR.

**Step 3 — Workspace output verifier**
- Write `scripts/verify-workspace-outputs.js`.
- Wire into `packages/app/package.json:postinstall`.
- Test locally by deleting `packages/protocol/dist/` and running `npm ci`.
- **Dependency**: Step 2 (don't layer changes). Independent otherwise.

**Step 4 — Document hybrid native strategy (Option C)**
- Convert `packages/app/app.json` → `packages/app/app.config.js` with a top-of-file comment block explaining why `ios/` is committed and `android/` is CNG.
- Add `HYBRID_NATIVE.md` note under `packages/app/` (user allows domain-specific docs).
- Add a `npm run preflight` script that asserts `packages/app/ios/LiveActivity/*.swift` exists.
- **Dependency**: Step 2.

**Step 5 — `bump-version.sh` Info.plist sync**
- Add PlistBuddy-based version sync for `ios/Chroxy/Info.plist` and `ios/LiveActivity/Info.plist`.
- Test on next version bump.
- **Dependency**: none; orthogonal.

**Step 6 (deferred) — Full CNG migration**
- Separate PR, separate audit, dedicated LiveActivity config plugin.
- Not urgent. Ship steps 1-5 first.

---

## Overall Verdict — 2.6 / 5

The configuration is **buildable but brittle**. Nothing here is architecturally wrong — it's just under-tested. Every finding in this audit can be fixed with a small number of file changes, and the single biggest ROI (CI prebuild dry-run) is a 25-line YAML addition that would have prevented today's five-build cascade entirely. The hybrid native strategy is defensible *only because LiveActivity Swift code exists*; if that were ever removed, this whole setup should flip to full CNG immediately. Priority ordering is clear: ship CI safety net first, fix Doctor warnings second, derisk workspace outputs third, document the hybrid fourth. Everything else is polish. The plan is concretely implementable in a single afternoon of focused work, with the exception of the deferred CNG migration which deserves its own cycle.
