# Futurist's Audit: EAS / Expo / CNG Configuration

**Agent**: Futurist — tech debt forecaster, thinks in 6/12/36-month windows
**Overall Rating**: 1.8 / 5
**Date**: 2026-04-11

---

## TL;DR forecast

This config is living on **borrowed time from three separate clocks** — the Expo SDK upgrade cycle (6 months), the hybrid-native drift rate (already visible, measurable, and accelerating), and the workspace-hoisting compound-interest curve. Today's `prebuildCommand` blow-up was not a one-off — it was the *first* payment on debt that has been accruing silently since `ios/` was committed in #2278. The next three payments are already scheduled: SDK 55's app.json validator tightening (~Q3 2026), the first force-prebuild during an SDK upgrade (probably SDK 56, ~Q1 2027), and the first npm workspace hoist collision that can't be patched with a `resolutions` field.

Doing nothing for 6 months is survivable. Doing nothing for 12 is the start of a 2-3 week native-project recovery. Doing nothing for 36 guarantees a forced rewrite of the native layer.

---

## Section ratings

### 1. `eas.json` build profiles — **2 / 5**

File: `packages/app/eas.json:1-21`.

Today's state is minimal-to-the-point-of-abdication. There is no pinned `cli.version` (only `>= 18.0.1`, line 3 — wildly permissive), no `node` version pin in any profile, no `env`, no `runtimeVersion` policy, no cache config, no `image` pin. Every EAS build inherits whatever defaults the EAS workers happen to ship that week.

**6-month forecast:** EAS ships ~4–6 CLI updates in that window. Probability of another silent behavior change burning a build ≈ 60% based on the PR #2801 precedent (one hit in ~4 months of observed history = 0.25/month baseline, compounded over 6 months). Cost per hit: 60–90 min of debugging before discovery, another 30 min to ship a fix. Expected value: **~2 lost afternoons in the next 6 months** purely from unpinned EAS CLI drift.

**12-month forecast:** EAS worker Node floor bumps to Node 22 or Node 24. Today there is no `node: "22"` override (EAS default is 20.x). The moment any transitive dep requires Node 22+, builds break with a cryptic install error. Probability: 75%. Discovery cost: 2–4 hours the first time.

**36-month forecast:** `cli.version >= 18.0.1` is effectively unbounded. A CLI v20 or v21 that introduces a config schema migration will either require a rushed emergency bump or a frozen-in-time pin to an unsupported major. Probability of forced migration: 100%.

### 2. `app.json` schema compliance — **2 / 5**

File: `packages/app/app.json`.

Known latent bugs:
- **Line 33** `"softwareKeyboardLayoutMode": "adjustResize"` — not a valid enum value per `@expo/config-types`. Currently passed through by `@expo/config-plugins/.../WindowSoftInputMode.js` because the mapping function falls back to raw input on unknown keys. This is a ticking time bomb: the day Expo adds validation (already flagged as a downgraded warning in expo-doctor), the build fails. **SDK 55 is the likely tightening point.**
- No `runtimeVersion` — builds can't correlate to OTA updates cleanly.
- `plugins` array lists `expo-live-activity` (line 59) — but `ios/` is committed, so the plugin's prebuild-time native modifications are **never actually run against this repo's iOS project**. The plugin is load-bearing for future prebuilds but dead code today. When someone eventually runs `expo prebuild`, the plugin will attempt to regenerate files that already exist with manual tweaks, and those tweaks die.

**6-month forecast:** `softwareKeyboardLayoutMode` warning becomes a hard error. Probability: 40%. **12-month:** 90%. The fix is one character (`"resize"`) but nobody will remember why until it breaks.

### 3. Dependency management / workspace hoisting — **2 / 5**

Evidence:
- `package.json:29` — root has its own `"expo-secure-store": "~15.0.8"` dependency that duplicates `packages/app/package.json:67`. Root has **no reason** to depend on a react-native-only module. This is fossil evidence of a past hoisting fix that nobody cleaned up.
- No `engines` field in `packages/app/package.json` or root `package.json` — only `packages/server/package.json:33` has one.
- First-batch auditors already found `@expo/vector-icons` was split-brain hoisted (wrong major ending up in the app bundle).
- No `overrides` / `resolutions` to defend against future hoist splits.

**Growth model:** hoisting bugs scale **quadratically** with workspace count × shared transitive deps. The project has 5 packages today. Each new workspace doubles the surface where a version can accidentally split. At 8 packages, expect a hoist bug every ~2 months. At 10+, continuous whack-a-mole.

