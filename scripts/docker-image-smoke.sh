#!/usr/bin/env bash
# Smoke-start a built Chroxy Docker image (#8133).
#
# The root Dockerfile shipped for months with every server start dying on
# ERR_MODULE_NOT_FOUND: the image never contained packages/protocol or
# packages/store-core, so npm's workspace links in node_modules/@chroxy/ pointed
# at nothing. release.yml built that image and pushed it to GHCR on every
# release, but nothing ever RAN it, so nothing noticed. Two callers run this
# script against a freshly built image, both against a LOCAL, unpushed
# `docker/build-push-action` build (`load: true`, `push: false`) — never a
# registry pull: ci.yml's `Docker Image Smoke` job (PR-time, path-filtered,
# tag `chroxy:ci`), and release.yml's `Docker Image` job (release-time,
# tag `chroxy:release-smoke` — pushes to GHCR only after this script exits 0,
# #8150). It runs locally the same way — including the bounded-execution
# calls below, which use a portable wrapper rather than bare `timeout` (see
# the note below):
#
#   docker build -t chroxy:local . && bash scripts/docker-image-smoke.sh chroxy:local
#
# Six checks, all against the image as built:
#
# 1. Every `@chroxy/*` specifier the server imports resolves inside the image.
#    The specifiers are read from the image's OWN copy of packages/server/src on
#    every run, never typed here: a hand-kept list beside a growing set is how a
#    new workspace import would slip past (docs/false-safety-guards.md). Two
#    ways this could pass while proving nothing are both failures instead:
#    finding zero specifiers, and a quoted `@chroxy/...` on a code line in a
#    form the extractor does not recognise (a template literal, a multi-line
#    `import(`, ...), which fails naming the line rather than being skipped.
#
# 2. The entrypoint's real `start` path reaches a healthy daemon. Health is
#    judged by running the image's OWN HEALTHCHECK command inside the container
#    (read back with `docker inspect`), under the image's own probe timeout, so
#    this checks the probe Docker itself would run, including that its tools
#    exist in the image.
#
# 3. #8151 review (C1) — the Default session actually comes up under the
#    HEADLESS claude-sdk provider, not merely "the process answers HTTP".
#    Check 2's HEALTHCHECK is `curl http://localhost:.../` — it returns ok
#    regardless of session state, so an image whose provider resolves to
#    claude-tui (node-pty unavailable here) was previously HEALTHCHECK-healthy
#    AND passed every check above it, while its own logs showed the Default
#    session's node-pty import fail and the session get torn down a moment
#    later. Proven by polling `docker logs` (bounded) for the sdk session's own
#    "[sdk] Ready for messages" line, and asserting the logs contain NEITHER
#    the node-pty-unavailable marker NOR "Destroyed session" — the exact
#    signature of a PTY-based provider failing and its phantom session being
#    cleaned up. A WS probe of `session_list` would name the provider more
#    directly, but this image's default posture requires E2E encryption for
#    anything beyond the unauthenticated `/` health route, and standing up
#    that handshake from a disposable bash+node probe is not cheap; the log
#    signature is specific enough that this script prefers it over building a
#    partial WS client.
#
#    #8151 round-2 review (Critical 4): the marker is READ from the image's
#    own `node-pty-support.js` (`NODE_PTY_UNAVAILABLE_CODE`), never hand-typed
#    here — a hardcoded copy of that prose string silently stopped matching
#    anything the first time the message was reworded (S8), and the negative
#    assertion could never fire again. (S1): the same assertion also re-runs
#    against a FRESH `docker logs` read at the very end of the script, after
#    checks 4-6 — a session that fails partway through those checks would
#    otherwise go unnoticed by check 3's one-time snapshot.
#
#    Mutant: build `FROM <this image>` + `ENV CHROXY_PROVIDER=claude-tui` —
#    still HEALTHCHECK-healthy, still passes checks 1/2/4/6, and goes RED here.
#
# 4. The image's own `claude` CLI (#8145) runs and reports the version the
#    Dockerfile pinned. The pin is read from the image's own
#    `org.chroxy.claude-code.version` label via `docker inspect`, never
#    parsed from the Dockerfile source, so this checks what actually shipped.
#
# 5. GET /dashboard, on the already-running healthy container, serves the
#    REAL BUILT dashboard — not just any 200, and not the unbuilt SOURCE
#    index.html (#8151 review C2): the dashboard's <title> marker sits in
#    BOTH, so a title-only check passes on a blank page whose script tag
#    points at /src/main.tsx (never fetched, never built) instead of a real
#    /dashboard/assets/*.js bundle. This extracts the actual <script src="...">
#    bundle path from the served HTML and fetches THAT asset with the token,
#    requiring 200, a non-empty body, and a JS content-type — the unbuilt
#    source HTML has no such script tag at all, so the extraction itself fails
#    first. #8151 review (S1) also runs a NEGATIVE control FIRST: GET
#    /dashboard with NO token must be 403 — proving auth actually gates the
#    route before the positive check's token is trusted to mean anything.
#
#    Mutants: an image serving the source index.html (no bundle to extract,
#    RED); a dist whose assets/ directory is emptied (bundle path extracted,
#    fetch 404s, RED).
#
# 6. Every THIRD-PARTY dependency the server's OWN package.json declares
#    (`dependencies` + `optionalDependencies`, read from the image's own copy,
#    never this checkout's) is checked inside the image. `@chroxy/*` names are
#    excluded — check 1 already resolves every specifier the server actually
#    imports, subpaths included, which a blind bare-root import here cannot
#    (e.g. `@chroxy/store-core`'s root export is a TypeScript source file the
#    server stage never ships; only `./crypto`'s dist is). This is what
#    catches a lazily-imported dep going missing (#8151): deleting
#    `@kubernetes/client-node` from the image previously still passed the
#    smoke with exit 0, because config.js only imports it when a K8s/Rancher
#    environment backend is actually used.
#
#    #8151 review (S2): for each name, the image's OWN packages/server/src is
#    scanned for the specifier(s) actually used (bare or with a subpath,
#    static `from`/`import`/`require`/dynamic `import(`) — the SAME mechanism
#    check 1 uses for `@chroxy/*`, generalised to every dependency name so
#    there is no hand-kept subpath list. A package used only via a subpath
#    (`@modelcontextprotocol/sdk/server/...`) is resolved at THAT subpath, not
#    a blind bare-root import — `@modelcontextprotocol/sdk`'s own bare "."
#    export is a dead link in the published package on every platform
#    (confirmed outside Docker too), which the old hand-written exemption hid
#    this check from ever actually exercising that dependency at all. Falls
#    back to the bare name only when the scan finds no specifier for it (e.g.
#    `@kubernetes/client-node`, imported bare with no subpath).
#
#    Two SEPARATE kinds of special case remain, both CHECKED — never
#    silently skipped — and both validated in BOTH directions (every
#    special-cased name must still be a real declared dependency, so a
#    typo'd or removed name fails loudly instead of silently widening what
#    this check accepts):
#
#      - EXEMPT_JSON: a name this check cannot validly `import()` at all —
#        currently only `node-pty` (no linux prebuild; the embedded terminal
#        and claude-tui provider are unsupported in this image, see the
#        Dockerfile's `CHROXY_PROVIDER` comment). #8151 review (S3): treated
#        as an EXPECTED FAILURE, not a free pass — the import is still
#        attempted, and it must actually fail; if it ever unexpectedly
#        SUCCEEDS (a future base image ships a prebuild, say), that is
#        reported as a failure too ("exemption no longer needed"), so a
#        silently-fixed exemption doesn't sit there unnoticed forever.
#      - STATIC_ASSETS_JSON: a package that is real and genuinely used, but
#        only as raw asset BYTES — http-routes.js's `readModule` reads
#        specific files off disk and serves them verbatim, never `import()`s
#        the package as a Node module. `@xterm/xterm` / `@xterm/addon-fit`
#        are exactly this (and `@xterm/xterm`'s own entry point throws "self
#        is not defined" under plain Node by design — it assumes a
#        browser/webworker global). #8151 review (S3): these are checked by
#        FILE EXISTENCE at the exact paths `readModule` reads, mirroring its
#        own two-candidate-path fallback — never exempted from checking at
#        all, the way they previously were.
#
# Every docker call that runs something in the image is bounded by
# `run_with_timeout` (scripts/lib/run-with-timeout.sh), so a wedged image
# fails with a message instead of hanging the job. It is NOT bare `timeout`:
# GNU coreutils' `timeout` ships on ubuntu-24.04 (where CI runs this) but on
# NEITHER a stock macOS NOR its Homebrew `coreutils` cask by default (which
# installs the GNU tools prefixed `gtimeout`, precisely so they do not shadow
# BSD's own utilities) — so a bare `timeout` call here previously made the
# "runs locally the same way" claim above false on this Mac: every bounded
# call failed with exit 127 before ever reaching the image. run_with_timeout
# tries `timeout`, then `gtimeout`, then falls back to a `perl` alarm/exec
# implementation that preserves the same exit-124-on-expiry contract this
# script's own `import_rc` check below relies on.
#
# #8151 review (S4): every `docker run` this script issues also gets `--init`
# — a tiny PID-1 (tini) inside the container that forwards signals and reaps
# zombies, so a SIGTERM from `run_with_timeout` on a wedged call actually
# stops the container's real process instead of being swallowed by an
# application PID 1 that never installed its own handler.
#
# Exit codes: 0 = healthy, 1 = a check failed, 2 = usage error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/run-with-timeout.sh
source "$SCRIPT_DIR/lib/run-with-timeout.sh"

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  echo "usage: $0 <image>" >&2
  exit 2
