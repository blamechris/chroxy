# Master Assessment: EAS / Expo / CNG Configuration

**Target**: The Expo / EAS Build / CNG configuration for `packages/app` — `eas.json`, `app.json`, `package.json`, the committed `ios/` LiveActivity project, the CNG-generated `android/` folder, and the cross-workspace `prepare`-script pipeline from `@chroxy/protocol` and `@chroxy/store-core`.
**Date**: 2026-04-11
**Panel size**: 6 agents
**Aggregate rating**: **2.1 / 5** — *Concerning. Ships today but on borrowed time. Active bugs already in production.*

---

## Auditor Panel

| Agent | Lens | Rating | Key Contribution |
|---|---|---:|---|
| **Skeptic** | Claims vs reality | 2.2 / 5 | Verified that prior commit messages were coherent; caught that `store-core`'s `prepare` script is dead weight because its `main` points at `src/index.ts`; caught that CI never builds iOS |
| **Builder** | Implementability | 2.6 / 5 | Showed the `@expo/vector-icons` blast radius is exactly 1 file (`Icon.tsx`), not dozens; highest-ROI fix is an `expo-doctor` CI job |
| **Guardian** | Safety / failure modes | 1.8 / 5 | Found an **actively shipping bug**: split-brain `@expo/vector-icons` (v14 in app, v15 hoisted to root); found lockfile still reports `packages/app: "0.6.7"` |
| **Minimalist** | YAGNI / cuts | 2.2 / 5 | Proposed a ~60% config-surface reduction; biggest cut is full-CNG migration deleting ~1000 LoC of committed native code |
| **Expo/EAS Expert** | Domain knowledge | 2.1 / 5 | **Definitive verdict: EAS does prepend `npx expo`** (resolves the cross-auditor dispute). **Showed the committed LiveActivity Swift is byte-identical to the plugin's source** — meaning full CNG is viable with zero feature loss |
| **Futurist** | Tech debt forecast | 1.8 / 5 | Forecast ~5 eng-hrs/month interest payment; found `ios/Chroxy/Info.plist:22` still at `0.2.0` despite project being at `0.6.9` — drift has already started |

**Weighted aggregate**: core panel 1.0× + extended 0.8× → **(2.2+2.6+1.8+2.2) + 0.8×(2.1+1.8) = 11.92 / 5.6 = 2.13 / 5**.

---

## Consensus Findings (4+ agents agree)

### 1. `@expo/vector-icons` is shipping split-brain RIGHT NOW — **P0 bug**

**Agreed by**: Skeptic, Builder, Guardian, Minimalist, Expo Expert (5/6)

- Root `node_modules/@expo/vector-icons` is `15.1.1` (hoisted because `expo@54` depends on it)
- `packages/app/node_modules/@expo/vector-icons` is `14.0.4` (pinned by `packages/app/package.json:45` at `~14.0.4`)
- App code imports via `src/components/Icon.tsx:2` — Metro resolves from the **nearest** `node_modules`, so the app bundles v14
- Expo internals (dev menu, splash, error screens) import v15
- Icon names that exist only in v15 render as tofu in the app code but correctly in Expo-internal screens — no build warning, no runtime error

**Blast radius**: exactly 1 source file (`src/components/Icon.tsx`) + `package.json:45` + a clean `npm install`. Bump to `^15.0.3` to match Expo SDK 54 expectations. Verify icon-name coverage for anything Icon.tsx actually uses.

### 2. `app.json` `android.softwareKeyboardLayoutMode: "adjustResize"` is schema-invalid — **P0 latent bomb**

**Agreed by**: Skeptic, Builder, Expo Expert, Guardian (4/6)

- Valid values per SDK 54 `@expo/config-types/ExpoConfig.d.ts`: `"resize"` or `"pan"`
- Current value silently works because `WindowSoftInputMode.js:41-48` does `MAPPING[value] ?? value` — the garbage happens to match the correct final Android string
- Doctor already flags this as an error; the build only passes because Doctor is downgraded to a warning
- Any future schema tightening (likely in SDK 55) turns this into a hard build failure

**Fix**: change `"adjustResize"` → `"resize"` in `packages/app/app.json`. One-line change. Zero behavior change.

### 3. iOS is **never** built in any CI path — silent drift already in progress

**Agreed by**: Skeptic, Builder, Guardian, Futurist (4/6)

- `grep -ri "ios\|xcode\|pod"` across `.github/workflows/*` returns zero matches for build jobs
- `packages/app/ios/Chroxy/Info.plist:22` has `CFBundleShortVersionString: 0.2.0` — project is at `0.6.9`, so this has been stale for **four minor releases** (since ~v0.3.0)
- Podfile.lock is 2490 lines and has never been regenerated or verified
- **`scripts/bump-version.sh` never touches Info.plist** — every prior version bump has silently extended the drift
- The `desktop-tests` job already uses `macos-latest`, so runner budget is not the blocker