**6-month forecast:** 1–2 more hoist-split bugs of the vector-icons class. Cost each: 1–3 hours debugging + a PR. **~4–6 engineering hours.**

**12-month forecast:** npm workspaces + React Native becomes the dominant friction surface. Migration to **pnpm** (with `shamefully-hoist=false` and an explicit `.npmrc` for RN) is the natural breakpoint. Migration cost at month 6: ~1 day. At month 18: ~3–5 days (more lockfile history to port, more scripts referencing `node_modules` layout, more CI paths to update). **Every month of delay adds roughly half a day of migration cost.**

### 4. Native strategy (hybrid drift trajectory) — **1 / 5**

This is the single biggest debt driver, and it is already hemorrhaging.

**Direct evidence of drift today:**
- `packages/app/ios/Chroxy/Info.plist:22` — `CFBundleShortVersionString` is `0.2.0`. Current project version is **0.6.9** (`app.json:5`, `package.json:3`). The iOS bundle version string has drifted by **4 minor releases**. This is the smoking gun: manual native state diverges the moment CNG sync stops running, and nobody noticed for ~5 months.
- `scripts/bump-version.sh` (169 lines) updates 11 files. It does **not** touch `ios/Chroxy/Info.plist`. Every version bump silently increases the drift.
- `.gitignore:19-26` has a 7-line explanatory comment about why `android/` is gitignored but `ios/` is tracked — the comment itself is evidence this trap has already bitten someone once.
- 37 tracked files under `packages/app/ios/` (per `git ls-files`), including a 737-line `project.pbxproj` that a human would have to hand-edit on any module change.
- Zero CI runs `xcodebuild`, `pod install`, or any iOS validation (`grep ios|xcode|pod` in `.github/workflows/` → 0 matches). The LiveActivity Swift code has been committed since #2278 and has **never been compiled in CI**.

**Drift accumulation model:** At the observed rate (1 missed sync over ~5 months on one field), expect ~2–3 drifted native fields per 6-month window. After 12 months, expect 5–8. After 24 months, the native project is effectively a fork that can't be regenerated without manual merge.

**6-month forecast:**
- Version drift extends to 3+ fields in Info.plist (CFBundleVersion, deployment target, maybe a permission string).
- First Xcode 17 / iOS 19 release happens. Building on a clean macOS worker against the committed `.pbxproj` will require hand-edits. Probability: 70%.
- Someone runs `expo prebuild` in frustration. Manual LiveActivity tweaks are lost. Recovery: **4–8 hours** of git archaeology.

**12-month forecast:**
- SDK 56 upgrade attempts `expo prebuild --clean` internally (Expo has been tightening CNG expectations each major). Committed `ios/` either blocks the upgrade or gets trashed. **Probability: 60%. Recovery cost: 1–2 engineering days.**
- Pods drift: `Podfile.lock` references react-native 0.81.5 (`packages/app/ios/Pods/ReactNativeDependencies-artifacts/reactnative-dependencies-0.81.5-*.tar.gz`). SDK 55 ships RN 0.82+. Upgrading requires either regen (deleting LiveActivity) or a manual Podfile + pbxproj diff party.

**36-month forecast:** The native project is effectively unmaintainable by anyone who wasn't present at the original LiveActivity commit. Either (a) a dedicated 1–2 week sprint migrates LiveActivity to an `expo-live-activity`-plugin-compatible shape and returns to pure CNG, or (b) the project accepts that iOS is now a permanent hand-maintained Xcode project and abandons CNG pretense entirely. **No middle path survives 36 months.**

### 5. Cross-workspace `prepare` scripts — **2 / 5**

Evidence:
- `packages/protocol/package.json:21` — `"prepare": "tsc"` produces `dist/` on `npm install`.
- `packages/store-core/package.json:19` — `"prepare": "npm run build:crypto"` with an 18-line inline Node one-liner that rewrites the output file to patch an ESM import. This inline patcher (`build:crypto` on line 18) is itself a tech debt red flag — it's doing regex replacement on compiled output because the upstream `tweetnacl-util` ESM interop broke at some point.
- `packages/app/package.json:29` — Jest `moduleNameMapper` hardcodes `"^@chroxy/protocol$": "<rootDir>/../protocol/dist/index.js"` — tests depend on `prepare` having already built the dist. If a fresh clone skips `prepare` (e.g. `npm ci --ignore-scripts`), tests silently import a non-existent file.
- `@chroxy/store-core` ships `main: "src/index.ts"` (raw TypeScript). This requires Metro to transform it — `jest.transformIgnorePatterns` has a `@chroxy/store-core` exception (line 19 of app package.json) to handle this. **If Metro ever drops its TS transform default, this breaks across all consumers simultaneously.**

