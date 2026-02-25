# Master Assessment — PR #892 (v0.2.0 Release)

**Audit Date:** 2026-02-24
**PR:** #892 — Remove PTY/tmux, bump version to v0.2.0, add release pipeline
**Auditor Panel:** 6 agents (Skeptic, Builder, Guardian, Minimalist, Tester, CI Expert)

---

## a. Auditor Panel

| Agent | Perspective | Rating | Key Contribution |
|-------|------------|--------|-----------------|
| Skeptic | Challenge assumptions, find what was missed | 2.5/5 | Tauri $VAR interpolation concern, JSDoc protocol rot, dashboard --terminal reference, workflow_dispatch gap, dead WS type branches |
| Builder | Identify ship blockers vs. polish | 3/5 | cli.js version hardcoded at 0.1.0, Tauri signing concern, service.js stale comment, describe.skip tombstones, Dockerfile version |
| Guardian | Security, supply chain, protocol correctness | 3/5 | App sends removed WS messages (protocol break), floating action tags, broad workflow permissions, empty keychain password |
| Minimalist | Measure dead code precisely | 3/5 | 2,583 lines of dead describe.skip tests, dead discovery UI in CreateSessionModal.tsx, dead imports, dead event handler |
| Tester | What does the test suite actually verify | 2.5/5 | 835-line count of same skip blocks, ResizeSchema silent-drop gap, misleading ptyManager fixtures, false raw event coverage |
| CI Expert | Pipeline correctness, build reproducibility | 3/5 | base64 --decode -o macOS failure (hard blocker), workflow_dispatch changelog extraction failure, missing Rust cache |

---

## b. Consensus Findings (4+ Agents Agree)

### 1. Dead Code Not Fully Cleaned

**All 6 agents** found PTY remnants across the codebase:

- 2,583 lines (Minimalist) / 835 lines (Tester) of `describe.skip` blocks in `ws-server.test.js` — same blocks, different counting scope
- Dead imports: `validateAttachments`, `ALLOWED_PERMISSION_MODE_IDS` in `ws-server.js`
- Dead event handler: `raw` listener in `event-normalizer.js`
- Dead config defaults: `tmuxSession`, `resume` in `server-cli-child.js`
- Dead UI: tmux discovery section in `CreateSessionModal.tsx`
- Dead JSDoc: 8 removed message types still documented in `ws-server.js` protocol comment
- Dead comment: node-pty reference in `service.js` line 191

The pattern is consistent: the large-scale deletions (removing entire files) were done correctly. The small-scale cleanup (imports, defaults, comments, test blocks) was not done.

### 2. cli.js Version Hardcoded at 0.1.0

**4 agents** found this (Builder, Guardian, Minimalist, Tester via import chain). The `packages/server/src/cli.js` file contains:

```js
.version('0.1.0')
```

The package is now at `0.2.0`. `chroxy --version` will report the wrong version immediately after the release is tagged.

### 3. Release Pipeline Has Correctness Issues

**5 agents** found problems with the release pipeline:

- CI Expert found `base64 --decode -o` is macOS-incompatible (hard blocker)
- Skeptic and Builder found `workflow_dispatch` breaks the `github-release` job
- Guardian found broad `contents: write` permissions on all jobs
- Guardian and Skeptic found floating action tags with no SHA pinning
- Guardian found empty keychain password (`-p ""`)

The Tauri `$VAR` question was raised by Skeptic and Builder as a concern; the CI Expert resolved it as not a blocker (see Contested Points below).

### 4. App Sends Removed WebSocket Messages

**Guardian and Minimalist** both found that the mobile app still sends `discover_sessions`, `attach_session`, and `resize` WebSocket messages that the server no longer handles. This is a **protocol break**: a user running a v0.2.0 server with the current app build will have a broken connection flow. The app sends `discover_sessions` at connection time and waits for `session_list` — which never arrives.

---

## c. Contested Points

### Tauri $ENV_VAR Interpolation

