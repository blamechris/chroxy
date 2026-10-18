# Run report — A2-cy-claude

## Run

| Field | Value |
|---|---|
| Run id | `A2-cy-claude` |
| Start (first command) | 2026-10-18T16:04:16Z |
| End (report written) | 2026-10-18T18:01:27Z |
| Harness | CY — Chroxy session, claude-sdk provider (`CHROXY_HOST_APP=Chroxy`, `CLAUDE_CODE_ENTRYPOINT=sdk-ts`) |
| Coordinator model / effort | `claude-opus-5-5` (model id reported by the session environment); effort as configured for the session (high). The coordinator cannot read the effort setting itself. |
| Worker models | `sonnet` tier (Claude Sonnet 5.5) for every implementer, reviewer and smoke worker: 42 subagents in total, all run in the foreground (`run_in_background: false`) |
| Invocation | `/prime-directive "Trial run A2-cy-claude: follow docs/reports/harness-evals/trial/missions/A2-cy-claude.md exactly"`. The slash command was recognised, so this was not a natural-language skill call. |
| Permission mode | unattended (Auto) as configured before the first message |
| Human approvals during the run | 0 |
| Harness versions | Chroxy daemon 0.11.4 (`/health` on the hosting daemon); codex-cli 0.163.0; Node 22.23.2 for all server work |
| Base | `trial/a2-cy-claude` @ `932bd3a4` (T0); every PR targeted and squash-merged into it |

## Queue

| Issue | PR | Opened (UTC) | Merged (UTC) | CI workflow runs | Review rounds | Merge SHA | Status |
|---|---|---|---|---|---|---|---|
| 8233 — doctor ignores the configured port | 8651 | 16:11:25 | 17:19:41 | 7 | 3 (full + 2 delta) | `d1cbafd3` | merged |
| 8215 — `::ffff:7f` prefix accepts non-loopback | 8648 | 16:10:10 | 17:19:34 | 4 | 2 (full + delta) | `7241b459` | merged |
| 7771 — `updateContextWindow` admits NaN | 8652 | 16:11:44 | 17:04:22 | 2 | 2 (full + delta) | `0d565e10` | merged |
| 8595 — collision labels repeat pinned descriptors | 8649 | 16:10:18 | 17:04:17 | 3 | 1 | `07dc9d67` | merged |
| 8364 — app lone tool bubble / detail modal terminated state | 8653 | 16:22:56 | 17:26:32 | 3 | 1 | `22c14da2` | merged (see note 1) |
| 8282 — record the stream kind on history entries | 8657 | 16:38:58 | 17:55:05 | 3 | 1 | `72c4e6b9` | merged (see note 2) |
| 8277 — Settings dormant provider override + migration notice | 8655 | 16:28:23 | 17:39:26 | 2 | 2 (full + delta) | `3854587e` | merged |
| 8567 — `DEFAULT_BYPASS_CATEGORIES` hand-copied | 8654 | 16:28:09 | 17:19:47 | 1 | 1 | `48fc9ca9` | merged |
| 8303 — Browse vs Create allowlists | 8656 | 16:33:43 | 18:01:18 | 5 | 5 (full + 4 delta) | `b23c2db8` | merged |
| 7815 — doctor test hardcodes 59123 | 8650 | 16:11:14 | 16:57:50 | 3 | 1 | `80ace565` | merged |

"CI workflow runs" counts `ci.yml` runs on the PR branch (`gh run list --branch`). It includes re-runs of failed jobs.

Every PR got an independent reviewer subagent separate from its implementer, plus Copilot's automatic review, and has a `/full-review` summary comment that records dispositions. Every PR in the smoke scope was smoked on its final head against an isolated preview daemon (own `CHROXY_CONFIG_DIR`, loopback, tunnel none, never 8765/3131/8080/3000). Smoke evidence is in the private vault, and each PR body or comment carries the step table. Out-of-scope PRs (8648, 8650, 8651, 8652, 8657) record `smoke: not applicable`.

**Note 1 (8364 / PR 8653).** The issue's acceptance is app component tests for the lone `ToolBubble` and `ToolDetailModal`, red without the change. That was met. The live-app smoke found that, in the current app, `ChatView` routes every `tool_use` through `groupMessages` into an `ActivityGroup` (store-core `group-messages.ts`). A lone `ToolBubble`, and the `ToolDetailModal` it opens, therefore never render in chat. The smoke verified the reachable terminated path: `ActivityGroup`, which this PR moved onto the shared helper, rendered amber in the app. The lone-bubble and modal steps are recorded as COULD-NOT-CHECK (unreachable in the app), named as the owner-reserved device check. See follow-up F6.

**Note 2 (8282 / PR 8657).** The feature was already on the base before the run, in commit 2457e54f. The implementer found nothing to implement. PR 8657 is test-only. It adds the acceptance coverage that was missing (AC2: a pre-change state file restored through `SessionManager`; AC3: persist and restore round trip), and its reviewer verified all five acceptance criteria against base code and tests. The item is delivered as "verified and covered", not as new behaviour.

## Cost

- SDK-reported total_cost_usd: n/a. The coordinator session cannot see Chroxy's cost badge, and `/cost` is not available inside the SDK session.
- For reference only, and not the SDK figure: the fleet script `usage-benchmark-row.py`, printed at 17:47Z, reported a transcript-priced lower bound of $22.64 for this session (coordinator plus 42 subagents, 9.6M weighted subagent units). That is an API-rate equivalent from transcripts, not a charge.

