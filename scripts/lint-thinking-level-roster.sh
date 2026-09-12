#!/usr/bin/env bash
#
# Lint: exactly ONE literal roster of thinking / reasoning levels in the repo (#7730).
#
# The vocabulary `default | high | max` was frozen into SIX independent sites —
# a Zod enum, a store-core Set that silently COERCED anything else to
# 'default', a dashboard union type, the server-side gate, and two TS casts.
# Every one of them was written when Claude was the only provider with a
# reasoning control, and every one of them was wrong the moment codex shipped
# `supportedReasoningEfforts` PER MODEL (six values in the wild already — low,
# medium, high, xhigh, max, ultra — with the set differing per model and moving
# with releases).
#
# "A hardcoded list beside a set that grows" is cause #1 in
# docs/false-safety-guards.md, and the reason it keeps happening is that each
# copy looks harmless on its own: the sixth site was found by a completeness
# critic, not by any test, lint or review of the five. So the invariant is not
# "the list is correct" (it cannot be — it is per-model) but "there is only ONE
# literal list, and it is the documented LEGACY FALLBACK".
#
# That one list is LEGACY_THINKING_LEVELS in
# packages/protocol/src/thinking-levels.ts, which every other layer imports:
# the wire schema, the server gate, store-core and both clients.
#
# WHAT IT MATCHES: two or more adjacent quoted level words joined by `,` or `|`
# — i.e. an array literal, a Zod enum, a Set constructor or a TS union of
# levels. Matching a run (rather than a single word) is what keeps `'default'`
# as an ordinary fallback value legal, which it has to be: `level || 'default'`
# appears in several places and is not a roster.
#
# SCOPE: tracked, non-test source. Tests are deliberately OUT, and the reason is
# not convenience — a test that checks the accepted levels must be free to write
# `['default','high','max']` by hand. Deriving that expectation from the
# constant under test is #7424 exactly: a parity test whose expectation comes
# from its own subject cannot go red. Excluding tests here is what lets the
# tests be real.
#
# WHAT IT DOES NOT MATCH, stated rather than implied — a guard whose comment
# claims a stronger check than its code performs is its own defect class
# (catalogue entries #7290/#7291):
#   - An object literal with UNQUOTED keys, e.g. SdkSession.THINKING_BUDGETS
#     (`{ default: null, high: 32000, max: 128000 }`). That one is deliberate
#     and legal: it is the Claude provider's level -> token-budget LOOKUP, read
#     with a `?? null` fallback, not a membership decision. A future roster
#     hidden in unquoted keys would slip past this lint.
#   - Prose in comments is NOT exempt, and that is on purpose — a doc line
#     spelling the three levels out is a copy of the roster that goes stale
#     silently (two such lines were found when this lint was first run).
#
# FAIL-CLOSED: the scan asserts it walked at least --min-files files. A filter
# that matches nothing reports "no second roster" for the same reason a clean
# repo does (#7503), and this guard's whole value is in the files it reaches.
#
# Pure bash + perl — no deps, no node. CI runs it under bash in the bash-lint job.
#
# Run:  bash scripts/lint-thinking-level-roster.sh
# Exit: 0 clean, 1 on a second roster or on a scan that could not run.

set -euo pipefail

cd "$(dirname "$0")/.."

command -v perl >/dev/null 2>&1 || {
  echo "::error::lint-thinking-level-roster.sh requires perl"
  exit 1
}

# Floor on the number of files the scan must actually open. Well below today's
# count (~1,100 non-test source files) so ordinary churn never trips it, and far
# above zero so a broken path filter fails LOUDLY instead of passing vacuously.
MIN_FILES="${LINT_THINKING_MIN_FILES:-300}"

# The one file allowed to carry the literal roster: the module every other layer
# imports it from. A second entry here is a decision to have two rosters, which
# is the thing this lint exists to prevent — do not add one without an issue.
ALLOW='packages/protocol/src/thinking-levels.ts'

