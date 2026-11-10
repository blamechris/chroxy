#!/usr/bin/env bash
#
# run-with-timeout.test.sh — tests for scripts/lib/run-with-timeout.sh (#8145).
#
# scripts/docker-image-smoke.sh called bare `timeout` throughout while its own
# header claimed the script "runs locally the same way" as CI. Neither a
# stock macOS nor its Homebrew `coreutils` cask installs a bare `timeout`
# (coreutils prefixes it `gtimeout` on purpose, to avoid shadowing BSD's own
# utilities) — so every bounded call in that script failed with exit 127 on
# this Mac, and the exit-127-vs-124 handling downstream read that as an
# internal scan error rather than what it actually was: the bound itself
# never ran. run_with_timeout() replaces every direct `timeout` call with a
# small wrapper that falls back through `timeout` -> `gtimeout` -> a `perl`
# alarm/exec implementation, and this harness proves each of the three things
# that matter about it:
#
#   1. it returns the command's own exit code;
#   2. it returns 124 on a timeout (scripts/docker-image-smoke.sh's own
#      `import_rc -ne 124` check relies on this exact convention);
#   3. the perl fallback path specifically works, forced by a PATH with
#      neither `timeout` nor `gtimeout` on it — including its own exit-code
#      passthrough, proven separately from the 0/124 cases above so a perl
#      implementation that always exits 0 on a normal completion cannot pass
#      by accident (#8145 review).
#
# No external test framework — same zero-dep convention as
# docker-entrypoint.test.sh / bump-version.test.sh.
#
# Run from repo root:
#   bash scripts/__tests__/run-with-timeout.test.sh
#
# Exit status: 0 if all tests pass, 1 otherwise.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/run-with-timeout.sh"

# Every case below must run. Without this, a harness whose cases stop
# executing prints "passed: 0  failed: 0" and exits 0 — "all cases passed" and
# "no case executed" are the same observable outcome (#7653).
EXPECTED_CASES=12

PASS=0
FAIL=0
FAILED_TESTS=()

pass() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("$1")
  echo "  FAIL - $1"
  [ -n "${2:-}" ] && echo "         $2"
}

echo "run-with-timeout.sh (#8145)"

# A PATH with only what every case here needs (a shell, perl, and the plain
# coreutils `true`/`false`/`sleep`) and specifically NEITHER `timeout` NOR
# `gtimeout` — this is what forces cases 5-7 down the perl fallback, and it
# is also representative of a stock macOS dev machine, which is the whole
# reason this file exists.
#
# It is a temp dir of links to exactly those tools, not a system directory
# like /usr/bin: on ubuntu-24.04 /usr/bin carries GNU `timeout`, so a PATH of
# system dirs silently ran cases 5-7 through GNU timeout instead of perl on
# the one platform CI uses (#8145 CI).
#
# Everything this run creates lives under ONE directory it made for itself,
# and the EXIT trap removes exactly that directory: nothing shared with another
# run, nothing matched by a pattern (#8579).
#
# The TERM-ignoring fixtures further down used to be allocated with
# `mktemp /tmp/chroxy-rwt-term-ignore-XXXXXX.sh`. BSD mktemp (stock macOS)
# substitutes only TRAILING X's, so with the `.sh` suffix it created the
# template's literal name. Every run on the machine then shared one path: a run
# cut off before its `rm -f` broke each later one ("mktemp: ... File exists"),
# and two concurrent runs could remove each other's fixture. A template that ENDS in
# X's is randomized by BSD and GNU mktemp alike, and a name inside a directory
# only this run has cannot collide with anything.
#
# The template is spelled out, rather than left to a bare `mktemp -d`, so the
# location follows TMPDIR on both platforms: stock macOS `mktemp -d` ignores it.
#
# A failed allocation stops HERE, before any case. An empty RUN_DIR would turn
# the paths below into `/no-timeout-bin` and `/fixtures`, and the cases would
# then report on a setup that never existed.
TMP_ROOT="${TMPDIR:-/tmp}"
RUN_DIR="$(mktemp -d "${TMP_ROOT%/}/chroxy-rwt.XXXXXX")" || RUN_DIR=""
if [ -z "$RUN_DIR" ] || [ ! -d "$RUN_DIR" ]; then
  echo "run-with-timeout.test.sh: could not allocate a run-owned temp dir under '$TMP_ROOT' — no case was run" >&2
  exit 1
