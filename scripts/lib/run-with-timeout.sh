# run-with-timeout.sh — a portable bounded-execution wrapper (#8145).
#
# scripts/docker-image-smoke.sh's header claimed it "runs locally the same
# way" as CI while calling bare `timeout` throughout — GNU coreutils, present
# on ubuntu-24.04 but on NEITHER stock macOS NOR its Homebrew `coreutils` cask
# unless installed with `brew install coreutils` (which prefixes the binary
# `gtimeout` rather than shadowing the system one). A local run on macOS with
# neither installed got exit 127 ("command not found") from every bounded
# call, which the script's own exit-127-vs-124 handling then read as an
# internal scan error rather than a hang — the opposite of what the bound
# exists for.
#
# `run_with_timeout SECS cmd...` tries, in order:
#   1. GNU `timeout` (Linux CI, and any macOS dev machine that installed it
#      un-prefixed, e.g. via `brew install coreutils` with the GNU names on
#      PATH);
#   2. `gtimeout` (Homebrew coreutils' default macOS name);
#   3. a `perl` fallback (present on both a stock macOS and Linux, per this
#      script's own header remark that macOS has no GNU `timeout` — that
#      absence is the reason this file exists).
#
# All three paths preserve GNU timeout's exit-124-on-expiry convention, since
# callers compare the raw exit status against 124 (see
# scripts/docker-image-smoke.sh's `import_rc`/`124` check).
#
# Sourced, not executed: `source scripts/lib/run-with-timeout.sh` before the
# first call. No `set -e`/`set -u` here — this file only defines a function,
# and imposing its own shell options on whatever sources it would be a
# surprise the caller did not ask for.
run_with_timeout() {
  if [ "$#" -lt 2 ]; then
    echo "run_with_timeout: usage: run_with_timeout SECS cmd [args...]" >&2
    return 2
  fi
  # `local`, not a bare global assignment: a caller may itself be named (or
  # source another script that names) a global $secs, and a wrapper that
  # clobbers the caller's variable is its own kind of bug (#8145 review).
  local secs="$1"
  shift

  # perl's `alarm()` only accepts a whole number of seconds — a non-numeric
  # or fractional value does not raise an error, it silently numifies (e.g.
  # "5abc" -> 5, "" -> 0, "-3" -> -3, arming an alarm for the wrong duration
  # or none at all). Reject anything that is not a plain non-negative
  # integer up front, in the wrapper itself, so every backend (`timeout`,
  # `gtimeout`, perl) is handed the same validated value rather than each
  # coping with — or silently mis-parsing — a bad one differently.
  case "$secs" in
    ''|*[!0-9]*)
      echo "run_with_timeout: SECS must be a plain whole number of seconds, got '$secs'" >&2
      return 2
      ;;
  esac

  # #8151 round-2 review (nit) — `-k 10`: if the initial TERM doesn't reap
  # the process within 10s, GNU timeout escalates to KILL itself rather than
  # leaving a wedged process running past its own bound. Without this, a
  # command that ignores (or is too stuck to handle) SIGTERM outlives the
  # "bounded" call indefinitely — exactly the hang this wrapper exists to
  # prevent. Mirrored in the perl fallback below.
  if command -v timeout >/dev/null 2>&1; then
    timeout -k 10 "$secs" "$@"
    return $?
  fi

  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout -k 10 "$secs" "$@"
    return $?
  fi

  if ! command -v perl >/dev/null 2>&1; then
    echo "run_with_timeout: no timeout, no gtimeout, and no perl on PATH — cannot bound '$*'" >&2
    return 127
  fi

  # The perl fallback. fork()s the command, arms an alarm for the parent's
  # wait, and on expiry SIGTERMs the child's WHOLE PROCESS GROUP and exits
  # 124 — GNU timeout's own exit code and default signal. Exec uses the
  # indirect-object form (`exec { $cmd[0] } @cmd`) so argv[0] is set
  # explicitly and no shell ever re-parses the arguments (unlike
  # `exec "@cmd"`, which shells out through /bin/sh when given a single
  # scalar containing spaces).
  #
  # `setpgrp(0,0)` in the child, before exec, puts it in its OWN new process
  # group (pgid == its own pid); `kill "TERM", -$pid` in the ALRM handler
  # then signals that whole group, not just the one process. Without this, a
  # bounded command that itself forks (a shell wrapper, `docker run`
  # spawning a helper) can outlive the alarm: killing only $pid leaves its
  # children running and the wait may never return, and the wrapper's own
  # 124 contract would then depend on what the bounded command happened to
  # fork, rather than being unconditional (#8145 review).
  perl -e '
    use POSIX qw(WNOHANG);
    my ($secs, @cmd) = @ARGV;
    my $pid = fork();
    if (!defined $pid) {
      print STDERR "run_with_timeout: fork failed: $!\n";
      exit 1;
    }
    if ($pid == 0) {
      setpgrp(0, 0);
      exec { $cmd[0] } @cmd;
      # exec only returns on failure (e.g. command not found).
      print STDERR "run_with_timeout: exec failed: $!\n";
      exit 127;
    }
    my $timed_out = 0;
    local $SIG{ALRM} = sub {
      $timed_out = 1;
      kill "TERM", -$pid;
      # #8151 round-2 review (nit) — escalate to KILL after a 10s grace
      # period if TERM alone did not reap the group, mirroring GNU
      # timeout'"'"'s own `-k 10` above. A process that ignores (or is too
      # wedged to handle) SIGTERM would otherwise run past this wrapper'"'"'s
      # bound forever instead of being forcibly reaped.
      my $reaped = 0;
      for (1..10) {
        if (waitpid($pid, WNOHANG) == $pid) { $reaped = 1; last; }
        sleep(1);
      }
      kill "KILL", -$pid unless $reaped;
    };
    alarm($secs);
    waitpid($pid, 0);
    alarm(0);
    if ($timed_out) {
      exit 124;
    }
    my $status = $?;
    if ($status == -1) {
      exit 1;
    } elsif ($status & 127) {
      # Killed by a signal: mirror the conventional 128+signal exit code.
      exit(128 + ($status & 127));
    } else {
      exit($status >> 8);
    }
  ' "$secs" "$@"
  return $?
}