**Cost**: Futurist estimates ~8-16 hours of Swift rot over 12 months, 40+ hours over 36, and a near-certain emergency recovery window on the SDK 55 or 56 upgrade.

### 4. `expo-doctor` is not in CI — it would have caught today's cascade

**Agreed by**: Builder, Futurist, Guardian (3/6, but unanimously endorsed as the highest-ROI action)

- Today's 5 failed builds ate ~75 min of iteration time; `expo-doctor` locally would have surfaced the exact same warnings that the EAS worker logged
- Builder's estimate: ~25 lines in `.github/workflows/ci.yml` for a new `app-expo-doctor` job
- Would have caught the softwareKeyboardLayoutMode, vector-icons duplication, and `@types/jest` mismatch *without* burning EAS build minutes
- Would not have caught the `prebuildCommand` syntax issue (that only manifests inside EAS's own prebuild phase) — but the `expo prebuild --no-install --platform android` dry-run would have

### 5. `package-lock.json` still reports `packages/app: "0.6.7"` — my lockfile fix missed a spot

**Agreed by**: Guardian, Expo Expert (2/6, but definitively verified)

- Today's PR #2800 fix synced the top-level `version` and `packages[""].version` fields in both `package-lock.json` and `packages/server/package-lock.json`
- **It missed** the workspace-nested entry at `package-lock.json:15939` which still says `"packages/app": { "version": "0.6.7" }` — a drift of 3 minor versions
- `scripts/bump-version.sh` patch in the same PR doesn't handle workspace-nested entries either — the pattern will re-appear on every future bump

**Fix**: extend the node one-liner in `scripts/bump-version.sh` to walk `lock.packages` and set every nested workspace entry whose name matches a workspace package, not just `packages[""]`.

### 6. `@types/jest` version mismatch vs SDK 54 expectation

**Agreed by**: Skeptic, Builder, Expo Expert (3/6)

- Expected per `packages/app/package.json`'s Expo SDK alignment: `29.5.14`
- Actual: `30.0.0`
- Low runtime blast radius (type-only), but it's a persistent Doctor warning and another "we don't match the expected stack" signal

---

## Contested Points

### Contested: What *actually* caused today's 5 failed builds?

**Skeptic** claimed: "EAS runs `prebuildCommand` via `sh -c`, not `npx expo`. My PR #2801 commit message is wrong. The real regression was trailing args propagating into `npm run build:crypto` → `tsc`, likely triggered by an npm CLI stricter-args change."

**Expo Expert** ruled: "EAS definitively prepends `npx expo` and appends `--platform <p> --non-interactive`." Three pieces of evidence:
1. The Expo docs example for `prebuildCommand` is literally `"prebuild --template example-template"` — the first token is an expo subcommand
2. The actual build log contained `"npx expo bash -c '...' --platform android exited with non-zero code: 1"`, which is only producible if EAS interpolates the value into an `npx expo` invocation
3. PR #2801's commit message analysis reconstructs this correctly

**Assessment**: **Expo Expert is correct.** The actual EAS build log (captured via the Expo GraphQL API — see `memory/expo-graphql-build-logs.md`) contained the literal string `npx expo bash -c`, which is an unambiguous fingerprint. Skeptic's "npm stricter-args change" theory is unsupported and should be ignored. The PR #2801 commit message on `1cc686698` is factually accurate.

### Contested: Delete LiveActivity entirely, or keep it via a config plugin?

**Minimalist** argued: "Delete `packages/app/ios/LiveActivity/` (571 Swift LoC) + `src/ios-live-activity/` (395 TS LoC) + the `expo-live-activity` dep. ~1,000 LoC in one swoop. This also unlocks full CNG, which dissolves the hybrid native state that caused today's pain."

**Expo Expert** countered with definitive evidence: "**`packages/app/ios/LiveActivity/*.swift` is byte-identical to `node_modules/expo-live-activity/ios-files/`**. Verified with `diff -q` — zero customization. The entire 'custom Swift code justifies committed iOS' rationale is factually wrong. Full CNG loses nothing."

**Assessment**: **Both are right about going full-CNG, but Expo Expert's finding changes the migration.** The committed Swift is zero-custom — it's a stale copy of what the plugin already ships. Full-CNG migration is therefore:
- Delete `packages/app/ios/` (37 files, including the byte-identical LiveActivity Swift)
- Add `packages/app/ios/` to `.gitignore` (alongside the existing `/android/`)
- Let `expo-live-activity` plugin regenerate it on every build
- **Keep the LiveActivity feature** — the user-facing Swift running in their phone is unchanged
- Eliminate the hybrid state that Expo Doctor warns about
- Eliminate the iOS CI gap (there's nothing to build in CI — it's plugin-generated)
- Eliminate the Info.plist drift (the plugin writes it fresh every time)

**Estimated scope**: smaller than Minimalist's 1000-LoC estimate because the TS wrapper in `src/ios-live-activity/` likely stays (it's the JS side of the bridge that the plugin expects). The deletion is ~600 LoC in `ios/LiveActivity/` plus the surrounding Xcode project wiring.