fi
trap 'rm -rf "$RUN_DIR"' EXIT
NO_TIMEOUT_DIR="$RUN_DIR/no-timeout-bin"
FIXTURE_DIR="$RUN_DIR/fixtures"
if ! mkdir "$NO_TIMEOUT_DIR" "$FIXTURE_DIR"; then
  echo "run-with-timeout.test.sh: could not create the run's directories under '$RUN_DIR' — no case was run" >&2
  exit 1
fi
for tool in bash sh perl true false sleep env; do
  # `type -P`, not `command -v`: `true`/`false` are shell builtins, and
  # `command -v true` prints the bare name, which would make a dangling link.
  src="$(type -P "$tool" 2>/dev/null || true)"
  if [ -z "$src" ]; then
    echo "run-with-timeout.test.sh: required tool '$tool' not found on PATH" >&2
    exit 1
  fi
  ln -s "$src" "$NO_TIMEOUT_DIR/$tool"
done
NO_TIMEOUT_PATH="$NO_TIMEOUT_DIR"

# --- 1. Passthrough: a successful command's exit code (0) ------------------
out=$(env -i PATH="$PATH" HOME="$HOME" bash -c "source '$LIB'; run_with_timeout 5 true"; echo "rc=$?")
rc="${out##*rc=}"
if [ "$rc" = "0" ]; then
  pass "returns 0 for a command that exits 0"
else
  fail "returns 0 for a command that exits 0" "got rc='$rc'"
fi

# --- 2. Passthrough: a failing command's own nonzero exit code -------------
out=$(env -i PATH="$PATH" HOME="$HOME" bash -c "source '$LIB'; run_with_timeout 5 bash -c 'exit 7'"; echo "rc=$?")
rc="${out##*rc=}"
if [ "$rc" = "7" ]; then
  pass "returns the command's own exit code (7), not a fixed value"
else
  fail "returns the command's own exit code (7), not a fixed value" "got rc='$rc'"
fi

# --- 3. Timeout: exit 124, under whichever backend is on the real PATH -----
start=$(date +%s)
env -i PATH="$PATH" HOME="$HOME" bash -c "source '$LIB'; run_with_timeout 1 sleep 5"
rc=$?
elapsed=$(( $(date +%s) - start ))
if [ "$rc" -eq 124 ] && [ "$elapsed" -lt 5 ]; then
  pass "returns 124 on a timeout (backend: whatever the real PATH provides)"
else
  fail "returns 124 on a timeout (backend: whatever the real PATH provides)" "rc=$rc elapsed=${elapsed}s"
fi

# --- 4. CONTROL: the same command does NOT time out with a longer bound ----
# Without this, a wrapper that always returned 124 would pass case 3 for the
# wrong reason.
env -i PATH="$PATH" HOME="$HOME" bash -c "source '$LIB'; run_with_timeout 5 sleep 0.1"
rc=$?
if [ "$rc" -eq 0 ]; then
  pass "CONTROL: a command that finishes well inside the bound does not report 124"
else
  fail "CONTROL: a command that finishes well inside the bound does not report 124" "got rc=$rc"
fi

# --- 5-7. Forced perl fallback: PATH carries neither timeout nor gtimeout --
found="$(env -i PATH="$NO_TIMEOUT_PATH" HOME="$HOME" bash -c 'command -v timeout; command -v gtimeout' 2>/dev/null)"
if [ -z "$found" ]; then
  pass "forced-fallback setup: NO_TIMEOUT_PATH has neither timeout nor gtimeout"
else
  fail "forced-fallback setup: NO_TIMEOUT_PATH ($NO_TIMEOUT_PATH) unexpectedly resolves one of them" \
       "found: $found — adjust NO_TIMEOUT_PATH for this host"
fi

out=$(env -i PATH="$NO_TIMEOUT_PATH" HOME="$HOME" bash -c "source '$LIB'; run_with_timeout 5 true"; echo "rc=$?")
rc="${out##*rc=}"
if [ "$rc" = "0" ]; then
  pass "perl fallback: returns 0 for a command that exits 0"
