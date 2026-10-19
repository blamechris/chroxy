# Run report — A2b-cy-claude

Mission: `docs/reports/harness-evals/trial/missions/A2b-cy-claude.md`. Issues are written
as "issue N" in this report, not `#N`, so nothing here cross-references an issue.

## Run facts

| Field | Value |
|---|---|
| Start (first command) | 2026-10-19T00:52:53Z |
| End (all queue items merged or flagged; report written) | 2026-10-19T02:35Z (about 1 h 42 min of the 12 h cap) |
| Harness | CY — Chroxy session, claude-sdk provider (`CHROXY_HOST_APP=Chroxy`, `CLAUDE_CODE_ENTRYPOINT=sdk-ts`) |
| Coordinator model as observed | `claude-sonnet-5-5` (the session's own model id; the mission expected `claude-opus-5-5`). Effort: not observable from inside the session; the user settings carried `effortLevel: high` for `claude-opus-5-5` only. |
| Worker models used | Independent reviewers: `general-purpose` subagents on `sonnet` (one per PR; a three-dimension panel for the cross-package PR; one fresh reviewer for the security-adjacent PR). One Codex read-only pass (`gpt-6-sol`) on the security-adjacent PR. Implementation was done by the coordinator itself: no implementation subagents were spawned. |
| Invocation | `/prime-directive "Trial run A2b-cy-claude: follow … exactly"` was recognised as a slash command and loaded the compiled `.claude/skills/prime-directive/SKILL.md` (no natural-language fallback). |
| Permission mode | Unattended, no human prompts. **Human approvals during the run: 0.** (The repo's merge hook blocked two merge attempts for want of a posted review comment; that is a tool hook, not a human approval — see incidents.) |
| Base branch / T0 | `trial/a2b-cy-claude` at `fef086cd`; T0 base `932bd3a4ef40bc9634cab390e6cf0facadd801d7` (`git merge-base origin/trial/a2b-cy-claude origin/main`) |
| Harness versions | Repository and preview-daemon `/health` version 0.11.4; Codex CLI 0.163.0. The version of the daemon hosting this session was not observable (n/a). App version: n/a. Skills: the clone's compiled `.claude/skills/` at the base SHA (no Codex compile in this run). |
| Cost | `n/a` — Chroxy's cost badge / `total_cost_usd` is not exposed to the agent in this session, and no estimate is given. |
| Human-owned QA left | See the two "COULD-NOT-CHECK" rows below. |

## Queue

CI runs = `CI` workflow runs on the PR's branch (push and pull_request events, so a re-push
adds runs). Review rounds = independent-review rounds on the PR, plus Copilot threads handled.
Every row used the closing line `Trial-Closes: N`; no issue was commented on, labelled, closed or filed.

| Issue | PR | Opened (UTC) | Merged (UTC) | CI runs | Review rounds | Merge SHA | Status |
|---|---|---|---|---|---|---|---|
| 8233 doctor ignores configured port | 8678 | 00:54 | 01:08 | 8 | 1 (clean); Copilot summary clean | `3d1bfc8a` | merged |
| 8215 `isLoopbackHost` mapped-hex prefix | 8679 | 00:59 | 01:19 | 6 | 1 (clean; nits folded in a follow-up commit); Copilot: no open issues, advisory "needs a closer look" because the callers are security-adjacent | `48564cbf` | merged |
| 7771 `updateContextWindow` admits NaN | 8680 | 01:05 | 02:10 | 3 | 1 + 1 Copilot thread (stale comments), fixed and resolved | `d13765cf` | merged |
| 8595 custom model collision labels | 8681 | 01:09 | 01:46 | 2 | 1 (clean); Copilot summary clean | `90d29ddc` | merged |
| 8364 lone tool bubble / detail modal terminated state | 8682 | 01:26 | 01:47 | 1 | 1 (clean); Copilot summary clean | `9a3f05bd` | merged; changed-feature smoke COULD-NOT-CHECK (named owner-reserved in the PR) |
| 8282 history entries record the stream kind | none | — | — | — | — | — | **no change required**: already delivered on the base (see below) |
| 8277 Settings dormant override + migration notice | 8683 | 01:45 | 02:10 | 3 | 1 (clean); Copilot summary clean | `825c6a16` | merged |
| 8567 default bypass set hand-copied in both clients | 8684 | 01:51 | 02:12 | 2 | 1 panel of 3 (clean); Copilot summary clean | `06114d68` | merged; app step COULD-NOT-CHECK (named in the PR) |
| 8303 Browse vs Create allowlists | 8685 | 02:06 | 02:34 | 6 | Codex read-only pass + 1 fresh reviewer (clean, 2 suggestions folded in) + 1 Copilot thread (already fixed, replied, resolved) | `cfe84e3e` | merged |
| 7815 doctor 'accepts custom port' hardcodes 59123 | 8686 | 02:14 | 02:27 | 4 | 1 (clean); Copilot summary clean | `ec45d7d3` | merged |

Nine PRs merged, one item verified as already satisfied, none blocked. Every PR was squash-merged
synchronously with all CI green on the final head, every review thread resolved and an independent-review
verdict comment posted. No `--auto`, `--admin` or protection override was used. `mergeStateStatus` read
`UNKNOWN` (GitHub still recomputing after a base move) at the moment of the merge call for PRs 8682 and
8683; their final-head CI was already fully green and GitHub accepted the merge.

### Smoke (mandatory for UI / session-runtime packages)

Isolated preview daemons were used for every package in the smoke scope (allow-listed environment,
temp config dir, 127.0.0.1, ephemeral port, no tunnel, never 8765; always stopped by SIGTERM to the
recorded pid, scratch removed). Evidence screenshots are in the private vault under `smoke/chroxy-pr<N>-<head7>/`.

| PR | Scope | Result |
|---|---|---|
| 8678, 8679, 8680, 8686 | server-only / test-only, outside the smoke scope list | `smoke: not applicable`, recorded in each PR |
| 8681 | store-core (label formatter) | PASS on two heads (the second after a typecheck-driven restructure): Browse → Select → Create, Haiku in the header picker, tiny prompt and reply, switch sessions and back, and the two overlay targets labelled `Custom (claude-alpha-1-0)` / `Custom (claude-beta-1-0)` in the picker |
| 8682 | app | App dev client loaded this PR's JS through Metro and rendered an existing chat: PASS. **Changed feature COULD-NOT-CHECK**: `ChatView` groups every `tool_use` message into the grouped renderer, so the lone `ToolBubble` and the detail modal only it opens are unreachable from the live chat. The behaviour is covered by component tests (4 red without the change). Named as the owner-reserved check in the PR. |
| 8683 | dashboard | PASS: migration notice shown and dismissed in Settings (and gone from New Session), dormant saved provider shown as a disabled option with a hint, Server default clears it, plus the owner path |
| 8684 | protocol + dashboard + app | PASS on the dashboard (quiet-hours bypass defaults are exactly the two shared defaults) plus the owner path; the app step is COULD-NOT-CHECK (a re-export of one constant plus a readonly prop type, covered by the app test and tsc; the simulator manual-connect route was not driven for this package) |
| 8685 | server + dashboard | PASS on two heads in two daemon configurations (roots and default cwd outside `$HOME`; default cwd outside the configured roots): Browse lists a root outside `$HOME`, Select + Create with that cwd, the filesystem root still refused, New Session note shown only for the second configuration, startup warning logged, plus the owner path |

## Review and guard notes

* Mutation proof was run for every new guard or test: removing the fix turned the tests red, and
  restoring it turned them green. The 8684 two-direction guard went red on both single-sided mutations
  (a category added to the server literal only; a `defaultBypass` flag added in the protocol only).
* 8685 (file-browsing authorization) got a read-only Codex pass on the first stable head. It ran with
  `gpt-6-sol` (`gpt-5.5` is rejected by this login) and hit its time limit before writing a summary, so the
  relayed result is its probe output. Its useful finding was fixed: a mis-cased `CHROXY_CONFIG_DIR` on a
  case-insensitive filesystem slipped past the state-root deny-list because Browse resolves with the
  canonicalising async realpath while the check used the case-preserving sync one.
* CI-found problems, all fixed in the PR before merge: an existing test in `models-overlay-reload.test.js`
  pinned the old NaN behaviour (8680); a dashboard typecheck failure from an indexed access (8681);
  a Windows-only failure of my own new test, where the temp dir sat inside a profile reached through an 8.3
  short name that the sync realpath does not expand (8685).

## Issue 8282: already satisfied on the base

The recorder already stamps `kind: 'thinking'` on reasoning streams, classifies legacy `-thinking-<n>`
ids, keeps `kind` through per-entry truncation, and the protocol schema carries the optional field;
`session-message-history-replay-parity.test.js` passes 97/97 and dropping the stamp turns 5 of them red.
Nothing was left to change, so no PR was opened and the item is reported rather than replaced.

## Stalls, incidents, pauses

* **No rate-limit pause, no stall over 90 minutes, no compaction, no restart.** The run was one continuous session.
* **Merge hook.** The repo's pre-merge hook blocked two merge attempts: first because no review-verdict
  comment existed yet, then because the comment and the merge were in one shell command, so the hook saw the
  merge before the comment existed. Posting the verdict comment in its own call first resolved it each time.
  Not a human approval.
* **Backgrounded CI watch.** One `gh pr checks --watch` ran past the 240 s tool limit and was moved to the
  background by the harness. It was stopped at once (`TaskStop`) and later waits used foreground slices bounded
  by `timeout`, per the dogfooding floor. No background task outlived a turn.
* **A claude-cli session was created during smoke** (PR 8683, first driver run). After the driver chose
  "Server default", the New Session dialog fell back to the first offered provider, which was the CLI one,
  because the preview daemon's default provider is not in its offered list. Creating a CLI session registers a
  permission hook in the user-level Claude settings while the daemon runs. The daemon was stopped immediately;
  `~/.claude/settings.json` was verified to parse, to still hold the `modelSettings` entry, and to contain no
  Chroxy hook afterwards. The driver was changed to select Claude (SDK) explicitly and abort otherwise, and the
  recorded run is the corrected one. No `claude-cli` session was created in any other run.
* **Other smoke artefacts.** A leftover `~/chroxy-smoke.*` directory that was not created by this run and a
  stale session in the iOS simulator's dev client were left untouched.
* **Preview-daemon fallback worth knowing.** The "Server default → CLI" fallback above is existing New Session
  behaviour, not part of any PR in this run.
* **Codex model.** `gpt-5.5` is rejected by the Codex login; `gpt-6-sol` worked.

## Follow-ups not filed (rule 4)

1. The lone `ToolBubble` and `ToolDetailModal` in the app are unreachable from `ChatView` (all `tool_use`
   messages are grouped). Either give them a path or remove them; PR 8682 only brings them to parity.
2. `validateCwdAllowed` resolves with the case-preserving sync realpath for the home deny-list, so on a
   case-insensitive filesystem a mis-cased home path can pass Create where Browse (canonical async realpath)
   now refuses it. Pre-existing and outside issue 8303.
3. A blank cwd still bypasses `validateCwdAllowed` (issue 8303 called this a separate decision); PR 8685 only
   logs a startup warning.
4. Browse now refuses credential/config directories (`~/.ssh`, `~/.config`, the daemon state root) that it
   used to list; mentioned in the PR, no migration needed, but it is a behaviour change.
5. The New Session dialog silently falls back to the first offered provider (here `claude-cli`) when neither
   the saved override nor the server default is offered; given that CLI sessions register a user-level hook,
   that fallback may deserve an explicit choice.
6. 8683 suggestions left as is: `aria-describedby` on the dormant hint, a note beside the Default model field
   while the saved provider is dormant, moving the notice-text helper out of a component module.
7. 8682 suggestions left as is: show the terminated summary in the collapsed bubble row, hide result images
   next to a terminated reason, share the stopped/terminated label helper.
8. 8684: a source-level check that the dashboard keeps no local copy of the bypass set (the hard-coded
   expectation already pins the values), a stale-dist cross-check in the roster test, and an optional entry in
   `docs/false-safety-guards.md` for roster-direction checks.
9. A relative `workspaceRoots` entry resolves against the daemon's working directory, in Create and now in
   Browse alike; the config documentation could say so.

## Decisions

No decision panel was needed; the decisions below were reversible and taken in the open.

* 8567: keep the daemon's own `DEFAULT_BYPASS_CATEGORIES` literal and pin it to the protocol set in both
  directions, rather than importing the protocol constant into the daemon (a test whose expectation is derived
  from its own subject cannot go red; the daemon should not depend on a UI table for behaviour).
* 8303: no separate "default cwd" entry in Browse's roots (a cwd that passes the session-cwd check is inside
  `$HOME` or a root by construction); the credential deny-list applies to every Browse request.
* 8277: show a dormant override as a disabled option plus a hint, keeping the Default model roster on the
  first offered provider.

## Isolation self-report (rule 5)

None read. No `trial/*` branch other than `trial/a2b-cy-claude` was fetched, diffed or listed, no PR with a
trial base other than this run's own was viewed, and nothing under
`~/Obsidian/no-it-all/reviews/harness-trial-2026-10/`, any `KEY.md` / `KEY.md.enc`, any `NEXT-*.md` seed or any
trial-run brief was read. At startup the harness loaded the owner's global instruction files before this mission
was loaded; no vault path was read by the agent. Vault paths written: `smoke/chroxy-pr<N>-<head7>/` evidence
folders (writes, plus reading back the agent's own screenshots). Two housekeeping notes: a directory listing
(names only) was taken of a leftover `~/chroxy-smoke.*` folder that was not this run's, and the Codex model list
was read from `~/.codex/models_cache.json` to pick an available model.
