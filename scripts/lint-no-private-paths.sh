#!/usr/bin/env bash
#
# Lint: a PR must not ADD the owner's private local paths to the public repo.
#
# Scans only the lines ADDED by `git diff --unified=0 <base>...HEAD`. History
# is left alone, and deleted lines never count, so a PR that removes an
# existing leak is always green.
#
# Rules (a line is flagged when it contains any of these):
#   home-path   an absolute home path under the owner's home directory
#   vault-path  the private notes vault directory (this also catches the
#               `~/`-prefixed spelling)
#   tailnet     a Tailscale MagicDNS host, <name>.tail<6 hex>.ts.net
#
# Exemptions:
#   - files under .claude/, .codex/ and .gemini/ (installed registry skills,
#     which legitimately reference the vault handoff path; a re-install must
#     not go red)
#   - a line carrying the opt-out marker (shown in the failure message), for a reviewed
#     one-off. Put it on the SAME line, usually in a trailing comment.
#
# The rule strings are assembled from fragments so that this file's own diff
# does not trip the guard it implements.
#
# Usage:  bash scripts/lint-no-private-paths.sh [--direct] [<base-ref>]
#   <base-ref>  defaults to origin/main; diffed as <base>...HEAD (merge-base).
#   --direct    diff <base>..HEAD instead. For a shallow CI checkout of a PR
#               merge commit, where the merge-base is not reachable but the
#               base tip is HEAD's first parent, so the two forms are equal.
#
# Exit: 0 clean, 1 violation, 2 cannot check (missing base, not a git repo,
#       diff failed). Callers must treat 2 as a failure: fail closed.

set -euo pipefail

DIRECT=0
BASE=""
for arg in "$@"; do
  case "$arg" in
    --direct) DIRECT=1 ;;
    -*) echo "::error::lint-no-private-paths: unknown option $arg" >&2; exit 2 ;;
    *) BASE="$arg" ;;
  esac
done
BASE="${BASE:-origin/main}"

command -v perl >/dev/null 2>&1 || {
  echo "::error::lint-no-private-paths requires perl" >&2
  exit 2
}

git rev-parse --git-dir >/dev/null 2>&1 || {
  echo "::error::lint-no-private-paths: not inside a git work tree" >&2
  exit 2
}

git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null || {
  echo "::error::lint-no-private-paths: base ref '$BASE' not found; cannot check (fetch it first)" >&2
  exit 2
}

if [ "$DIRECT" -eq 1 ]; then RANGE="${BASE}..HEAD"; else RANGE="${BASE}...HEAD"; fi

DIFF_FILE="$(mktemp)"
trap 'rm -f "$DIFF_FILE"' EXIT
git -c core.quotepath=off diff --unified=0 --no-color --no-ext-diff "$RANGE" >"$DIFF_FILE" || {
  echo "::error::lint-no-private-paths: 'git diff $RANGE' failed (no merge-base? shallow clone?); cannot check" >&2
  exit 2
}

PRIVATE_PATH_MARKER="private-path-guard:"" allow" \
PRIVATE_PATH_HOME="/Users/""blamechris/" \
PRIVATE_PATH_VAULT="Obsidian/""no-it-all" \
perl -e '
  my $marker = $ENV{PRIVATE_PATH_MARKER};
  my @literal = (
    [ "home-path",  $ENV{PRIVATE_PATH_HOME} ],
    [ "vault-path", $ENV{PRIVATE_PATH_VAULT} ],
  );
  my $tailnet = qr/[A-Za-z0-9-]+\.tail[0-9a-f]{6}\.ts\.net/;
  my ($path, $skip, $line, $bad) = ("", 0, 0, 0);
  while (my $l = <STDIN>) {
    chomp $l;
    if ($l =~ /^\+\+\+ (.*)$/) {
      my $p = $1;
      if ($p eq "/dev/null") { $path = ""; $skip = 1; next }
      $p =~ s{^b/}{};
      $path = $p;
      $skip = ($p =~ m{^\.(?:claude|codex|gemini)/}) ? 1 : 0;
      next;
    }
    if ($l =~ /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/) { $line = $1; next }
    next if $l =~ /^(?:---|diff |index |new file|deleted file|similarity|rename |old mode|new mode|Binary )/;
    next unless $l =~ /^\+/;
    my $cur = $line++;
    next if $skip;
    my $text = substr($l, 1);
    next if index($text, $marker) >= 0;
    for my $r (@literal) {
      if (index($text, $r->[1]) >= 0) { print "$path:$cur: [$r->[0]]\n"; $bad++ }
    }
    if ($text =~ $tailnet) { print "$path:$cur: [tailnet]\n"; $bad++ }
  }
  exit($bad ? 1 : 0);
' <"$DIFF_FILE" >"$DIFF_FILE.out" && rc=0 || rc=$?
trap 'rm -f "$DIFF_FILE" "$DIFF_FILE.out"' EXIT

if [ "$rc" -ne 0 ]; then
  if [ "$rc" -ne 1 ]; then
    echo "::error::lint-no-private-paths: scanner failed (exit $rc); cannot check" >&2
    exit 2
  fi
  echo "::error::This change adds a private local path (home directory, private notes vault, or tailnet host) to the public repo:"
  sed 's/^/    /' "$DIFF_FILE.out"
  echo "  Fix: use a repo-relative path, \$HOME, or a placeholder."
  echo "  For a reviewed one-off, put the marker 'private-path-guard:"" allow' on the same line."
  exit 1
fi

echo "OK: no private local paths added in $RANGE."