fi

TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-60}"
PORT=8765
NAME="chroxy-smoke-$$"
IMAGE_SERVER=/app/packages/server

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  docker rm -f "$NAME" "$NAME-scan" "$NAME-imports" "$NAME-ptymarker" "$NAME-version" "$NAME-depjson" "$NAME-deps" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# grep that reads "no match" (exit 1) as empty output but a real error (exit 2)
# as a failure: an erroring filter must never look like "nothing found".
grep_or_empty() { grep "$@" || [ $? -eq 1 ]; }

# #8151 round-2 review (Critical 4) — check 3's negative assertion used to
# `grep -qF 'node-pty unavailable'`, a hand-copied SUBSTRING of
# node-pty-support.js's prose message. S8 reworded that prose ('node-pty
# unavailable' -> 'node-pty is unavailable here') and silently broke the
# match: the assertion could no longer fire on a REAL failure, so a
# regression that reintroduced claude-tui as the Default provider would have
# passed this check clean. Fixed by deriving the needle from the SAME
# literal the message is built from — read from the image's own copy of
# node-pty-support.js (never this checkout's; same "ask the shipped
# artifact" principle as checks 2/4/6) — so there is only one string to
# reword, not two to keep in sync. Called once, after check 2's HEALTHCHECK
# passes but before check 3's log read; both the check-3 and the S1 end-of
# -script re-read below use the result.
#
# $@ reserved for the FIRST positional arg below ($IMAGE) — keep this
# function call-site free of its own argv so a future edit that adds args to
# the surrounding script doesn't silently leak into it.
assert_no_pty_failure_signature() {
  local logs="$1"
  local where="$2"
  grep -qF "$NODE_PTY_MARKER" <<<"$logs" \
    && fail "container logs ($where) contain the node-pty-unavailable marker ($NODE_PTY_MARKER) — the Default session attempted a PTY-based provider (claude-tui/user-shell), not claude-sdk"
  grep -qF 'Destroyed session' <<<"$logs" \
    && fail "container logs ($where) contain 'Destroyed session' — the Default session was torn down after a start failure"
  # Explicit: under `set -e`, this function's CALLER aborts the whole
  # script if the function's own return status is non-zero — and without
  # this, the function's return status is whatever the LAST `grep` above
  # exited with. On the intended (good) path neither grep matches, so that
  # grep exits 1 ("no match") — a status `&&` correctly exempts from
  # tripping `set -e` AT THE GREP ITSELF, but which then silently becomes
  # THIS FUNCTION's own return status once it falls off the end, with
  # nothing left to exempt IT at the call site. Measured: without this
  # line, a passing check (no PTY-failure signature present — the actual
  # common case) silently aborted the whole script right after this
  # function returned, with no FAIL message at all.
  return 0
}

