# Skeptic's Audit: EAS / Expo / CNG Configuration

**Agent**: Skeptic — cynical systems engineer, cross-references every claim against actual code
**Overall Rating**: 2.2 / 5
**Date**: 2026-04-11

---

## TL;DR verdict

The current state is "mostly lucky, not correct". PR #2801 is a fix that works — but its *commit message* rewrites history with a theory that contradicts its own earlier commits in the same PR and is inconsistent with how EAS Build actually runs `prebuildCommand`. The removal of `prebuildCommand` happens to be safe, but two of the three reasons given in the commit message are wrong or unverified. The underlying project is in a **mixed CNG / committed-native state** with no CI verification of either native side, a duplicated `@expo/vector-icons` that ships the wrong major version, and a config field (`softwareKeyboardLayoutMode`) set to an invalid enum value that only works because Expo's mapping function silently passes unknown values through.

---

## Section ratings

### 1. `eas.json` build profiles — **2 / 5**

The file is essentially empty now (`packages/app/eas.json:1-21`). That's fine as a tactical revert, but it papers over a confused history:

- `58b8a67f5` (2026-03-21) added `prebuildCommand` as a multi-command shell chain — `cd ../protocol && npx tsc && cd ../store-core && npm run build:crypto`. The commit message said this was to "compile @chroxy/protocol and @chroxy/store-core before JS bundling", showing the author believed `prebuildCommand` accepts arbitrary shell.
- PR #2801's **final commit** (`1cc686698`, 2026-04-10) removed `prebuildCommand` entirely with a new theory: *"EAS's prebuildCommand... EAS literally prepends 'npx expo' to its value."* That theory is **wrong** (see finding #1 below). EAS actually runs `prebuildCommand` through `sh -c` with `--no-install --platform <p>` appended as positional args — which is exactly what the **earlier commit in the same PR** (`bash -c` wrapper) correctly identified. The author flipped theories mid-PR and left the more recent (incorrect) one in the permanent history.
- `eas.json:7-16` now has **no** `runtimeVersion` policy, no `node` version pin, no `env`, no cache config. Every invocation relies on whatever EAS defaults are live that day. Given this project has already been bitten twice in a month by invisible EAS-CLI behavior changes, the absence of a pinned `cli.version` (only `>= 18.0.1` — wildly permissive) is a latent hazard.
- `production` uses `"autoIncrement": true` but `preview` does not, and `development` has `"developmentClient": true` without `"distribution": "internal"` — fine but undocumented as to why the profiles diverge.

Why not 1: it's minimal enough to mostly work, and there's no active landmine in what's left.

### 2. `app.json` Expo config — **2 / 5**

