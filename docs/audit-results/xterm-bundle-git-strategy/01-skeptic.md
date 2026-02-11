# Skeptic's Audit: xterm-bundle.generated.ts Git Strategy

**Agent**: Skeptic -- Cynical systems engineer who cross-references every claim against actual code
**Overall Rating**: 4/5 (Gitignore) vs 2/5 (Commit)
**Date**: 2026-02-11

## Claim Verification

### "CI already runs npm install" -- VERIFIED TRUE
`.github/workflows/ci.yml` lines 29, 53, 74: all three jobs run `npm ci` at workspace root before tests/typecheck.

### "postinstall runs automatically" -- VERIFIED TRUE (with nuance)
`packages/app/package.json` line 13 defines the hook. npm workspaces runs lifecycle scripts for workspace members during `npm ci`. However, `--ignore-scripts` would skip it.

### "290KB" -- VERIFIED TRUE
Actual: 297,223 bytes. The file is 51% of all TypeScript source in the app by byte count.

### "Fresh clones work immediately" -- TRUE only if committed
If gitignored, `xterm-html.ts` line 2 import fails until `npm install` runs. Standard for any Node.js project.

## Key Findings

1. **The generated file is 51% of app source by size** -- Every xterm bump produces unreviewable diffs
2. **CI regenerates the file on every run anyway** -- The committed copy is literally never used in CI
3. **Hardcoded version comment will drift** -- Script line 28 hardcodes `@5.5.0` instead of reading from package.json
4. **No `*.generated.*` pattern in .gitignore** -- Would need explicit entry
5. **Tests import transitively** -- Missing file causes immediate, loud failure (a feature for gitignore approach)

## Verdict

Gitignore it. The "fresh clone works immediately" argument is a red herring -- no Node.js project works without `npm install`. CI overwrites the committed copy anyway. 290KB of minified JS in diffs is unreviewable noise.