docker version >/dev/null 2>&1 || fail "cannot reach Docker (no docker CLI on PATH, or no daemon running)"
docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "no such image: $IMAGE (build it first)"

# --- 1. Every @chroxy/* specifier the server imports resolves in the image ---
# Every line of the image's server JavaScript that quotes an @chroxy/ specifier
# (JS only: src/ also holds Markdown design notes that name packages in prose).
set +e
SRC_LINES="$(run_with_timeout 60 docker run --rm --init --name "$NAME-scan" --entrypoint grep "$IMAGE" \
  -rhE --include='*.js' --include='*.mjs' --include='*.cjs' "['\"\`]@chroxy/" "$IMAGE_SERVER/src")"
scan_rc=$?
set -e
[ "$scan_rc" -le 1 ] || fail "could not scan $IMAGE_SERVER/src inside $IMAGE (exit $scan_rc)"

# Code lines only: JSDoc (`* @param {import('@chroxy/x').T}`) and // comments
# name types and prose, not runtime imports.
CODE_LINES="$(printf '%s\n' "$SRC_LINES" | grep_or_empty -vE '^[[:space:]]*(//|/\*|\*)')" \
  || fail "internal: comment filter errored"

# Static `from`, side-effect `import '…'`, dynamic `import(…)` and `require(…)`.
IMPORT_RE="(^|[^A-Za-z0-9_\$.])(from|import|require)[[:space:]]*\(?[[:space:]]*['\"]@chroxy/[A-Za-z0-9_-]+(/[A-Za-z0-9_./-]+)?['\"]"

UNRECOGNISED="$(printf '%s\n' "$CODE_LINES" | grep_or_empty -vE "$IMPORT_RE" | grep_or_empty -E "['\"\`]@chroxy/")" \
  || fail "internal: unrecognised-form filter errored"
if [ -n "$UNRECOGNISED" ]; then
  printf '%s\n' "$UNRECOGNISED" >&2
  fail "the line(s) above quote an @chroxy/ specifier in a form this script cannot check — use a plain static or import('…') specifier"
fi

SPECS="$(printf '%s\n' "$CODE_LINES" | grep_or_empty -oE "$IMPORT_RE" \
  | grep_or_empty -oE "@chroxy/[A-Za-z0-9_./-]+" | sort -u)" \
  || fail "internal: specifier extraction errored"
if [ -z "$SPECS" ]; then
  fail "found zero @chroxy/* imports under $IMAGE_SERVER/src in $IMAGE — the scan matched nothing, which proves nothing"
fi

echo "== Resolving $(printf '%s\n' "$SPECS" | wc -l | tr -d ' ') @chroxy/* specifier(s) inside $IMAGE"
# Run from the server package so bare specifiers resolve exactly as the
# server's own imports do. $SPECS is intentionally unquoted: one argv each.
set +e
# shellcheck disable=SC2086
run_with_timeout 120 docker run --rm --init --name "$NAME-imports" -w "$IMAGE_SERVER" "$IMAGE" node --input-type=module -e '
  for (const spec of process.argv.slice(1)) {
    await import(spec)
    console.log("  resolved " + spec)
  }
' $SPECS
import_rc=$?
set -e
[ "$import_rc" -ne 124 ] || fail "resolving the @chroxy/* specifiers timed out after 120s"
[ "$import_rc" -eq 0 ] || fail "a @chroxy/* specifier the server imports does not resolve inside the image"

# --- 2. The entrypoint's `start` reaches a healthy daemon -------------------
HC_KIND="$(docker inspect -f '{{index .Config.Healthcheck.Test 0}}' "$IMAGE" 2>/dev/null)" \
  || fail "image has no HEALTHCHECK to run"
[ "$HC_KIND" = "CMD-SHELL" ] || fail "unexpected HEALTHCHECK form '$HC_KIND' (expected CMD-SHELL)"
HC_CMD="$(docker inspect -f '{{index .Config.Healthcheck.Test 1}}' "$IMAGE")"
# The probe's own timeout, in nanoseconds; Docker's default is 30s when unset.
HC_TIMEOUT_NS="$(docker inspect -f '{{json .Config.Healthcheck.Timeout}}' "$IMAGE")"
case "$HC_TIMEOUT_NS" in ''|*[!0-9]*) fail "unreadable HEALTHCHECK timeout '$HC_TIMEOUT_NS'" ;; esac
if [ "$HC_TIMEOUT_NS" -gt 0 ]; then
  HC_TIMEOUT_S=$(( (HC_TIMEOUT_NS + 999999999) / 1000000000 ))
else
  HC_TIMEOUT_S=30
fi

# Fixed rather than auto-generated (the entrypoint would otherwise mint a
# fresh uuid and write it ONLY to the container's own config.json) so checks
# 5/6 below can authenticate a dashboard request without reaching into the
# container to read it back.
DASHBOARD_TOKEN="chroxy-smoke-test-dashboard-token"

echo "== Starting $IMAGE (tunnel off) and waiting up to ${TIMEOUT_SECONDS}s for: $HC_CMD"
docker run -d --init --name "$NAME" \
  -e ANTHROPIC_API_KEY=sk-ant-smoke-test-not-a-real-key \
  -e CHROXY_TUNNEL=none \
  -e PORT="$PORT" \
  -e API_TOKEN="$DASHBOARD_TOKEN" \
  "$IMAGE" start >/dev/null || fail "could not start a container from $IMAGE"

deadline=$((SECONDS + TIMEOUT_SECONDS))
until run_with_timeout "$HC_TIMEOUT_S" docker exec "$NAME" sh -c "$HC_CMD" >/dev/null 2>&1; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
    docker logs "$NAME" >&2 || true
    fail "container exited before becoming healthy (logs above)"
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    docker logs "$NAME" >&2 || true
    fail "container not healthy after ${TIMEOUT_SECONDS}s (logs above)"
  fi
  sleep 1
done

echo "== Healthy: the image's HEALTHCHECK passed"

# Read the node-pty-unavailable marker from the image's OWN
# node-pty-support.js (see assert_no_pty_failure_signature, above, for why).
echo "== Reading the node-pty-unavailable marker from the image's own node-pty-support.js"
set +e
NODE_PTY_MARKER="$(run_with_timeout 30 docker run --rm --init --name "$NAME-ptymarker" --entrypoint node "$IMAGE" --input-type=module -e "
  const m = await import('$IMAGE_SERVER/src/utils/node-pty-support.js')
  process.stdout.write(m.NODE_PTY_UNAVAILABLE_CODE || '')
")"
marker_rc=$?
set -e
[ "$marker_rc" -ne 124 ] || fail "reading the node-pty-unavailable marker timed out after 30s"
[ "$marker_rc" -eq 0 ] || fail "could not read NODE_PTY_UNAVAILABLE_CODE from the image's own node-pty-support.js (exit $marker_rc): $NODE_PTY_MARKER"
[ -n "$NODE_PTY_MARKER" ] \
  || fail "the image's node-pty-support.js exports no NODE_PTY_UNAVAILABLE_CODE — the negative-signature check below would match nothing and prove nothing"

# --- 3. The Default session is actually live under claude-sdk (#8151 C1) ---
# HEALTHCHECK above proves only "the HTTP server answers" — main's own
# claude-tui image was ALSO healthy while its Default session's node-pty
# import failed and the phantom session was torn down a moment later. Poll
# `docker logs` (bounded) for the sdk session's own "Ready for messages" line
# (sdk-session.js, logger tag [sdk] — see logger.js's
# "<ts> [INFO] [sdk] <msg>" format), and assert the logs show NEITHER a
# node-pty failure NOR a destroyed session — the signature of a PTY-based
# provider failing instead.
echo "== Checking the Default session actually started under claude-sdk (not a silently-failing claude-tui)"
SDK_READY_DEADLINE=$((SECONDS + 20))
sdk_ready=0
LOGS=""
while [ "$SECONDS" -lt "$SDK_READY_DEADLINE" ]; do
  LOGS="$(docker logs "$NAME" 2>&1)"
  if grep -qF '[sdk] Ready for messages' <<<"$LOGS"; then
    sdk_ready=1
    break
  fi
  sleep 1
done
if [ "$sdk_ready" -ne 1 ]; then
  printf '%s\n' "$LOGS" >&2
  fail "the Default session never logged '[sdk] Ready for messages' within 20s (logs above) — the configured provider may not be claude-sdk, or it failed to start"
fi
assert_no_pty_failure_signature "$LOGS" "at check 3"

echo "== Default session OK: claude-sdk is live (no $NODE_PTY_MARKER or session-teardown signature in the logs)"

# --- 4. The image's own claude CLI runs and reports the pinned version -----
# Read the pin from the image's OWN label (baked in by the root Dockerfile,
# #8145) rather than parsing the Dockerfile here — this checks what shipped,
# not what the source says should ship. `start` above ran preflight for real
# (no `--skip-checks`): if `claude` were missing or unusable the container
# would already have failed to become healthy, so this check is confirming
# the SPECIFIC version, not merely presence.
CLAUDE_LABEL_VERSION="$(docker inspect -f '{{index .Config.Labels "org.chroxy.claude-code.version"}}' "$IMAGE" 2>/dev/null)"
[ -n "$CLAUDE_LABEL_VERSION" ] \
  || fail "image carries no org.chroxy.claude-code.version label — cannot verify the installed claude CLI's version against the pin"

echo "== Checking the image's claude CLI reports the pinned version ($CLAUDE_LABEL_VERSION)"
set +e
CLAUDE_VERSION_OUT="$(run_with_timeout 30 docker run --rm --init --name "$NAME-version" --entrypoint claude "$IMAGE" --version 2>&1)"
claude_version_rc=$?
set -e
[ "$claude_version_rc" -ne 124 ] || fail "claude --version timed out after 30s inside $IMAGE"
[ "$claude_version_rc" -eq 0 ] || fail "claude --version exited $claude_version_rc inside $IMAGE: $CLAUDE_VERSION_OUT"
# EXACT first-token compare, not a substring match: `claude --version` prints
# "X.Y.Z (Claude Code)", and a substring `grep -qF` against the pin would let
# a label of "2.1.28" pass against a reported "2.1.280" (the shorter string is
# contained in the longer one) — the opposite direction a version check must
# never be wrong in (#8145 review). `${var%%[[:space:]]*}` takes everything
# before the first whitespace, so a stray leading/trailing space in either
# value cannot produce a false mismatch either.
CLAUDE_VERSION_REPORTED="${CLAUDE_VERSION_OUT%%[[:space:]]*}"
[ "$CLAUDE_VERSION_REPORTED" = "$CLAUDE_LABEL_VERSION" ] \
  || fail "claude --version reported '$CLAUDE_VERSION_REPORTED', not the pinned '$CLAUDE_LABEL_VERSION': $CLAUDE_VERSION_OUT"

echo "== claude CLI OK: $CLAUDE_VERSION_OUT"

# --- 5. GET /dashboard serves the REAL BUILT bundle, not a 404 or a blank --
# The already-running, already-healthy container from check 2. curl runs
# INSIDE the container (the image has curl — see the Dockerfile's "System
# dependencies" step) rather than against a published host port, because this
# script never publishes one.
#
# #8151 review (S1): negative control FIRST — no token must be 403, proving
# auth actually gates the route before the positive check below trusts the
# token to mean anything.
echo "== Checking GET /dashboard with NO token is rejected (403)"
set +e
NOAUTH_STATUS="$(run_with_timeout 15 docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' \
  "http://localhost:${PORT}/dashboard")"
noauth_rc=$?
set -e
[ "$noauth_rc" -ne 124 ] || fail "GET /dashboard (no token) timed out after 15s inside $IMAGE"
[ "$noauth_rc" -eq 0 ] || fail "GET /dashboard (no token) inside $IMAGE could not be completed (curl exit $noauth_rc)"
[ "$NOAUTH_STATUS" = "403" ] \
  || fail "GET /dashboard with NO token returned HTTP $NOAUTH_STATUS, not 403 — auth is not actually gating the dashboard"

echo "== Checking GET /dashboard serves the built dashboard (real bundle, not the source HTML)"
set +e
DASH_STATUS="$(run_with_timeout 15 docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' \
  "http://localhost:${PORT}/dashboard?token=${DASHBOARD_TOKEN}")"
dash_status_rc=$?
DASH_BODY="$(run_with_timeout 15 docker exec "$NAME" curl -s \
  "http://localhost:${PORT}/dashboard?token=${DASHBOARD_TOKEN}")"
dash_body_rc=$?
set -e
[ "$dash_status_rc" -ne 124 ] && [ "$dash_body_rc" -ne 124 ] \
  || fail "GET /dashboard timed out after 15s inside $IMAGE"
[ "$dash_status_rc" -eq 0 ] && [ "$dash_body_rc" -eq 0 ] \
  || fail "GET /dashboard inside $IMAGE could not be completed (curl exit $dash_status_rc/$dash_body_rc)"
[ "$DASH_STATUS" = "200" ] \
  || fail "GET /dashboard returned HTTP $DASH_STATUS, not 200 (dashboard dist missing or auth rejected the smoke token?)"
grep -qF '<title>Chroxy Dashboard</title>' <<<"$DASH_BODY" \
  || fail "GET /dashboard returned 200 but the body doesn't contain the dashboard's own <title>Chroxy Dashboard</title> marker — served the wrong thing, or an empty/placeholder page"

# #8151 review (C2) — the title marker sits in the UNBUILT source index.html
# too (it has a plain <script src="/src/main.tsx"> instead of a built
# /dashboard/assets/*.js bundle), so it alone proves nothing about whether a
# BUILD actually happened. Extract every real asset reference and fetch each
# one.
#
# #8151 round-2 review (S2) — checking only the FIRST <script src> left every
# other referenced asset (a CSS stylesheet <link href>, a second JS chunk)
# completely unchecked: an emptied or missing asset other than the entry
# bundle would pass this check clean. Both tag forms are extracted here
# (`src="..."` from <script>, `href="..."` from <link>), and EVERY one is
# fetched and required to return 200 with a non-empty body.
# Built as a loop rather than `mapfile`/`readarray` (bash 4+ only) — this
# repo's scripts stay compatible with macOS's stock /bin/bash 3.2.
ASSET_PATHS=()
while IFS= read -r _asset_path; do
  [ -n "$_asset_path" ] && ASSET_PATHS+=("$_asset_path")
done < <(
  { grep_or_empty -oE 'src="(/dashboard/assets/[^"]+)"' <<<"$DASH_BODY"
    grep_or_empty -oE 'href="(/dashboard/assets/[^"]+)"' <<<"$DASH_BODY"
  } | sed -E 's/^(src|href)="//; s/"$//' | sort -u
) || fail "internal: asset-path extraction errored"
if [ "${#ASSET_PATHS[@]}" -eq 0 ]; then
  fail "GET /dashboard's HTML has no <script src=\"/dashboard/assets/*\"> or <link href=\"/dashboard/assets/*\"> tag — this is the SOURCE index.html (script src=\"/src/main.tsx\"), not a built dashboard"
fi

# The entry bundle (the one .js asset) additionally gets a minimum-size
# floor (#8151 round-2 review S2) — a 200 + non-empty body alone still
# passes a degenerate near-empty bundle (a build that silently dropped the
# app's own code while still emitting SOME output). 10KB is well under any
# real Vite-built React bundle for this app (which runs to hundreds of KB)
# and well above a stub/placeholder file.
ENTRY_BUNDLE_MIN_BYTES=10000
BUNDLE_PATH=""
for p in "${ASSET_PATHS[@]}"; do
  case "$p" in *.js) BUNDLE_PATH="$p"; break ;; esac
