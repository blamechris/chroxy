# Minimalist's Audit: xterm-bundle.generated.ts Git Strategy

**Agent**: Minimalist -- Ruthless engineer who believes the best code is no code
**Overall Rating**: 5/5 (Gitignore) vs 3/5 (Commit)
**Date**: 2026-02-11

## Core Question

Is the file a build artifact or source code? It is deterministically derived from `node_modules` contents by a 40-line script that runs automatically on install. **It is a build artifact. Treat it like one.**

## Option Comparison

| Option | Simplicity | Correctness | Maintenance |
|--------|:-:|:-:|:-:|
| Committed | 3/5 | 5/5 | 2/5 |
| Gitignored + postinstall | 5/5 | 5/5 | 5/5 |
| Manual vendor copy | 2/5 | 4/5 | 1/5 |
| Metro custom transformer | 1/5 | 4/5 | 2/5 |

## Alternative Approaches Evaluated

All alternatives (manual vendoring, Metro plugins, Expo assets) are strictly worse. The 40-line postinstall script is already the minimal correct approach.

## Key Findings

1. **Gitignore it** -- one line in `.gitignore`, one `git rm --cached`. Done.
2. **The generation script is correct** -- 40 lines, derives from source of truth, runs automatically
3. **No CI changes needed** -- verified in `ci.yml`, `npm ci` triggers workspace postinstall
4. **The escape function is minimal** -- three replacements for three metacharacters, nothing to cut
5. **No alternative is simpler** -- this is already the 80/20 solution

## Verdict

The file is a build artifact. Add one line to `.gitignore`. No other changes needed. The postinstall hook handles everything.