else
  fail "perl fallback: returns 0 for a command that exits 0" "got rc='$rc' out='$out'"
fi

# Exit-code PASSTHROUGH under the perl fallback specifically, not just the
# 0/124 cases above: a perl implementation that (for example) always
# `exit`ed 0 on a normal, non-timed-out completion would still pass both of
# those, since neither uses a nonzero, non-timeout exit code (#8145 review).
out=$(env -i PATH="$NO_TIMEOUT_PATH" HOME="$HOME" bash -c "source '$LIB'; run_with_timeout 5 bash -c 'exit 7'"; echo "rc=$?")
rc="${out##*rc=}"
if [ "$rc" = "7" ]; then
  pass "perl fallback: returns the command's own exit code (7), not 0 or a fixed value"
else
  fail "perl fallback: returns the command's own exit code (7), not 0 or a fixed value" "got rc='$rc' out='$out'"
fi

start=$(date +%s)
env -i PATH="$NO_TIMEOUT_PATH" HOME="$HOME" bash -c "source '$LIB'; run_with_timeout 1 sleep 5"
rc=$?
elapsed=$(( $(date +%s) - start ))
if [ "$rc" -eq 124 ] && [ "$elapsed" -lt 5 ]; then
  pass "perl fallback: returns 124 on a timeout, forced by a PATH without timeout/gtimeout"
else
  fail "perl fallback: returns 124 on a timeout, forced by a PATH without timeout/gtimeout" \
       "rc=$rc elapsed=${elapsed}s"
fi

