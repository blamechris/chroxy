#!/usr/bin/env bash
#
# Lint: no producer piped into an early-exiting `grep -q` in a script that
# enables `pipefail` (#7907).
#
# Under `set -o pipefail`, `producer | grep -q PATTERN` can report "not found"
# even when PATTERN genuinely IS present. `grep -q`/`--quiet` exits the
# instant it finds a match, without draining the rest of its stdin; if the
# producer (echo/printf/cat) is still writing when that happens, the kernel
# delivers SIGPIPE to it, and `pipefail` promotes that broken-pipe write
# error into the whole PIPELINE's exit status — even though grep itself
# matched. This was observed live: CI "Scripts Tests" on PR #7892 failed with
# `printf: write error: Broken pipe` and a FAIL for a needle that was plainly
# present in the haystack (scripts/__tests__/merge-updater-feeds.test.sh, fixed
# by #7908 alongside scripts/__tests__/bump-version.test.sh). This lint is the
# structural guard against the same shape reappearing in a PRODUCTION script —
# #7908 fixed only the two test harnesses; #7907 fixed the production sites
# this lint now watches (scripts/bump-version.sh, scripts/docker-entrypoint.sh,
# scripts/require-review-before-merge.sh — the pre-merge review gate, a false
# "not found" there SKIPS the gate — packages/desktop/scripts/verify-entitlements.sh,
# and scripts/lint-no-raw-color-literals.sh).
#
# Depending on which side of the `if`/`||`/`!` the check sits on, a flipped
# verdict fails OPEN (a guard silently skipped — the review gate and the
# bump-version changelog TODO check) or fails CLOSED (a legitimate input
# wrongly rejected — the entitlements check, the version-format check). Both
# are bugs; the fix is the same either way: give grep the data directly with
# a here-string (`grep -q PATTERN <<<"$var"`, bash 3.2 compatible) or a
# `case`/`[[ =~ ]]` match, so there is no separate writer process for a
# SIGPIPE to land on.
#
# Scope: producer is `echo`, `printf`, or `cat` — the shapes this repo's
# sites actually took (a captured shell variable re-emitted, or a file
# re-read, then piped straight into `-q`-flavored grep). This does NOT
# flag every `producer | grep -q` in the tree: `head -N file | grep -q`,
# `awk '...' file | grep -qx`, `curl -s url | grep -q`, and similar read a
# small, single-shot, or externally-sourced stream that doesn't share the
# "producer re-emits an already-fully-materialized, arbitrarily large
# variable/file across multiple writes" shape this bug needs. Widening the
# producer list to catch every pipe would not close a real gap here — see
# scripts/__tests__/bump-version.test.sh's own guard (#7908) for the same
# scoping call. A future site piping a LARGE captured variable through a
# different producer into a `-q` grep should add that producer to the PAT
# below, or use the allowlist comment if it is a reviewed, justified case
# (e.g. a small, bounded, file-backed producer that cannot race).
#
# Only files that enable `pipefail` somewhere (a `set` line mentioning it) are
# scanned for the pattern — a script that never sets pipefail can't have this
# failure mode; a piped producer|grep -q there just reports grep's own exit
# status, same as always.
#
# Full-comment lines are skipped before matching, so this file's own
# explanatory prose above, and the two test harnesses #7908 fixed (which
# quote the buggy shape as documentation in comments), are not false
# positives. A single site can be exempted with a
# `# lint-ignore-pipe-grep-q: <reason>` comment on the line immediately above
# the offending pipe, or as a trailing comment on the same line — for a
# reviewed, justified case only.
#
# Run:  bash scripts/lint-no-pipe-into-grep-q.sh
# Exit: 0 clean, 1 if any offending site is found.

set -euo pipefail

cd "$(dirname "$0")/.."