done
[ -n "$BUNDLE_PATH" ] \
  || fail "none of the extracted dashboard asset paths end in .js — no entry bundle to apply the size floor to: ${ASSET_PATHS[*]}"

for ASSET_PATH in "${ASSET_PATHS[@]}"; do
  echo "== Fetching dashboard asset: $ASSET_PATH"
  set +e
  ASSET_INFO="$(run_with_timeout 15 docker exec "$NAME" curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}' \
    "http://localhost:${PORT}${ASSET_PATH}?token=${DASHBOARD_TOKEN}")"
  asset_rc=$?
  set -e
  [ "$asset_rc" -ne 124 ] || fail "fetching $ASSET_PATH timed out after 15s inside $IMAGE"
  [ "$asset_rc" -eq 0 ] || fail "fetching $ASSET_PATH inside $IMAGE could not be completed (curl exit $asset_rc)"
  read -r ASSET_HTTP_CODE ASSET_CONTENT_TYPE ASSET_SIZE <<<"$ASSET_INFO"
  [ "$ASSET_HTTP_CODE" = "200" ] \
    || fail "dashboard asset $ASSET_PATH returned HTTP $ASSET_HTTP_CODE, not 200 — the dist's assets/ directory may be missing or emptied"
  [ -n "$ASSET_SIZE" ] && [ "$ASSET_SIZE" -gt 0 ] 2>/dev/null \
    || fail "dashboard asset $ASSET_PATH returned an empty body"
  if [ "$ASSET_PATH" = "$BUNDLE_PATH" ]; then
    case "$ASSET_CONTENT_TYPE" in
      application/javascript*) ;;
      *) fail "the dashboard's entry bundle ($BUNDLE_PATH) has content-type '$ASSET_CONTENT_TYPE', not application/javascript" ;;
    esac
    [ "$ASSET_SIZE" -ge "$ENTRY_BUNDLE_MIN_BYTES" ] \
      || fail "the dashboard's entry bundle ($BUNDLE_PATH) is only $ASSET_SIZE bytes (floor: ${ENTRY_BUNDLE_MIN_BYTES}) — looks like a near-empty/degenerate build, not the real app"
    BUNDLE_SIZE="$ASSET_SIZE"
  fi