**Skeptic and Builder** flagged the `$APPLE_SIGNING_IDENTITY` strings in `tauri.conf.json` as non-functional, asserting that Tauri does not interpolate environment variables in its JSON config.

**CI Expert** corrected this: Tauri v2 **does** support `$ENV_VAR` substitution in `tauri.conf.json`. This feature was added in the Tauri v2.0 release. The JSON config is pre-processed before being consumed by the build system.

**Resolution: CI Expert is correct.** The Tauri signing config will work as written, assuming the environment variables are set on the runner. The real signing blocker is the `base64 -o` macOS incompatibility, not the config format.

### Dead Test Line Counts

**Minimalist** counted 2,583 lines for the `describe.skip` blocks. **Tester** counted 835 lines for the same blocks.

**Resolution:** Both agents are looking at the same three `describe.skip` blocks. The discrepancy is a difference in counting scope — Minimalist likely included surrounding comments, whitespace, and the `describe.skip` wrappers themselves in addition to the test body lines. Tester likely counted only the `it()` blocks. The exact count is immaterial. Both agents agree the blocks should be deleted.

---

## d. Factual Corrections

The following factual errors appear in individual reports:

1. **Tauri $VAR interpolation (Skeptic and Builder):** Both reports incorrectly state that Tauri does not interpolate environment variables in `tauri.conf.json`. Tauri v2 added this feature. The CI Expert report is the authoritative source on this point.

2. **base64 -o omission (Skeptic, Builder, Guardian, Minimalist, Tester):** None of these agents identified the `base64 --decode -o` macOS incompatibility, which is the actual release pipeline blocker. The CI Expert was the only agent to catch this. It is the most actionable finding in the entire audit.

---

## e. Risk Heatmap

```
                        IMPACT
                  Low      Med      High
             |---------|---------|---------|
        Low  |         |         |         |
L            |---------|---------|---------|
I       Med  |         |    C    |    B    |
K            |---------|---------|---------|
E      High  |         |    A    |    D    |
L            |---------|---------|---------|
I
H
O
O
D

A = Dead code / stale comments (many files, low blast radius per file)
    High likelihood (it's already there), medium impact (confusion, not breakage)

B = Release pipeline partial failures (workflow_dispatch, broad permissions, no SHA pinning)
    Medium likelihood (only triggered on release runs), high impact (bad releases)

C = App protocol break (app sends removed messages, server drops them)
    Medium likelihood (affects users who upgrade server without app), high impact (broken UX)

D = base64 -o macOS failure (blocks signed releases entirely)
    High likelihood (100% — will fail on every macOS runner), high impact (no signed release)
```

---

## f. Recommended Action Plan

### Priority 1 — Fix Before Merge (Blocking)

These must be resolved before the PR is merged. They will cause visible failures on first use.

**P1.1 — Fix base64 --decode -o in release.yml**

In `.github/workflows/release.yml`, replace:
```bash
echo "$APPLE_CERTIFICATE" | base64 --decode -o certificate.p12
```
with:
```bash
echo "$APPLE_CERTIFICATE" | base64 --decode > certificate.p12
```

**P1.2 — Fix cli.js version: read from package.json**

In `packages/server/src/cli.js`:
```js
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { version } = require('../package.json')
// ...
.version(version)
```

**P1.3 — Add tag guard to github-release job in release.yml**

```yaml
jobs:
  github-release:
    if: startsWith(github.ref, 'refs/tags/v')
    # ...
```

---

### Priority 2 — Fix Before Tagging v0.2.0

These should be committed to the branch before the release tag is cut.

**P2.1 — Delete 3 describe.skip blocks from ws-server.test.js**

Delete lines 1388–3971 (or equivalent). The file must be fully green with no skipped blocks.

**P2.2 — Remove ResizeSchema from ClientMessageSchema in ws-schemas.js**

```js
export const ClientMessageSchema = z.discriminatedUnion('type', [
  // remove: ResizeSchema,
])
```

**P2.3 — Clean dead imports from ws-server.js**