# The producer-into-grep-q shape, reused (with `cat` added as a third
# producer) from the static guard #7908 added inside
# scripts/__tests__/bump-version.test.sh and
# scripts/__tests__/merge-updater-feeds.test.sh. Matches `grep -q`, `-Eq`,
# `-qF`, `-E -q`, `--quiet`, and a pipe with no surrounding whitespace —
# verified NOT to self-match this variable's own definition line (the `|`
# characters here are regex metacharacters inside `[^|]`/`\|`, not adjacent
# to a real "echo"/"printf"/"cat" producer token the way a real offending
# line is).
PAT='(echo|printf|cat)[^|]*\|[[:space:]]*grep([[:space:]]+-[A-Za-z]+)*[[:space:]]+(-[A-Za-z]*q[A-Za-z]*|--quiet)'

IGNORE_MARKER='lint-ignore-pipe-grep-q'

# Test hook: scan a temp tree instead of the git index (see
# scripts/__tests__/lint-no-pipe-into-grep-q.test.sh) so the golden test is
# self-contained and does not depend on — or mutate — the real repo tree.
if [ -n "${LINT_PIPE_GREP_Q_SCAN_DIR:-}" ]; then
  file_list() { find "$LINT_PIPE_GREP_Q_SCAN_DIR" -type f -name '*.sh' | sort; }
else
  file_list() { git ls-files -- '*.sh'; }
fi

offenders=""
scanned=0

while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  scanned=$((scanned + 1))

  # Scope to scripts that enable pipefail SOMEWHERE (a `set` line mentioning
  # it) — matches `set -o pipefail`, `set -eo pipefail`, `set -euo pipefail`,
  # etc., wherever in the file it appears (top-level or inside a function).
  #
  # Boundary is spelled with POSIX character classes, not `\b`: `\b` is a
  # GNU/BSD extension, not POSIX ERE, so it risks silently no-matching (or
  # matching a literal backspace) under a stricter grep — which would widen
  # this guard's blind spot to EVERY pipefail-enabled script on that platform
  # (flagged in review). `(^|[^[:alnum:]_])pipefail([^[:alnum:]_]|$)` is
  # equivalent here in practice (`pipefail` can never be the first token on a
  # `set ...` line, so the `^` branch is dead weight, not a behavior change)
  # and portable.
  grep -qE '^[[:space:]]*set[[:space:]]+.*(^|[^[:alnum:]_])pipefail([^[:alnum:]_]|$)' "$f" || continue

  line_no=0
  prev_line=""
  while IFS= read -r line || [ -n "$line" ]; do
    line_no=$((line_no + 1))

    # Skip full-comment lines (leading whitespace then `#`) — this file's own
    # prose above, and #7908's harnesses, quote the buggy shape as
    # documentation, which must not be flagged as a finding.
    trimmed="${line#"${line%%[![:space:]]*}"}"
    if [[ "$trimmed" == \#* ]]; then
      prev_line="$line"
      continue
    fi

    if [[ "$line" =~ $PAT ]]; then
      if [[ "$line" == *"$IGNORE_MARKER"* || "$prev_line" == *"$IGNORE_MARKER"* ]]; then
        prev_line="$line"
        continue
      fi
      offenders="${offenders}${f}:${line_no}: ${trimmed}
"
    fi
    prev_line="$line"
  done < "$f"
done < <(file_list)

if [ "$scanned" -eq 0 ]; then
  echo "::error::lint-no-pipe-into-grep-q.sh found zero *.sh files to scan — file enumeration is broken" >&2
  exit 2
fi

if [ -n "$offenders" ]; then
  echo "::error::producer piped into an early-exiting grep -q in a pipefail-enabled script:"
  printf '%s' "$offenders" | sed 's/^/    /'
  echo ""
  echo "  Under pipefail, grep -q's early exit can SIGPIPE a still-writing producer"
  echo "  (echo/printf/cat), which pipefail promotes to the pipeline's exit status --"
  echo "  flipping a genuine match into \"not found\" (#7907). Fix: hand grep the data"
  echo "  directly with a here-string (grep -q PATTERN <<<\"\$var\") or a"
  echo "  case/[[ =~ ]] match, instead of piping a producer into it."
  echo "  Justified case? Add \"# $IGNORE_MARKER: <reason>\" on the line above (or as a"
  echo "  trailing comment on the same line)."
  exit 1
fi

echo "OK — no producer piped into grep -q in any pipefail-enabled script ($scanned *.sh files scanned)."
