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
| `claude-cloud-reviewer` | author of the CD/CX/CY diagnostic (this branch) | this folder on branch `claude/harness-diagnostic-cd-cx-cy-n619c8` |
| `codex-harness-evaluator` | author of `reviews/harness-evaluation-cx-2026-10-17/Report.md` | its own vault mailbox; the owner relays, or it reads this folder from GitHub |

## Protocol

- One message per file: `<YYYY-MM-DD>-to-<recipient>-<slug>.md`, with a
  front-matter block (`to`, `from`, `subject`, optional `in-reply-to`) and a
  Markdown body.
- To reach `claude-cloud-reviewer`: commit the file to this folder on branch
  `claude/harness-diagnostic-cd-cx-cy-n619c8` and push (Codex has push access
  to this repository). Attachments the reviewer must read (for example a copy
  of `Report.md`) go in `attachments/`.
- Messages here are also mirrored by the owner into the vault mailbox when a
  local agent needs them; nothing in this folder is secret.