# --- 9-10. #8151 round-2 review (S-e) — a TERM-ignoring command must still
# be reaped (via the `-k 10` / perl grace-then-KILL escalation) rather than
# outliving the bound, AND the call must still prompt-return with the
# AGREED timeout code — not the raw "killed by signal" code the escalation
# itself produces. GNU timeout's own convention conflates the two: a plain
# TERM-reaped timeout reports 124, but when TERM is ignored and the `-k`
# escalation has to fire, timeout reports the wrapped command's "killed by
# signal 9" status (137) instead — measured directly (`gtimeout -k 10 2
# <this script>` exits 137). run_with_timeout now normalizes 137 -> 124 in
# the one place both GNU backends return through, so every caller's
# existing `-eq 124` check keeps meaning "timed out" regardless of whether
# escalation fired. Each case also confirms the actual process is no longer
# alive afterward — "the call returned in time" alone would still pass if
# escalation silently failed to end anything and the TERM-ignoring process
# just kept running in the background.
#
# HOW "NO LONGER ALIVE" IS ESTABLISHED. These two assertions used to ask
# `pgrep -f` for the fixture's path. The fixture did `exec sleep 40`, so the
# process it became had `sleep 40` for an argv and the path matched nothing.
# Measured with a stand-in wrapper that kills nothing: both assertions reported
# `ok` while both fixtures were alive (#8579 validation). "No such process" and
# "a process this search cannot see" were the same answer.
#
# Now the fixture says which process it is, and the harness looks at exactly
# that process:
#
#   identity   The fixture writes its own pid to `<fixture>.pid`, AFTER it has
#              started ignoring TERM. A record that is absent, unreadable, not
#              exactly one newline-terminated line, or not a plain pid FAILS:
#              with nothing naming the process there is nothing to observe, and
#              that is not evidence it ended. The record lives in this run's
#              own FIXTURE_DIR, and the fixture is refused if one is already
#              there, so it cannot be another process's.
#   observers  `ps` is asked about that pid AND this harness's own pid in one
#              call. Nothing it says counts — not an absent row, not a `Z` —
#              unless it exited 0, every line it printed is one well-formed
#              row for one of those two pids, and the harness's own row is
#              among them. The harness is in the query, so a ps able to look
#              exits 0 even when the fixture is gone (measured, macOS ps); one
#              that is missing, denied, half-working or silent is "unknown"
#              whatever else it printed. Then kill(pid, 0) — which delivers no
#              signal — is asked about the same pid, and has to agree:
#                gone     no row for the pid, and kill fails with ESRCH
#                zombie   a row in state Z, and kill succeeds
#                present  a row in any other state: running, sleeping, stopped
#                unknown  anything else, the two disagreeing included
#              gone and zombie pass. present and unknown fail.
#   zombie     ps reports `Z` for a process that has terminated and is waiting
#              for its parent to collect it. It cannot run again, and once the
#              bounded call has returned, its parent is whatever adopted it —
#              so one that lingers describes the host's init, not the wrapper.
#              It passes, after the full wait for it to go, with a note. That
#              is why these two cases claim "no LIVE process": not "no process
#              table entry", and not "collected". The `Z` itself is ps's word
#              alone; kill(pid, 0) cannot tell a zombie from a running process,
#              it only confirms the pid still exists.
#   bound      The exit is asynchronous. Measured on macOS, /usr/bin/timeout
#              and GNU timeout 9.12 both end THEMSELVES with the KILL they
#              escalate to (wait status: signal 9), so neither waits for the
#              command, and the call can return before the kernel has
#              finished with it. The look is repeated for a few seconds and
#              stops at the first "gone". The fixture's own lifetime (40s) is
#              far longer than that window, so waiting cannot turn a survivor
#              into a pass.
#   not a kill A pid that ended is not proof the WRAPPER ended it. The fixture
#              writes `<fixture>.ended` when it leaves on its own, which a
#              KILL never lets it do; gone or zombie with that marker fails.
#
# Nothing here sends a signal. A fixture that survives is released by removing
# its own file, which its loop polls: the `rm -f` after each case, and the EXIT
# trap's removal of RUN_DIR on every other way out. So there is no pid to kill
# and no pattern to match, and pid reuse can only turn a pass into a failure,
# never the reverse: a process that is alive, or dead and not yet collected,
# keeps its pid.
#
# What this does NOT see: anything the fixture itself started (its `sleep 1`
# ticks). Only the one process that recorded its pid is observed.
#
# The fixture's path is a fixed name inside this run's own FIXTURE_DIR, so it
# is unique per run through its directory (#8579). A fixture that could not be
# written stops the run: carrying on would report the missing file as a wrong
# exit code from the wrapper.
make_term_ignoring_script() {
  local path="$1"
  if [ -e "$path" ] || [ -e "$path.pid" ] || [ -e "$path.ended" ]; then
    return 1
  fi
  cat > "$path" <<'EOF' || return 1
#!/usr/bin/env bash
trap '' TERM
printf '%s\n' "$$" > "$0.pid" || exit 97
while [ "$SECONDS" -lt 40 ] && [ -e "$0" ]; do sleep 1; done
{ : > "$0.ended"; } 2>/dev/null
EOF
  chmod +x "$path"
}

# How many looks, 0.2s apart, each wait below is allowed: 5s to find a usable
# identity record, 5s for the identified process to be gone.
IDENTITY_TRIES=25
LIVENESS_TRIES=25

# Reads a fixture's identity record into FIXTURE_PID. Returns non-zero, with
# the reason in FIXTURE_PID_DETAIL, for anything but one newline-terminated
# line holding a plain pid. `read` fails on a line with no trailing newline,
# which is what makes a half-written record unusable instead of a shorter pid.
read_fixture_pid() {
  local file="$1" first="" extra=""
  FIXTURE_PID=""
  FIXTURE_PID_DETAIL=""
  if [ ! -f "$file" ]; then
    FIXTURE_PID_DETAIL="no record at $file"
    return 1
  fi
  if ! { IFS= read -r first && ! IFS= read -r extra && [ -z "$extra" ]; } 2>/dev/null < "$file"; then
    FIXTURE_PID_DETAIL="the record at $file is unreadable or is not exactly one complete line"
    return 1
  fi
  case "$first" in
    ''|0*|*[!0-9]*)
      FIXTURE_PID_DETAIL="the record at $file does not hold a pid: '$first'"
      return 1
      ;;
  esac
  if [ "${#first}" -gt 10 ]; then
    FIXTURE_PID_DETAIL="the record at $file does not hold a pid: '$first'"
    return 1
  fi
  FIXTURE_PID="$first"
}

