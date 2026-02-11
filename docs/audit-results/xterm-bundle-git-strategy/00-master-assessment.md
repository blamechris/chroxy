# Master Assessment: xterm-bundle.generated.ts Git Strategy

**Date**: 2026-02-11
**Aggregate Rating**: Gitignore 4.25/5 vs Commit 3.0/5
**Agents**: 4 (core panel)

## Auditor Panel

| Agent | Perspective | Gitignore Rating | Commit Rating | Key Contribution |
|-------|-------------|:--:|:--:|-----------------|
| Skeptic | Claims vs reality | 4/5 | 2/5 | Verified CI regenerates the file anyway; committed copy is never used |
| Builder | Implementability | 3/5 | 4/5 | Identified `git bisect` as strongest argument for committing; proposed `.gitattributes` mitigation |
| Guardian | Safety/failure modes | 4/5 | 3/5 | Found "stale script masking" as worst failure mode for committing |
| Minimalist | Simplicity | 5/5 | 3/5 | Confirmed postinstall script is already the minimal correct approach |

## Consensus Findings (4/4 agents agree)

### 1. CI works in both scenarios
All agents verified that `.github/workflows/ci.yml` runs `npm ci` at workspace root, which triggers `postinstall` for all workspace packages. The generated file exists before tests and typecheck run regardless of git tracking.

### 2. The postinstall approach is correct
No agent found a simpler alternative. The 40-line script deriving from `node_modules` is the right pattern. Metro plugins, manual vendoring, and Expo assets are all strictly worse.

### 3. The hardcoded version comment should be fixed
The script writes `// Source: @xterm/xterm@5.5.0` as a literal string. All agents noted this will drift on version bumps. Should read from `package.json` in `node_modules`.

## Contested Point: git bisect

**Builder** (alone) argues for committing because `git bisect` requires every checkout to be self-contained. With gitignore, you must run `npm install` at each bisect step.

**Skeptic, Guardian, Minimalist** counter that:
- `git bisect` already requires `npm install` if any dependency changed between commits
- The file didn't exist before this PR, so bisecting across the boundary breaks anyway
- This is a standard trade-off that every project with generated files accepts

**Assessment**: Builder raises a valid point, but the practical impact is low. `git bisect run` can include `npm ci` as a setup step. The other three agents are right that this is standard practice.

## Factual Corrections

| Claim | Agent | Correction |
|-------|-------|------------|
| "290KB" | Skeptic | Actual: 297,223 bytes (297KB). Close enough. |
| "npm ci doesn't run postinstall" | (preemptive) | All agents verified: `npm ci` DOES run lifecycle scripts since npm 7+ |

## Risk Heatmap

```
Impact
  HIGH  | [A3 stale script] .  .  .  .  [B3 --ignore-scripts]
        |
  MED   | [A1 version drift] .  .  .  .  .  .  .  .  .  .
        |
  LOW   | [A4 diff noise]  .  [B5 fresh clone]  .  .  .  .
        +--------------------------------------------------
          LOW              MEDIUM              HIGH
                        Likelihood
```

A3 (stale script masking) is high-impact/medium-likelihood -- the worst risk in the entire analysis.
B3 (`--ignore-scripts`) is high-impact but very low likelihood in this project.

## Recommended Action

**Gitignore the file.** The consensus is 3-1 in favor.

Concrete steps:
1. Add `packages/app/src/components/xterm-bundle.generated.ts` to `.gitignore`
2. `git rm --cached packages/app/src/components/xterm-bundle.generated.ts`
3. Add `.gitattributes` with `linguist-generated=true` (useful if the decision is ever reversed)
4. Fix hardcoded version comment in `bundle-xterm.js` to read from `node_modules`

## Final Verdict

**Aggregate: Gitignore wins 4.25/5 vs 3.0/5.**

The file is a deterministic build artifact derived from committed inputs (`package.json`, `package-lock.json`, `bundle-xterm.js`). The postinstall hook guarantees it exists whenever `node_modules` exists. CI already regenerates it on every run. Committing it creates a false sense of safety while enabling the worst failure mode identified (stale script masking -- Guardian's Finding 1). Gitignoring it enforces the invariant that the file always matches installed packages, with all failures being loud and immediate. The one legitimate counter-argument (`git bisect`) affects a narrow workflow and has standard mitigations.

## Appendix

| Report | File |
|--------|------|
| Skeptic | [01-skeptic.md](01-skeptic.md) |
| Builder | [02-builder.md](02-builder.md) |
| Guardian | [03-guardian.md](03-guardian.md) |
| Minimalist | [04-minimalist.md](04-minimalist.md) |
