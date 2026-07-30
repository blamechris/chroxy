# /session-lifecycle

The session bookends, codified — one skill that makes every repo start, run, and end sessions the same way. It bundles the Resume protocol (session start), the during-session reporting conventions, the end-of-session checklist, and the follow-on protocol into a single installable unit, composing the component skills (`/catchup`, `/learn`, `/visual-brief`, `/create-issue`) by reference. Natural-language cues like *"resume"*, *"let's start"*, *"wrap up"*, or *"close out the session"* should route here.

This skill is a **bundle head**: it does not re-implement the components, it drives them. Where a component skill is not yet installed in this repo, the install-on-miss rule applies — run `skill add <name>` first, then invoke it.

## Arguments

- `$ARGUMENTS` — optional subcommand:
  - `start` — run the session-start (Resume) protocol only.
  - `end` — run the end-of-session checklist only.
  - *(empty)* — infer from context: fresh session with no work done yet → `start`; work shipped and the user is wrapping up → `end`; otherwise ask which bookend is meant.

## Instructions

### Session start — the Resume protocol

Run these in order; each step re-derives state rather than trusting memory:

1. **Conventions** — read `CLAUDE.md` (project root). If the repo has none, note it and continue.
2. **Working tree** — `git status && git log --oneline -5`. Name anything dirty; never assume a clean tree.
3. **Open PRs, split by author** — the split matters so external contributions aren't lost before autonomous work starts:
   ```bash
   gh pr list --state open --author "@me"
   gh pr list --state open --search "-author:@me"
   ```
4. **Skill drift** — run `/skill outdated` and report any drifted skills (fix now only if the session will use them).
5. **Prior-session state** — if a handoff note, session ledger, or queue file exists (no handoff-note/session-ledger convention exists in this repo yet — for a marathon session use `autonomous-session-<date>.md` at the repo root (gitignored, never commit) per /tackle-issues and /prime-directive's convention), read the ledger's STATE header (not the full history) and the handoff TL;DR. `/catchup` is the component skill for reconstructing a prior session where installed.
6. **Verify the last claimed merge** — if the prior session's notes claim a merge, confirm it (`gh pr view <n>` reports `MERGED`) before building on it. State is re-derived, not trusted.

Then state, in one short block: branch/HEAD, dirty files, open PRs (mine/others), drifted skills, and what the session is picking up.

### During the session

- **Every user-facing message ends with a bold `**Status:**` line** — one to three lines: done / in flight / blocked-on-named-thing. This is the global reporting rule in `~/.claude/CLAUDE.md` ("End-of-message summary"); follow it from there — do not restate or fork it here. Subagents' final messages carry their own `**Status:**` line.
- **Session boundaries** — the global `~/.claude/CLAUDE.md` "Session boundaries" section governs when to end this session and restart fresh (wave boundaries, ~150K main-thread context, second compaction, work-class switches). Follow it from there.

### Session end — the checklist

Run in order; skip a step only by saying so with a reason:

1. **Convergence note** — write what shipped, what remains, and *why* each remaining item is blocked or deferred, into the closing chat message for ad-hoc sessions; `autonomous-session-<date>.md`'s STATE header for a marathon session (see /tackle-issues).
2. **Executive brief** — for a session that shipped real work (several PRs/issues, an epic), run `/visual-brief` into the vault (`$CLAUDE_BRIEF_DIR`). Skip for small sessions — say so.
3. **Capture learnings** — run `/learn` for genuinely novel lessons; "nothing novel" is a valid outcome, stated.
4. **Cleanup** — remove this session's worktrees (leave other sessions' worktrees alone), prune branches only after verifying each had a `MERGED` PR, stop dev daemons/servers started this session, restore any test-env mutations (stop any dev daemons started this session (`npx chroxy start`, `npx expo start`, the mock server on :9876, a booted iOS simulator) — this repo has several long-running processes that outlive a session if not stopped explicitly; no test-env files get mutated during testing).
5. **Final `**Status:**` line** — the last message ends with the short status pointing at the brief (if one was produced) and naming anything left for the user.

### Follow-on protocol (when a task completes and work remains)

The canonical rules live in `~/.claude/CLAUDE.md` under **"Follow-on protocol"** — fold-in vs file-an-issue vs comment-and-skip. Follow them from there; this skill deliberately does not duplicate the text, so the global file stays the single source of truth. The one repo-local hook: filing a scoped follow-up goes through `/create-issue` where installed.

## Component skills (the bundle)

| Component | Role | If missing |
|---|---|---|
| `/catchup` | Reconstruct prior-session state at start | `skill add catchup` |
| `/visual-brief` | End-of-session HTML executive brief | `skill add visual-brief` |
| `/learn` | Persist novel lessons at end | `skill add learn` |
| `/create-issue` | File scoped follow-on issues | `skill add create-issue` |

Installing `session-lifecycle` should be followed by installing any missing components in the same pass — the bundle head without its components is a checklist that can't execute.

<!-- skill-templates: session-lifecycle f7bc0db 2026-07-30 -->
