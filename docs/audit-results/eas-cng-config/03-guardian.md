# Guardian's Audit: EAS / Expo / CNG Configuration

**Agent**: Guardian — paranoid SRE who designs for 3am pages
**Overall Rating**: 1.8 / 5
**Date**: 2026-04-11

---

## TL;DR

This config is a landmine field. The project is in a **hybrid CNG / committed-native** state where neither side of the fence is load-bearing: `packages/app/ios/` is tracked (37 files, PR #2278), `packages/app/android/` is gitignored as of today, and `eas.json` has **no `prebuildCommand` at all** — meaning EAS runs the default `expo prebuild` every build, regenerating *both* native projects from `app.json`. There is zero iOS/EAS CI coverage, so the only thing catching drift is a real build that ships to real users. A `@expo/vector-icons` version split is live in the lockfile right now (14.0.4 in the app, 15.1.1 hoisted). The lockfile reports `packages/app` as `0.6.7` while every package.json says `0.6.9` — **the lockfile is not actually a lockfile at the moment**.

I would not trust this to ship a production release without at least fixing the top 5 findings.

---

## Section ratings (1–5)

### 1. `eas.json` build profiles — failure modes & recovery — **2 / 5**

File: `packages/app/eas.json:1-21`

- **Minimal to the point of hostile.** No `prebuildCommand`, no `env`, no `node`/`cli` pinned version (only `">= 18.0.1"`), no `image` pinned, no `resourceClass`, no `cache.key`. Every build runs on whatever Ubuntu image + Node Expo happens to ship *today*.
- **Zero production safety net.** `build.production` is literally `{"autoIncrement": true}` (`eas.json:14`). No `distribution`, no channel, no `env`, no `credentialsSource`. A `--profile production` submit today would pick whatever global credentials and Node version EAS defaults to. On a release day, that is how you ship an unsigned or misgigned APK.
- **`preview` and `development` are identical except for `developmentClient`** (`eas.json:7-13`). If preview breaks there is no baseline to compare against. Both are `distribution: "internal"` so the "preview" APK is not meaningfully different from "development".
- **No `node` version pinned.** Server requires Node 22 (`CLAUDE.md`). EAS does not. A future EAS image rolling to Node 24 could trip the postinstall `scripts/bundle-xterm.js` or tsc in `@chroxy/protocol`'s `prepare`.
- **Prior corpse in the git log**: commits `58b8a67f5` → `67b5bab6d` → `28f7c372d` document that a previous `prebuildCommand` silently injected `--platform android` into `tsc` inside the store-core build script for weeks because EAS literally prepends `npx expo` to the value. Nobody noticed until today because there is no canary build, no smoke test, and no CI coverage. That is the current failure mode even with the command removed: **any command placed in `prebuildCommand` will have EAS's flags appended with no warning.**

Recovery story: nonexistent. If `eas build --profile production` explodes at 2am, there is no rollback — no prior-version pinning, no "known good" Node/Expo/EAS image identifier in the repo. The only recovery is `git log eas.json` + guessing.

### 2. `app.json` Expo config — silent-corruption risks — **2 / 5**

File: `packages/app/app.json`

- **`softwareKeyboardLayoutMode: "adjustResize"`** (`app.json:33`) — **this is not a valid value for that field.** The Expo config plugin `node_modules/@expo/config-plugins/build/android/WindowSoftInputMode.js:41` maps `{pan: "adjustPan", resize: "adjustResize"}`. Valid values are `"pan"` or `"resize"`. The current value falls through the `?? value` fallback (line 41: `return MAPPING[value] ?? value`) and lands in the manifest *by accident*. When Expo adds schema validation (trivial PR upstream) this silently becomes a build failure — or worse, the value is stripped and the Android keyboard behavior changes without any log line.
- **No `runtimeVersion` / `updates.fallbackToCacheTimeout`.** Combined with `appVersionSource: "remote"` (`eas.json:4`), the app has no identity invariant between OTA-able JS and the native binary. An OTA push could land incompatible JS on a stale native binary.
- **No `jsEngine` set.** Depends on Expo default. A default flip (Hermes → JSC or vice versa) would ship silently with different regex/Intl/crypto behavior.
- **`ios.infoPlist.ITSAppUsesNonExemptEncryption: false`** (`app.json:24`) — the project ships end-to-end encryption (`@chroxy/store-core/crypto`, tweetnacl). **This is technically a false ITAR/BIS declaration.** Apple explicitly allows this for E2E messaging *if* the encryption is exempt per §740.17(b)(2), but the declaration should be accompanied by the exemption self-classification. Nuke risk: Apple compliance review rejection on production submit.
- **`extra.eas.projectId`** (`app.json:63`) is checked in. No env-override path. If the EAS project gets rotated or recreated, every dev must edit `app.json` to fix it.
- **Plugin array entries have no version pin.** `"expo-live-activity"` (`app.json:59`) uses whatever `expo-live-activity@^0.4.2` resolves to at the time of `npm ci` inside EAS. An auto-update to 0.5.x that bumps the pod name could silently delete the LiveActivity extension from the generated Xcode project.

### 3. Dependency management — supply-chain + hoisting hazards — **1 / 5**

**This section is the most dangerous.**

- **Split-brain `@expo/vector-icons`.** `package-lock.json:2962` records `node_modules/@expo/vector-icons@15.1.1` at the root (pulled in transitively via `expo@54` which declares it as a direct dep at `package-lock.json:7839`). `package-lock.json:15945` records `packages/app/@expo/vector-icons@~14.0.4`. I verified both are physically present on disk right now:
  - `node_modules/@expo/vector-icons/package.json` → `15.1.1`
  - `packages/app/node_modules/@expo/vector-icons/package.json` → `14.0.4`

  Metro's resolver prefers the closer copy (`packages/app/node_modules`) so the app imports 14.0.4 via `src/components/Icon.tsx:2`. But **expo's own internal code imports the hoisted 15.1.1**. A shipping APK has both versions bundled. **Font files / icon ID tables differ between v14 and v15** — any icon expo internals render (splash, dev menu, error screens) uses 15.1.1 glyphs, and anything the app renders uses 14.0.4 glyphs. A v15-only icon name in app code would render as tofu with no warning. A v14-only icon name in expo internals would do the same in reverse. Likelihood this has already shipped: high.

- **`package-lock.json` is stale.** Line 15939 shows `"packages/app": {"version": "0.6.7"}` while `packages/app/package.json:5` says `"0.6.9"`. The lockfile has drifted through at least two version bumps (v0.6.8 #2680 and v0.6.9 #2800) without being regenerated. **This means `npm ci` on EAS is resolving against an inconsistent snapshot** — the integrity hashes still lock transitive deps, but workspace metadata is wrong. When/if a workspace peerDep gets introduced in 0.6.8 or 0.6.9 that references a bumped shared dep, npm ci will quietly resolve wrong.

- **Phantom dep in root `package.json`.** Root `package.json:29` declares `expo-secure-store: ~15.0.8` as a **direct dependency of the monorepo root**. The root package has no code. This is a ghost — probably added when someone ran `npm install expo-secure-store` from the wrong cwd. It hoists to root `node_modules` and shadows whatever version app declares. Today both are `~15.0.8` so it is a no-op. **Tomorrow when the app bumps to `~16.0.0` and nobody edits the root, the hoisted 15.0.8 wins** and the app is shipping against an older SecureStore native API. SecureStore deals with the encryption key for the chat store — a version mismatch here is a data-corruption / key-loss hazard, not just a display bug.

- **`postinstall` and `prepare` scripts are unguarded.**
  - `packages/app/package.json:14` runs `node scripts/bundle-xterm.js` on every `npm install` / `npm ci`.
  - `packages/store-core/package.json:20` runs `build:crypto` (an inline `tsc + node -e string-replace` pipeline) on `prepare`.
  - `packages/protocol/package.json:22` runs `tsc` on `prepare`.

  There is **no `.npmrc` with `ignore-scripts=true`**, no sandboxing. An attacker who compromises any transitive dev dep (`tsx`, `vitest`, `@babel/core`, `jest-expo`, `cocoapods-*`) gets arbitrary code execution during EAS's `npm ci` phase — **and that runs with the production signing credentials pulled from EAS servers already in the environment**. Supply-chain blast radius is "steal iOS signing certificate + Android keystore + publish APK to store as you."

- **`prepare` silent-failure story is horrific.** If `tsc` in `@chroxy/store-core` fails (e.g. Node 24 drops a flag, or `tweetnacl-util`'s types change), `npm ci` prints a red error line and **keeps going** because npm treats failed `prepare` as non-fatal in some configurations. The result: `packages/store-core/dist/crypto.js` is **stale from the last successful install** on the EAS cache. The server boots with old crypto (it imports `@chroxy/store-core/crypto` which is dist-only). The app uses `src/index.ts` so it loads fresh TypeScript via Metro and gets *new* crypto. **Server and app disagree on the encryption format mid-wire.** Users see "decryption failed" on the dashboard while mobile works fine, or vice versa. Recovery: nuke `node_modules`, `npm install` locally, hope the EAS cache key changes.

### 4. Native project strategy — irreversibility + CI coverage — **1 / 5**

- **Hybrid CNG / committed-native.** `packages/app/ios/` has 37 tracked files (`git ls-files packages/app/ios/ | wc -l` = 37), including the full Xcode project (`project.pbxproj`), a `LiveActivity` target with 15 Swift files (`packages/app/ios/LiveActivity/LiveActivityWidget.swift` etc.), custom `AppDelegate.swift`, `Chroxy-Bridging-Header.h`, entitlements, and two `Podfile.lock`s. Meanwhile `packages/app/android/` was **just gitignored today** (`packages/app/.gitignore:26`).
- **`eas.json` has no `prebuildCommand`.** That means EAS runs the default, which is `expo prebuild --no-install --platform <platform>`. For iOS this **regenerates the native project from `app.json`** on every build. `expo prebuild` is idempotent *only* if the existing native project matches what the config plugins would generate. The committed LiveActivity target is not generated by any config plugin — the `expo-live-activity` library ships its own Swift sources at `node_modules/expo-live-activity/ios/`, but the target wiring (extension embedding, provisioning, `ExpoModulesCore` plumbing, build phase scripts) was **done manually in PR #2278 and committed**. When `expo prebuild` runs on iOS in EAS, one of two things happens:
  1. Expo sees the existing `ios/` folder and leaves it alone (current behavior in Expo 54, because the folder is tracked → EAS preserves it).
  2. Expo decides to regenerate (schema bump, plugin re-generation, `--clean` passed) → **the LiveActivity target is destroyed**. No warning. The APK ships without the widget extension, and the bundle identifier of the extension silently vanishes from the provisioning profile.

  Case 1 is the current lucky state. Case 2 is one Expo SDK upgrade away. There is no canary detecting it.

- **`expo prebuild --clean` is a guillotine.** If anyone panics and runs `expo prebuild --clean` in `packages/app/` to "fix a build," it **will destroy**:
  - `ios/Chroxy.xcodeproj/project.pbxproj` (39 LiveActivity references — `grep -c 'LiveActivityWidget\|LiveActivity' packages/app/ios/Chroxy.xcodeproj/project.pbxproj` = 39)
  - `ios/LiveActivity/` (15 Swift files, custom entitlements, widget bundle)
  - `ios/Chroxy/Chroxy.entitlements`, `Chroxy-Bridging-Header.h` (both tracked)
  - `ios/Podfile.lock` pins (currently pins `ExpoLiveActivity (0.4.2)` → `d0dd0e8e1460b6b26555b611c4826cdb1036eea2`)
  - `ios/Podfile.properties.json`

  Recovery: `git checkout packages/app/ios/` — but only if the dev remembers to stop mid-panic.

- **Zero CI coverage.** `.github/workflows/ci.yml` does not run `expo prebuild`, does not run `pod install`, does not build an iOS archive, does not run `expo-doctor`, does not even lint `app.json` against the config-plugin schema. `grep -i 'ios\|xcode\|prebuild\|eas' .github/workflows/ci.yml` → **zero matches**. The first time anyone knows a change broke the iOS build is when a human clicks `eas build --platform ios` from their machine. Given today's context — five failed EAS builds in a row — **this is the main reason bugs compound**: there is no automated check between "commit to main" and "EAS build phase failure."

- **LiveActivity drift detector = nothing.** If `app.json:59` drops `"expo-live-activity"` from plugins (e.g. accidental edit), the committed Swift target still compiles, the pod is still in the lockfile, and the widget will appear in the binary but the JS bridge will not work. The app would "ship" with a dead widget that users can see on the lock screen but that doesn't update. No test catches this.

### 5. Cross-workspace build — prepare-script silent-failure risk — **2 / 5**

- **`prepare` is not explicit enough.** `packages/protocol/package.json:22` `"prepare": "tsc"` — no output check, no "did dist actually get written" assertion. A `tsc` no-op (wrong `tsconfig.json` include path, empty source tree) still exits 0 and prints nothing. `dist/` stays stale.
- **`packages/store-core/package.json:18`** build:crypto is a one-liner shell pipeline inside JSON. Unquoted backslashes, escaped quotes, inline `node -e` that does a `replace()` call on import syntax. **If `fs.readFileSync('dist/crypto.js')` finds a file but `tsc` silently failed to write it, the replace runs on the OLD dist and overwrites with OLD content.** The `prepare` phase exits 0. This is the scenario I most fear in a future EAS build: the server ships with crypto that can decrypt old envelopes but not new ones, or vice versa, and the mobile app keeps working.
- **Metro bypasses `prepare` for app → store-core path.** `packages/store-core/package.json:7` sets `main: src/index.ts`. Metro compiles the TypeScript source directly. So the app is immune to `prepare` failures — only the **server** (which uses the `./crypto` subpath export → `dist/crypto.js`) is at risk. This is a split-stack hazard: one side of the wire uses compiled output, the other uses source, and the build step that keeps them synchronized is silent.
- **Babel/Metro config missing.** `packages/app/` has **no `metro.config.js` and no `babel.config.js`** (verified — neither file exists). The app relies entirely on Expo's SDK-54 defaults for monorepo resolution. Any Expo default change (e.g. stricter `unstable_enablePackageExports`, which is in active development) could flip `@chroxy/store-core`'s `exports` field resolution from the app's bare import `'@chroxy/store-core'` to a `types`-only resolution and silently return `undefined` at runtime.
- **Jest moduleNameMapper at `packages/app/package.json:29`** maps `@chroxy/protocol` to `dist/index.js` — so test runs *require* `prepare` to have succeeded. If `tsc` in `@chroxy/protocol` failed during the last `npm install`, `jest` fails loudly. That's fine — but the app runtime uses Metro which follows `main: ./dist/index.js` (`packages/protocol/package.json:7`), so the **app runtime also requires `dist/` to exist and be fresh**. No guard. No check. No error if it's stale.

### 6. Resilience — recovery playbook completeness — **1 / 5**

There is no documented playbook anywhere for:
- Rolling back a bad EAS build
- Regenerating native projects without destroying the LiveActivity target
- Triaging a `prepare`-script silent failure
- Pinning a known-good Expo SDK / Node / EAS CLI combo
- Verifying the shipped APK actually contains v14 vs v15 vector-icons

`CLAUDE.md` documents "rebuild with `eas build --profile development`" but not "what do I do when the production build signs against the wrong key." The git log (`58b8a67f5`, `67b5bab6d`, `28f7c372d`, `1cc686698`) **is** the playbook — which is to say, there is no playbook, there is only a trail of scar tissue.

---

## Top 5 most dangerous findings (likelihood × impact)

| # | Finding | Likelihood | Impact | Score |
|---|---------|:----------:|:------:|:-----:|
| 1 | **Split-brain `@expo/vector-icons@14` vs `@15` shipping in same binary** (`package-lock.json:2962` + `:15945`, verified on disk in `node_modules/@expo/vector-icons/` = 15.1.1 and `packages/app/node_modules/@expo/vector-icons/` = 14.0.4). App imports v14, Expo internals import v15. Icons silently render as tofu depending on who drew them. Already shipping. | **5/5** (confirmed live) | **3/5** (UX bug, not data loss) | **15** |
| 2 | **`prepare` silent failure in `@chroxy/store-core` ships stale `dist/crypto.js` to the server** while the mobile app compiles fresh source via Metro. Server and app use incompatible crypto versions. Users see "decryption failed" on one client and not the other. Irreversible for any messages encrypted under the stale version. `packages/store-core/package.json:18` build:crypto has no dist-freshness guard; `packages/app/src/utils/crypto.ts:2` imports source via Metro; `packages/server/src/ws-server.js:8` imports `./crypto` subpath which resolves to `dist/`. | **3/5** (needs a `tsc` blip or Node upgrade) | **5/5** (data-loss for encrypted messages) | **15** |
| 3 | **`package-lock.json` is stale** (`package-lock.json:15939` says `packages/app: 0.6.7`; actual is `0.6.9` per `packages/app/package.json:5`). Every `npm ci` on EAS resolves against a snapshot that does not match current source. One missed workspace peer-dep bump and the install picks wrong. Nobody knows how much drift has already accumulated. | **5/5** (confirmed live) | **4/5** (builds non-reproducible) | **20** |
| 4 | **Committed iOS LiveActivity target destroyed by `expo prebuild --clean`.** `packages/app/ios/LiveActivity/` (15 files), 39 pbxproj references, custom entitlements, and `Podfile.lock` pin — none of it is generated by any config plugin in `app.json:59` (`"expo-live-activity"` is just the library, not the target). One Expo SDK upgrade that flips prebuild behavior, or one panicked `--clean`, wipes the widget without warning. No CI catches it. | **3/5** (one upgrade away) | **5/5** (feature deletion + provisioning profile break) | **15** |
| 5 | **Supply-chain: `postinstall` + `prepare` scripts run with EAS signing creds in scope.** `packages/app/package.json:14` (`postinstall: node scripts/bundle-xterm.js`), `packages/store-core/package.json:20` (`prepare: build:crypto`), `packages/protocol/package.json:22` (`prepare: tsc`). No `.npmrc` with `ignore-scripts=true`. A compromised transitive dev dep (`tsx`, `vitest`, `@babel/core`, `jest-expo`) gets arbitrary code execution inside the EAS runner during `npm ci`, with iOS signing certs and Android keystore already decrypted in env. Blast radius: publish malicious APK as the real publisher. | **2/5** (real world attacks happen) | **5/5** (full supply-chain compromise) | **10** |

**Bonus dishonorable mention:** `softwareKeyboardLayoutMode: "adjustResize"` at `app.json:33` is not a valid schema value (valid values are `"pan"` / `"resize"` per `node_modules/@expo/config-plugins/build/android/WindowSoftInputMode.js:8-11`). Works today by fall-through. Silently breaks on any future schema tightening. Low impact (Android keyboard behavior regression) but high embarrassment.

**Bonus #2:** `app.json:24` declares `ITSAppUsesNonExemptEncryption: false` while the app ships tweetnacl + custom protocol crypto. This is technically a false export-compliance declaration unless accompanied by a §740.17(b)(2) self-classification. Production submit rejection risk.

---

## Recovery playbooks

### Scenario A — "EAS preview builds started failing after an Expo SDK auto-update"

The exact failure mode we hit today, in scripted form.

```bash
# 1. IDENTIFY: which Expo component bumped?
cd /Users/blamechris/Projects/chroxy
git log --oneline --since="2 weeks ago" -- package-lock.json packages/app/package.json
# Look for "expo" bump. Also check packages/app/package.json's `expo: ^54.0.0` range —
# caret-range means patches auto-adopted on every fresh npm ci.

# 2. PIN to known-good. Change packages/app/package.json:
#    "expo": "54.0.23"  (exact, not ^)
# And the other expo-* packages to exact versions that EAS built successfully on
# the last green build (check EAS dashboard → build logs → "Install dependencies" phase
# for the exact versions that were installed).

# 3. Regenerate lockfile INSIDE the workspace to avoid root-level pollution:
rm -rf packages/app/node_modules node_modules package-lock.json
npm install
# Verify packages/app version is current (NOT 0.6.7):
grep -A1 '"packages/app"' package-lock.json | head

# 4. Test prebuild LOCALLY before pushing — never let EAS be the first to try:
cd packages/app
# DO NOT run --clean. Just dry-run:
npx expo prebuild --platform ios --no-install --dry-run 2>&1 | tee /tmp/prebuild-dry.log
# Look for lines like "Warning: ios/Chroxy.xcodeproj would be overwritten"
# If you see ANY overwrite warning for files in ios/LiveActivity/ or
# ios/Chroxy.xcodeproj/project.pbxproj, STOP. The LiveActivity target is at risk.

# 5. If prebuild is clean, trigger preview build:
eas build --profile preview --platform ios --non-interactive

# 6. If build still fails, snapshot the EAS logs:
eas build:view <build-id> --logs > /tmp/eas-fail.log
# Grep for "prebuildCommand", "autolinking", "Podfile", "tsc --platform"
# — those are the three classes of failure we've hit.

# 7. Rollback path: revert the Expo bump, force-push the lock regen:
git revert <bump-commit>
git push origin HEAD
eas build --profile preview --platform ios
```

Gates / hard stops:
- **Never run `expo prebuild --clean`** as a recovery step on this repo until the LiveActivity target is either (a) ported to an Expo config plugin or (b) moved to a separate `ios-native/` folder that is NOT wiped by prebuild.
- **Never pin via root `package.json`** — that's the phantom-dep hazard. Pin inside `packages/app/package.json`.

### Scenario B — "The committed `packages/app/ios/` folder has gone stale and won't build locally"

Most dangerous scenario because the instinct is to run `expo prebuild --clean`. Don't.

```bash
# 1. BACK UP the LiveActivity target before touching anything:
cd /Users/blamechris/Projects/chroxy
cp -R packages/app/ios /tmp/chroxy-ios-backup-$(date +%s)

# 2. DIAGNOSE what is stale. The three usual suspects:
#    - Podfile.lock out of sync with node_modules/expo-*
#    - Chroxy-Bridging-Header.h missing an import for a new Expo module
#    - project.pbxproj references a file that doesn't exist in node_modules anymore
cd packages/app/ios
pod install 2>&1 | tee /tmp/pod-install.log
grep -i "error\|unable\|not found" /tmp/pod-install.log

# 3. If pod install succeeds but xcodebuild fails:
cd packages/app
xcodebuild -workspace ios/Chroxy.xcworkspace -scheme Chroxy -configuration Debug \
  -destination 'generic/platform=iOS' -dry-run 2>&1 | tee /tmp/xcode-dry.log
grep -i error /tmp/xcode-dry.log | head

# 4. SELECTIVE regeneration — regenerate only the files NOT part of LiveActivity:
#    Move LiveActivity out of the way first:
mv ios/LiveActivity /tmp/LiveActivity-stash
mv ios/Chroxy/Chroxy.entitlements /tmp/Chroxy.entitlements.stash
mv ios/Chroxy/Chroxy-Bridging-Header.h /tmp/bridging-header.stash
# Now you can safely prebuild:
npx expo prebuild --platform ios --no-install
# Merge LiveActivity back manually:
mv /tmp/LiveActivity-stash ios/LiveActivity
mv /tmp/Chroxy.entitlements.stash ios/Chroxy/Chroxy.entitlements
mv /tmp/bridging-header.stash ios/Chroxy/Chroxy-Bridging-Header.h
# Re-add the target to project.pbxproj — this step is MANUAL and requires
# opening Xcode and re-linking the Widget Extension target. If you don't know
# how to do this, STOP and restore from /tmp/chroxy-ios-backup-*.

# 5. Verify pbxproj still has all 39 LiveActivity references:
grep -c 'LiveActivityWidget\|LiveActivity' ios/Chroxy.xcodeproj/project.pbxproj
# Expected: 39 (or higher if new references were added). If < 39, you have lost
# target wiring — restore from backup.

# 6. If everything is hopelessly broken, full restore:
rm -rf packages/app/ios
cp -R /tmp/chroxy-ios-backup-* packages/app/ios
git status packages/app/ios  # should show clean
```

### Scenario C — "A workspace `prepare` script started failing and I need to ship now"

```bash
# 1. IDENTIFY which prepare is failing:
cd /Users/blamechris/Projects/chroxy
npm install 2>&1 | tee /tmp/install.log
grep -B2 -A10 "prepare\|build:crypto\|tsc" /tmp/install.log | grep -i error

# 2. If it's @chroxy/store-core/build:crypto failing:
cd packages/store-core
npx tsc src/crypto.ts --outDir dist --module ESNext --target ES2022 \
  --declaration --moduleResolution node --esModuleInterop --skipLibCheck
# If that succeeds, the inline `node -e` replace step is the culprit. Run it manually
# and inspect dist/crypto.js — it should NOT import { encodeBase64, decodeBase64 }
# but should use the naclUtil.encodeBase64 destructure form.

# 3. EMERGENCY BYPASS (ship-now path): commit the built dist/ directly.
#    store-core's .gitignore should NOT include dist/ for this to work — verify:
cat packages/store-core/.gitignore
# If dist/ is gitignored, force-add:
git add -f packages/store-core/dist/crypto.js packages/store-core/dist/crypto.d.ts
# Push and build. Remove the prepare script dependency temporarily:
# packages/store-core/package.json: change "prepare": "npm run build:crypto"
# to "prepare": "npm run build:crypto || true"
# WARNING: This is the "ship now, fix tomorrow" hammer. Revert within 48h.

# 4. VERIFY the shipped dist actually gets used by the server:
cd packages/server
node -e "const c = require('@chroxy/store-core/crypto'); console.log(Object.keys(c));"
# Should print: DIRECTION_SERVER, DIRECTION_CLIENT, createKeyPair, encrypt, decrypt, etc.
# If it prints undefined or errors, the prepare never wrote dist/ and you are
# shipping against a broken module. DO NOT BUILD.

# 5. VERIFY the app doesn't depend on prepare (it shouldn't, it uses Metro + source):
cd packages/app
grep -rn "store-core/crypto\|store-core/dist" src/ __tests__/ jest.setup*.js
# Should return NO matches. If it does, the app also needs dist/ and the bypass
# in step 3 propagates to the mobile binary as well.

# 6. Fix properly:
# - Move build:crypto to a proper script file (not an inline node -e).
# - Add a post-build check: `node -e "require('./dist/crypto.js')"` that exits nonzero
#   if the dist module fails to load.
# - Wire that into CI so the next drift is caught before it hits EAS.
```

---

## Overall rating: **1.8 / 5**

### Verdict

**This configuration is not safe to trust with a production release as-is.** The `@expo/vector-icons` split-brain is already live in the bundle and has almost certainly shipped to users. The lockfile is structurally stale and `npm ci` is not reproducible. The hybrid CNG/committed-native iOS state is held together by luck — there is nothing in the build pipeline that would notice if `expo prebuild` destroyed the LiveActivity target, and there is no iOS CI to catch it pre-merge. The `prepare` scripts in `@chroxy/store-core` and `@chroxy/protocol` are silent-failure shaped: a failed `tsc` leaves stale `dist/` in place with zero warnings, and the server (which consumes `dist/`) will boot with crypto code incompatible with what the app (which consumes source via Metro) is sending. Any of these is a 3am page waiting for a trigger — an Expo SDK auto-bump, a Node image flip on the EAS runner, a panicked dev running `expo prebuild --clean` on their laptop, or a compromised transitive dev dep exploiting the unguarded `postinstall` path to the EAS signing certificates.

Before the next production release: fix the lockfile drift, pin `@expo/vector-icons` to a single version, add `expo-doctor` + `expo prebuild --dry-run` + an iOS archive build to CI, move the LiveActivity target into an Expo config plugin so prebuild owns it, add a post-`prepare` assertion that `dist/crypto.js` exports what server expects, and remove the phantom `expo-secure-store` dep from the root `package.json`. None of those are large PRs. All of them are table stakes.
