#!/usr/bin/env bash
#
# docker-entrypoint.test.sh — tests for scripts/docker-entrypoint.sh (#7239).
#
# The entrypoint hardcoded `CONFIG_DIR="$HOME/.chroxy"` while the daemon honours
# CHROXY_CONFIG_DIR, so `docker run -e CHROXY_CONFIG_DIR=/data` split the
# container in two: the entrypoint wrote config.json to the mounted volume at
# ~/.chroxy, and the daemon read /data — an unmounted, ephemeral path — for
# everything else. The token survived by accident (the entrypoint exports
# API_TOKEN and server-cli falls back to it), which is exactly why the split was
# silent: the daemon started fine while every piece of persistent state was
# being destroyed on each restart.
#
# Strategy: run `prepare_config` for real, then assert WHICH directory the
# config landed in. The entrypoint's final `exec node /app/...` fails in this
# harness (that path does not exist outside the image) and that is fine — it
# happens strictly after prepare_config has written the file we assert on.
#
# No external test framework — same zero-dep convention as bump-version.test.sh.
#
# Run from repo root:
#   bash scripts/__tests__/docker-entrypoint.test.sh
#
# Exit status: 0 if all tests pass, 1 otherwise.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENTRYPOINT="$REPO_ROOT/scripts/docker-entrypoint.sh"

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

# Each case runs the entrypoint's `start` path in a subshell with an isolated
# HOME. CHROXY_CONFIG_DIR is set or unset EXPLICITLY every time — an inherited
# value from the developer's shell would make these assertions vacuous, which is
# the exact way a control stops controlling.
#
# The trailing `exec node /app/...` fails here (that path exists only in the
# image); it runs strictly after prepare_config has written the file asserted on.

echo "docker-entrypoint.sh (#7239)"

# --- 1. The bug: an override must be honoured ------------------------------
tmp="$(mktemp -d)"
(
  export HOME="$tmp/home"
  mkdir -p "$HOME"
  export ANTHROPIC_API_KEY="sk-ant-test"
  export CHROXY_CONFIG_DIR="$tmp/relocated"
  bash "$ENTRYPOINT" start >/dev/null 2>&1
)
if [ -f "$tmp/relocated/config.json" ]; then
  pass "CHROXY_CONFIG_DIR is honoured — config lands in the relocated root"
else
  fail "CHROXY_CONFIG_DIR is honoured — config lands in the relocated root" \
       "expected $tmp/relocated/config.json to exist"
fi

if [ ! -f "$tmp/home/.chroxy/config.json" ]; then
  pass "config does NOT also land in \$HOME/.chroxy (the split-brain)"
else
  fail "config does NOT also land in \$HOME/.chroxy (the split-brain)" \
       "entrypoint wrote to \$HOME/.chroxy while the daemon reads CHROXY_CONFIG_DIR"
fi
rm -rf "$tmp"

# --- 2. POSITIVE CONTROL: the default is unchanged -------------------------
# Proves the assertions above come from the override being honoured, not from
# the entrypoint having stopped writing config at all.
tmp="$(mktemp -d)"
(
  export HOME="$tmp/home"
  mkdir -p "$HOME"
  export ANTHROPIC_API_KEY="sk-ant-test"
  unset CHROXY_CONFIG_DIR
  bash "$ENTRYPOINT" start >/dev/null 2>&1
)
if [ -f "$tmp/home/.chroxy/config.json" ]; then
  pass "POSITIVE CONTROL: with no override, config still lands in \$HOME/.chroxy"
else
  fail "POSITIVE CONTROL: with no override, config still lands in \$HOME/.chroxy" \
       "expected $tmp/home/.chroxy/config.json to exist"
fi
rm -rf "$tmp"

# --- 3. Token preservation across restarts, in the relocated root ----------
# The entrypoint preserves an existing apiToken so a restart does not re-pair
# every device. That has to keep working at the relocated path, not just at the
# default one.
tmp="$(mktemp -d)"
(
  export HOME="$tmp/home"
  mkdir -p "$HOME"
  export ANTHROPIC_API_KEY="sk-ant-test"
  export CHROXY_CONFIG_DIR="$tmp/relocated"
  bash "$ENTRYPOINT" start >/dev/null 2>&1
)
first="$(node -e "process.stdout.write(require('$tmp/relocated/config.json').apiToken||'')" 2>/dev/null)"
(
  export HOME="$tmp/home"
  export ANTHROPIC_API_KEY="sk-ant-test"
  export CHROXY_CONFIG_DIR="$tmp/relocated"
  bash "$ENTRYPOINT" start >/dev/null 2>&1
)
second="$(node -e "process.stdout.write(require('$tmp/relocated/config.json').apiToken||'')" 2>/dev/null)"
if [ -n "$first" ] && [ "$first" = "$second" ]; then
  pass "the apiToken survives a restart in the relocated root"
else
  fail "the apiToken survives a restart in the relocated root" \
       "first='$first' second='$second'"
fi
rm -rf "$tmp"

# --- 4. Mode: the config file holds a token and must not be world-readable --
tmp="$(mktemp -d)"
(
  export HOME="$tmp/home"
  mkdir -p "$HOME"
  export ANTHROPIC_API_KEY="sk-ant-test"
  export CHROXY_CONFIG_DIR="$tmp/relocated"
  bash "$ENTRYPOINT" start >/dev/null 2>&1
)
mode="$(stat -f '%Lp' "$tmp/relocated/config.json" 2>/dev/null \
     || stat -c '%a' "$tmp/relocated/config.json" 2>/dev/null)"
if [ "$mode" = "600" ]; then
  pass "the relocated config.json is chmod 600"
else
  fail "the relocated config.json is chmod 600" "got mode '$mode'"
fi
rm -rf "$tmp"

echo ""
echo "passed: $PASS  failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  for t in "${FAILED_TESTS[@]}"; do echo "  - $t"; done
  exit 1
fi
exit 0
