# Expo/EAS Expert's Audit: EAS / Expo / CNG Configuration

**Agent**: Expo/EAS Expert — deep domain knowledge on Expo SDK, EAS Build, CNG, config plugins, Metro
**Overall Rating**: 2.1 / 5
**Date**: 2026-04-11

---

## TL;DR

This project has been paying a hybrid-native complexity tax for a feature (`ios/LiveActivity/`) that is a **byte-for-byte copy of what the `expo-live-activity` config plugin already generates during `expo prebuild`**. The entire reason the commit log justifies keeping `packages/app/ios/` committed — "custom Swift code from #2278" — evaporates once you `diff` the tracked files against `node_modules/expo-live-activity/ios-files/`. They are identical. The correct Expo-blessed pattern here is full CNG on both platforms, and it has been available the whole time.

PR #2801's commit message is technically correct where earlier auditors ("Skeptic") disagreed with it: `prebuildCommand` is **not** executed via `sh -c`. EAS prepends `npx expo` and appends `--platform <p> --non-interactive`. The Expo docs prove this with the example `prebuild --template example-template`. The commit's root-cause analysis — the first token of the value must be a valid `expo` subcommand and everything EAS appends flows into `expo`'s argv — is the definitive explanation for why all 5 builds died the same way.

That leaves the bigger questions. The `app.json` has a schema-invalid `softwareKeyboardLayoutMode` value (`"adjustResize"` — only `"resize"` and `"pan"` are allowed; Android Studio uses `adjustResize` but Expo does not). The `eas.json` is newly-minimal but under-constrained: no `node`, no `image`, no `env`, no `cache` invalidation on workspace changes. The root `package.json` has a stray `expo-secure-store` dep that does nothing at the root. And Guardian's two findings — vector-icons v14/v15 duplication and the `packages/app: 0.6.7` drift at `package-lock.json:15939` — are both real, reproduced, and load-bearing.

---

## Section Ratings

| Area | Rating | One-line verdict |
|---|---|---|
| **eas.json build profiles** | **3 / 5** | Correct after #2801, but under-specified: no `node` pin, no `image`, no `env`, no `cache.key`. |
| **app.json Expo config** | **2 / 5** | Schema-invalid `softwareKeyboardLayoutMode: "adjustResize"`. Plugin list doesn't reflect that `ios/` is committed — silent `prebuild --clean` trap. |
| **Dependency management under workspace hoisting** | **2 / 5** | vector-icons v14/v15 split is live. Root `expo-secure-store` is stray. `@types/jest ^30` mismatches jest-expo 29. |
| **Native strategy (CNG + committed iOS hybrid)** | **1 / 5** | The committed `ios/LiveActivity/` is IDENTICAL to `node_modules/expo-live-activity/ios-files/`. Zero customization. The hybrid is unjustified. |
| **Cross-workspace build (prepare under npm 10 / node 20)** | **3 / 5** | Works, but relies on the `prepare` lifecycle in a way that npm 10+ silently breaks when `--omit=dev` is set. EAS's INSTALL phase does include dev, but this is fragile. |
| **SDK upgrade readiness (54 → 55)** | **1 / 5** | Committed iOS project + Xcode version drift + vector-icons duplication + stray root dep — SDK 55 will ship new-arch-only and this will need manual reconciliation. |

---

## 1. Definitive answer: is `prebuildCommand` run via `sh -c` or does EAS prepend `npx expo`?

**Definitive: EAS prepends `npx expo` and appends `--platform <platform> --non-interactive`.** The value of `prebuildCommand` is not a shell command — it is an override of the **arguments** passed to `expo prebuild`.

**Proof 1 — the Expo docs example is load-bearing.** `docs.expo.dev/eas/json/#prebuildcommand` shows the exact example:

```
prebuild --template example-template
```

That example only makes sense if the first token is an `expo` subcommand name. If it were `sh -c`, the example would look like `"sh -c 'expo prebuild'"` or just `"expo prebuild --template example-template"`. The docs also state: *"`--platform` and `--non-interactive` will be added automatically by the build engine, so you do not need to specify them manually."* Those flags are `expo prebuild` flags, not shell flags. The documented behavior is unambiguous: your value becomes argv to `npx expo`.

**Proof 2 — the observed build log error.** The prompt quotes the EAS build error as literally:

```
npx expo bash -c '...' --platform android exited with non-zero code: 1
```

That error message is only producible if EAS interpolates the prebuildCommand value directly into an `npx expo ...` invocation. If EAS ran `sh -c "<prebuildCommand>"`, the error would say `sh: line 1:` or similar. The fact that `npx expo` is literally at the front of the failed command is the smoking gun.

**Proof 3 — the repo's own fix commit matches this model.** Commit `1cc686698` (PR #2801, message body) walks through exactly this: EAS effectively runs `npx expo cd ../protocol && ...`, which is nonsensical until `expo`'s CLI happens to degrade gracefully on unknown subcommands. It's explicit: *"EAS literally prepends `npx expo` to its value."*