**6-month forecast:** 1 broken fresh-clone scenario (someone runs `--ignore-scripts` for auditing, tests fail mysteriously). ~2 hours debug cost per incident.

**12-month forecast:** Metro bump in SDK 55 or 56 either changes its TS-transform default or removes `moduleNameMapper` support for .ts mains. Probability of one such regression: 40%. Cost: half a day of Metro config debugging.

**Sustainability verdict:** `prepare` scripts are a load-bearing anti-pattern. They work today because of a chain of assumptions (npm runs `prepare`, Metro transforms TS, tsc output survives node-resolve). Each assumption is independently fragile.

### 6. `scripts/bump-version.sh` extensibility — **2 / 5**

File: `scripts/bump-version.sh` (169 lines).

Current state:
- 11 locations updated via 10 separate inline `node -e` blocks (lines 46–107) plus awk/sed for Cargo.toml (lines 119–132) plus another loop for lockfiles (lines 138–150).
- **Does not update `ios/Chroxy/Info.plist` CFBundleShortVersionString** — this is the root cause of the 0.2.0 / 0.6.9 drift documented above.
- Each new workspace package requires a new `node -e` block. Linear growth, but with copy-paste overhead and no abstraction.

**Growth model:** ~10–15 lines per new sync target. Today: 169 lines for 11 targets. At 15 targets: ~230 lines. At 20 targets: ~320 lines and every edit risks inconsistency.

**Breaking point:** When the script hits ~250 lines or when someone has to add a second non-JSON format (e.g. Android `versionName` in `build.gradle` — which is already being missed because `/android/` is gitignored). At that point, the ROI flips in favor of `changesets` or `release-please`.

**6-month forecast:** 1 more sync target added (probably the Info.plist fix this report is forcing). Script grows to ~185 lines. Still manageable.

**12-month forecast:** Probably extended to handle `build.gradle versionName` + `Info.plist` + maybe a `Cargo.toml` sidekick crate. ~220 lines. Becoming cumbersome.

**18-month forecast:** Migration to `changesets` or `release-please` becomes cheaper than the next 3 extensions. Migration cost today: ~1 day. At month 18: still ~1 day, but you've eaten ~6 hours of drift bugs in the interim.

**Recommendation:** Migrate to `changesets` *now*, but only if the iOS Info.plist sync is fixed in the same PR — otherwise the migration ships the same drift bug forward.

### 7. CI coverage for native builds — **1 / 5**

Evidence: `grep -r "ios\|xcode\|pod" .github/workflows/` returns **zero matches** in any workflow file. `ci.yml` has jobs for server-tests, server-lint, dashboard-tests, dashboard-typecheck, store-core-tests, store-core-typecheck, app-tests, app-typecheck, protocol-tests, desktop-tests (Rust on macOS) — but **no iOS build, no pod install, no xcodebuild validation**.

The `desktop-tests` job (line 281) proves a macOS runner is already budgeted — adding an iOS validation job would not even add a new runner class. It would just add ~10–15 min per PR.

**LiveActivity code is committed Swift that has never been compiled in CI.** It compiles on the maintainer's local machine, and that is the only evidence it works.