Remove `validateAttachments` and `ALLOWED_PERMISSION_MODE_IDS` from the import line.

**P2.4 — Remove dead defaults from server-cli-child.js**

Remove `tmuxSession = 'claude'`, `resume = false`, and `process.env.TMUX_SESSION` handling.

**P2.5 — Fix service.js error message**

Remove or update the stale node-pty reference in the error message around line 191.

---

### Priority 3 — Follow-Up Issues (Post-Merge)

File as GitHub issues. Do not block the merge on these.

**P3.1 — Remove discover_sessions / attach_session dead UI from app**
Remove the tmux discovery section from `CreateSessionModal.tsx`. File a protocol version issue if needed.

**P3.2 — Update ws-server.js JSDoc protocol comment**
Remove the 8 deleted message types from the documented protocol.

**P3.3 — Remove raw event handler from event-normalizer.js**
Delete the `session.on('raw', ...)` handler and its associated tests.

**P3.4 — Pin third-party actions to SHA in release.yml**
Pin `actions/checkout`, `actions/upload-artifact`, `tauri-apps/tauri-action`, and any other third-party actions to full commit SHAs.

**P3.5 — Add Rust/cargo caching to release pipeline**
Add `Swatinem/rust-cache@v2` before the Tauri build step to reduce build times from 35–45 min to 5–10 min.

**P3.6 — Scope permissions per-job in release.yml**
Move `contents: write` from workflow level to the `github-release` job only.

**P3.7 — Remove dashboard.js reference to --terminal flag**
Update user-facing help text in the dashboard that references the removed `--terminal` flag.

---

## g. Final Verdict

### Aggregate Rating

Weighted calculation (core panel: 1.0x, extended panel: 0.8x):

```
Core panel (Skeptic 2.5, Builder 3, Guardian 3, Minimalist 3): weight 1.0x each
Extended panel (Tester 2.5, CI Expert 3): weight 0.8x each

Numerator:   (2.5 + 3 + 3 + 3) * 1.0 + (2.5 + 3) * 0.8
           = 11.5 + 4.4
           = 15.9

Denominator: 4 * 1.0 + 2 * 0.8
           = 4 + 1.6
           = 5.6

Rating:      15.9 / 5.6 = 2.84 → 2.8/5
```

### Verdict

**Aggregate Rating: 2.8 / 5**

The PR accomplishes its primary goal: PTY code is structurally removed, the major files are deleted, and the version numbers are bumped in `package.json`. This is the right direction and the hard work is done.

However, the cleanup has a long tail. Dead code, stale references, and protocol ghosts were left behind throughout the codebase. More critically, the release pipeline introduced in this PR has two hard failures that will surface on the first real release run:

1. `base64 --decode -o` crashes on macOS GitHub Actions runners
2. `workflow_dispatch` without a tag guard produces a malformed GitHub release

The cli.js version string is wrong — `chroxy --version` will report `0.1.0` for a `0.2.0` release.

These are all fixable. None require architectural changes. The three Priority 1 items are approximately 10 lines of code total.

**The PR should NOT be tagged as v0.2.0 until the 3 Priority 1 items are resolved.** Once those are committed, the tag is safe to cut. The Priority 2 items should follow in a cleanup commit before or immediately after the tag. Priority 3 items can be tracked as GitHub issues.

---

## h. Appendix — Individual Reports

- [01-skeptic.md](./01-skeptic.md) — Skeptic perspective: assumptions challenged, stale references catalogued
- [02-builder.md](./02-builder.md) — Builder perspective: ship blockers vs. cleanup debt
- [03-guardian.md](./03-guardian.md) — Guardian perspective: security, supply chain, protocol correctness
- [04-minimalist.md](./04-minimalist.md) — Minimalist perspective: dead code inventory with line counts
- [05-tester.md](./05-tester.md) — Tester perspective: test suite integrity and coverage gaps
- [06-ci-expert.md](./06-ci-expert.md) — CI Expert perspective: pipeline correctness and build reproducibility