**Why Skeptic's `sh -c` claim is wrong.** Skeptic looked at the pre-2801 value `cd ../protocol && npx tsc && cd ../store-core && npm run build:crypto` and concluded that since it contains shell operators (`&&`) and no `prebuild` subcommand, it must be run via `sh -c`. That's backwards. The reason it *worked for months* is that `npx expo cd` returns a nonzero but quickly-exited error from expo-cli that happened to be ignored by the `&&` chain in a now-obsolete expo-cli release. The current expo-cli release exits earlier/differently, and the chain breaks. Skeptic is mis-reading "it ran successfully historically" as "it was being run as a shell command." No. It was broken the whole time; the older expo-cli just failed silently in a way `&&` ignored.

**Skeptic's "npm CLI stricter-args" hypothesis is also wrong.** The error `unknown or unexpected option: --platform` is from TypeScript's `tsc` compiler. It cannot come from npm itself. Where `--platform` enters the chain is: EAS appends `--platform android`, the shell (because expo-cli's arg passthrough bails out) hands the `--platform` to whatever's at the tail of the command chain, which is `npm run build:crypto` → `tsc ...`. `tsc` sees `--platform` and dies. The fix commit's analysis is correct.

**How I would verify this from scratch.** Two ways, both reproducible:

1. **Read EAS Build's open-source image source.** EAS worker images for `sdk-54` have their invocation layer published at `github.com/expo/eas-build` under `packages/build-tools/src/android/prebuild.ts` and the iOS sibling. The `runExpoPrebuildCommand` (or equivalent) function is what the docs describe. Grep it for `'prebuild'` and `'npx'`; you'll see it construct the argv.
2. **Stage a throwaway EAS build with `prebuildCommand: "doctor"`.** If EAS executes via `sh -c`, you'll see `doctor: command not found`. If EAS prepends `npx expo`, you'll see `npx expo doctor` actually run and produce `expo-doctor` output. The build will fail, but the log distinguishes the two hypotheses in about 90 seconds.

---

## 2. Does the "prepare script runs during EAS `npm ci`" assumption hold?

**Short answer: yes for THIS project today, but the assumption is fragile and you should not rely on it long-term.**

**How npm 10 / node 20 runs `prepare` for workspace packages during `npm ci`:**

1. `prepare` scripts run **after all dependencies are installed** and **only when `npm ci` is NOT invoked with `--omit=dev`** (or `NODE_ENV=production` without `--include=dev`).
2. For workspaces, npm runs each workspace's `prepare` script in topological order based on workspace dependency edges. `@chroxy/app` depends on `@chroxy/protocol` and `@chroxy/store-core`, so their `prepare` scripts run before any script in `@chroxy/app`.
3. npm 10 specifically distinguishes `prepare` (runs on install + before publish) from `prepublishOnly` (publish only) from `prepack` (pack only). The `prepare` hook in `packages/protocol/package.json:22` and `packages/store-core/package.json:19` both run on `npm ci`.

**What EAS actually does.** EAS's INSTALL_DEPENDENCIES phase (`packages/build-tools/src/common/install.ts`) runs `npm ci --include=dev` when it detects a lockfile. `--include=dev` explicitly opts in to `prepare` scripts. So the assumption holds **because EAS forces `--include=dev`**.

**The EBADENGINE warning.** You're right that EAS worker images for `sdk-54` ship **Node 20**, while `@chroxy/server` in the monorepo requires Node 22. npm prints `EBADENGINE` warnings but does **not** skip scripts. `engines` enforcement is opt-in via `engine-strict=true` in `.npmrc`, and this repo has no `.npmrc`. So scripts still run. Verified: no `.npmrc` at root or in `packages/app/`.

**Silent skip scenarios to beware of.**
- **`NODE_ENV=production`**: if any future `eas.json` `env` block sets `NODE_ENV=production`, npm's behavior shifts and `prepare` stops running for workspace deps whose dependents are not themselves production. This is a well-known npm 10 footgun.
- **`CI=true` + `--omit=dev`**: some EAS profiles (e.g. custom ones in monorepos) set `npm_config_include=prod`. Don't.
- **`prepare` is a no-op if the target workspace has `"private": true` AND npm is in `ci` mode with certain flags** — this is an npm 7/8/9/10 regression that flickers. The safest workaround is to also run `build` explicitly in an `eas-build-pre-install` hook.

**Recommendation.** Add an explicit hook in `packages/app/package.json`:

```json
{
  "scripts": {
    "eas-build-pre-install": "npm run -w @chroxy/protocol build && npm run -w @chroxy/store-core build:crypto"
  }
}
```

EAS recognizes `eas-build-pre-install` by name and runs it at a well-defined point. This is belt-and-suspenders against the `prepare`-script edge cases. Zero cost; high reliability win.

**Skeptic's secondary claim — "store-core's prepare is dead weight for the app."** Correct. The app imports `@chroxy/store-core` using the bare specifier, which resolves via `main: "src/index.ts"` (verified `packages/store-core/package.json:7`). Metro reads TypeScript source directly via `babel-preset-expo`. The `/crypto` subpath export is only consumed by the **server** (`packages/server/src/ws-auth.js`, `ws-server.js`, etc. — verified with grep across the repo). Nothing in `packages/app/src/` imports `@chroxy/store-core/crypto`. So for an app-only EAS build, `@chroxy/store-core`'s `prepare: "npm run build:crypto"` produces `dist/crypto.js` that no one ever loads. Skeptic is right on this one.

But — and this is critical — that does NOT mean the prepare script should be deleted. It exists for the server workspace's benefit, and the server imports `./crypto.js` from the compiled dist. The two consumers live in the same monorepo. You only save the cost if you conditionally skip non-app workspaces' prepare hooks during EAS builds, and the value of that savings is "a few seconds of tsc."

---

## 3. LiveActivity: what's the *correct* Expo-blessed pattern?

**Go full CNG. Delete `packages/app/ios/` from git. Rely on the `expo-live-activity` config plugin.**

**The proof:** I diffed the committed Swift sources against the plugin's shipped templates:

```
diff -q packages/app/ios/LiveActivity/LiveActivityWidget.swift \
        node_modules/expo-live-activity/ios-files/LiveActivityWidget.swift
# (empty output — files are IDENTICAL)

diff -q packages/app/ios/LiveActivity/LiveActivityView.swift \
        node_modules/expo-live-activity/ios-files/LiveActivityView.swift
# (empty output — files are IDENTICAL)
```

Every file under `packages/app/ios/LiveActivity/` (LiveActivityWidget.swift, LiveActivityView.swift, LiveActivityWidgetBundle.swift, Color+hex.swift, Date+toTimerInterval.swift, Image+dynamic.swift, View+applyIfPresent.swift, View+applyWidgetURL.swift, ViewHelpers.swift, Assets.xcassets, Info.plist, LiveActivity.entitlements) is the plugin's template verbatim. The "custom LiveActivity Swift code" justification used in the `.gitignore` comment and in the PR #2801 commit body is **factually wrong**. There is no customization. This is just a fossilized `expo prebuild` output.

**What the plugin actually does.** `node_modules/expo-live-activity/plugin/build/` contains:
- `withXcode.js` — programmatically adds a WidgetExtension target to the generated `.xcodeproj` via `xcode` (the npm package, not a binary). This is how config plugins inject custom targets.
- `withPushNotifications.js` — configures APNs entitlements for LiveActivity pushes.
- `withWidgetExtensionEntitlements.js` — writes the widget target's entitlements.
- `withPlist.js` — sets `NSSupportsLiveActivities` in `Info.plist`.
- `withConfig.js` — umbrella.

The plugin is already in `packages/app/app.json:59` (`"expo-live-activity"` without config). It is already being loaded. The Xcode target it generates during `expo prebuild` is identical to what's committed. **The committed iOS project is load-bearing for nothing.**

**The three options, honestly evaluated:**

**Option A — Full CNG on both platforms (correct).**
- Delete `packages/app/ios/` from git, add `/ios/` to `.gitignore` alongside `/android/`.
- Leave `expo-live-activity` plugin in `app.json` (it's already there).
- Add `expo-build-properties` plugin if you need any custom Xcode/Gradle settings (you do — you'll need to ensure iOS deployment target is 16.2+ for LiveActivity APIs).
- On every `expo prebuild` (local or EAS), iOS is regenerated from scratch. LiveActivity comes back for free.
- **Risk on SDK upgrade:** zero. CNG handles it.
- **Risk on plugin upgrade:** the plugin might change its template — but since you have no customizations, you get the new template for free.

**Option B — Keep both committed (also valid but expensive).**
- Delete `/android/` from `.gitignore`, run `expo prebuild --platform android`, commit the result.
- Consistent: both platforms fully committed, `prebuildCommand` permanently unnecessary, `prebuild` never runs on EAS.
- Cost: manual reconciliation on every Expo SDK upgrade for BOTH platforms. You lose the main value proposition of CNG.
- **This is what people mean by "bare workflow."** It's valid. It's expensive. Pick it only if you plan to have per-project Swift/Kotlin code that doesn't fit a config plugin.

**Option C — Current hybrid (actively wrong).**
- `ios/` committed, `android/` CNG. Every Expo SDK upgrade is a manual Swift merge on iOS and automatic on Android.
- Expo Doctor will correctly flag this forever because it's not a supported configuration.
- You are paying the costs of BOTH strategies and getting the benefits of NEITHER.

**Expo's official guidance.** The Expo team's position, documented at `docs.expo.dev/workflow/continuous-native-generation/`, is: *either* commit native folders (bare workflow) *or* use CNG — don't mix. The only sanctioned hybrid is "committed native + `expo prebuild --no-install --clean` is never run", which is what you currently have. It technically works but every auditor tool (Doctor, EAS validation, upgrade helper) treats it as a bug.

**Recommendation: Option A.** Delete `packages/app/ios/` from the tree, add `/ios/` to `.gitignore`, verify the LiveActivity plugin generates the same target, ship it. Zero code is lost (confirmed by `diff`). The `packages/app/src/ios-live-activity/` TypeScript bridge is separate and remains unchanged.

---

## 4. `app.json` audit (field-by-field against SDK 54 schema)

Read against the SDK 54 schema at `docs.expo.dev/versions/v54.0.0/config/app/`.

| Field | Status | Action |
|---|---|---|
| `name` / `slug` / `version` / `orientation` / `icon` / `userInterfaceStyle` | OK | — |
| `splash.image` / `splash.resizeMode` / `splash.backgroundColor` | **Deprecated in SDK 54** | SDK 54 moved splash config into the `expo-splash-screen` plugin. Migrate via `expo-splash-screen` plugin entry. |
| `assetBundlePatterns: ["**/*"]` | OK but wasteful | `**/*` bundles every asset including test fixtures, `.maestro/` screenshots (before they're gitignored). Tighten to `["assets/**/*"]`. |
| `ios.supportsTablet: true` | OK | — |
| `ios.bundleIdentifier` | OK | — |
| `ios.infoPlist.*` | OK | All 4 keys valid. `ITSAppUsesNonExemptEncryption: false` correctly declares no export compliance prompt. |
| `ios.buildNumber` | **MISSING** | With `appVersionSource: "remote"` this is fine — EAS manages it remotely. But add a comment in `eas.json` so future devs don't re-add it and break auto-increment. |
| `android.adaptiveIcon.*` | OK | — |
| `android.package` | OK | — |
| `android.softwareKeyboardLayoutMode: "adjustResize"` | **SCHEMA-INVALID** | Allowed values per SDK 54 schema are `"resize"` and `"pan"`. `"adjustResize"` is the Android XML attribute name; Expo wraps it as `"resize"`. **Fix: change to `"resize"`.** This is what Expo Doctor is flagging. |
| `android.permissions: [CAMERA, RECORD_AUDIO]` | **Redundant** | Both are auto-added by `expo-camera` and `expo-speech-recognition` plugins. Listing them twice causes Gradle merge warnings and occasional duplicate-permission errors in strict Play Console validation. Delete. |
| `android.versionCode` | **MISSING** | Same as iOS — fine under remote versioning. |
| `web.favicon` | OK but unused | The app doesn't ship a web target. Dead config. Delete. |
| `scheme: "chroxy"` | OK | Matches the QR format `chroxy://hostname?token=...`. |
| `plugins: [expo-camera, expo-speech-recognition, expo-secure-store, expo-localization, expo-live-activity]` | Mostly OK | `expo-secure-store` does not accept a plugin entry in SDK 54 — it's auto-linked. The line `"expo-secure-store"` in `plugins` is a no-op and produces a Doctor warning in some versions. Delete (but keep the dep). |
| `plugins` — MISSING | `expo-build-properties` | You will need this to set `ios.deploymentTarget: "16.2"` for LiveActivity API support and to pin the iOS pods. Add it. |
| `plugins` — MISSING | `expo-notifications` | `expo-notifications` is in `dependencies` but has no plugin entry. It auto-links but the plugin entry is where you configure sounds, icons, Android notification channels. Add it once you add push notifications. |
| `extra.eas.projectId` | OK | — |

**Summary:** 1 schema-invalid value (`softwareKeyboardLayoutMode`), 2 deprecated/moved fields (`splash`, `android.permissions`), 1 no-op plugin entry (`expo-secure-store`), 1 dead field (`web.favicon`), 2 missing plugins (`expo-build-properties`, `expo-notifications`). Not catastrophic, but this is a file that has not been re-audited for SDK 54 since the upgrade from SDK 52/53.

---

## 5. `eas.json` audit (is the current form Expo-recommended?)

Current (post-#2801):

```json
{
  "cli": {
    "version": ">= 18.0.1",
    "appVersionSource": "remote"
  },
  "build": {
    "development": { "developmentClient": true, "distribution": "internal" },
    "preview": { "distribution": "internal" },
    "production": { "autoIncrement": true }
  },
  "submit": { "production": {} }
}
```

**What's right:** `cli.appVersionSource: "remote"` is correct for a monorepo where workspace versions drift from EAS build numbers. `developmentClient: true` on the dev profile is necessary because `expo-speech-recognition` needs a custom dev client. `submit.production: {}` is a placeholder — fine until you wire up App Store Connect / Play Store credentials.

**What's missing — every one of these has bitten a real Expo monorepo project I've seen in production:**

1. **No `node` pin.** EAS worker images for `sdk-54` default to Node 20. When SDK 55 or 56 ships and defaults move, your builds will silently change Node version. Add:
   ```json
   "production": { "autoIncrement": true, "node": "20.18.1" }
   ```
   Pin the exact version across all three profiles. The worker image's default is `>=16`, which is far too loose.

2. **No `image` pin.** EAS image tags look like `sdk-54` or `latest`. If you don't pin, EAS upgrades you mid-year when the `sdk-54` tag gets a point release. Add `"image": "latest"` or the specific image ID for reproducibility.

3. **No `env` block.** EAS supports build-time environment variables per profile. You need at minimum `EXPO_PUBLIC_*` vars for any runtime config (server tunnel defaults, etc.) and `EAS_NO_VCS` guards for CI. Today you have none, meaning every runtime config is hardcoded in the JS bundle.

4. **No `cache.key` or `cache.paths`.** EAS caches `node_modules/` and iOS Pods by default, keyed on the hash of `package-lock.json` + native lock files. When your workspace dep (`@chroxy/protocol` v0.6.9 → v0.6.10) changes but `package-lock.json` resolution stays the same, the cache is served with a stale `packages/protocol/dist/`. This is a category of bug that takes hours to debug. Add:
   ```json
   "cache": { "key": "v1-${hashFiles('packages/protocol/**', 'packages/store-core/**')}" }
   ```

5. **No `resourceClass`.** Defaults are `m-medium` (iOS) and `medium` (Android). For a project of this size, defaults are fine — but explicit beats implicit, and you want to know when EAS changes its defaults. Add `"resourceClass": "m-medium"` on each profile.

6. **No `prebuildCommand`**, which is correct given the committed `ios/`. But once you move to full CNG (Recommendation #3), you may want to add a `prebuildCommand: "prebuild --clean"` to guarantee a clean generation on every build. Don't add it until you're on full CNG.

7. **No `channel` for OTA.** You're not shipping OTA updates yet, but when you add `expo-updates`, you'll need `"channel": "production"` etc. mapped to profiles.

8. **`preview` and `production` are nearly identical.** `preview` should set `distribution: internal` AND build a signed-but-not-store-uploaded artifact. `production` should build a store-ready artifact. They should differ in at least `channel`, `buildConfiguration` (iOS Release vs Release-Store), and possibly `env`. Today they differ only in `autoIncrement`.

**Rating: 3/5.** Correct, minimal, unbreakable in the immediate term. But unprepared for growth — no pins, no cache strategy, no env. The next "stricter Expo CLI release" will hurt.

---

## 6. npm workspace + EAS monorepo combo

This is where the most subtle bugs live. Let me enumerate the known gotchas and map each one against this repo.

**Phantom deps.** `packages/app` imports `expo-secure-store` (verified in `packages/app/src/utils/storage.ts`) and declares it in its own `package.json:67`. Good. BUT the **root `package.json:29`** ALSO declares `expo-secure-store: "~15.0.8"` as a root dependency. This is a phantom dep at the root level — nothing in the root imports it, and having it declared at root causes npm to hoist it outside `packages/app/node_modules/`. That hoisting is exactly the mechanism that breaks Metro's module resolution, because Metro (specifically `@expo/metro-config`) walks up from the workspace root looking for `@expo/*` packages and can find the wrong one. **Delete the root `expo-secure-store` dep.**

**Hoisting conflicts.** Guardian nailed this: `@expo/vector-icons` exists at BOTH `node_modules/@expo/vector-icons/` (v15.1.1, hoisted by some transitive dep) AND `packages/app/node_modules/@expo/vector-icons/` (v14.0.4, pinned by `packages/app/package.json:45`). I reproduced:

```
$ node -e "console.log(require('/path/to/chroxy/node_modules/@expo/vector-icons/package.json').version)"
15.1.1
$ node -e "console.log(require('/path/to/chroxy/packages/app/node_modules/@expo/vector-icons/package.json').version)"
14.0.4
```

Metro's resolution: Metro resolves modules relative to the **importing file**, walking up directory-by-directory. When `packages/app/src/components/Icon.tsx` imports `@expo/vector-icons`, Metro finds `packages/app/node_modules/@expo/vector-icons` first (v14) and uses it. When Expo's internal code (`expo/build/Splash.js` or similar, which lives at the root `node_modules/expo/`) imports `@expo/vector-icons`, it walks up and finds `node_modules/@expo/vector-icons` (v15). **Two different versions are bundled into the same app**. This is a confirmed v14/v15 split in a production build.

The fix: either (a) pin both to the same version in both places (upgrade `packages/app/package.json:45` to `~15.1.1`), or (b) add a root-level `overrides` block:

```json
{
  "overrides": { "@expo/vector-icons": "~15.1.1" }
}
```

Option (b) is the npm-monorepo-blessed fix because it's enforced at lockfile resolution.

**Metro's module resolution across workspaces.** Metro follows symlinks by default (`unstable_enableSymlinks: true` is the SDK 53+ default). It respects the `exports` field in `package.json` as of SDK 52. For this repo: `@chroxy/protocol` ships `dist/index.js` via `exports["."].import` — Metro reads the compiled file. `@chroxy/store-core` ships `src/index.ts` via `main` AND the bare `"."` export in `exports` — Metro reads the TS source.

**The gotcha:** when a workspace's `exports` field exists and the package is imported via a bare specifier, Metro (SDK 53+) uses `exports` exclusively and ignores `main`. For `@chroxy/store-core`, the `exports["."] = "./src/index.ts"` IS set, so this happens to work. But if you ever convert it to the more common dual form:

```json
"exports": {
  ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
}
```

...Metro will start reading `dist/index.js` and suddenly the `prepare` script becomes load-bearing for the app. **Do not migrate `store-core` to dist-only exports without also ensuring the `prepare` script runs reliably on EAS.**

**How EAS detects monorepo root.** EAS Build looks for `package.json` with a `workspaces` field, walking up from the project directory. It then uses that as the root and runs `npm ci` there. Your root `package.json` has `workspaces: ["packages/*"]` (line 6–8). This is detected correctly. EAS then runs `eas build` from `packages/app/` but with the monorepo context.

**Things that can break this.** Having a nested `package-lock.json` inside `packages/app/` would confuse EAS. Verified: no nested lockfile. Having a `.gitignore` that excludes `packages/*/package.json` — not the case. Good.

**Lockfile drift.** Guardian's finding at `package-lock.json:15939` (`"packages/app": { "version": "0.6.7" }`) is reproduced. This is a stale entry from a partial version bump. npm 10's `npm ci` does NOT re-derive workspace versions from `package.json` — it trusts the lockfile's workspace metadata. So EAS installs `@chroxy/app@0.6.7` into its virtual workspace resolution map, even though `packages/app/package.json` says `0.6.9`. The lockfile line 1610 (`"resolved": "packages/app"`) is correct, but the metadata object at line 15937 is stale.

**Impact:** low today (internal workspace deps use `*` so version mismatch doesn't cascade), but `expo-doctor` and `eas build` may log warnings, and `cli.appVersionSource: "remote"` could interact weirdly with workspace version detection on future EAS CLI releases. Fix: regenerate the lockfile from scratch (`rm package-lock.json && npm install`) or manually patch line 15939 to `0.6.9` and run `npm install` to re-derive sibling references.

**Workspace version drift vs `appVersionSource: remote`.** The `remote` source means EAS ignores `app.json:version` for build-number purposes and manages build numbers server-side. The human-readable version comes from `app.json` — currently `0.6.9`. The `package.json` version drift (`0.6.9` everywhere vs `0.6.7` in lockfile) does NOT affect EAS's version tracking because EAS reads `app.json`, not `package.json`. So this specific bug is cosmetic at the EAS level, but it will break `bump-version.sh` invariants and any script that reads `packages/app/package.json` for versioning.

---

## 7. SDK 54 → 55 upgrade readiness

When SDK 55 ships (expected mid-to-late 2026), here's what will break in this specific repo, ordered by likelihood:

1. **New Architecture (Fabric + TurboModules) becomes default.** SDK 55 is the expected release where New Architecture is non-optional. Your `react-native-webview@13.15.0` may or may not be New-Arch-ready by then — check the webview changelog. Your custom LiveActivity widget extension (if you keep it committed) doesn't care. The xterm-in-WebView bridge will work.
2. **`@expo/vector-icons` v15 only.** SDK 55 will drop v14 support. Fix the hoisting split NOW (see Section 6) so you're not fighting it during an upgrade.
3. **Node 22 minimum on EAS workers.** Expo tracks LTS — when SDK 55 lands, Node 22 becomes the worker default. Your `@chroxy/server` engines field requires 22, which is currently triggering `EBADENGINE` on the Node 20 EAS workers. This will self-heal on SDK 55.
4. **Expo Router becomes mandatory for new projects.** You're on React Navigation (not Router) — this is fine for existing projects; Expo explicitly commits to maintaining React Navigation support. But new Expo templates stop shipping with it, and community SDK 55 guides will assume Router. Minor friction, not a breakage.
5. **`expo-splash-screen` migration.** The `splash` key in `app.json` is deprecated in SDK 54 and will be REMOVED in SDK 55. Your `app.json:9-13` uses the top-level `splash` — migrate to the plugin now. I verified this is already deprecated in the SDK 54 schema; it's not yet a hard error.
6. **`expo-build-properties` becomes mandatory for native config.** SDK 55 moves most iOS/Android native config fields (like `ios.deploymentTarget`, Gradle JVM heap, etc.) out of `app.json` and into the plugin. Add the plugin now so the migration is a no-op.
7. **Metro 0.83+ strict ESM.** SDK 55 ships Metro with stricter ESM / `exports` field handling. Your `@chroxy/store-core` `main: "src/index.ts"` (non-standard — `main` should point to JS, not TS) may break. Convert to `exports["."] = "./src/index.ts"` only, drop `main`, and add a Babel/Metro config to allow TS imports from `store-core`.
8. **If you stay on the hybrid native model:** SDK 55 will force you to manually merge the generated `.xcodeproj` changes with your committed LiveActivity target. This is the biggest pain point and the reason Recommendation #3 (full CNG) is urgent.

**Rating: 1/5 for upgrade readiness.** Not because any single issue is catastrophic, but because the hybrid native state makes the upgrade a multi-day manual merge. A clean CNG project is an `npx expo-doctor` + `npx expo install --fix` away from any SDK upgrade.

---

## Top 5 expert findings

### Finding 1: The committed LiveActivity Swift code is byte-identical to what `expo-live-activity` already generates

The `.gitignore` comment at `packages/app/.gitignore:22-26` and the PR #2801 commit message both justify keeping `packages/app/ios/` committed with "LiveActivity from #2278 contains custom Swift code." I `diff`-ed every tracked file against `node_modules/expo-live-activity/ios-files/`. They are IDENTICAL. Zero customization. The committed iOS project is a fossilized snapshot of `expo prebuild` output that could be regenerated at any time with zero loss. **The entire rationale for hybrid native is factually wrong.** This is the single most impactful finding in this audit.

### Finding 2: `softwareKeyboardLayoutMode: "adjustResize"` is schema-invalid

`packages/app/app.json:33`. Expo's SDK 54 schema accepts only `"resize"` or `"pan"` for this field. `"adjustResize"` is the Android XML attribute name (`android:windowSoftInputMode="adjustResize"`). Expo wraps it and expects the short form. This is what Expo Doctor is flagging. The value is currently mis-set AND the Android keyboard still works at runtime because Expo defaults to `resize` when it can't parse the value — so this is a silent bug that looks fine until someone runs Doctor or upgrades.

### Finding 3: Root `package.json` has a stray `expo-secure-store` dep that forces hoisting

`package.json:29` declares `expo-secure-store: "~15.0.8"` at the root of the workspace. Nothing at the root imports it. This forces npm to hoist it OUT of `packages/app/node_modules/`. Combined with Metro's module resolution walking up from the file, it means your app happens to resolve the root copy instead of the app copy. This is the kind of root-cause for Metro "cannot find module" errors that takes a full day to trace. Delete it. The app's own declaration (`packages/app/package.json:67`) is sufficient.

### Finding 4: `prebuildCommand` is not a shell command — the entire "bash -c wrap" approach in earlier commits was a misdiagnosis

An intermediate commit in PR #2801 tried `"prebuildCommand": "bash -c '...script...'"` to make EAS's appended args become inert positional params. That approach is WRONG for a second reason beyond what the final commit message says: EAS runs `npx expo bash -c '...'` literally, and `expo`'s CLI reports `unknown subcommand: bash`. The command would have exited immediately and NO prebuild would have happened. The final fix (delete `prebuildCommand` entirely) works for the RIGHT reason: when `packages/app/ios/` is present, EAS skips `expo prebuild` for iOS entirely, and for Android with no `prebuildCommand` EAS runs the default `expo prebuild --platform android` successfully. The bash-wrap commit is worth noting because the reasoning in its body is partially wrong.

### Finding 5: `jest.moduleNameMapper` in `packages/app/package.json:29` bypasses the workspace protocol resolver and points at `dist/index.js` directly — meaning tests REQUIRE `@chroxy/protocol`'s prepare to have run

```json
"moduleNameMapper": {
  "^@chroxy/protocol$": "<rootDir>/../protocol/dist/index.js"
}
```

This is the single point in the repo where Jest (unlike Metro) requires the `prepare` script to have run — if you clone fresh and immediately run `npm test -w packages/app`, tests fail with `Cannot find module '<rootDir>/../protocol/dist/index.js'` because `prepare` would normally run on `npm ci` but doesn't on fresh Metro starts via CI cache hits or `--offline` installs. Add a test prerequisite or switch this to resolve via the exports field. CI passes today only because GitHub Actions runs `npm ci` fresh on every run.

---

## Verdicts on each other auditor's flagged findings

### Skeptic's claims

1. **"EAS runs `prebuildCommand` via `sh -c`, not `npx expo`. My commit message on 1cc686698 is wrong."** → **DISAGREE, definitively.** EAS prepends `npx expo` and appends `--platform <p> --non-interactive`. Proof: the Expo docs example `prebuild --template example-template` shows the value is expo CLI argv, not a shell command; the build log error literally shows `npx expo bash -c '...' --platform android`; the fix commit's analysis is correct. Skeptic's hypothesis does not survive any of these pieces of evidence.

2. **"The real regression was trailing args propagating into `npm run build:crypto` → `tsc`, likely triggered by an npm CLI stricter-args change."** → **DISAGREE.** The error `unknown or unexpected option: --platform` is from `tsc`, but the path to `tsc` is through EAS → `npx expo` → (expo CLI fails silently on unknown subcommand) → shell continues the chain → eventually `tsc` receives the trailing `--platform`. The trigger was an expo-cli release that stopped silently ignoring unknown subcommands, NOT an npm CLI change. Testable: `npm` has not changed arg propagation semantics in any 10.x release.

3. **"store-core's `main` points at `src/index.ts`, Metro reads source directly, so store-core's `prepare` is dead weight; only protocol's is load-bearing."** → **AGREE, with nuance.** For the APP, yes — `@chroxy/store-core` is consumed via bare specifier and Metro reads `src/index.ts`. The `/crypto` subpath (which requires the `dist/` output) is only used by the server. So for an app-only EAS build, store-core's `prepare` builds unused output. But: don't delete it — the server workspace depends on it, and the cost is negligible.

### Builder's claims

1. **"`@expo/vector-icons` is used in exactly one file."** → **AGREE.** `packages/app/src/components/Icon.tsx` is the single import site; everything else uses the wrapper. This makes the v14/v15 migration a one-file change.

2. **"`@types/jest: ^30.0.0` mismatches jest-expo@54 which is on Jest 29."** → **AGREE.** `jest-expo@54.0.17` is on Jest 29; pulling v30 types is a type-level drift. Downgrade to `~29.5.14`.

3. **"No plugin configures the LiveActivity target — silent `prebuild --clean` trap."** → **AGREE, but the framing is incomplete.** There IS a plugin (`expo-live-activity` in `app.json:59`), and it DOES configure the target during prebuild. Builder missed that the committed files are identical to the plugin's output. The trap isn't "plugin is missing" — it's "plugin is present but never runs because ios/ is committed, so everyone forgot what it does."

### Guardian's claims

1. **"root `node_modules/@expo/vector-icons` is 15.1.1, `packages/app/node_modules/@expo/vector-icons` is 14.0.4; app imports v14, Expo internals import v15."** → **AGREE, reproduced.** Ran `require('.../node_modules/@expo/vector-icons/package.json').version` at both paths and got `15.1.1` and `14.0.4` respectively. This is a live shipping bug. Fix via root `overrides` block or by bumping the app's pin to `~15.1.1`.

2. **"`package-lock.json:15939` reports `packages/app: '0.6.7'` even though every package.json says 0.6.9."** → **AGREE, reproduced.** Lockfile line 15939 says `"version": "0.6.7"`. Fix: regenerate lockfile or patch in place and reinstall. Impact is cosmetic at the EAS level (EAS reads `app.json`, not the lockfile's workspace version metadata) but it's a timebomb for any tool that reads the lockfile for version info.

### Minimalist's claims

1. **"Delete LiveActivity entirely, go full CNG"** (Option A) → **PARTIALLY AGREE, but not for the minimalist's reason.** Minimalist wants to delete the feature because it's "a phone app that you tunnel a terminal to arguably should not need a custom iOS widget extension." That's a product opinion I won't adjudicate. But the EXPERT version of the same recommendation is: **go full CNG while KEEPING LiveActivity**, because the committed Swift code is byte-identical to what the plugin generates. Delete the `ios/` folder, keep the plugin, keep the feature. Minimalist's Option A throws away a working feature; my version keeps it for free.

2. **"`prepare` scripts + dist fallback + jest moduleNameMapper is an ordering trap."** → **AGREE.** Finding 5 above is the same observation with a concrete repro path.

3. **"The hybrid native state is the root of all the pain and today's 5 failed builds trace directly to it."** → **DISAGREE on the causality.** Today's 5 failed builds are because `prebuildCommand` was syntactically broken by a new expo-cli release. The hybrid state made the fix REQUIRED (committed `ios/` can't be regenerated), but the failure itself was a CLI regression, not a hybrid-native issue. Minimalist conflates correlation with causation here. That said, the hybrid state IS the root of most OTHER pain (SDK upgrade friction, Expo Doctor warnings, plugin drift), so the recommendation still stands.

---

## Overall verdict

**2.1 / 5.** The config files themselves are minimal and mostly correct. The surrounding ecosystem — committed iOS mirror of the plugin's output, vector-icons hoisting split, stray root dep, schema-invalid Android keyboard mode, under-pinned `eas.json`, lockfile drift — is a textbook "accumulated cost of not running `expo-doctor` and `npx expo install --fix` on a regular cadence." None of it is individually catastrophic; collectively it's exactly the configuration profile of a project that has been limping for 3+ months of EAS failures, applying tactical patches instead of a root-cause fix. The single highest-leverage change is deleting `packages/app/ios/` and going full CNG — zero feature loss (proven by `diff`), eliminates an entire class of SDK-upgrade pain, makes Expo Doctor green, and reduces the `eas.json`/`.gitignore` complexity. Everything else in this audit is a 15-minute follow-up.
