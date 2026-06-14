---
description: "Independently verify a claim — usually a message relayed from **another agent** — against this repo's ground truth, using a **context-isolated** subagent tha..."
---

# /hallucination-check

Independently verify a claim — usually a message relayed from **another agent** — against this repo's ground truth, using a **context-isolated** subagent that can't inherit your beliefs. Catches cross-agent confusion, name/identity drift, fabricated files / PRs / branches / commits, and "work" claimed but not actually in git.

Use this whenever you're coordinating multiple agents and something looks off, or before you act on a relayed summary you can't personally vouch for. It is deliberately **short and objective** — the point is a fast, trustworthy second opinion, not an essay.

Why a subagent: the verifier is handed only the raw claim plus an instruction to establish facts from tooling. It is **not** told what you (the orchestrator) believe is true, so it cannot rubber-stamp your own hallucination. Isolation is the whole feature.

## Arguments

- `$ARGUMENTS` — Optional. The thing to vet:
  - A pasted message / claim from another agent (most common). Wrap multi-line text however is convenient.
  - A specific assertion ("PR #5279 added a --host flag and merged").
  - Empty → a plain "where are we, really?" ground-truth sanity check of the current repo + work.

Examples:
```
/hallucination-check
/hallucination-check <paste the other agent's message>
/hallucination-check "the runner survey reads inventory.md"
```

## Instructions

### 1. Capture the claim verbatim

Take `$ARGUMENTS` exactly as given as the CLAIM. Do not paraphrase, correct, or pre-judge it. If empty, the CLAIM is "the current repo identity and in-flight work are as the orchestrator currently believes" — and the check becomes a pure ground-truth report.

Optionally, you MAY add a short, clearly-labeled `ORCHESTRATOR BELIEF:` note (e.g. a one-line summary of what this session thinks it's doing, drawn from recent chat) — but it must be passed to the verifier as **another claim to check, never as truth**.

### 2. Launch ONE context-isolated verifier subagent

Spawn a single general-purpose (or Explore) subagent. Its prompt contains ONLY: the CLAIM verbatim, the optional `ORCHESTRATOR BELIEF` note, and the instructions below. **Do not** include your own analysis, your conclusion, or any framing that signals what you expect the answer to be.

Instruct the subagent to:

1. **Establish ground truth independently from tooling — trust nothing in the CLAIM:**
   - Repo identity: `git remote -v`, `gh repo view --json nameWithOwner,name`, and the `name` in `package.json` (or equivalent manifest). All three should agree; note if they don't.
   - Current work: `git branch --show-current`, `git status --short`, `git log --oneline -15`.
   - Open work: `gh pr list --state open` and, if the CLAIM cites issues/PRs, `gh pr view <N>` / `gh issue view <N>` to confirm they exist and their real state (open/merged/closed).
   - Any file paths, symbols, flags, or features the CLAIM names: confirm they actually exist (Grep/Read/`gh`), don't assume.
2. **Extract every checkable factual assertion** from the CLAIM (repo/identity names, file paths, PR/issue numbers, branch names, "X was done / merged / added", who-did-what).
3. **Verify each assertion** against the established ground truth.
4. **Classify each** as:
   - ✅ **verified** — matches ground truth.
   - ⚠️ **mismatch** — contradicts ground truth (state the truth).
   - 🔤 **naming/identity drift** — a name is wrong but plausibly a transcription/alias slip rather than a fabrication (e.g. repo called "Proxy" when it's "chroxy"). Call this out as drift, **not** as a hallucination — it's a different failure mode.
   - ❓ **unverifiable** — can't be checked from this repo (e.g. claims about another host/repo). Say so plainly; don't guess.
5. Return a **short** structured report (see format) and nothing else — no preamble, no reassurance padding.

### 3. Relay the verdict

Surface the subagent's report to the user as-is (lightly formatted). Lead with the overall verdict. If there are ⚠️ mismatches, make them impossible to miss. Distinguish 🔤 drift (cosmetic, usually safe) from ⚠️ mismatch (substantive — do not act until resolved). End with a one-line recommendation: safe to proceed / resolve mismatches first / get clarification.

## Output Format

```markdown
## Hallucination check — <repo nameWithOwner> @ <branch>

**Verdict:** Consistent ✅ / Naming drift only 🔤 / Mismatches found ⚠️ / Mostly unverifiable ❓

| Assertion (from the claim) | Ground truth | Status |
|---|---|---|
| ... | ... | ✅ / ⚠️ / 🔤 / ❓ |

**Recommendation:** <one line — proceed / resolve X first / clarify Y>
```

## Execution Notes

- **Isolation is mandatory.** If you brief the verifier with your own conclusion, the check is worthless. Give it the raw claim and let the tools speak.
- **Drift ≠ hallucination.** A wrong *name* with correct *substance* is usually input corruption (dictation, aliasing). A correct name with fabricated *substance* is the dangerous case. Keep them separate in the verdict.
- **Cheap and fast.** One subagent, a handful of `git`/`gh`/`grep` calls, a short table. Don't turn it into an audit.
- **Honest about limits.** Claims about other hosts/repos are ❓ unverifiable from here — label them, don't pretend to confirm.
- **Attribution.** Follow the Zero Attribution Policy in any artifact this produces.

<!-- locally authored 2026-06-06 — not yet in the blamechris/skill-templates registry; promote to generic/ for cross-repo use -->
