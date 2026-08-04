#!/usr/bin/env bash
#
# Lint: no literal NUL byte in a tracked source file (#7103).
#
# A NUL byte embedded in a text file makes that file INVISIBLE to any search
# layer that passes grep's -I (skip binary files) or otherwise sniffs for NUL —
# which is what the agent/editor search tooling does by default. The failure is
# silent: no warning, no "binary file matches" line, just an empty result that
# is indistinguishable from "the string isn't there". Five files were affected
# when this lint was written, including the dashboard's central message switch,
# and a "find every producer of X" sweep that skipped it concluded a handler
# did not exist (#7086, same shape as #7096).
#
# Note that `file(1)` does NOT predict this: three of the five reported `data`,
# one reported plain `UTF-8 text`. NUL presence is the only reliable test, so
# that is exactly what this scans for.
#
# The byte is easy to reintroduce by accident — writing a control character
# through an editor tool emits the literal byte rather than an escape (the same
# trap CLAUDE.md records for control-character regexes). When code genuinely
# needs a NUL at RUNTIME, construct or escape it in the source
# (`'\u0000'`, `String.fromCharCode(0)`) so the file itself stays plain text.
#
# Scope is the whole workspace, not just `src` dirs: the one file where a NUL
# was legitimate-but-must-be-encoded-differently was a TEST fixture, so a
# source-only guard would have missed precisely the file that needed it.
# `git ls-files` is the file-list source of truth, which puts ignored/generated
# trees (node_modules, dist, packages/desktop/src-tauri/target, …) out of scope
# by construction.
#
# Pure bash + perl — no deps, no node. CI runs it under bash.
#
# Run:  bash scripts/lint-no-nul-bytes.sh
# Exit: 0 clean, 1 if any tracked source file carries a NUL byte.

set -euo pipefail

cd "$(dirname "$0")/.."

command -v perl >/dev/null 2>&1 || {
  echo "::error::lint-no-nul-bytes.sh requires perl (used to scan for the NUL byte)"
  exit 1
}

# Extensions treated as source/text. Binary fixtures (.png, .ico, .woff, .pdf,
# …) are out of scope by OMISSION rather than by an exclude list, so a new
# binary asset type can never accidentally fail this lint. Add an extension
# here when a new text file type lands in the repo.
EXTS='ts|tsx|js|jsx|mjs|cjs|json|md|sh|bash|zsh|yml|yaml|toml|css|scss|html|rs|py|txt|sql|lock'

# Grandfathered allowance: EMPTY by design. #7103 rebuilt the one legitimate
# NUL (a NUL-in-filename attachment fixture in
# packages/server/tests/claude-tui-attachments.test.js) as a `\u0000` ESCAPE, so
# the byte still reaches the code under test while the file stays greppable —
# that is the fix, not an exemption. Add a space-separated repo-relative path
# here ONLY when a raw byte is genuinely unavoidable, with an issue link.
ALLOW=''

# Space-separated paths, one file per line on stdin (NUL-delimited).
if [ -n "${LINT_NUL_SCAN_DIR:-}" ]; then
  # Test hook: scan a temp tree instead of the git index (see
  # scripts/__tests__/lint-no-nul-bytes.test.sh). Paths are reported as-is.
  file_list() { find "$LINT_NUL_SCAN_DIR" -type f -print0; }
else
  file_list() { git ls-files -z; }
fi

hits="$(file_list | LINT_NUL_EXTS="$EXTS" LINT_NUL_ALLOW="$ALLOW" perl -0 -ne '
  BEGIN {
    $re = qr/\.(?:$ENV{LINT_NUL_EXTS})$/i;
    %allow = map { $_ => 1 } grep { length } split /\s+/, ($ENV{LINT_NUL_ALLOW} // "");
  }
  chomp;
  my $f = $_;
  next unless $f =~ $re;
  next if $allow{$f};
  open(my $fh, "<:raw", $f) or next;
  my $data = do { local $/; <$fh> };
  close $fh;
  next unless defined $data && index($data, "\0") >= 0;
  my (@ln, $i);
  for my $line (split /\n/, $data, -1) { $i++; push @ln, $i if index($line, "\0") >= 0 }
  print $f, " (line", (@ln > 1 ? "s " : " "), join(",", @ln), ")\n";
')"

if [ -n "$hits" ]; then
  echo "::error::Literal NUL byte found in tracked source file(s) — these are invisible to any -I / NUL-sniffing search:"
  printf '%s\n' "$hits" | sed 's/^/    /'
  echo "  Fix: keep the source plain text and produce the byte at RUNTIME instead —"
  echo "  '\\u0000' in a string literal, or String.fromCharCode(0) for a constructed"
  echo "  separator. Do NOT write the control character through an editor tool: that"
  echo "  emits the literal byte again. Verify with 'cat -v' (a NUL shows as ^@)."
  echo "  For a composite Map key, prefer an unambiguous ASCII encoding — see"
  echo "  packages/server/src/utils/composite-key.js."
  exit 1
fi

echo "OK — no literal NUL byte in any tracked source file."