# One look at one pid. Sets PROBE_STATE to gone, zombie, present or unknown
# (the table above) and PROBE_DETAIL to what was seen. It starts at unknown and
# every early return leaves it there: only the last few lines can set a state
# that passes, and they are reached only after ps has exited 0, printed nothing
# but well-formed rows for the two pids asked about, and listed this harness.
probe_pid() {
  local pid="$1" listing ps_rc p st rest saw_self=0 saw_pid=0 pid_state="" krc
  PROBE_STATE=unknown
  PROBE_DETAIL=""
  if [ "$pid" = "$$" ]; then
    PROBE_STATE=present
    PROBE_DETAIL="the record names this harness's own pid"
    return
  fi
  listing="$(ps -o pid= -o stat= -p "$$,$pid" 2>/dev/null)"
  ps_rc=$?
  if [ "$ps_rc" -ne 0 ]; then
    PROBE_DETAIL="ps exited $ps_rc with this harness's own pid ($$) in the query — it could not look, so nothing it printed about pid $pid counts"
    return
  fi
  while read -r p st rest; do
    [ -n "$p" ] || continue
    if [ -z "$st" ] || [ -n "$rest" ]; then
      PROBE_DETAIL="ps printed a line that is not one 'pid state' row: '$p $st $rest'"
      return
    fi
    if [ "$p" = "$$" ] && [ "$saw_self" -eq 0 ]; then
      saw_self=1
    elif [ "$p" = "$pid" ] && [ "$saw_pid" -eq 0 ]; then
      saw_pid=1
      pid_state="$st"
    else
      PROBE_DETAIL="ps printed a row that is not the one row for either pid asked about: '$p $st'"
      return
    fi
  done <<< "$listing"
  if [ "$saw_self" -ne 1 ]; then
    PROBE_DETAIL="ps did not list this harness's own pid ($$), so nothing it printed about pid $pid counts"
    return
  fi
  perl -e 'exit(kill(0, $ARGV[0]) ? 0 : ($!{ESRCH} ? 3 : 4))' "$pid" 2>/dev/null
  krc=$?
  if [ "$saw_pid" -eq 1 ]; then
    case "$pid_state" in
      Z*)
        if [ "$krc" -eq 0 ]; then
          PROBE_STATE=zombie
          PROBE_DETAIL="ps state '$pid_state'"
        else
          PROBE_DETAIL="ps reports pid $pid as a zombie (state '$pid_state'), but the signal-0 check did not agree that the pid exists (perl exit $krc, expected 0)"
        fi
        ;;
      *)
        PROBE_STATE=present
        PROBE_DETAIL="ps state '$pid_state'"
        ;;
    esac
    return
  fi
  case "$krc" in
    3) PROBE_STATE=gone ;;
    0) PROBE_DETAIL="ps does not list pid $pid, but the pid still accepts signal 0" ;;
    *) PROBE_DETAIL="ps does not list pid $pid, and the signal-0 check did not confirm it (perl exit $krc, expected 3 for ESRCH)" ;;
  esac
}

# assert_fixture_not_alive LABEL FIXTURE — exactly one pass or fail.
assert_fixture_not_alive() {
  local label="$1" fixture="$2" tries=0
  while ! read_fixture_pid "$fixture.pid"; do
    tries=$((tries + 1))
    [ "$tries" -lt "$IDENTITY_TRIES" ] || break
    sleep 0.2
  done
  if [ -z "$FIXTURE_PID" ]; then
    fail "$label" "the fixture's process cannot be identified ($FIXTURE_PID_DETAIL) — that is not evidence it ended"
    return
  fi
  tries=0
  while :; do
    probe_pid "$FIXTURE_PID"
    [ "$PROBE_STATE" = gone ] && break
    tries=$((tries + 1))
    [ "$tries" -lt "$LIVENESS_TRIES" ] || break
    sleep 0.2
  done
  case "$PROBE_STATE" in
    gone|zombie)
      if [ -e "$fixture.ended" ]; then
        fail "$label" "fixture pid $FIXTURE_PID has ended, but it left on its own ($fixture.ended exists) — the wrapper did not end it"
      else
        pass "$label"
        if [ "$PROBE_STATE" = zombie ]; then
          echo "         note: fixture pid $FIXTURE_PID has terminated but has NOT been collected — it is still in the process table as a zombie ($PROBE_DETAIL)"
        fi
      fi
      ;;
    present)
      fail "$label" "fixture pid $FIXTURE_PID is still in the process table ($PROBE_DETAIL) after $LIVENESS_TRIES looks"
      ;;
    *)
      fail "$label" "could not establish whether fixture pid $FIXTURE_PID is still alive: $PROBE_DETAIL"
      ;;
  esac
}

