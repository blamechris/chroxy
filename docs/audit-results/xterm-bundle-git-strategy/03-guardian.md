# Guardian's Audit: xterm-bundle.generated.ts Git Strategy

**Agent**: Guardian -- Paranoid security/SRE who designs for 3am pages
**Overall Rating**: 4/5 (Gitignore) vs 3/5 (Commit)
**Date**: 2026-02-11

## Failure Mode Analysis

### If Committed (Option A)
| Failure | Severity | Likelihood |
|---------|----------|------------|
| Version drift (upgrade xterm, forget regenerate) | HIGH | MEDIUM |
| Stale script masking (script breaks, nobody notices) | HIGH | MEDIUM |
| Merge conflicts on 290KB blob | MEDIUM | LOW |
| PR diff noise | LOW | CERTAIN |

### If Gitignored (Option B)
| Failure | Severity | Likelihood |
|---------|----------|------------|
| `--ignore-scripts` skips postinstall | HIGH | LOW |
| Fresh clone without `npm install` | LOW | LOW |
| postinstall fails | CAUGHT | N/A (throws, npm exits non-zero) |

## Critical Finding: Stale Script Masking

The worst failure mode is A3: if the file is committed, the generator script becomes optional. When it breaks (e.g., xterm changes internal file paths), nobody notices because the committed file keeps working. Months later, someone tries to upgrade and discovers the script hasn't worked in 3 versions. This is a classic "deferred failure" anti-pattern.

With gitignore, any script breakage is caught immediately -- the file doesn't exist, imports fail, CI fails.

## Additional Findings

1. **Escape function is robust** -- covers backslash, backtick, `${` in correct order
2. **No size sanity check** -- script could write empty strings without error
3. **Hardcoded version comment will drift** -- should read from actual package.json
4. **Supply chain risk is equivalent** for both options (exact version pinning is the real protection)
5. **No CI drift detection** -- if committed, should have a CI step to verify file matches regenerated output

## Verdict

Gitignore. Prefer systems that fail loudly and immediately over ones that accumulate hidden debt. The gitignored approach enforces an invariant (file always matches installed packages) automatically, while committed requires discipline to maintain.