done

echo "== Dashboard OK: 403 with no token, 200 + ${#ASSET_PATHS[@]} real asset(s) with one (entry bundle $BUNDLE_SIZE bytes)"

# --- 6. Every server dependency (not just @chroxy/*) is checked ------------
# Read the NAME list from the image's own packages/server/package.json (never
# this checkout's) — same "ask the shipped artifact" principle as checks 2/4.
# `@chroxy/*` names are filtered out here: check 1 above already resolves
# every @chroxy/* specifier the server ACTUALLY imports, including subpaths
# (e.g. `@chroxy/store-core/crypto`) — testing the bare `@chroxy/store-core`
# root here would fail even in a correct image, because that root export
# resolves to a TypeScript source file the server stage never copies (only
# `./crypto`'s built dist is shipped; the server has no reason to ship the
# other). Check 1 is the precise tool for workspace packages; this check's
# job is everything else.
echo "== Reading the image's own server dependency list"
set +e
DEP_JSON="$(run_with_timeout 30 docker run --rm --init --name "$NAME-depjson" --entrypoint node "$IMAGE" -e "
  const pkg = JSON.parse(require('fs').readFileSync('$IMAGE_SERVER/package.json', 'utf8'));
  const names = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
  ].filter((n) => !n.startsWith('@chroxy/'));
  process.stdout.write(JSON.stringify(names));
