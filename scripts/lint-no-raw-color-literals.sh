#!/usr/bin/env bash
#
# Ratchet lint: no raw color literals in NEW styling files.
#
# Chat redesign #6389 (Phase 0 #6390). The redesign single-sources color
# through @chroxy/design-tokens → CSS vars (dashboard) / COLORS (mobile). This
# guard keeps NEW component/screen styling files token-clean: any styling file
# that is NOT in the committed baseline must contain zero hex color literals.
#
# It is deliberately a NEW-FILE ratchet, not a per-file count: the codebase has
# ~120 existing literal-heavy files (50-119 literals each) that are being
# migrated to tokens over Phases 1-3, and a count ratchet would churn the
# baseline on every edit to those files. Grandfathering the existing set and
# forcing only new files onto tokens is the non-noisy, forward-tightening guard.
#
# When a brand-new styling file legitimately needs a literal (rare), or an old
# file is fully migrated and you want to prune it, run:
#     scripts/lint-no-raw-color-literals.sh --update
# and commit the regenerated baseline.
#
# Mirrors the packages/server/scripts/lint-*.sh custom-lint pattern. Pure
# grep/comm — no deps. POSIX tools + bash process substitution (the shebang is
# bash; CI runs it under bash).

set -euo pipefail

cd "$(dirname "$0")/.."

BASELINE="scripts/no-raw-color-literals-baseline.txt"

# 3/4/6/8-digit hex color literals (#fff, #ffff, #4a9eff, #4a9eff22).
PAT='#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})'

# The recheck pass below strips comments with perl. Fail LOUD if perl is missing
# rather than letting `set -e` + the `|| true` swallow turn a perl-less runner
# into a silently-disabled guard (every candidate would be dropped → all files
# pass). perl is present on both CI runner pools; this just keeps it honest.
command -v perl >/dev/null 2>&1 || {
  echo "::error::lint-no-raw-color-literals.sh requires perl (used to strip comments before the hex re-check)"
  exit 1
}

# Styling files (components + screens) that contain at least one hex literal,
# excluding tests, generated bundles, and the xterm color assets. The color
# *sources* (dashboard src/theme, mobile src/constants/colors.ts) are out of
# scope by construction — they live outside components/screens.
collect() {
  # First pass: candidate files matching the raw pattern (a superset — includes
  # files whose only "match" is a #NNNN issue reference in a comment). Second
  # pass: re-check each candidate with COMMENTS STRIPPED, and keep only those
  # that still contain a hex literal. Real color literals live in code / CSS
  # values; #NNNN issue refs (3-4 hex digits → they trip the {3,4} branch) live
  # exclusively in // and /* */ comments — so stripping comments removes the
  # false positives without weakening the guard on actual colors (#6423).
  grep -rlE "$PAT" \
    packages/dashboard/src/components \
    packages/app/src/components \
    packages/app/src/screens \
    --include='*.ts' --include='*.tsx' --include='*.css' 2>/dev/null \
    | grep -vE '\.test\.|/__tests__/|\.generated\.|xterm|\.stories\.' \
    | while IFS= read -r f; do
        # Strip // line comments and /* */ block comments (the latter across
        # newlines, via the /s flag), then test for a remaining hex literal.
        if perl -0777 -pe 's{//[^\n]*}{}g; s{/\*.*?\*/}{}gs' "$f" 2>/dev/null | grep -Eq "$PAT"; then
          printf '%s\n' "$f"
        fi
      done \
    | LC_ALL=C sort
}

current="$(collect || true)"

if [ "${1:-}" = "--update" ]; then
  printf '%s\n' "$current" | grep -c . >/dev/null 2>&1 || true
  printf '%s\n' "$current" > "$BASELINE"
  echo "Wrote $BASELINE ($(printf '%s\n' "$current" | grep -c . || true) grandfathered files)."
  exit 0
fi

if [ ! -f "$BASELINE" ]; then
  echo "::error::missing baseline $BASELINE — run: scripts/lint-no-raw-color-literals.sh --update"
  exit 1
fi

baseline="$(LC_ALL=C sort "$BASELINE")"

# New offenders = files-with-literals not present in the baseline.
offenders="$(comm -23 <(printf '%s\n' "$current") <(printf '%s\n' "$baseline") | grep -v '^$' || true)"

if [ -n "$offenders" ]; then
  echo "::error::New styling file(s) contain raw color literals — use a design token instead"
  echo "  Dashboard: var(--token) (see packages/dashboard/src/theme) ; Mobile: COLORS.* (packages/app/src/constants/colors.ts)."
  echo "  Offending files:"
  printf '%s\n' "$offenders" | sed 's/^/    /'
  echo "  If a literal is genuinely unavoidable, run 'scripts/lint-no-raw-color-literals.sh --update' and commit the baseline."
  exit 1
fi

echo "OK — no new styling files with raw color literals ($(printf '%s\n' "$baseline" | grep -c . || true) grandfathered)."
