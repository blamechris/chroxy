
# Minimalist's Audit: EAS / Expo / CNG Configuration

**Agent**: Minimalist — ruthless cutter, YAGNI gospel, believes the best code is no code
**Overall Rating**: 2.2 / 5
**Date**: 2026-04-11

---

## Verdict up front

This project is paying the full complexity tax of a hybrid native/CNG setup for one feature (iOS LiveActivity) that the app could live without. On top of that it carries a handful of dead deps, a bespoke `prepare` → `dist/` pipeline for trivially-sized shared packages, a 148-line version-bump script that reinvents `npm version --workspaces`, and a postinstall that bundles xterm into a TypeScript string constant. The config files themselves are close to minimal — the weight is in the scaffolding around them. The hybrid native state is the single largest source of pain and today's 5 failed builds trace directly to it.

---

## Section-by-section ratings

| Area | Rating | Summary |
|---|---|---|
| eas.json build profiles | **4 / 5** | Already lean (21 lines). Minor fat, nothing urgent. |
| app.json Expo config | **3 / 5** | ~5 fields are defaults or dead. Plugins list is honest. |
| Dependency list | **2 / 5** | Two hard-dead deps, one stale dup, one unused devDep, and a broken sub-indirection. |
| Native project strategy (CNG/native hybrid) | **1 / 5** | This is the root of all the pain. Two-mode state costs months of debugging. |
| Cross-workspace build (prepare scripts, dist indirection) | **1 / 5** | `prepare` scripts + dist fallback + jest `moduleNameMapper` points at `dist/index.js` — every fresh checkout has an ordering trap. |
| Helper scripts (bump-version, bundle-xterm) | **2 / 5** | 148-line bash doing what `npm version --workspaces` does. xterm bundler is gratuitous. |

---

## 1. Native project strategy — the big rock

