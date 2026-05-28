# /decompose-issue

Break a single GitHub issue that is too large into 2-5 independently implementable sub-issues. This is the **manual triage** counterpart to the auto-decomposition baked into `/autonomous-dev-flow` and `/parallel-dev` — use it when a human reads an issue and decides it needs splitting before any implementation runs.

The skill always pauses for user confirmation of the proposed breakdown before creating any sub-issues.

## Arguments

- `$ARGUMENTS` - Issue number (required). Accepts `#15` or `15`. Optionally followed by flags:
  - `--force` — Skip the "this looks implementable as-is" early-out and decompose anyway.
  - `--label NAME` — Additional label applied to every sub-issue (repeatable).

Examples:

```
/decompose-issue #15
/decompose-issue 15 --force
/decompose-issue #42 --label area:auth
```

## Instructions

### 1. Parse Arguments and Read the Parent

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
PARENT_NUM=$(echo "$ARGUMENTS" | grep -oE '[0-9]+' | head -1)

if [ -z "$PARENT_NUM" ]; then
  echo "Error: issue number required, e.g. /decompose-issue #15"
  exit 1
fi

# Fetch the full parent context
gh issue view "$PARENT_NUM" --json number,title,state,labels,body,comments,assignees
```

Confirm the issue exists and is open. If closed, ask the user whether to reopen before continuing — decomposing a closed issue is almost always wrong.

### 2. Prior-Decomposition Guard

Scan the parent's comments for an existing "Decomposed into" comment from a previous run (manual or auto):

```bash
gh issue view "$PARENT_NUM" --json comments \
  | jq -r '.comments[].body' \
  | grep -E 'Decomposed into #[0-9]+' || true
```

If a prior decomposition exists:

1. Extract the sub-issue numbers from the comment.
2. Look up each sub-issue's state (`open` / `closed`) and any linked PR.
3. Report the existing breakdown to the user — **do not create new sub-issues**.
4. Exit unless the user explicitly says "decompose again" (rare; usually means the prior split was wrong).

### 3. Assess Complexity (early-out)

Before proposing a breakdown, decide whether the issue actually needs decomposing. Read the body and consider:

- **Single-file, single-behavior change** → likely implementable as-is.
- **Acceptance criteria is one checkbox or a tight cluster** → likely implementable as-is.
- **Body explicitly enumerates multiple independent deliverables** → good decomposition candidate.
- **Touches several subsystems / multiple test surfaces / cross-cutting concerns** → good decomposition candidate.
- **No acceptance criteria at all** → needs requirements before it can be decomposed (recommend the user fill in criteria first).

If the issue looks implementable as-is and `--force` was not passed, output a brief explanation and exit:

```markdown
## #${PARENT_NUM} looks implementable as-is

**Why:** [single-file change / tight acceptance criteria / etc.]

If you still want to break it up, re-run with `--force`.
```

Stop here. Do not create sub-issues.

### 4. Explore Scope and Propose Sub-Issues

Read the parent body, then explore the codebase enough to understand the work:

- Grep for files / symbols the issue names.
- Read `CLAUDE.md` for project conventions if not already in context.
- Identify the natural seams — places where the work splits into independently shippable pieces (different files, different test surfaces, different acceptance criteria).

Propose **2-5 sub-issues**. Each sub-issue must be:

- **Independently implementable** — a separate PR could merge it without the others.
- **Low or medium complexity** — if any sub-issue is still high-complexity, split further.
- **Tied to specific acceptance criteria** — vague sub-issues defeat the point.

Present the proposed breakdown to the user as a table and wait for confirmation:

```markdown
## Proposed decomposition of #${PARENT_NUM} — ${PARENT_TITLE}

| # | Proposed Title | Scope | Complexity |
|---|----------------|-------|------------|
| 1 | type(scope): … | Files: src/a.ts, src/b.ts | low |
| 2 | type(scope): … | Files: src/c.ts; new test surface | medium |
| 3 | type(scope): … | Migration + backfill | medium |

**Labels each sub-issue will receive:** enhancement, parent:#${PARENT_NUM}

