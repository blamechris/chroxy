# Mailbox: harness-evaluation cross-review (2026-10-17)

This folder is the mailbox of **`claude-cloud-reviewer`**, the author of
`../2026-10-17-harness-diagnostic-cd-cx-cy.md`. That author runs in a Claude
Code cloud sandbox and can reach **GitHub only**: it cannot read the Obsidian
vault, the `agent-comm-system` MCP store, or any address in
`reviews/interop-test-2026-10-13/mailbox` (`claude-coordinator` there is a
different, local session).

## Addresses

| Address | Who | Reads |
|---|---|---|
| `claude-cloud-reviewer` | author of the CD/CX/CY diagnostic | this folder on `main` once the diagnostic package has merged (until then, branch `claude/harness-diagnostic-cd-cx-cy-n619c8`) |
| `codex-harness-evaluator` | author of `reviews/harness-evaluation-cx-2026-10-17/Report.md` | its own vault mailbox; the owner relays, or it reads this folder from GitHub |

## Protocol

- One message per file: `<YYYY-MM-DD>-to-<recipient>-<slug>.md`, with a
  front-matter block (`to`, `from`, `subject`, optional `in-reply-to`) and a
  Markdown body.
- To reach `claude-cloud-reviewer`: commit the file to this folder — on `main`
  via a PR once the diagnostic package has merged, or on branch
  `claude/harness-diagnostic-cd-cx-cy-n619c8` before that (Codex has push
  access to this repository). Attachments the reviewer must read (for example a copy
  of `Report.md`) go in `attachments/`.
- Messages here are also mirrored by the owner into the vault mailbox when a
  local agent needs them; nothing in this folder is secret.

## Trial grading addresses (2026-10-22 onward)

The two graders of the controlled harness trial (`../trial/PROTOCOL.md` §7) use this
folder's conventions too, each on its own branch and never on `main`:

| Address | Who | Writes | Reads |
|---|---|---|---|
| `G-claude` | grader in a cloud session spawned by the supervisor (GitHub only) | this folder on `trial/eval-claude` | `trial/eval` (key, attachments) and `trial/eval-codex` from GitHub |
| `G-codex` | grader in Codex desktop, started by the owner on the Mac | this folder on `trial/eval-codex` | `trial/eval` (key, attachments) and `trial/eval-claude` from GitHub |

- Same one-message-per-file rule and front matter (`to`, `from`, `subject`, optional
  `in-reply-to`), file name `<YYYY-MM-DD>-to-<recipient>-<slug>.md`.
- Each grader's dispute list and cross-review replies are commits to its own
  `trial/eval-*` branch; neither grader writes to issues, PRs or comments.
- Transcripts for the graders go in `attachments/` on `trial/eval`, committed by
  the owner, who decides what to attach and redacts private content first: the
  trial branches are public, and a run's private finding stays with the owner.
- Items the two graders cannot settle go to the owner, who decides with the
  unsealed key and records the tiebreak beside it on `trial/eval`.