This is the single highest-leverage change in the entire audit.

### Contested: Is `@chroxy/store-core`'s `prepare` script load-bearing?

**Skeptic** and **Expo Expert** both claim: "No — `store-core`'s `package.json` has `"main": "src/index.ts"`, so Metro reads source TypeScript directly. The `prepare` script compiles `dist/crypto.js` but nothing in the app bundle imports from `dist/`."

**Assessment**: This needs verification before acting on it. The claim is plausible (Metro does handle TS source directly since SDK 50+), but the audit didn't confirm that `packages/app/src/**` never imports `@chroxy/store-core/crypto` via the `exports.crypto` sub-path. If it does, the `dist/crypto.js` is load-bearing after all. **Action: before removing the `prepare` script, grep all `packages/app/src/` imports of `@chroxy/store-core` and confirm they land on `src/index.ts`, not `dist/crypto.js`.**

---

## Factual Corrections to Recent Work

These are claims in today's commits / my summaries that the audit proved wrong:

1. **My summary after PR #2801 said "I fixed the lockfile sync completely"** — **wrong**. It missed `package-lock.json:15939` where `packages/app: "0.6.7"` still lives. Guardian and Expo Expert both independently found this. The `bump-version.sh` patch in the same PR has the same gap.

2. **My commit message on `c2036cc95` (historical) said "npm runs prepare after install... ensuring dist outputs exist"** — **unverified, likely only partially true**. `.github/workflows/ci.yml:210-212` and `:248-250` both manually run `npm run build` for protocol after `npm ci`, strongly implying that `prepare` isn't reliably firing in CI's install step. Skeptic flagged this.

3. **My PR #2800 summary claimed "Dashboard Type Check on main has been red since #2795"** — **true**, and the fix bundled into #2800 restored it. No correction needed, but the same class of "main is silently red" issue exists today for the iOS build path (which just isn't in CI at all).

4. **My commit message on `1cc686698` claiming "EAS prepends `npx expo`"** — **correct**, confirmed definitively by Expo Expert. Skeptic's disagreement was wrong.