Approve to create these 3 sub-issues, or reply with changes (e.g. "merge 1 and 2", "drop 3", "add a sub-issue for X").
```

**This is the only confirmation point.** Wait for the user. If they request changes, revise the table and confirm again before creating.

### 5. Create Sub-Issues

After approval, create each sub-issue. Mirror the body template used by `/autonomous-dev-flow` so downstream skills can consume them consistently:

```bash
for SUB in "${PROPOSED_SUBS[@]}"; do
  SUB_URL=$(gh issue create \
    --title "${SUB_TITLE}" \
    --label "${SUB_LABELS}" \
    --body "$(cat <<EOF
## Summary

${SUB_DESCRIPTION}

Part of #${PARENT_NUM}

## Implementation Plan

- Files to modify: \`${SUB_FILES}\`
- Test strategy: ${SUB_TEST_STRATEGY}
- Approach: ${SUB_APPROACH}

## Acceptance Criteria

- [ ] ${SUB_CRITERION_1}
- [ ] ${SUB_CRITERION_2}
EOF
)")
  SUB_NUM=$(echo "$SUB_URL" | grep -oE '[0-9]+$')
  CREATED_NUMS+=("$SUB_NUM")
done
```

Label set for each sub-issue:

```bash
# Default labels: enhancement, plus from-review if parent has it
SUB_LABELS="enhancement"
if gh issue view "$PARENT_NUM" --json labels -q '.labels[].name' | grep -q '^from-review$'; then
  SUB_LABELS="$SUB_LABELS,from-review"
fi

# Add any --label flags the user passed
for extra in "${EXTRA_LABELS[@]}"; do
  SUB_LABELS="$SUB_LABELS,$extra"
done
```

**Verify labels exist** before applying them. Skip any that don't exist in the repo rather than failing:

```bash
EXISTING_LABELS=$(gh label list --json name -q '.[].name')
# Filter SUB_LABELS to only those in EXISTING_LABELS
```

### 6. Comment on Parent and Cross-Link

After all sub-issues are created, comment on the parent with the canonical "Decomposed into" line so future runs of this skill and `/autonomous-dev-flow`'s prior-decomposition guard both detect it:

```bash
SUB_LIST=$(printf '#%s, ' "${CREATED_NUMS[@]}" | sed 's/, $//')

gh issue comment "$PARENT_NUM" --body "$(cat <<EOF
Decomposed into ${SUB_LIST} — each independently implementable.

Parent stays open until all sub-issues merge.
EOF
)"
```

**Do NOT close the parent.** It stays open until every sub-issue is merged, so the broader scope remains tracked.

### 7. Report to User

Output a summary table as the primary result:

```markdown
## Decomposed #${PARENT_NUM} — ${PARENT_TITLE}

| Sub-issue | Title | Labels |
|-----------|-------|--------|
| #${SUB_1} | … | enhancement |
| #${SUB_2} | … | enhancement |
| #${SUB_3} | … | enhancement |

**Parent:** #${PARENT_NUM} (stays open)
**Comment posted on parent:** ✓

Next: `/autonomous-dev-flow #${SUB_1} #${SUB_2} #${SUB_3}` to implement them, or pick them up manually.
```

## Critical Rules

1. **Confirmation gate is mandatory.** Never create sub-issues without explicit user approval of the proposed breakdown. This is the difference between this skill and the inline decomposition in `/autonomous-dev-flow` (which runs unattended).
2. **Parent stays open.** Do not close the parent — it tracks the broader scope until all sub-issues merge.
3. **Don't re-decompose.** If a prior "Decomposed into" comment exists, report the existing sub-issues and exit. Only re-decompose on explicit user request.
4. **Each sub-issue must be independently implementable.** A separate PR could ship it. If a sub-issue depends on another sub-issue's code, you split wrong — re-think the seams.
5. **Cross-link both directions.** Every sub-issue body says "Part of #N". The parent gets a single "Decomposed into #A, #B, #C" comment.
6. **2-5 sub-issues.** Fewer than 2 means the parent wasn't actually too complex (recommend `--force` exit instead). More than 5 means the work is unbounded and probably needs a design doc, not decomposition.
7. **Respect labels that don't exist.** Skip missing labels gracefully — don't fail the run because the repo doesn't use `complexity:*`.
8. **NO attribution.** Follow the project's attribution policy. No "Generated with Claude" / `Co-Authored-By` lines in issue bodies or comments.

## When NOT to use this skill

- The parent has no acceptance criteria → fix the criteria first; you can't split work that isn't defined.
- The parent describes a single atomic operation (a migration, a one-line config change, a single test) → it doesn't decompose, it just gets done.
- The parent already has a "Decomposed into" comment → use the existing sub-issues unless they're wrong.
- The work spans multiple repos → that's a coordination problem, not a decomposition problem. Open issues in each repo separately.
<!-- skill-templates: decompose-issue 9652481 2026-05-27 -->