- **Line 33 bug:** `"softwareKeyboardLayoutMode": "adjustResize"` is an **invalid value**. The Expo config type (`node_modules/@expo/config-types/build/ExpoConfig.d.ts:808`) declares `'resize' | 'pan'`. The plugin at `node_modules/@expo/config-plugins/build/android/WindowSoftInputMode.js:41-48` reads this value, maps `resize → adjustResize` / `pan → adjustPan`, and falls back to the raw input when no mapping matches (`MAPPING[value] ?? value`). So "adjustResize" happens to produce the intended final `android:windowSoftInputMode="adjustResize"` — but only because the config plugin silently accepts garbage. Any future validation in config-plugins will fail the build. Correct value is `"resize"`.
- **Mixed CNG / non-CNG state is a real project invariant, not a warning to be dismissed.** `packages/app/ios/` has 37 tracked files including LiveActivity code, `Chroxy.xcodeproj/project.pbxproj`, and a tracked `Podfile.lock` (2490 lines). Android has zero tracked files. That means `app.json` drives iOS via CNG semantics (plugins array, infoPlist object) *but Expo will not regenerate ios/* because committed native folders suppress prebuild. If a contributor edits `app.json:20-25` (e.g. adds a new `NSXxxUsageDescription`), the change lands in Android's generated `AndroidManifest.xml` on the next EAS build but **never reaches `ios/Chroxy/Info.plist`**. No CI check catches this drift.
- Plugins array (line 43-60) uses `expo-live-activity` which isn't in the Expo SDK expected-version set — it's a community plugin pinned at `~0.4.2` in `package.json:62`. That's fine, but the committed LiveActivity Swift code in `ios/LiveActivity/` is tightly coupled to that version and there's no runtime test validating the binding.

### 3. Dependency management — **1 / 5**

- **`@expo/vector-icons` is the headline bug, and it's real.** `packages/app/package.json:45` pins `"@expo/vector-icons": "~14.0.4"`. Expo SDK 54 expects `^15.0.3`. Running `Icon.tsx:2` (`import { Ionicons } from '@expo/vector-icons'`) resolves via Metro's nearest-`node_modules` walk to `packages/app/node_modules/@expo/vector-icons` (version 14.0.4), **not** the hoisted root `node_modules/@expo/vector-icons@15.1.1`. So the shipping app is one major behind the SDK spec. The hoisted 15.1.1 is dead weight consumed only by peerDep resolution for other tools. Any API difference between 14→15 ships to users as a real bug; Doctor's warning is a **load-bearing signal**, not cosmetic.
- **`@types/jest: ^30.0.0`** (line 82) vs Expo's expected `29.5.14`. Dev-only; low impact but still drift.
- Root `package.json:28-30` has `"dependencies": { "expo-secure-store": "~15.0.8" }` at the **workspace root** — not in a package, not in `devDependencies`, just dangling. There's no reason the monorepo root needs `expo-secure-store` as a runtime dep. Either it's vestigial and should be removed, or it's a misplaced workaround. Nothing in `package.json:9-17` scripts uses it.
- `packages/app/package.json:43-44` declares `"@chroxy/protocol": "*"` and `"@chroxy/store-core": "*"` — the `*` version range (rather than `workspace:*` or a real semver) technically works with npm workspaces but is not the recommended form and would break with pnpm or yarn classic. Minor hygiene issue.
- `packages/app/package.json:14` `postinstall: node scripts/bundle-xterm.js` runs on every install, including in EAS cloud builds. That script reads from `node_modules/@xterm/...` and writes a generated TS file. If EAS's install step hoists differently than local, this could silently produce a different bundle. The script isn't shown to me here but the fact it runs on postinstall in CI/cloud is a fragility vector.

### 4. Native project strategy (mixed CNG + committed ios/) — **1 / 5**

This is the worst section.

- **No iOS CI.** `.github/workflows/ci.yml` has `app-tests` (lines 190–226) and `app-typecheck` (lines 228–253). Neither builds iOS, runs `pod install`, runs `xcodebuild`, validates `Podfile.lock`, or lints `project.pbxproj`. The only workflow that references iOS/xcode at all is zero: `grep -in "ios|xcode|pod|xcodebuild"` in `.github/workflows/` returns nothing. The committed LiveActivity Swift from #2278 has **no automated verification whatsoever**. It either builds on EAS or it doesn't — there's no signal until someone manually runs a preview build.
- **`packages/app/ios/Podfile.lock` is tracked (2490 lines)** but never verified. If a new expo module is added to `package.json`, nothing runs `pod install`, nothing detects the lockfile is stale. Contributors have to remember.
- **Android is true CNG** (zero files tracked under `packages/app/android/`), iOS is traditional committed. The `/android/` .gitignore entry (`.gitignore:26`) is correctly anchored and safe. Nothing in the repo currently has a path like `packages/app/android/...` tracked, so the ignore rule hides nothing. However, the `.gitignore:19-25` comment explicitly documents the mixed state but doesn't warn future contributors that editing `app.json` `ios.infoPlist` **will not reach `ios/Chroxy/Info.plist`** on an EAS build. That's the actual trap and it's undocumented.
- The `Pods/` directory is un-gitignored by the app-level `.gitignore` but tracked status shows `git ls-files packages/app/ios/Pods` returns empty — so Pods/ is not tracked, which is standard. There should be an explicit `ios/Pods/` entry in `packages/app/.gitignore` for safety; relying on a parent `.gitignore` or convention is fragile.

### 5. Cross-workspace build (protocol + store-core) — **3 / 5**

This actually works, but not for the reasons PR #2801 claims.

- `packages/protocol/package.json:7` sets `"main": "./dist/index.js"`. So any Metro/Node importer resolves the **compiled dist**. The `"prepare": "tsc"` script on line 21 runs on `npm ci` (verified locally — created a clean copy in `/tmp/protocol-test` and ran `npm install`, `dist/index.js` + `dist/schemas/` were generated). **This is the only load-bearing `prepare` for the app bundle.**
- `packages/store-core/package.json:7` sets `"main": "src/index.ts"` — pointing to **source**, not dist. Metro (via Expo's metro-config, `node_modules/expo/node_modules/@expo/metro-config/build/ExpoMetroConfig.js:144-156`) includes `.ts` in `sourceExts`, so Metro compiles `src/index.ts` directly via Babel. **The `prepare` script on `packages/store-core/package.json:19` is effectively irrelevant for the app bundle.** I verified this by clean-installing store-core in `/tmp/store-core-test`: `npm install` produces only `dist/crypto.js` + `dist/crypto.d.ts` (because `build:crypto` only compiles that one file), yet the app bundle works because Metro reads source. The server and desktop packages import `@chroxy/store-core/crypto` directly (confirmed in `packages/server/src/ws-auth.js:7`, `packages/server/src/ws-server.js:8`, etc.) which **does** need `dist/crypto.js` — but that's a Node-side requirement, not an EAS/app requirement.
- **PR #2801's claim:** *"@chroxy/protocol and @chroxy/store-core both declare 'prepare' scripts... EAS runs during INSTALL_DEPENDENCIES well before any prebuild/bundling would reference them. The prebuildCommand's stated intent is already covered."* This is **half-true**. It's covered for `@chroxy/protocol` (which actually needs its dist for Metro to find the main entry). It's **also** covered for `@chroxy/store-core` but not for the stated reason — Metro never needed dist for store-core at all.
- **Bigger concern:** `.github/workflows/ci.yml:210-212` in `app-tests` and `ci.yml:248-250` in `app-typecheck` **manually run `npm run build` for protocol** after `npm ci`. If `prepare` ran automatically during `npm ci` in CI, these explicit steps would be redundant. Either they're defensive insurance (fine) or `prepare` doesn't actually run for workspace packages in CI's `npm ci` invocation (alarming — means PR #2801's claim that `prepare` handles it during EAS install is unverified). Without an EAS build log showing `prepare` firing, I don't trust this is stable.
- `store-core/package.json:18` `build:crypto` script is a 10-line bash one-liner that runs `tsc` + a post-process `node -e "..."` to rewrite a tweetnacl-util default-import. Fragile. If the `prepare` script fails (because tsc errors, or the regex-replace misses), `dist/crypto.js` won't exist and the server breaks. No visibility.

### 6. Resilience (SDK upgrade, new contributor onboarding) — **2 / 5**

- New contributor clones the repo, runs `npm install`, runs `npx expo run:ios` — what happens? The committed `ios/` folder exists, so Expo skips prebuild. Then `pod install` runs (from Podfile autolinking, `packages/app/ios/Podfile:1`). If their local `@expo/*` versions differ from the tracked `Podfile.lock`, they'll either get a `pod install` warning or a build error. No `postinstall` or setup script tells them to run `cd ios && pod install`.
- New contributor runs `npx expo run:android`. This triggers prebuild → generates `android/`. Because of the `.gitignore:26` rule, the generated folder is not tracked — good. But the first run is slow and unreliable because Gradle/SDK setup on a fresh Mac is never automated.
- **SDK upgrade path:** the next time someone runs `npx expo install --fix` to bump to Expo SDK 55 or 56, they'll need to: (a) fix `@expo/vector-icons` major bump, (b) regenerate `ios/` or manually reconcile every native module pin in `Podfile.lock` and `project.pbxproj`, (c) fix `softwareKeyboardLayoutMode` if config-plugins validation tightens, (d) fix `@types/jest`. None of this is documented. `docs/` has no upgrade guide.
- **EAS CLI upgrade drift:** there's no `cli.version` pin beyond `>= 18.0.1`. The PR #2801 incident is literally an example of silent EAS behavior drift. Until a precise lower-and-upper bound is set, this will happen again.

---

## Top 5 skeptical findings

### Finding 1: PR #2801's final commit message theory is wrong, contradicting its own earlier commits

**File:** commit message of `1cc686698` (PR #2801 merge)
**Claim:** *"EAS literally prepends 'npx expo' to its value... which EAS actually runs as: `npx expo cd ../protocol && npx tsc && ...`"*
**Reality:** EAS Build runs `prebuildCommand` through a shell (`sh -c`) with `--no-install --platform <p>` appended as trailing args. The earlier commit in the same PR (the `bash -c` wrapper attempt, quoted in the squash message) correctly identified this as arg propagation: *"Wrapping the chain in 'bash -c \"...\"' causes the appended args to become positional params to bash ($0, $1, ...)."* That commit's theory is right; the final commit's theory is wrong. If EAS prepended `npx expo`, wrapping in `bash -c` would have been nonsensical — yet the author tried `bash -c` first, which implies they knew it was shell-executed.

**Why the shell chain "worked" in March and broke in April:** the terminal command in the chain is `npm run build:crypto`, which receives `--no-install --platform android` as appended args. Older npm versions silently dropped unknown trailing args to `npm run`; newer npm either errors or forwards them to the script, triggering `tsc: unknown or unexpected option: --platform`. That's the real regression — an npm/npx behavior change, not expo CLI.

**Impact:** the fix (removing `prebuildCommand`) is coincidentally safe for unrelated reasons (see Finding 2), but the commit history now contains a false explanation that will mislead the next person who hits a similar issue.

### Finding 2: Only `@chroxy/protocol`'s `prepare` script is load-bearing for the app bundle; `@chroxy/store-core`'s is dead code for EAS

**Files:**
- `packages/protocol/package.json:7` (`"main": "./dist/index.js"`) + `:21` (`"prepare": "tsc"`)
- `packages/store-core/package.json:7` (`"main": "src/index.ts"`) + `:19` (`"prepare": "npm run build:crypto"`)
- `packages/app/src/store/connection.ts:117`, `packages/app/src/store/message-handler.ts:42` (app imports `@chroxy/protocol`)
- `packages/app/src/store/types.ts:39`, `packages/app/src/utils/crypto.ts:13` (app imports `@chroxy/store-core` main entry only — never `@chroxy/store-core/crypto`)
- `/tmp/store-core-test` clean-install reproduction: `prepare` produces **only** `dist/crypto.js` + `dist/crypto.d.ts` (not `dist/index.js`, not `dist/types.js`, not the handlers/ subtree)

**Claim:** PR #2801 asserts *"@chroxy/protocol and @chroxy/store-core both declare 'prepare' scripts... that build their dist/ outputs automatically on 'npm ci'"*, implying both are needed.

**Reality:** the app's Metro bundle consumes `@chroxy/store-core`'s `src/index.ts` directly because `main` points at source and Metro handles `.ts` in `sourceExts` (`node_modules/expo/node_modules/@expo/metro-config/build/ExpoMetroConfig.js:144-146`). The store-core `prepare` script is consumed by the Node-side server (`packages/server/src/ws-server.js:8`, `ws-auth.js:7`, `ws-client-sender.js:1`, `test-client.js:9`) which imports the subpath `@chroxy/store-core/crypto` — resolved via `exports["./crypto"]: "./dist/crypto.js"` in `packages/store-core/package.json:11-15`. That's a server concern, not an EAS/app concern.

**Impact:** if `store-core`'s `prepare` script ever fails (it does fragile regex-based post-processing on line 18), the error will only manifest server-side — the EAS app build will succeed regardless. The PR's "two independent reasons this is safe" framing is overstated; there's really one reason.

### Finding 3: `softwareKeyboardLayoutMode: "adjustResize"` is an invalid config value that passes silently

**File:** `packages/app/app.json:33`
**Evidence:** `node_modules/@expo/config-types/build/ExpoConfig.d.ts:808` declares `softwareKeyboardLayoutMode?: 'resize' | 'pan'`. `node_modules/@expo/config-plugins/build/android/WindowSoftInputMode.js:41-48` reads the value, has `const MAPPING = { pan: 'adjustPan', resize: 'adjustResize' }`, and falls back to `MAPPING[value] ?? value` if the key isn't in the map.

**Reality:** the current `"adjustResize"` value bypasses the mapping (because it's not a map key) and is written straight into `AndroidManifest.xml` as `android:windowSoftInputMode="adjustResize"`. That happens to be the correct final Android string, so it *works*, but it's only working because the plugin silently accepts invalid enum values. The Expo Doctor warning is correct that this is invalid. When Expo tightens validation (which it will — this is a standard pre-1.0 API hardening pattern), the build will fail. The "correct" fix is to change it to `"resize"`.

**Impact:** latent timebomb on SDK upgrades. Trivial fix, one-line change, zero runtime difference.

### Finding 4: `@expo/vector-icons` ships 14.0.4 to users while root `node_modules` has 15.1.1 hoisted

**Files:**
- `packages/app/package.json:45` (`"@expo/vector-icons": "~14.0.4"`)
- `packages/app/node_modules/@expo/vector-icons/package.json` (reports `"version": "14.0.4"`)
- `node_modules/@expo/vector-icons/package.json` (reports `"version": "15.1.1"`)
- `packages/app/src/components/Icon.tsx:2` (`import { Ionicons } from '@expo/vector-icons'`)

**Reality:** Metro's module resolver walks up from `packages/app/src/components/` and stops at the first `node_modules` with a match — that's `packages/app/node_modules/@expo/vector-icons@14.0.4`. The hoisted 15.1.1 at the root is **never bundled into the app**. Expo SDK 54 expects `^15.0.3`. The shipping app is one major version behind the SDK's expected version, and the Doctor warning is correct that this is a real mismatch.

**Impact:** unknown until an API difference bites. Icon rendering bugs, TypeScript type mismatches, and any new glyphs added in v15 are missing. The "fix" is a single dependency bump, but nobody has done it because Doctor warnings are being treated as cosmetic.

### Finding 5: iOS is never built in CI, Podfile.lock drift is undetectable, and `app.json` iOS config changes never reach `ios/Chroxy/Info.plist`

**Files:**
- `.github/workflows/ci.yml:190-226` (`app-tests` job — Jest only)
- `.github/workflows/ci.yml:228-253` (`app-typecheck` job — `tsc --noEmit` only)
- `.github/workflows/*.yml` (no `xcodebuild`, `pod install`, `ios`, or `expo run:ios` references anywhere)
- `packages/app/ios/Podfile.lock` (2490 lines, tracked)
- `packages/app/app.json:20-25` (infoPlist with `NSLocalNetworkUsageDescription`, etc.)
- `packages/app/ios/Chroxy/Info.plist` (physical file, committed, will not be regenerated by prebuild because the folder already exists)

**Reality:** CI exercises zero percent of the iOS build surface. The LiveActivity Swift sources from #2278, the pbxproj file (737 lines), the Podfile.lock (2490 lines) — all unverified on every PR. The mixed CNG state means any edit to `app.json`'s `ios` section will **never** propagate to the committed `ios/Chroxy/Info.plist` unless someone manually runs `expo prebuild --platform ios --clean`, which would simultaneously wipe the uncommitted LiveActivity customizations.

**Impact:** this is the biggest structural bug in the whole setup. If someone edits `app.json` line 22 to add a new iOS permission, CI passes, the PR merges, and the next EAS iOS build uses a stale `Info.plist` that doesn't have the new permission. The app ships broken on iOS with no warning. The `.gitignore:19-25` comment correctly documents the mixed state but doesn't surface the contributor-facing trap.

---

## What the recent commits get wrong or leave unsupported

1. **`1cc686698` (PR #2801) final commit message — "EAS literally prepends 'npx expo'"**: wrong. EAS runs `prebuildCommand` through `sh -c` with trailing platform args. The author's own earlier commit in the same PR (`bash -c` wrapper) correctly identified this. The explanation got rewritten during the squash.

2. **`1cc686698` — "The prebuildCommand's stated intent is already covered [by prepare scripts]"**: half-true. Covered for `@chroxy/protocol` (which Metro actually needs dist for). For `@chroxy/store-core` it's covered for a different reason (Metro reads `src/index.ts` directly) — the `prepare` script is irrelevant for the app bundle and only matters for the server/desktop packages that import `@chroxy/store-core/crypto`.

3. **`1cc686698` — "when committed native folders are present EAS will not run 'expo prebuild' at all"**: plausible and probably true, but I cannot verify it from the local `node_modules` (no `eas-cli` installed locally). The claim is stated authoritatively; it should have been cited with an EAS docs link or an EAS build log excerpt.

4. **`58b8a67f5` (the 2026-03-21 "fix EAS build" commit)**: its commit message claims it adds `prebuildCommand` "to compile @chroxy/protocol and @chroxy/store-core before JS bundling". That framing presumed `prebuildCommand` was arbitrary shell, which happened to work but wasn't the design intent. The commit is technically responsible for the six-week window in which the build succeeded by accident. No one realized until PR #2801 that it was a landmine.

5. **`c2036cc95` (the "add prepare scripts" commit)**: its message says *"npm runs prepare after install for workspace packages, ensuring dist/ outputs exist before Metro bundling in EAS cloud builds."* This is asserted without verification. `.github/workflows/ci.yml:210-212` and `:248-250` both **manually** run `npm run build` for `@chroxy/protocol` after `npm ci`, which strongly implies `prepare` is NOT reliably firing in CI's install step. If it were, the manual step would be dead code. EAS's behavior here is likely the same as CI's — neither has been empirically verified.

---

## Overall verdict

**2.2 / 5.** The EAS / CNG setup is a house of cards held up by coincidence. Today's fix (PR #2801) works but rewrites history with an incorrect theory that will mislead future debugging. The project is in a mixed CNG / committed-native state with no iOS CI, a real dependency-version bug (`@expo/vector-icons` 14.0.4 actually shipping while SDK expects 15), an invalid config field that only works because Expo's plugin validator silently accepts garbage, and a rootless `expo-secure-store` dep at the monorepo root. Four of the Expo Doctor warnings being treated as cosmetic are actually load-bearing signals. The `prepare`-script theory for cross-workspace builds is half-right but the load-bearing path is `@chroxy/protocol`, not store-core. Until someone either (a) goes all-in on CNG (delete `ios/`, rebuild LiveActivity as a config plugin) or (b) goes all-in on tracked native (delete the `ios.infoPlist` entries from `app.json`, add iOS CI), this config will keep surprising people. Every one of the last three EAS fixes has been reactive and partially wrong.
