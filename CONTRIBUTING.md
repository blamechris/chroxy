# Contributing to Chroxy

Thanks for your interest in contributing! This document covers how to get started.

## What to expect

- All changes go through a PR; `main` is protected.
- CI runs lint, type-check, and tests across the `server`, `dashboard`, `app`, `store-core`, and `protocol` packages — these must pass before merge.
- We squash-merge to keep history linear.
- Be patient on review turnaround — this is a solo-maintained project.
- For non-trivial changes, open an issue first so we can agree on the approach before you spend time on it.

## Development Setup

1. **Fork and clone the repo**
   ```bash
   git clone https://github.com/YOUR-USERNAME/chroxy.git
   cd chroxy
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the server** (Terminal 1)
   ```bash
   PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start
   ```

4. **Start the app dev server** (Terminal 2)
   ```bash
   cd packages/app
   npx expo start
   ```

5. **Connect from your phone** — The app requires a custom dev build (not Expo Go) due to native modules. See `packages/app/README.md` for build instructions.

## Project Structure

- `packages/server` — Node.js daemon (CLI headless mode) with WebSocket API and web dashboard
- `packages/app` — React Native app (TypeScript, Expo 54) with chat view, xterm.js terminal, voice input, and plan mode UI
- `packages/desktop` — Tauri tray app (Rust + web dashboard) with voice-to-text and system integration
- `packages/protocol` — Shared WebSocket protocol types and Zod schemas (`@chroxy/protocol`)
- `packages/store-core` — Shared store logic and crypto utilities (`@chroxy/store-core`)
- `docs/` — Architecture docs and guides
- `scripts/` — Helper scripts

## Making Changes

1. Create a branch: `git checkout -b feature/your-feature`
2. Make your changes
3. Run server tests: `cd packages/server && PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm test`
4. Run app type check: `cd packages/app && npx tsc --noEmit`
5. Commit with a clear message
6. Push and open a PR

## Branch protection & CI policy

`main` is protected. Every PR is expected to clear these gates before merging:

- **Required status checks must be green.** These checks block the merge:
  `Server Tests`, `Server Lint`, `Server Windows Tests`, `Protocol Tests`,
  `Store Core Tests`, `Store Core Type Check`, `Dashboard Tests`,
  `Dashboard Type Check`, `Design Tokens Tests`, `App Tests`, `App Type Check`,
  `App Expo Doctor`, and `Desktop Rust Tests`. That is the set wired as required.
  Every OTHER job that runs on a pull request is listed, with the reason it is
  not a gate, in the not-required table below — the two lists together must
  account for every PR-visible job, and a guard fails when they do not. The
  `Desktop (macOS)` / `Desktop (Windows)` release builds run only on tag pushes
  and gate the release pipeline, not PRs. One rostered check is conditional by
  design: `Desktop Rust Tests` runs only for same-repo events, so a fork PR
  skips it — and a skipped required check is understood to still satisfy branch
  protection. Understood, not measured: this repo has had one fork PR in ~3,500,
  it predates that `if:` gate and reported no checks at all, so the precedent
  behind this sentence has never actually run here (#7641).
  Three guards hold these lists honest:
  `packages/server/tests/contributing-required-checks.test.js` proves every name
  in the roster is a real ci.yml job name;
  `packages/server/tests/ci-required-check-partition.test.js` proves the roster
  and the not-required table partition the PR-visible jobs exactly, so a job
  added to any workflow cannot stay unclassified; and
  `scripts/check-required-contexts.sh` (local, needs repo-admin read) diffs the
  roster against the LIVE required set — classic branch protection plus branch
  rulesets — run it after changing either side; it exits 2, never 0, when it
  cannot see the live settings.
- **All review conversations must be resolved.** A PR with an open review thread
  cannot merge — resolve it (or have it resolved) first.
- **A Copilot review** is requested automatically on the default branch (via a
  repository ruleset) and is expected before merge.
- **No force-pushes or branch deletions** to `main`.

#### Jobs that run on a PR and are deliberately not required

A required-check roster is a hand-maintained list beside a growing set of jobs —
the first cause in [`docs/false-safety-guards.md`](docs/false-safety-guards.md),
and this repo has hit it four times, once per job, in #7199, #7216, #7544 and
#7639. Each was filed because a job was added and nobody decided whether it
should gate. So the roster above is only half the record: every job in a
workflow triggered by `pull_request` must appear either there or here, and
`ci-required-check-partition.test.js` fails until it does. A row in this table
is a decision, not a backlog entry.

"Not required" does not mean "advisory to the author" — it means **a red result
here does not stop a merge**, on the GitHub merge button and in `/batch-merge`'s
gate, which derives its roster from the list above.

| Check | Workflow | Why it is not a merge gate |
| --- | --- | --- |
| `Resolve Runner Target` | `ci.yml` | **No good reason — this one is a hole.** Twelve of the thirteen required checks declare `needs: runner-target`. A `needs` failure skips the dependent rather than failing it, and this repo's own `/batch-merge` gate accepts `SKIPPED` as passing for a required context — so on the autonomous merge path its failure would stand down twelve required suites. Whether GitHub's own merge button does the same is documented behaviour but **unmeasured here**: no required context has ever reported skipped in this repo. It is a one-minute hosted bash step with no flake history, so requiring it is cheap either way. Tracked in #7641. |
| `Detect Changed Paths` | `ci.yml` | Path-filter plumbing whose only live consumer is `Renovate Config`. Same skip-cascade shape as the row above and it should follow the same decision; its `platform` output has no consumer at all (#7642). |
| `Scripts Tests` | `ci.yml` | **Should be required; not yet wired.** It carries the `bash -n` parse-check over every tracked shell script, `compile-skill-targets --check`, the AGENTS.md sync gate, and all 14 `scripts/__tests__` suites including `merge-updater-feeds.test.sh`, whose subject breaks the desktop auto-updater. Deterministic, no network, no flake history. #7544, #7639. |
| `Release PR Subject` | `ci.yml` | **Should be required; not yet wired.** Deterministic and content-derived; it is the check that would have caught #4627 and the 463-commit untagged gap in #7176. #7199. |
| `Renovate Config` | `ci.yml` | Proposed for requiring in #7216, on the argument that its usual skipped result satisfies protection — documented, not measured here (#7641). Small external-network surface (`npx` resolving a pinned `renovate`) is the other argument for waiting. |
| `Desktop Rust Tests (Windows)` | `ci.yml` | Its `if:` is byte-identical to the already-required macOS twin, so requiring it adds no new semantics. It shares the `chroxy-win` runner with the required `Server Windows Tests`, which has queued indefinitely during an outage before (#7057) — requiring it doubles the exposure to that one host, not the risk class. |
| `Style Lint` | `ci.yml` | Design-token ratchet, undefined-CSS-var check and the #7103 NUL-byte scan. Held back only by having produced a PR-unrelated red before: the baseline `comm` ran under the ambient locale (#7493, #7513). That is fixed; this row is the remaining reason to re-check rather than a standing exemption. |
| `Claude Hooks Tests` | `ci.yml` | Validates the hook emitters that feed the daemon's notification pipeline. Left on the mixed self-hosted ARM64 pool and named in #7491 as showing the #7471 isolated-cancel signature — requiring it before that is fixed would convert an infrastructure flake into a blocked merge. |
| `Dashboard Smoke (Playwright)` | `ci.yml` | The repo's only UI-regression gate (#6315), and the sole producer of the hosted npm-cache entry fork PRs restore. It runs a live `npx playwright install`, a 40-iteration boot poll and a full daemon start, so it has genuine PR-unrelated flake surface; it needs a measured flake baseline before it can gate a merge. |
| `notify` | `repo-relay.yml` | Fires the cross-repo relay/notification. It reports on a PR but asserts nothing about the code, and a missed notification must never block a merge. The only row here that is exempt on its merits rather than pending a decision. |

<!-- end not-required table -->

Rows above that say "should be required" are the open half of #7639. Promoting one
takes three edits, and only two of them are guarded — know which is which before
you rely on it:

1. Add the name to the roster bullet **and** delete its row here. The partition
   guard fails if you do one without the other, because the two lists would then
   either overlap or leave the job unclassified.
2. Add the context to **live branch protection**. Nothing in CI can check this —
   reading protection needs repo-admin scope that `GITHUB_TOKEN` does not have —
   so a roster naming a context that is not actually required stays green here.
   `scripts/check-required-contexts.sh` is what catches it, and it only runs when
   a human runs it. Run it after any promotion.

Deliberate policy choices (a solo-maintained project):

- **No required approving review.** The maintainer self-merges once the checks and
  conversation-resolution gates above pass; the required checks plus the Copilot
  review are the quality bar, not a second human reviewer. This keeps merge latency
  low and lets unattended/batch maintenance flows merge their own green, reviewed
  PRs.
- **Admins are not force-subjected to the protection rules**, which keeps an
  emergency-fix path open. This is why the bar above is framed as the expected
  policy rather than a rule enforced against every actor — in practice every merge
  still goes through these gates.

Repository Actions are hardened too: third-party actions are pinned to full commit
SHAs, the default workflow token is read-only (jobs elevate their own permissions
per-workflow as needed), and workflows on pull requests from first-time
contributors require maintainer approval before they run.

### If your PR's CI looks slow

PRs from a fork run on GitHub-hosted runners, which start with an empty `~/.npm`
and rely on a restored npm cache. Each job may instead install the monorepo from
scratch — a couple of extra minutes per job. **It does not fail, and it is not
something you did.** Two different cases:

- **Your PR does not touch a `package-lock.json`.** A cold install here should be
  rare — the cache is refreshed by a job on every push to `main`. If you see one
  anyway, it is worth reporting: it means a cache producer has gone missing.
- **Your PR changes a `package-lock.json`** — a dependency bump, or anything that
  regenerates a lockfile. The cache key is a hash of the lockfiles, so *your* key
  exists in no scope anything can read, and no job on `main` will ever create it
  (those build `main`'s key, not yours). There are no `restore-keys` configured,
  so there is no partial fallback either. **Every push to this PR cold-installs,
  for the life of the PR.** That is expected, is not worth working around, and no
  amount of cache-warming on our side would change it.

If you hit the first case, please say so in your PR — it means something on our
side broke, and it is worth knowing. The reasoning, the measurements behind it,
and the guards that are supposed to prevent it are written down in
[`docs/decisions/2026-08-npm-cache-producer.md`](docs/decisions/2026-08-npm-cache-producer.md).

## Code Style

- **TypeScript** for the app, **JavaScript (ES modules)** for the server
- Server: no semicolons, single quotes, plain JavaScript ES modules
- App: TypeScript strict, functional components, Zustand for state
- Meaningful variable names over comments
- Keep functions small and focused
- App state management: Zustand store
- Server: EventEmitter pattern for component communication

## Areas to Contribute

### Easy Wins
- UI polish and animations
- Better error messages and edge case handling

### Medium
- App-side test suite (component rendering, store logic)
- Settings page improvements
- Maestro E2E test flows for new features

### Larger Projects
- Session recording and replay
- Tailscale support as tunnel alternative
- Additional session providers via the provider adapter interface

## Questions?

Open an issue or start a discussion. We're friendly!

## Stale PR policy

To keep the PR queue manageable, external contributions follow an automated stale policy:

- **7 days** without contributor activity (commits, comments, or pushes) — a friendly reminder comment is posted and the PR is labeled `stale`.
- **14 days** without contributor activity (7 days after the reminder) — the PR is closed with a "feel free to reopen" message.

PRs from the repo owner are exempt. Issues are not affected by this policy.

### Exempt labels

A PR carrying any of the following labels is parked indefinitely and will not be marked stale:

- `pinned` — long-running work the maintainers want to keep visible
- `needs-discussion` — waiting on a design or scope decision
- `blocked:developer-program` — blocked on upstream (e.g. Apple/Google developer program access)
- `priority: critical`, `priority: high` — high-priority work that shouldn't be auto-closed while in the queue

If your PR is legitimately blocked on something outside your control, ask a maintainer to apply one of these labels.

### How to keep your PR open

Just comment on the PR (anything works — a status update, a question, or a "still working on this") to reset the timer. Pushing new commits also counts as activity.

If your PR is closed and you come back to it later, you can reopen it directly on GitHub — no need to file a new one.

The policy is automated via [`.github/workflows/stale.yml`](.github/workflows/stale.yml).