**6-month forecast:** LiveActivity still compiles locally (maintainer hasn't rotated Xcode). Probability of silent Swift-level breakage that nobody notices until release build time: 30%. Cost on discovery: 1–4 hours.

**12-month forecast:** Xcode 17 ships. Swift 6 strict-concurrency default tightens. LiveActivity Swift almost certainly gets a new warning or error. Probability: 85%. Discovery mode: a user reports LiveActivity broken on iOS 19. Recovery: **1 full day** minimum because nobody has built the Xcode project in CI for 12 months and the regression window is enormous.

**36-month forecast:** LiveActivity is rotted. It either gets rewritten or gets `#if false`'d out.

---

## SDK Upgrade Forecast Table

| SDK | ETA | What breaks | Severity | Mitigation cost |
|---|---|---|---|---|
| **55** | Q3 2026 | `softwareKeyboardLayoutMode: "adjustResize"` becomes hard error (`app.json:33`). Expo doctor's 4 downgraded warnings likely promote to errors. Metro version bump may break `@chroxy/store-core` raw-TS `main` field. `@expo/vector-icons` pinned to `~14.0.4` is out-of-range for SDK 55 (expected ~15.x). EAS worker Node bumps to 22+ — if any transitive dep has been requiring Node 22, this is first working build. | Medium | 4–8 hours |
| **56** | Q1 2027 | Pure CNG expectations tighten — `expo prebuild` during upgrade tries to modify `ios/` more aggressively. Committed LiveActivity files risk being overwritten or the upgrade wizard refuses to proceed. RN 0.82+ Podfile format incompatible with committed Podfile.lock. `expo-live-activity` plugin likely has a major bump requiring schema migration in `app.json`. | **High** | 2–5 days (iOS native recovery) |
| **57** | Q3 2027 | React 20 / React Native 0.84+ likely defaults on. New Arch enforcement. Jest preset revision breaks `moduleNameMapper` hack in `package.json:29`. Committed `.pbxproj` references ancient build settings that Xcode 17+ refuses. | **Critical** | 1–2 weeks |

**Cumulative upgrade cost if nothing is pre-paid: ~3 weeks of engineering over 18 months.** Most of that is concentrated in the SDK 56 hit, where the hybrid-native state collides with CNG tightening.

---

## Tech-Debt Interest Estimate

| Category | Monthly cost | Evidence |
|---|---|---|
| Build debugging (EAS regressions, prebuild failures) | **1.5 hours** | Today: 5 failed builds × 15 min = 75 min. Plus an hour to diagnose + PR #2801 to ship the fix. This happens ~once every 4–6 weeks given unpinned EAS CLI and confused prebuild state. |
| Hoisting whack-a-mole | **1 hour** | vector-icons split already happened. With 5 workspaces + no overrides + no engines pin, expect one incident per ~2 months. |
| Drift bugs from manual native + missing CI | **1 hour** | Info.plist 0.2.0 vs 0.6.9 is evidence the drift is already real. Assume ~1 drift-discovery hour/month on average, rising. |
| Contributor onboarding friction | **1 hour** | New contributor loses ~1 hour per month on: "why is android/ gitignored but ios/ committed", "why does `npm install` fail without `prepare`", "why is `softwareKeyboardLayoutMode` working despite being wrong", "why doesn't CI validate iOS". Amortized over any realistic contribution rate. |
| Silent bug tail (bugs introduced by drift, found later) | **0.5 hours** | Small today. Rises fast after SDK 55. |
| **Total interest rate** | **~5 hours/month** | **≈ 60 engineering hours/year** |

At a nominal $150/hr loaded engineering cost, that's **~$9,000/year** being paid in tech-debt interest to avoid ~2 weeks of one-time remediation. **IRR of remediation: >300%.**

---

## Do-Nothing Trajectory

**6 months (Oct 2026):**
- ~30 engineering hours eaten (5 hr/month × 6).
- `softwareKeyboardLayoutMode` is probably still valid (40% hit probability). If it breaks, +2 hours.
- Info.plist drift has extended to 2–3 fields. Not yet a blocker.
- LiveActivity still compiles locally but nobody has looked at it.
- 1 more hoist-split incident in the bug log.
- **Status: annoying but functional.**

**12 months (Apr 2027):**
- ~60 engineering hours eaten (compounding slightly as drift widens).
- SDK 55 upgrade has been deferred once because "the keyboard thing scares me." Project now on SDK 54, which is about to be unsupported.
- First real LiveActivity regression reported by a user on iOS 19. 1 day lost to Swift debugging on a config nobody has touched in a year.
- Info.plist has 5+ drifted fields. `expo prebuild` is now an emergency recovery tool rather than a normal command.
- A new contributor has bounced off the project citing "native setup is confusing."
- **Status: dragging. Upgrades avoided. Recruitment visibly harder.**

**36 months (Apr 2029):**
- ~180+ hours eaten. Cumulative interest exceeds the one-time fix cost by **~6×**.
- Two forced SDK upgrades have happened, each a ~1-week emergency.
- `packages/app/ios/` is a hand-maintained Xcode project; nobody pretends it's CNG anymore.
- `scripts/bump-version.sh` is ~300 lines, has 3 untested edge cases, and new contributors avoid running it.
- **Either the project has bit the bullet and rewritten the native layer (~2 weeks), or it's stuck on an increasingly-dated SDK with security-patch-only RN updates.**

One-sentence trajectory: *If nothing changes, in 12 months the project pays for a 1-week emergency native recovery sprint; in 36 months it pays for a 2-week forced rewrite of the iOS layer — both avoidable by investing ~3 focused days now.*

---

## Top 5 Compound-Interest Investments (do these NOW)

### 1. Add an iOS build validation job to CI — **highest ROI**

Cost now: **~3 hours** (add `ios-build` job to `.github/workflows/ci.yml`, reuse macos-latest runner already used by `desktop-tests`, run `pod install && xcodebuild -workspace Chroxy.xcworkspace -scheme Chroxy -configuration Debug build` on PR).

Compound return: catches Swift/Xcode/Podfile regressions within the PR that introduces them instead of on discovery. Protects the committed LiveActivity code from the silent-rot trajectory above. Expected savings over 12 months: **8–16 hours** (one prevented emergency debug session). Over 36 months: **40+ hours**.

**Do this first.** It's the single change that most dramatically changes the drift curve.

### 2. Fix `Info.plist` CFBundleShortVersionString sync in `bump-version.sh`

Cost now: **~30 minutes** (add one `plutil -replace CFBundleShortVersionString` call). Also update the Android `versionName` once `/android/` is no longer gitignored (or add a hook that fails if iOS drift > 1 version).

Compound return: stops the bleeding on the single most concrete drift bug in the repo today. Prevents the "version shown in TestFlight doesn't match the code" bug from biting during release.

### 3. Pin the EAS CLI hard + add `env.NODE_VERSION` to every profile

Cost now: **~15 minutes**. Change `eas.json:3` from `">= 18.0.1"` to a narrow range like `"~18.0.1"` (or exact), add `"env": { "NODE_VERSION": "22" }` to all three profiles.

Compound return: eliminates the class of regression that produced PR #2801. Expected prevention: **1–2 build incidents per year × 2 hours each**.

### 4. Fix `softwareKeyboardLayoutMode` to `"resize"` — one-character fix

Cost now: **~2 minutes**. File: `packages/app/app.json:33`.

Compound return: removes the SDK 55 hard-error probability entirely. Prevents ~4 hours of "why is the keyboard plugin refusing to run" debugging during that upgrade.

### 5. Kill the root-level `expo-secure-store` dependency + add `engines` + add explicit `overrides`

Cost now: **~1 hour**. Remove `package.json:29`. Add `"engines": { "node": ">=22" }` to root + `packages/app/package.json`. Add `"overrides": { "@expo/vector-icons": "~14.0.4" }` to root to defend against hoist splits of the class that already bit the project once.

Compound return: prevents the vector-icons class of bug from recurring (estimated 1–2 incidents/year × 2 hours). Gives npm a fighting chance on hoisting.

---

## Honorable mentions (do these within 3 months)

- **Migrate to `changesets`** and retire `bump-version.sh`. Cost: ~1 day. Payback: ~6 months. Absolutely essential before adding a 12th sync target.
- **Decide about CNG** — write down the explicit policy: "ios/ is hand-maintained, no `expo prebuild` allowed; here's the list of manual steps required when bumping expo-live-activity". A 1-page document is the difference between controlled drift and unbounded drift. Cost: ~2 hours.
- **Remove `@chroxy/store-core`'s raw-TS `main`** field. Build it to `dist/` like `@chroxy/protocol`. Cost: ~2 hours. Payback: eliminates the Metro-transform fragility entirely.

---

## Overall Rating: **1.8 / 5**

**Verdict:** This configuration is sustainable for the next 6 months through accumulated luck, not design — the same kind of luck that kept `prebuildCommand` working for months before it suddenly didn't. The hybrid native-plus-CNG state is the dominant debt driver; the `Info.plist` 0.2.0 / 0.6.9 drift (visible right now at `packages/app/ios/Chroxy/Info.plist:22`) is proof the degradation has already started. The total tech-debt interest rate is approximately **5 engineering hours per month**, rising, and the single highest-leverage investment is adding an iOS build to CI — three hours of work that prevents an estimated 8–16 hours of rot over the next year and ~40 hours over three years. Without that intervention, the project faces a 60%-probable forced native-layer recovery sprint during the SDK 56 upgrade in Q1 2027, with a recovery cost of 2–5 engineering days. The do-nothing trajectory is not catastrophic, but it is measurably wasteful: over 36 months, it costs roughly 6× what a focused 3-day remediation would cost today.