")"
dep_json_rc=$?
set -e
[ "$dep_json_rc" -ne 124 ] || fail "reading the image's server package.json timed out after 30s"
[ "$dep_json_rc" -eq 0 ] || fail "could not read packages/server/package.json's dependencies inside $IMAGE (exit $dep_json_rc): $DEP_JSON"

# See the header comment (check 6) for what each list means and why.
EXEMPT_JSON='[
  {"name": "node-pty", "reason": "no linux prebuild — npm ci --ignore-scripts skips the native build; the embedded terminal and claude-tui provider are unsupported in this image"}
]'
# http-routes.js's readModule(pkg, file) — the EXACT files it reads (checked
# by existence, never import()ed: see the header comment, S3).
STATIC_ASSETS_JSON='{
  "@xterm/xterm": ["lib/xterm.js", "css/xterm.css"],
  "@xterm/addon-fit": ["lib/addon-fit.js"]
}'

echo "== Checking the image's server dependencies (subpath-aware; exemptions are expected failures, not free passes)"
set +e
# shellcheck disable=SC2016
RESOLVE_OUT="$(run_with_timeout 120 docker run --rm --init --name "$NAME-deps" -w "$IMAGE_SERVER" "$IMAGE" \
  node --input-type=module -e '
    import { readFileSync, readdirSync, existsSync } from "fs"
    import { join } from "path"

    const names = JSON.parse(process.argv[1])
    const exempt = JSON.parse(process.argv[2])
    const staticAssets = JSON.parse(process.argv[3])

    if (names.length === 0) {
      console.error("FAIL: found zero dependencies in packages/server/package.json inside the image — proves nothing")
      process.exit(1)
    }

    // Bidirectional (both special-case categories): every special-cased name
    // must be a REAL declared dependency — a stale/renamed entry (the dep was
    // removed, or never existed) must fail loudly rather than silently widen
    // what this check accepts.
    const nameSet = new Set(names)
    const specialCased = [...exempt.map((e) => e.name), ...Object.keys(staticAssets)]
    const stale = specialCased.filter((n) => !nameSet.has(n))
    if (stale.length > 0) {
      for (const n of stale) {
        console.error(`FAIL: special-cased name "${n}" is not a declared dependency of packages/server/package.json — remove it or fix the typo`)
      }
      process.exit(1)
    }

    // #8151 review S2 — scan the image'"'"'s OWN server src for the
    // specifier(s) actually used per package name (bare or with a subpath),
    // so a package resolved only via a subpath is checked AT that subpath
    // rather than via a blind bare-root import.
    function walk(dir) {
      let out = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) out = out.concat(walk(p))
        else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(p)
      }
      return out
    }
    // Comment lines only (mirrors check 1'"'"'s CODE_LINES filter): a JSDoc
    // line naming a specifier in PROSE (e.g. explaining why a package'"'"'s
    // exports map does NOT allow some subpath) would otherwise be scanned as
    // if it were a real import — this is a heuristic per-line strip, not a
    // real parser, so a trailing `// comment` on a code line is not stripped;
    // that only risks a spurious EXTRA specifier tried (still checked, at
    // worst redundantly), never a real one silently skipped.
    const stripCommentLines = (text) =>
      text.split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n")
    const srcFiles = walk("src")
    const srcText = srcFiles.map((f) => stripCommentLines(readFileSync(f, "utf8"))).join("\n")

    function escapeRegex(s) {
      return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
    function specifiersUsedFor(name) {
      const re = new RegExp(
        "(?:^|[^A-Za-z0-9_$.])(?:from|import|require)\\s*\\(?\\s*[\x27\"\x60](" + escapeRegex(name) + "(?:/[A-Za-z0-9_./-]+)?)[\x27\"\x60]",
        "g",
      )
      const found = new Set()
      let m
      while ((m = re.exec(srcText))) found.add(m[1])
      return found
    }

    // #8151 round-2 review (S3) — mirror check 1'"'"'s UNRECOGNISED-line
    // floor: a line that quotes a declared dependency name (followed by a
    // closing quote or a `/subpath`) but that specifiersUsedFor'"'"'s strict
    // import-form regex does NOT match on THAT line must FAIL, naming the
    // line — rather than silently falling through to the bare-name
    // resolution, which would check `name` without ever having verified the
    // form the line actually used (a template literal, a multi-line
    // `import(`, a dynamically-built path). Scoped to a QUOTED mention
    // (quote immediately before the name, quote or /subpath immediately
    // after) to stay narrow, same as check 1'"'"'s own quote-before-the
    // -specifier precondition — an unquoted substring match would flag
    // unrelated prose/log text that happens to contain a dependency'"'"'s
    // name.
    // A bare dependency NAME is a common, unrelated string value throughout
    // this codebase (log tags like createLogger('"'"'ws'"'"'), mode ids like
    // '"'"'openai/form'"'"' compared with ===) — nothing like `@chroxy/`'"'"'s
    // near-unambiguous namespace prefix. Measured against this repo'"'"'s own
    // src/ before picking the gate below: a quote-adjacent name/subpath scan
    // with NO further restriction flagged 57 lines, none of them a real
    // import; adding "the line must also contain an import/from/require
    // keyword" (checked separately from, and in addition to, the strict
    // per-specifier regex below) brought that to zero while still catching
    // an import-shaped line the strict regex fails to recognise.
    const importKeywordRe = /(?:^|[^A-Za-z0-9_$])(?:from|import|require)(?:[^A-Za-z0-9_$]|$)/
    const checkableNames = names.filter((n) => !(n in staticAssets) && !exempt.some((e) => e.name === n))
    const srcLines = srcText.split("\n")
    const unrecognisedMentions = []
    for (const line of srcLines) {
      if (!importKeywordRe.test(line)) continue
      for (const name of checkableNames) {
        const mentionRe = new RegExp("[\x27\"\x60]" + escapeRegex(name) + "(?:/[A-Za-z0-9_./-]*)?[\x27\"\x60]")
        if (!mentionRe.test(line)) continue
        const strictRe = new RegExp(
          "(?:^|[^A-Za-z0-9_$.])(?:from|import|require)\\s*\\(?\\s*[\x27\"\x60]" + escapeRegex(name) + "(?:/[A-Za-z0-9_./-]+)?[\x27\"\x60]",
        )
        if (!strictRe.test(line)) unrecognisedMentions.push({ name, line })
      }
    }
    if (unrecognisedMentions.length > 0) {
      for (const { name, line } of unrecognisedMentions) {
        console.error(`FAIL: a line quotes dependency "${name}" in a form the specifier scan does not recognise: ${line.trim()}`)
      }
      process.exit(1)
    }

    let checked = 0
    let failed = 0

    for (const name of names) {
      if (name in staticAssets) {
        for (const file of staticAssets[name]) {
          const candidates = [join("node_modules", name, file), join("..", "..", "node_modules", name, file)]
          if (candidates.some((p) => existsSync(p))) {
            console.log(`  resolved ${name}/${file} (static asset — checked by existence, matches http-routes.js readModule)`)
            checked++
          } else {
            console.error(`FAIL: static asset "${name}/${file}" not found at either candidate path readModule checks: ${candidates.join(" or ")}`)
            failed++
          }
        }
        continue
      }

      const exemption = exempt.find((e) => e.name === name)
      if (exemption) {
        // #8151 review S3 — an EXPECTED failure, not a free pass: the import
        // is still attempted, and must actually fail; an unexpected SUCCESS
        // is reported as a failure too ("exemption no longer needed").
        try {
          await import(name)
          console.error(`FAIL: exemption "${name}" is no longer needed — it imported successfully inside this image (reason on file: ${exemption.reason})`)
          failed++
        } catch (err) {
          console.log(`  expected failure confirmed: ${name} (${exemption.reason}) — ${String(err.message).split("\n")[0]}`)
          checked++
        }
        continue
      }

      const specifiers = specifiersUsedFor(name)
      const toResolve = specifiers.size > 0 ? [...specifiers] : [name]
      for (const spec of toResolve) {
        try {
          await import(spec)
          console.log(`  resolved ${spec}`)
          checked++
        } catch (err) {
          console.error(`FAIL: dependency "${spec}" does not resolve inside the image: ${err.message}`)
          failed++
        }
      }
    }

    if (checked === 0) {
      console.error("FAIL: zero dependencies were actually checked — the floor check above must never pass on nothing checked")
      process.exit(1)
    }
    if (failed > 0) process.exit(1)
    console.log(`== ${checked} check(s) passed (${exempt.length} expected-failure exemption(s), ${Object.keys(staticAssets).length} static-asset package(s))`)
  ' "$DEP_JSON" "$EXEMPT_JSON" "$STATIC_ASSETS_JSON")"
resolve_rc=$?
set -e
printf '%s\n' "$RESOLVE_OUT"
[ "$resolve_rc" -ne 124 ] || fail "checking the image's server dependencies timed out after 120s"
[ "$resolve_rc" -eq 0 ] || fail "one or more server dependency checks failed inside $IMAGE (see FAIL lines above)"

echo "== Dependency checks OK"

# --- S1: re-check the node-pty-failure / session-teardown signature -------
# Check 3's read of `docker logs` was a single snapshot taken right after the
# Default session's "Ready for messages" line appeared. Checks 4-6 above run
# real commands against the SAME long-lived container (a separate `claude
# --version` container, two curl requests, a dependency scan) — none of them
# touch the Default session, but nothing proves the session stayed up and
# healthy for the ~minute or more those checks took to run. Re-reading the
# logs now and re-applying the SAME negative assertions catches a session
# that failed AFTER check 3's snapshot (e.g. a delayed node-pty import
# rejection, or a crash loop that only manifests a few seconds in).
echo "== Re-checking the Default session's logs at the end of the run (#8151 review S1)"
assert_no_pty_failure_signature "$(docker logs "$NAME" 2>&1)" "at end of script"
echo "== End-of-run log check OK: still no $NODE_PTY_MARKER or session-teardown signature"
