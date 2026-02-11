# Builder's Audit: xterm-bundle.generated.ts Git Strategy

**Agent**: Builder -- Pragmatic full-stack dev focused on implementability and developer experience
**Overall Rating**: 4/5 (Commit with .gitattributes) vs 3/5 (Gitignore)
**Date**: 2026-02-11

## Analysis

### Option A: Keep Committed + `.gitattributes`
- Zero CI risk, zero ordering dependencies
- `git bisect` works perfectly -- every commit is self-contained
- Fresh clone compiles without `npm install`
- Branch switching is safe
- `.gitattributes` with `linguist-generated=true` eliminates PR diff noise on GitHub

### Option B: Gitignore
- Clean git history, no generated diffs
- File always in sync with installed packages
- `git bisect` breaks -- every checkout requires `npm install`
- Standard pattern for generated files

## Gotcha Analysis

- **postinstall fails**: Throws immediately, `npm ci` exits non-zero. Caught in CI. Not a real risk.
- **git bisect**: Strongest argument for committing. Gitignored files disappear on checkout.
- **npm ci vs npm install**: Both run postinstall. No difference.
- **Workspace hoisting**: `require.resolve` handles it. Verified packages exist at root `node_modules`.

## Key Findings

1. CI works in both scenarios -- `npm ci` triggers postinstall in all 3 workflow jobs
2. `git bisect` strongly favors keeping committed
3. 290KB is modest by generated-code standards, compresses well in packfiles
4. `.gitattributes` eliminates the main visual annoyance of committing
5. Staleness risk is mitigated by postinstall running on every `npm install`

## Verdict

Keep committed, add `.gitattributes` with `linguist-generated=true`. One line, one file. Gets clean PR diffs while preserving `git bisect` and zero-friction clones.