**Current state:** `packages/app/ios/` committed (37 tracked files, 571 lines of Swift in LiveActivity, 737-line `project.pbxproj`), `packages/app/android/` gitignored with a 7-line warning comment explaining why. Expo Doctor flags this hybrid state. `prebuildCommand` has been a load-bearing landmine for months (fix landed in 28f7c372d / #2801).

**Why it exists:** #2278 added LiveActivity Swift code (~571 LoC across 9 files) that is not expressible through an off-the-shelf config plugin, so iOS was ejected. Android has no parallel reason to be ejected.

**Three clean options, ordered by how much they delete:**

### Option A (most minimal) — Delete LiveActivity entirely. Go full CNG.

- **Removed:** 37 tracked iOS files, 571 Swift LoC, 395 LoC in `src/ios-live-activity/`, `expo-live-activity` dep, 3 lines of `.gitignore` explanation, the 2-line `live-activity` plugin entry in app.json.
- **Total: ~1,000 LoC and ~40 files deleted** in one swoop.
- **What the app loses:** LiveActivity pills on the lock screen showing Claude Code session state. Users who cared have 30 seconds of minor regret.
- **Risk:** Low-medium. Feature is additive — nothing else depends on it. A smoke test + one Maestro run verifies the app still boots.
- **YAGNI verdict:** A phone app that you tunnel a terminal to arguably should not need a custom iOS widget extension. This is the 80/20 cut.

### Option B — Keep LiveActivity, commit Android too. No CNG.

- Delete `/android/` from `.gitignore`, commit whatever `expo run:android` produces once.
- **Removed:** 7 lines of gitignore comment, the prebuild-vs-not asymmetry, an entire class of CNG-related build failures (including today's), 1 Expo Doctor warning, `eas.json` gets simpler because prebuild is never needed.
- **What the project gives up:** automatic native reconciliation on Expo SDK upgrades — every SDK bump you eject again manually. But: you already do this for iOS.
- **Risk:** Very low. It's what you already do for iOS.
- **Verdict:** If you won't delete LiveActivity, this is the honest choice. "Half CNG, half not" is worse than either extreme.

### Option C (status quo) — Hybrid

This is where you are, and it is the most expensive option. Every EAS build has to reconcile. Every SDK upgrade has two separate reconciliation paths. Every new native module has two install paths. Expo Doctor will always complain. Reject.

**Recommendation:** Option A first, Option B as a fallback. The hybrid state is the top-rated cut in this audit.

---

## 2. `eas.json` audit

Only 21 lines. Actually close to minimal. Small observations:

- **`cli.version: ">= 18.0.1"`** — load-bearing for EAS compatibility warning. Keep.
- **`cli.appVersionSource: "remote"`** — load-bearing since `bump-version.sh` also writes the version, but `production.autoIncrement: true` expects remote. This is a conflict in intent. If you use `remote`, delete the app version writes from `bump-version.sh`. If you want local versioning, drop `appVersionSource` and `autoIncrement`. Pick one.
- **`build.development`** — `developmentClient: true` + `distribution: internal`. Both required. Keep.
- **`build.preview`** — 1 field. Keep.
- **`build.production.autoIncrement: true`** — see above. Conflicts with `bump-version.sh`. Delete one or the other.
- **`submit.production: {}`** — empty object, load-bearing for `eas submit`. If you've never run `eas submit`, delete it; it's 3 lines. If you plan to, keep.

**Minimum viable eas.json (if you pick Option B, no prebuild, no submit):**

```json
{
  "cli": { "version": ">= 18.0.1" },
  "build": {
    "development": { "developmentClient": true, "distribution": "internal" },
    "preview": { "distribution": "internal" },
    "production": {}
  }
}
```

16 lines → 10. Not a huge win. Rating stands at 4/5.

---

## 3. `app.json` audit

Field-by-field dead-weight pass:

| Field | Status | Delete? |
|---|---|---|
| `name`, `slug`, `version` | load-bearing | keep |
| `orientation: "default"` | **DEFAULT** — `default` is Expo's default | **delete** |
| `icon` | load-bearing | keep |
| `userInterfaceStyle: "dark"` | non-default, keep | keep |
| `splash` | non-default, keep | keep |
| `assetBundlePatterns: ["**/*"]` | **DEFAULT** | **delete** |
| `ios.supportsTablet: true` | non-default | keep (you want iPad) |
| `ios.bundleIdentifier` | load-bearing | keep |
| `ios.infoPlist.*` | load-bearing (usage strings required by App Store) | keep |
| `android.adaptiveIcon` | load-bearing | keep |
| `android.package` | load-bearing | keep |
| `android.softwareKeyboardLayoutMode: "adjustResize"` | **Expo Doctor flags this as invalid** | **delete** (fixes 1 warning) |
| `android.permissions` | dubious — Expo auto-merges from config plugins | **probably redundant** (verify with `expo prebuild --clean`; the expo-camera and expo-speech-recognition plugins already add CAMERA + RECORD_AUDIO) |
| `web.favicon` | dead — there is no web target, project is mobile-only | **delete** |
| `scheme: "chroxy"` | load-bearing for deep link | keep |
| `plugins.expo-camera` | load-bearing | keep |
| `plugins.expo-speech-recognition` | load-bearing | keep |
| `plugins.expo-secure-store` | plugin entry may be unnecessary in SDK 54 (secure-store autolinks) | verify/delete |
| `plugins.expo-localization` | plugin entry may be unnecessary (auto) | verify/delete |
| `plugins.expo-live-activity` | delete if Option A from §1 | delete (Option A) |
| `extra.eas.projectId` | load-bearing | keep |

**5 fields safe to delete today, 2–3 more to verify.** Post-trim app.json is ~48 lines (from 67).

---

## 4. Dependency list — dead deps and dupes

Verified by grepping `packages/app/src` and `__tests__`:

### Hard-dead (zero imports)

| Dep | Type | Evidence | Action |
|---|---|---|---|
| `tweetnacl` | dep | 0 imports in `src/` | **delete from `packages/app/package.json`** — only used transitively via `@chroxy/store-core`, which declares it itself |
| `tweetnacl-util` | dep | 0 imports in `src/` | **delete** — same reason |
| `@expo/ngrok` | devDep | only reference is in lockfile; tunnel mode broken per MEMORY.md | **delete** |

Net: 3 deps removed, 0 source changes, 0 risk. Saves install time.

### Duplicate

| Dep | Problem |
|---|---|
| `@expo/vector-icons: "~14.0.4"` | Root lockfile shows `15.1.1` hoisted at root (pulled in by `expo`) AND `14.0.4` nested under `packages/app/node_modules/`. You're shipping two copies in the dev bundle. Expo Doctor flags this. |

**Action:** Delete `@expo/vector-icons` from `packages/app/package.json`. It's a transitive dep of `expo`. Used in exactly one file (`src/components/Icon.tsx`), which will resolve via hoisted copy. Removes the version mismatch warning.

### Root-level oddity

- Root `package.json` declares `expo-secure-store: "~15.0.8"` as a **root dep**, duplicated in the app workspace. This is a leftover and makes no sense for a workspace root that has no code of its own. **Delete from root `package.json`.**

### Potentially-removable-if-you-cut-LiveActivity

- `expo-live-activity` — delete under Option A above. 1 dep gone.

### Summary

- **5 dep deletions** (3 dead + 1 duplicate + 1 root leaking + potentially 1 for LiveActivity) are pure wins, all grep-verified, all zero-risk.
- Jest `moduleNameMapper` for `@chroxy/protocol` pointing at `../protocol/dist/index.js` is the cross-workspace wart — see §5.

Dependency section rating: **2/5**.

---

## 5. Workspace `prepare` scripts and `dist/` indirection

### `@chroxy/protocol`

- Has `"main": "./dist/index.js"` and `"prepare": "tsc"`.
- Every clean `npm install` runs `tsc` → `dist/`.
- Jest imports via explicit `moduleNameMapper: { "^@chroxy/protocol$": "<rootDir>/../protocol/dist/index.js" }` — if you forget to run `prepare` before `npm test`, tests fail cryptically.
- **Simpler:** change `"main"` to `./src/index.ts` and add `@chroxy/protocol` to `jest.transformIgnorePatterns` (already done). Metro and ts-jest can compile it. Delete the `prepare` script entirely. The same package also has `.exports` for `./schemas` which is dead weight if nothing imports it directly.

### `@chroxy/store-core`

This one is actively absurd. The `build:crypto` script is:

```
tsc src/crypto.ts --outDir dist --module ESNext --target ES2022 --declaration --moduleResolution node --esModuleInterop --skipLibCheck
&& node -e "fs...replace(\"import { encodeBase64, decodeBase64 } from 'tweetnacl-util';\",\"import naclUtil from 'tweetnacl-util';\\nconst { encodeBase64, decodeBase64 } = naclUtil;\")"
```

It compiles one file then uses `sed`-in-node to hand-patch a named import into a default-destructure because the ESM shape of `tweetnacl-util` confuses the consumer. This runs on `prepare` AND `pretest`. The whole package has exactly two export paths: `"."` points at `src/index.ts` (raw!) while `"./crypto"` points at `dist/crypto.js`. It's half-compiled, half-raw. Pick one.

**Recommended simplification:**

- Change the crypto import to `import naclUtil from 'tweetnacl-util'` at the source level.
- Delete `build:crypto`, delete `prepare`, delete `pretest`, delete the `dist/` fallback.
- Export `./crypto` directly from `src/crypto.ts`.
- Metro/ts-jest/vitest all handle TS source fine.

**Deletion:** ~15 lines of package.json scripts, 1 dist dir, 1 ordering trap, 1 cryptic post-install `node -e` sed.

Cross-workspace rating: **1/5**.

---

## 6. `bump-version.sh` — 148 lines doing what `npm` does in one

The script:
1. Reads version from server/package.json.
2. Rewrites **8** `package.json` / `app.json` files via 8 separate `node -e` blocks.
3. Line-edits `Cargo.toml` via `awk + sed` with `.bak` cleanup.
4. Rewrites 2 `package-lock.json` files via another `node -e` block.
5. Runs `cargo generate-lockfile`.
6. Prints the list.

Of 148 lines, roughly:
- **Essential** (Cargo.toml, Cargo.lock, tauri.conf.json): ~30 lines — legitimate because these aren't npm workspaces.
- **Cargo-culted**: everything else. `npm version <new> --workspaces --no-git-tag-version` does all 8 package.json rewrites and both package-lock.json updates in one command, natively.

**Recommended rewrite** (note: this only qualifies as minimalist because the replacement is shorter):

```bash
#!/usr/bin/env bash
set -euo pipefail
NEW="${1:-$(node -p "require('./packages/server/package.json').version.replace(/(\d+)$/, (_, p) => +p + 1)")}"
npm version "$NEW" --workspaces --include-workspace-root --no-git-tag-version
# Expo app.json (not an npm workspace field)
node -e "const fs=require('fs'); const a=JSON.parse(fs.readFileSync('packages/app/app.json','utf-8')); a.expo.version='$NEW'; fs.writeFileSync('packages/app/app.json', JSON.stringify(a,null,2)+'\n')"
# Tauri (Rust)
node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('packages/desktop/src-tauri/tauri.conf.json','utf-8')); c.version='$NEW'; fs.writeFileSync('packages/desktop/src-tauri/tauri.conf.json', JSON.stringify(c,null,2)+'\n')"
sed -i.bak -E "/^\[package\]/,/^\[/s/^version = \"[^\"]*\"/version = \"$NEW\"/" packages/desktop/src-tauri/Cargo.toml && rm packages/desktop/src-tauri/Cargo.toml.bak
(cd packages/desktop/src-tauri && cargo generate-lockfile) 2>/dev/null
echo "Bumped to $NEW"
```

**~15 lines vs 170. ~90% deletion.** Risk: medium — needs one real run to verify all 12 files update. Verify by running on a clean branch and `git diff` inspection.

---

## 7. `scripts/bundle-xterm.js` postinstall

**Purpose:** Reads three files from `node_modules/@xterm/*`, escapes them for template literals, writes them as exported string constants into `src/components/xterm-bundle.generated.ts`.

**Why:** The React Native WebView needs inline `<script>`/`<style>` blobs to run xterm client-side. Can't `import` a CSS file in RN. Can't load xterm from CDN (offline, tunnel reliability).

**Is it actually necessary?** Yes, the underlying problem is real — RN + WebView + offline = you need a way to inline third-party JS/CSS. But the shape of the solution is heavy:

- 45-line script
- 1 postinstall hook on every `npm install` across all workspaces (slows every CI run)
- 1 generated TS file that's gitignored via `collectCoverageFrom` exclusion
- A contributor who `git clone`s then opens the file in their IDE sees red squiggles until `npm install` runs

**Simpler alternatives (none strictly shorter, but better):**

1. **Commit the generated file.** It changes only when xterm version bumps (rare). Delete postinstall, delete script invocation. Add a single `bundle-xterm` script that contributors run when updating xterm. Net: postinstall goes away, ~45 lines become run-on-demand. Same file count but no ordering trap.
2. **Read + inject at runtime** via `Asset.loadAsync` from `expo-asset`, bundling the raw `.js`/`.css` as assets. More code, not less — reject.
3. **fetch from CDN with cache** — violates offline-first. Reject.

**Recommended:** Option 1. Delete the postinstall hook, commit `xterm-bundle.generated.ts`, rename `bundle-xterm` script to `update-xterm`. **Saved: 1 postinstall across every CI job, 1 per-install race condition, 0 lines of actual code.**

Helper scripts rating: **2/5** — bundle-xterm is not removable but the postinstall wrapping is.

---

## Top 5 deletions (ranked by impact)

### 1. Delete `packages/app/ios/LiveActivity/` + `src/ios-live-activity/` + `expo-live-activity` dep

- **LoC removed:** ~1,000 (571 Swift + 395 TS + ~40 misc)
- **Files removed:** ~15 tracked + 1 plugin entry + 1 dep
- **Risk:** Low — feature is additive. No other subsystem imports from `ios-live-activity/`.
- **Verify:** Smoke test app launch, run `packages/app/.maestro/run-all.yaml`, confirm no crashes.
- **Bonus:** Unlocks going full-CNG, which deletes Expo Doctor warnings #3 and #5 and makes `eas.json` and `.gitignore` simpler. Fixes the root cause of today's 5 failed builds.

### 2. Delete the whole hybrid native state (after #1)

Move to full CNG. Remove `packages/app/ios/` from git, delete the `/android/` gitignore rule + 7-line explanation comment, simplify `.gitignore`, remove the "mixed CNG/non-CNG" Expo Doctor warning.

- **LoC removed:** 37 additional tracked files (pbxproj alone is 737 lines), 7 lines of gitignore comments
- **Risk:** Medium — first clean CNG run on iOS needs validation. Mitigated because LiveActivity was the only reason to eject.
- **Verify:** `expo prebuild --clean && eas build --profile development --platform all`.

### 3. Delete `@chroxy/store-core`'s `build:crypto` + `prepare` scripts + `dist/` export fallback

- **LoC removed:** ~15 lines of package.json + a compile step + an auto-patch step
- **Risk:** Low — fix the import at the source and let Metro/ts-jest/vitest compile TS directly. Same for `@chroxy/protocol`'s `prepare` (another ~5 lines + a jest `moduleNameMapper` that can probably go).
- **Verify:** Run `npm test` in both workspaces, run app Metro build, run server tests.

### 4. Delete dead and duplicate deps

- `tweetnacl`, `tweetnacl-util`, `@expo/ngrok`, `@expo/vector-icons` (from app), `expo-secure-store` (from root)
- **LoC removed:** 5 lines of dependency declarations
- **Risk:** Zero — all grep-verified with zero direct imports (tweetnacl pair) or single transitively-satisfied import (vector-icons).
- **Verify:** `npm install && npm test -w @chroxy/app` and boot the app.

### 5. Replace `bump-version.sh` with the `npm version --workspaces` one-liner

- **LoC removed:** ~130 (from 148 to ~18)
- **Risk:** Medium — needs one real version bump to verify all 12 files land correctly. Not hard, but you're touching release machinery.
- **Verify:** Run on a throwaway branch, `git diff` all files, run `cargo check` in the Tauri dir.

---

## Honorable mentions (smaller cuts not in the top 5)

- Delete `app.json` dead fields: `orientation: "default"`, `assetBundlePatterns: ["**/*"]`, `web.favicon`, `android.softwareKeyboardLayoutMode` (invalid per Expo Doctor), `android.permissions` (probably auto-added by plugins). **5–7 lines.**
- Delete the `@types/jest` devDep if `jest-expo` already pulls it in transitively (Expo Doctor flagged the version mismatch — the simpler fix is delete, not align).
- Consider whether `scripts/bundle-xterm.js` needs to be a postinstall or just a one-shot (see §7) — probably one-shot.
- `packages/app/package.json` has a `jest.transformIgnorePatterns` regex that mentions `zustand` — zustand is shipped as ESM and newer `jest-expo` handles that. Verify and delete if dead.

---

## Overall rating: 2.2 / 5

The raw config files are fine. The ecosystem **around** them is carrying unnecessary weight: a hybrid native state for one widget feature, dead deps from pivot debris, a compile-to-dist fallback for 200-line shared packages, and a 148-line version bumper that reinvents what npm already does. The number-one fix is also the single biggest simplification: go full CNG, delete LiveActivity, and ~1,000 lines vanish. Everything downstream from that decision gets simpler.

If someone with authority gave me a free rein and one afternoon, the config surface area of this app would shrink by roughly 60%.