# 9. Real backend (whatever the unmodified PATH provides — timeout, gtimeout,
# or perl, same as case 3).
term_script="$FIXTURE_DIR/term-ignore-real-backend.sh"
if ! make_term_ignoring_script "$term_script"; then
  echo "run-with-timeout.test.sh: could not write the fixture '$term_script' — stopping before its cases" >&2
  exit 1
fi
start=$(date +%s)
# The lib and the fixture are passed as ARGUMENTS, not spliced into the `-c`
# source: the fixture path follows TMPDIR, and a TMPDIR containing an
# apostrophe would otherwise end the quoted string early and make bash exit 2
# on a syntax error before the wrapper ran (#8579 review).
# shellcheck disable=SC2016 # `$1`/`$2` belong to the inner bash, not to this shell
env -i PATH="$PATH" HOME="$HOME" bash -c 'source "$1"; run_with_timeout 1 "$2"' rwt-case "$LIB" "$term_script"
rc=$?
elapsed=$(( $(date +%s) - start ))
# The grace window (perl: hardcoded 10s; GNU timeout: `-k 10`) means this
# returns at ~11s, not ~1s — bounded well under the TERM-ignoring script's
# own 40s lifetime, which is the actual property under test (it did NOT run
# to completion).
if [ "$rc" -eq 124 ] && [ "$elapsed" -lt 40 ]; then
  pass "a TERM-ignoring command is still reaped and reports the agreed timeout code (124), not 137"
else
  fail "a TERM-ignoring command is still reaped and reports the agreed timeout code (124), not 137" \
       "rc=$rc elapsed=${elapsed}s"
fi
assert_fixture_not_alive "no live process is left after a TERM-ignoring command's bound expires" "$term_script"
# Removing the fixture is also what releases one that survived (see above).
rm -f "$term_script"

# 10. Forced perl fallback — the SAME property, under the backend that has
# its own, independently-written grace-then-KILL loop (not GNU coreutils'
# `-k`), so a fix that only patched the GNU path would leave this half red.
term_script2="$FIXTURE_DIR/term-ignore-perl-fallback.sh"
if ! make_term_ignoring_script "$term_script2"; then
  echo "run-with-timeout.test.sh: could not write the fixture '$term_script2' — stopping before its cases" >&2
  exit 1
fi
start=$(date +%s)
# shellcheck disable=SC2016 # `$1`/`$2` belong to the inner bash, not to this shell
env -i PATH="$NO_TIMEOUT_PATH" HOME="$HOME" bash -c 'source "$1"; run_with_timeout 1 "$2"' rwt-case "$LIB" "$term_script2"
rc=$?
elapsed=$(( $(date +%s) - start ))
if [ "$rc" -eq 124 ] && [ "$elapsed" -lt 40 ]; then
  pass "perl fallback: a TERM-ignoring command is still reaped and reports 124"
else
  fail "perl fallback: a TERM-ignoring command is still reaped and reports 124" \
       "rc=$rc elapsed=${elapsed}s"
fi
assert_fixture_not_alive "perl fallback: no live process is left after a TERM-ignoring command's bound expires" "$term_script2"
rm -f "$term_script2"

echo ""
echo "passed: $PASS  failed: $FAIL"
BROKEN=0
if [ "$FAIL" -gt 0 ]; then
  for t in "${FAILED_TESTS[@]}"; do echo "  - $t"; done
  BROKEN=1
fi
if [ "$((PASS + FAIL))" -ne "$EXPECTED_CASES" ]; then
  echo "HARNESS BROKEN: ran $((PASS + FAIL)) cases, expected $EXPECTED_CASES — a case stopped executing"
  BROKEN=1
fi
[ "$BROKEN" -eq 0 ] || exit 1
exit 0