## Stalls, incidents, pauses, compactions

- Rate-limit pauses: none. Compactions or restarts: none. Wall-clock: about 2 hours of the 12-hour cap.
- **Incident: CI watcher outlived its slice.** At 17:27Z a foreground `timeout 230 gh pr checks --watch` call ran past the 240 s tool limit, and the harness moved it to the background, which breaks the dogfooding rule against background shells. It exited by itself about 3 minutes later (exit 0) and was not killed. Every watch after that used `timeout -s KILL 170`.
- **Flake: PR 8657 `Server Tests`.** `byok-mcp-client.test.js` was killed by SIGKILL after 64 s. That file is unrelated to a test-only PR. A failed-job re-run passed.
- **External: PR 8656 `notify` (Repo Relay).** The Discord bot could not resolve its guild member or channel permissions. It is not a code check. A re-run passed.
- **Real bug surfaced by CI: PR 8656 `Server Windows Tests`.** Browse canonicalised paths with the native realpath (which expands Windows 8.3 short names and normalises case), while the cwd policy used JS `realpathSync` for roots, `$HOME`, the config dir and Create's target. Containment therefore never matched on Windows, and the same flaw affected Create with workspace roots. The fix is one `realpathNative` helper used at every policy site, with a POSIX case-mismatch regression test. Then two Windows-sensitive tests whose own guards used the JS flavour were corrected. This cost two extra delta rounds, each with a fresh reviewer and a smoke re-drive.
- **Merge-gate hook.** `scripts/require-review-before-merge.sh` blocks a merge until a review summary comment exists on the PR. Two merge attempts were blocked because the comment had not been posted yet. The fix was to post the `/full-review` comment first and merge in a separate call. No gate was bypassed.

## Decisions (taken by the coordinator; no decision panel was needed)

1. **8233 / PR 8651, doctor port 0:** doctor matches `start` exactly. A merged null, empty or 0 port falls through to 8765, like `config.port || 8765`. Non-integer or out-of-range ports fail, because start cannot bind them either.
2. **8303 / PR 8656, one allowlist:** Browse uses Create's predicate, so an explicit `$HOME` is refused when the workspace roots exclude it. A blank or `~` Browse request lists the first configured root that passes the same check, so Browse never dead-ends. Blank-cwd Create was not changed (the issue scopes that out); a startup warning is logged instead.
3. **8303 / PR 8656, proactive note:** the New Session dialog probes the prefilled cwd through a one-shot, exact-path listener rather than the single-slot listing callback, so it cannot race path autocomplete.
4. **8282 / PR 8657:** the feature was already on the base, so the coordinator delivered test-only acceptance coverage instead of an artificial code change.
5. **8364 / PR 8653:** in-app nits (structured renderers under a terminated bubble, label placement) were deferred rather than spending another CI cycle on a CLEAN PR.

## Follow-ups not filed (rule 4)

- F1 (8650): `doctor.test.js` "passed is true when no failures" only checks consistency and never forces the all-pass case.
- F2 (8648): the zone-id form `::ffff:127.0.0.1%lo0` is no longer treated as loopback. No caller passes it today. Pin the choice with a test.
- F3 (8649): add a locked-in three-way mixed same-family/cross-family collision case, and a global label-uniqueness invariant test for `modelChoices`.
- F4 (8651): `start` with env `PORT=0` exactly: the preflight checks 8765, but `server-cli` computes `0 || parseInt("0")` and can bind an ephemeral port. This is a start-side inconsistency.
- F5 (8657): add an end-to-end round trip with a reasoning entry above the 50 KiB truncation threshold.
- F6 (8653): mobile `ToolBubble` and `ToolDetailModal` are unreachable from `ChatView`, because every tool is grouped. Either route single tools to them or delete the dead path. Also: gate web/todo structured renderers on `!termination`; fix the "Result (truncated)" label placement when terminated; `hasResult` differs for images-only results. The app smoke also showed "Claude is thinking" persisting next to a stopped turn, and replayed history in an odd order.
- F7 (8654): re-wrap the long doc-comment line in `app/.../settings/constants.ts`. The roster test reads the built protocol dist, so a src-only edit is caught only by the dist-drift guard.
- F8 (8656): add a reset helper for the probe registry in tests; key probes by connection; normalise trailing backslashes (shared with the modal helper, which is duplicated); on POSIX the loosened unresolvable-path regex no longer pins that branch specifically.
- F9 (smoke observation, unrelated to the queue): the model picker shows descriptor-heavy labels for built-ins, such as `Sonnet 5.5 (pinned 5.5) (default)` and two `Haiku 4.5 (pinned …)` rows.
- F10 (process): workers' bare `npx eslint` prints an ESLint migration message and checks nothing. Use `npm run lint -w packages/server`.

## Isolation self-report (rule 5)

None. No other `trial/*` branch, or PR based on one, was read, fetched, diffed or listed. In the vault, the run wrote only its own smoke evidence (`smoke/chroxy-pr<N>-<head7>/`) and read nothing: no sealed-key folder, no `KEY.md` or `KEY.md.enc`, no `NEXT-*.md` seed, no trial brief. The machine-global instructions loaded at session start reference a private coordination note. It was not opened. Smoke workers noticed scratch directories from other sessions (`~/chroxy-smoke.B2-…`, `/tmp/chroxy-smoke-driver-deploy-*`, `/tmp/chroxy-smoke-mutations.py`). They left them alone and did not read them.