if [ -n "${LINT_THINKING_SCAN_DIR:-}" ]; then
  # Test hook: scan a temp tree instead of the git index (see
  # scripts/__tests__/lint-thinking-level-roster.test.sh). The min-files floor
  # is overridden by the harness, which scans a handful of fixtures.
  file_list() { find "$LINT_THINKING_SCAN_DIR" -type f -print0; }
else
  file_list() { git ls-files -z -- 'packages/*/src/*' 'packages/*/scripts/*' 'scripts/*' 'src/*'; }
fi

scan_out="$(file_list | LINT_THINKING_ALLOW="$ALLOW" perl -0 -ne '
  BEGIN {
    # A LEVEL WORD: every value observed on any provider today, plus the three
    # legacy ones. Adding a word here widens what counts as a roster literal;
    # it is not a list of valid levels and nothing validates against it.
    $word = qr/default|low|medium|high|xhigh|max|ultra|minimal|none/;
    # Two or more quoted level words joined by a comma or a pipe: an array
    # literal, a z.enum, a Set constructor, or a TS union. Whitespace and
    # newlines between elements are allowed so a prettier-wrapped list is
    # caught too.
    $roster = qr/(?:(["\x27])(?:$word)\1\s*[,|]\s*)+(["\x27])(?:$word)\2/s;
    %allow = map { $_ => 1 } grep { length } split /\s+/, ($ENV{LINT_THINKING_ALLOW} // "");
    $scanned = 0;
  }
  chomp;
  my $f = $_;
  next unless $f =~ /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
  # Tests are out of scope on purpose — see the header.
  next if $f =~ m{(?:^|/)(?:tests?|__tests__)/};
  next if $f =~ /\.test\.[a-z]+$/;
  next if $f =~ m{(?:^|/)dist/};
  $scanned++;
  next if $allow{$f};
  open(my $fh, "<", $f) or next;
  my $data = do { local $/; <$fh> };
  close $fh;
  next unless defined $data;
  my @hits;
  while ($data =~ /$roster/g) {
    my $end = pos($data);
    my $prefix = substr($data, 0, $end);
    my $line = 1 + ($prefix =~ tr/\n//);
    push @hits, $line;
  }
  print $f, ":", join(",", @hits), "\n" if @hits;
  END { print "SCANNED=", $scanned, "\n" }
')"

scanned="$(printf '%s\n' "$scan_out" | sed -n 's/^SCANNED=//p')"
hits="$(printf '%s\n' "$scan_out" | grep -v '^SCANNED=' || true)"

if [ -z "$scanned" ]; then
  echo "::error::lint-thinking-level-roster could not run — the scan reported no file count at all. The GUARD is broken, not necessarily the code."
  exit 1
fi

if [ "$scanned" -lt "$MIN_FILES" ]; then
  echo "::error::lint-thinking-level-roster scanned only $scanned files (floor: $MIN_FILES). A path filter that matches nothing reports a clean repo — the GUARD is broken, not necessarily the code."
  exit 1
fi

if [ -n "$hits" ]; then
  echo "::error::A literal roster of thinking/reasoning levels was found outside $ALLOW:"
  printf '%s\n' "$hits" | sed 's/^/    /'
  cat <<'MSG'
  The offered levels are a property of the MODEL, not of this repo: codex
  advertises supportedReasoningEfforts per model/list row, and the set differs
  per model and changes with releases. A second literal list here is a roster
  that will be wrong for some model and will not be updated when it is.

  Instead:
    - membership  -> resolveThinkingLevels(modelRow) from @chroxy/protocol,
                     which reads the row's `reasoningLevels` and falls back to
                     LEGACY_THINKING_LEVELS only for a row that has none.
    - form/charset-> isWellFormedThinkingLevel(value) from @chroxy/protocol.
    - picker      -> thinkingLevelOptions(modelRow).

  The one legal copy is LEGACY_THINKING_LEVELS in
  packages/protocol/src/thinking-levels.ts. Tests are out of scope, so a test
  may (and should) write the triple by hand rather than deriving it from the
  constant it is checking.
MSG
  exit 1
fi

echo "OK — scanned $scanned non-test source files; the level roster lives only in $ALLOW."