5. **Implicit claim that "full CNG would lose LiveActivity"** (baked into the hybrid-state rationale across the project's history) — **wrong**. The committed Swift is byte-identical to the plugin's source. Full CNG is viable with zero feature loss.

---

## Risk Heatmap

```
                    Low Impact         Med Impact                  High Impact
High Likelihood  │                  │ vector-icons split brain │ Next SDK upgrade breaks
                 │                  │ (SHIPPING NOW)           │ iOS native project
                 │                  │                          │ (high drift already)
                 │                  │ bump-version.sh misses   │
                 │                  │ Info.plist               │
─────────────────┼──────────────────┼──────────────────────────┼──────────────────────
Med Likelihood   │ @types/jest      │ softwareKeyboardLayout   │ LiveActivity Swift
                 │ mismatch         │ silently ignored → hard  │ diverges from plugin
                 │ (type-only)      │ error in SDK 55          │ (identical today,
                 │                  │                          │ will drift without CI)
─────────────────┼──────────────────┼──────────────────────────┼──────────────────────
Low Likelihood   │ Dead store-core  │                          │ Full EAS worker image
                 │ prepare script   │                          │ rebuild breaks
                 │                  │                          │ prebuildCommand assumptions
                 │                  │                          │ again (mitigated by
                 │                  │                          │ deletion in #2801)
```

**Top-right cell is red**: high likelihood + high impact. Two entries there, both already silently shipping.

---

## Recommended Action Plan

Ordered by consensus severity + impact-to-effort ratio. Numbers in parens are the count of agents who flagged that item.

### P0 — Ship-critical fixes (do this week)

1. **Dedupe `@expo/vector-icons`** (5/6) — bump `packages/app/package.json:45` from `~14.0.4` to `^15.0.3`, clean-install, verify `src/components/Icon.tsx` icon names still resolve. Blast radius: 1 source file. Effort: S.

2. **Fix `android.softwareKeyboardLayoutMode`** (4/6) — change `"adjustResize"` → `"resize"` in `packages/app/app.json`. Effort: trivial. Zero runtime behavior change.

3. **Complete the lockfile sync** (2/6, verified) — extend `scripts/bump-version.sh` to walk all `lock.packages[<workspace>]` entries, not just `lock.packages[""]`. Then manually fix `package-lock.json:15939` from `0.6.7` → `0.6.9`. Effort: S.

4. **Sync `ios/Chroxy/Info.plist` version** (Futurist) — `packages/app/ios/Chroxy/Info.plist:22` is still at `0.2.0`. Wire Info.plist into `bump-version.sh` (or better: resolve it permanently via the full-CNG migration in P2). Effort: S.

### P1 — Prevention (do this sprint)

5. **Add `app-expo-doctor` CI job** (3/6, highest-ROI) — ~25 lines in `.github/workflows/ci.yml`. Runs `expo-doctor` + `expo prebuild --no-install --platform android` on every PR touching `packages/app/**`. Would have caught everything in today's cascade in 2 min. Effort: S.

6. **Pin `@types/jest` to `29.5.14`** (3/6) — per Expo SDK 54 expectation. Effort: trivial.

7. **Verify `@chroxy/store-core` `prepare`-script claim** (2/6) — grep `packages/app/src/**` for imports of `@chroxy/store-core/crypto`. If none land on `dist/`, remove the `prepare` script and the sed-hack `build:crypto` script alongside it. Effort: M (verification + safe removal).

### P2 — Strategic (do this quarter)

8. **Full CNG migration** (Minimalist + Expo Expert converging) — delete `packages/app/ios/` entirely, add `/ios/` to `.gitignore`, let `expo-live-activity` plugin regenerate the native project every build. Eliminates the hybrid state, the iOS CI gap, the Info.plist drift, and the Podfile.lock rot in one go. The committed Swift is already byte-identical to the plugin's source, so there is **zero feature loss**. Effort: M-L (migration + one round of manual verification that the plugin regenerates to a working Xcode project). **Single highest-leverage change in the entire audit.**

9. **Add iOS build validation to CI** (4/6) — redundant *if* P2 #8 lands (no committed Xcode project to drift). Essential *if* P2 #8 is deferred — without it, the native state WILL break silently on the next SDK upgrade. The `desktop-tests` workflow already has a `macos-latest` runner, so budget is not a blocker. Effort: S if P2 #8 is done (just remove the iOS CI job from scope); M if it's still needed.

### P3 — Long-term tech-debt paydown

10. **Replace `scripts/bump-version.sh` with `npm version --workspaces` + `changesets`** — Futurist and Minimalist both flagged 150+ lines of shell that grows linearly with every bump target. Effort: M. Defer until the script accumulates 2+ more gaps.

11. **Consider pnpm/turborepo migration** — Futurist flagged npm workspace hoisting as a trajectory risk. Not urgent today but will compound as more workspace packages are added. Effort: L. Defer until hoisting causes a second shipping bug.

---

## Final Verdict

**Aggregate rating: 2.1 / 5 — Concerning, not broken.**

This configuration is a classic tech-debt trap: every individual decision was defensible at the time, the system still ships, and the costs are paid in slow accumulating interest rather than one catastrophic failure. But the audit surfaced one **actively shipping bug** (vector-icons split-brain), one **silently invalid schema field** (softwareKeyboardLayoutMode), and one **silent drift vector** (committed iOS with zero CI) — plus the discovery that the hybrid-native justification is **factually wrong** because the committed Swift is byte-identical to the plugin's source.

The good news: most fixes are trivial, and there's one strategic move (full-CNG migration, enabled by the byte-identical-Swift finding) that dissolves most of the debt in a single M-sized change. The project should ship the P0 fixes this week, add the `expo-doctor` CI job to prevent regression, and seriously consider the full-CNG migration before SDK 55 lands.

Do-nothing cost, per Futurist: ~60 eng-hrs/year (~$9k), with a probable emergency recovery window on the SDK 55/56 upgrade in 2026-Q3 or Q4.

---

## Appendix: Individual Reports

| # | Report | Rating | Focus |
|---|---|---|---|
| 1 | [01-skeptic.md](./01-skeptic.md) | 2.2 / 5 | Claims vs reality, commit message accuracy |
| 2 | [02-builder.md](./02-builder.md) | 2.6 / 5 | Concrete file changes, effort estimates |
| 3 | [03-guardian.md](./03-guardian.md) | 1.8 / 5 | Failure modes, shipping bugs, recovery |
| 4 | [04-minimalist.md](./04-minimalist.md) | 2.2 / 5 | Deletions, surface-area reduction |
| 5 | [05-expo-expert.md](./05-expo-expert.md) | 2.1 / 5 | Domain verdicts, dispute resolution |
| 6 | [06-futurist.md](./06-futurist.md) | 1.8 / 5 | Tech-debt forecast, SDK upgrade trajectory |
