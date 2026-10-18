# Dry runs — results and what they changed

Three dry runs on 2026-10-18, one per harness that had never run the
prime-directive under trial rules, each on a synthetic one-file task against its
own `trial/dry-*` base (missions in `missions/dry/`). All three delivered the
task through the full merge gate and wrote a run report. Two of three failed the
isolation rule as it was then written, in the same way, and that changed the
rule.

| Dry run | Harness | Coordinator | Workers observed | PING PR → merged | Report PR → merged | Invocation | Isolation |
|---|---|---|---|---|---|---|---|
| `dry-cy-claude` | Chroxy, claude-sdk | Sonnet 5.5 (dashboard default; mission said Opus 5.5) | one `sonnet` review subagent | 8616 → 00:14Z | 8621 → 00:30Z | `/prime-directive` expanded natively | clean |
| `dry-cy-codex` | Chroxy, codex app-server | gpt-6-astra / xhigh | `gpt-5.6-luna` low, `gpt-5.6-sol` medium | 8617 → 00:21Z | 8622 → 00:38Z | `/prompts:` not expanded; read the compiled skill file itself | violated: startup read of `coordination/Core Goal.md`, self-reported |
| `dry-cx` | Codex desktop | gpt-6-astra / xhigh | `gpt-6.1-sol` low and medium | 8620 → 00:26Z | 8623 → 00:41Z | `/prompts:` expansion unverified; read the prompt file itself | violated: same startup read, self-reported |

First commands were 00:00:52Z, 00:08:47Z and 00:10:32Z respectively; every run
finished inside its 45-minute cap, report included.

## Findings

1. **The vault ban was too broad.** Both Codex harnesses read
   `~/Obsidian/no-it-all/coordination/Core Goal.md` at startup because a
   machine-level instruction asks for it before planning; both then read the
   mission, read nothing further from the vault, finished the task, and
   self-reported. Neither touched the key. The Chroxy
   Codex run also suppressed its normal vault writes (usage ledger, brief,
   handoff seed) to obey the ban, which changes the harness under test. The
   rule now bans only the key's folder, the key files, and reading or resuming
   from another run's handoff seed or brief (PROTOCOL §4 rule 4, mission rule 5).
2. **Chroxy has no unattended mode for Codex sessions** (#8619). The dry run
   needed more than forty human approvals in Accept Edits mode for a one-file
   change; the same task in the Codex desktop app needed none. Permission mode is
   now an explicit control (PROTOCOL §3), and run 2 is blocked on the fix.
3. **Worker tiers differ across arm B.** Codex desktop delegated to
   `gpt-6.1-sol`; Chroxy's Codex session delegated to `gpt-5.6-luna` and
   `gpt-5.6-sol`, because the older codex binary on PATH cannot use `gpt-6.1-sol`
   on a ChatGPT login (#8609). The PATH binary is upgraded before run 2 and both
   versions are recorded (PROTOCOL §3, Versions).
4. **`/prompts:prime-directive` did not expand in either Codex harness.** Each
   recovered by reading the directive text itself: the Codex desktop run read
   `~/.codex/prompts/prime-directive.md`, the Chroxy Codex run read the compiled
   `.claude/skills/prime-directive/SKILL.md`, and both verified the two files
   byte-identical. The Codex missions now state that fallback.
5. **The Chroxy default model is Sonnet 5.5**, so the Claude dry run ran on it;
   the Chroxy missions now say to confirm model and effort in the header before
   the first message.
6. **GitHub's squash subject appends the PR number**, which the `#N` rule read
   as a violation; the rule now says issue numbers.
7. **Chroxy's cost badge is the SDK's `total_cost_usd`**, an API-rate equivalent
   shown beside "Included (subscription)" (#8624). The cost measure is now
   labelled accordingly.
8. **The pre-merge hook** `scripts/require-review-before-merge.sh` requires a PR
   comment matching its keyword pattern; the Claude dry run posted one. Known and
   documented in the script's header; no change.
9. Issues filed from the dry runs: #8618 (header clipping), #8619 (no unattended
   Codex mode), #8624 (cost badge derivation). #8611 already covered the New
   Session modal.

## State after the dry runs

The three `trial/dry-*` branches keep their PING and report commits as evidence
for the trial report. The four real bases are re-cut from the merge commit of
the PR that landed this file, so the clones carry the corrected rules.
