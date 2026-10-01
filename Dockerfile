# Declared ONCE, above the first FROM, and re-declared bare (no default) in
# each stage that needs it (#8145 review) — Docker's documented pattern for a
# single value shared across stages. The old shape — a second, INDEPENDENT
# `ARG` default for this same name inside the final stage — could drift from
# this one with no build error, which is exactly the defect class this pin
# exists to prevent one layer up (docs/false-safety-guards.md): the LABEL and
# the verified binary could silently disagree. It is also why only ONE
# assignment of this ARG's default may exist anywhere in this file: Renovate's
# regex manager and packages/server/tests/dockerfile-claude-version-floor.
# test.js's PIN_RE both key off that literal spelling (name, then bare `=`,
# then a value with no space), and a bare re-declaration below has no `=` to
# match.
ARG CLAUDE_CODE_VERSION=2.1.280

FROM node:22-slim AS claude-cli

# Pinned, signature-verified Claude Code CLI for the final image (#8145).
# This stage downloads one exact release straight from Anthropic's release
# bucket and verifies it before the final stage ever sees it:
#   1. the GPG key that signs releases is fetched, imported into a throwaway
#      keyring, and its fingerprint is checked against the pin below — an
#      unpinned `gpg --import` would trust whatever key the download
#      happened to return;
#   2. the checked key is re-exported, BY FINGERPRINT, into its own
#      single-key keyring file. This step is the fix for a real bypass
#      (#8170 review, reproduced twice): the downloaded `claude-code.asc` is
#      not guaranteed to hold only one key — an attacker controlling the
#      download can APPEND a second key to it. Checking that the pinned
#      fingerprint is present SOMEWHERE in an imported keyring, then
#      verifying with `gpg --verify` against that WHOLE keyring, accepts a
#      signature from either key: the pin was checked, but nothing then
#      stopped the OTHER key from signing. Exporting just the one fingerprint
#      into its own file, and verifying with `gpgv --keyring` against THAT
#      file, cannot accept a signature from any key but the one just checked.
#   3. the release manifest and its detached signature are downloaded and
#      verified with `gpgv` against that single-key keyring — never
#      `gpg --verify`, which trusts every key in whatever keyring it is
#      pointed at;
#   4. the manifest's own `version` field must equal the pin (catches a
#      substituted or off-channel manifest slipping past a valid signature);
#   5. the platform binary is downloaded and checked against the manifest's
#      sha256 checksum.
# Every step fails the build on mismatch — no `|| true`, no silent fallback.
# curl/ca-certificates/gnupg are installed ONLY in this throwaway stage; the
# final image never gets a GPG toolchain. `gpgv` ships in the same `gnupg`
# apt package as `gpg` — no extra install — and is used deliberately in place
# of `gpg --verify --assert-signer`, which needs gnupg >=2.4.1; this image's
# base (Debian bookworm) ships 2.2.40.
#
# Docs: https://code.claude.com/docs/en/setup, "Binary integrity and code
# signing" — key URL, fingerprint and manifest/signature layout below are
# taken from there (confirmed 2026-09-30).
ARG CLAUDE_CODE_VERSION
ARG CLAUDE_CODE_SIGNING_FPR=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /claude-cli

# node:22-slim is glibc (Debian), not musl, so the platform key is always the
# non-musl one. Uses dpkg --print-architecture, matching the cloudflared step
# below, rather than TARGETARCH (this Dockerfile declares no such ARG).
RUN set -eu; \
    ARCH="$(dpkg --print-architecture)"; \
    case "$ARCH" in \
      amd64) PLATFORM=linux-x64 ;; \
      arm64) PLATFORM=linux-arm64 ;; \
      *) echo "claude-cli: unsupported architecture '$ARCH' (expected amd64 or arm64)" >&2; exit 1 ;; \
    esac; \
    echo "$PLATFORM" > /claude-cli/platform

# Fetch the release signing key into a throwaway keyring, confirm the pinned
# fingerprint is present, then re-export JUST that key (by fingerprint) into
# its own single-key keyring file — see the stage header for why "the pin is
# present somewhere in the download" is not the same claim as "only the
# pinned key can sign".
ENV GNUPGHOME=/claude-cli/gnupg
RUN set -eu; \
    mkdir -p "$GNUPGHOME" && chmod 700 "$GNUPGHOME"; \
    curl --proto '=https' --tlsv1.2 -fsSL https://downloads.claude.ai/keys/claude-code.asc -o /claude-cli/claude-code.asc; \
    gpg --batch --import /claude-cli/claude-code.asc; \
    FPR="$(gpg --batch --with-colons --fingerprint security@anthropic.com \
      | awk -F: '/^fpr:/ { print $10; exit }')"; \
    if [ "$FPR" != "$CLAUDE_CODE_SIGNING_FPR" ]; then \
      echo "claude-cli: release key fingerprint mismatch: got '$FPR', expected '$CLAUDE_CODE_SIGNING_FPR'" >&2; \
      exit 1; \
    fi; \
    echo "claude-cli: key fingerprint OK: $FPR"; \
    gpg --batch --export "$FPR" > /claude-cli/release-key.gpg; \
    if [ ! -s /claude-cli/release-key.gpg ]; then \
      echo "claude-cli: exporting the pinned key produced an empty keyring file" >&2; \
      exit 1; \
    fi

# Fetch the signed release manifest and verify it against ONLY the pinned key
# — gpgv, not `gpg --verify`: gpgv trusts nothing beyond the exact --keyring
# file it is given, so a second key anywhere in the download tree cannot
# vouch for anything here.
RUN set -eu; \
    REPO=https://downloads.claude.ai/claude-code-releases; \
    curl --proto '=https' --tlsv1.2 -fsSL "$REPO/${CLAUDE_CODE_VERSION}/manifest.json" -o /claude-cli/manifest.json; \
    curl --proto '=https' --tlsv1.2 -fsSL "$REPO/${CLAUDE_CODE_VERSION}/manifest.json.sig" -o /claude-cli/manifest.json.sig; \
    gpgv --keyring /claude-cli/release-key.gpg /claude-cli/manifest.json.sig /claude-cli/manifest.json

# The manifest's own top-level version must equal the pin: a signature check
# alone would happily pass on a correctly-signed manifest for the WRONG
# version if the URL above were ever mis-substituted.
RUN set -eu; \
    MVER="$(node -e "console.log(JSON.parse(require('fs').readFileSync('/claude-cli/manifest.json','utf8')).version)")"; \
    if [ "$MVER" != "$CLAUDE_CODE_VERSION" ]; then \
      echo "claude-cli: manifest version '$MVER' does not match pinned CLAUDE_CODE_VERSION '$CLAUDE_CODE_VERSION'" >&2; \
      exit 1; \
    fi

# Download the platform binary and verify it against the manifest's checksum.
# node reads the JSON (no jq in this image, same as elsewhere in this file).
RUN set -eu; \
    PLATFORM="$(cat /claude-cli/platform)"; \
    REPO=https://downloads.claude.ai/claude-code-releases; \
    curl --proto '=https' --tlsv1.2 -fsSL "$REPO/${CLAUDE_CODE_VERSION}/${PLATFORM}/claude" -o /claude-cli/claude; \
    CHECKSUM="$(node -e "console.log(JSON.parse(require('fs').readFileSync('/claude-cli/manifest.json','utf8')).platforms['$PLATFORM'].checksum)")"; \
    echo "${CHECKSUM}  /claude-cli/claude" | sha256sum -c -; \
    chmod 0755 /claude-cli/claude

# #8151 — build the web dashboard (@chroxy/dashboard, Vite) so the final image
# can serve it at /dashboard instead of 404ing. Separate builder stage: the
# final image only ever gets the built `dist/`, never the dashboard's own
# node_modules (react, vite, mermaid, ...) or its TypeScript sources.
FROM node:22-slim AS dashboard-builder

WORKDIR /app

# Same two-phase install as the server stage below, and for the same reason:
# a workspace's package.json present at `npm ci` time makes npm run that
# workspace's OWN `prepare` script even under --ignore-scripts (there is no
# TypeScript toolchain in this stage's node_modules until after ci). Only
# @chroxy/dashboard itself has neither a `prepare` script nor an out-of-date
# dist directory, so ONLY its package.json — plus the two root files
# `npm ci --workspace` needs to resolve the workspace — is present up front.
COPY package.json package-lock.json ./
COPY packages/dashboard/package.json packages/dashboard/

# Full install (dev deps included — vite/react/@vitejs/plugin-react/typescript
# are devDependencies and the build needs them) of ONLY @chroxy/dashboard's own
# dependency graph — not the whole monorepo, and in particular not the Expo
# app (`--workspace` scopes both the linked workspaces AND what gets fetched).
RUN npm ci --workspace=@chroxy/dashboard --ignore-scripts --no-audit --no-fund

# Now that ci has already run, bring in the rest of the dashboard's own
# source and the three workspace packages it imports at build time.
# @chroxy/design-tokens has no prepare/build step (plain .js source, no
# dist) so it's safe to copy in one shot. @chroxy/protocol and
# @chroxy/store-core mirror the server stage's protocol/store-core copy
# below: package.json + their COMMITTED dist/ only, deferred until after ci
# for the same prepare-script reason. store-core's `"."` export (unlike its
# `"./crypto"` subpath) resolves to raw `src/index.ts` — Vite transforms that
# directly, no build step — so its `src/` is copied too, dist is not enough.
COPY packages/dashboard/ packages/dashboard/
COPY packages/design-tokens/ packages/design-tokens/
COPY packages/protocol/package.json packages/protocol/
COPY packages/protocol/dist/ packages/protocol/dist/
COPY packages/store-core/package.json packages/store-core/
COPY packages/store-core/dist/ packages/store-core/dist/
COPY packages/store-core/src/ packages/store-core/src/

RUN npm run build -w @chroxy/dashboard

FROM node:22-slim

# System dependencies (no tmux, no build-essential — CLI headless mode only)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install cloudflared (multi-arch, pinned version + checksum verification)
ARG CLOUDFLARED_VERSION=2026.2.0
ARG CLOUDFLARED_SHA256_AMD64=176746db3be7dc7bd48f3dd287c8930a4645ebb6e6700f883fddda5a4c307c16
ARG CLOUDFLARED_SHA256_ARM64=03c5d58e283f521d752dc4436014eb341092edf076eb1095953ab82debe54a8e
RUN ARCH=$(dpkg --print-architecture) && \
    curl --proto '=https' --tlsv1.2 -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${ARCH}" \
      -o /usr/local/bin/cloudflared && \
    EXPECTED=$(eval echo "\$CLOUDFLARED_SHA256_$(echo $ARCH | tr a-z A-Z | tr - _)") && \
    echo "${EXPECTED}  /usr/local/bin/cloudflared" | sha256sum -c - && \
    chmod +x /usr/local/bin/cloudflared

WORKDIR /app

# Copy package files for dependency installation
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/

# Stub app package.json so npm workspace resolution succeeds. No version field:
# npm ci does not compare it, and a hardcoded one only goes stale.
RUN mkdir -p packages/app && echo '{"name":"@chroxy/app","private":true}' > packages/app/package.json

# Install server dependencies only (skip native compilation for optional deps).
# --no-audit/--no-fund: the audit call has stalled 17-48s per install against
# the registry (#7616), and the workflow-level NPM_CONFIG_* settings that
# disable it in CI do not reach inside `docker build`.
RUN npm ci --workspace=@chroxy/server --omit=dev --ignore-scripts --no-audit --no-fund

# Copy server source
COPY packages/server/ packages/server/

# #8133 — the server imports two sibling workspace packages at runtime
# (@chroxy/protocol, @chroxy/store-core/crypto). `npm ci` links
# node_modules/@chroxy/<name> -> packages/<name>, so both directories must exist
# in the image or the links dangle and `start` dies with ERR_MODULE_NOT_FOUND.
# Each needs only its package.json (the exports map) and its committed dist/.
# They are copied AFTER npm ci on purpose: with a workspace's package.json
# present, npm ci runs its `prepare` script (`tsc`) even under
# --ignore-scripts, and the image has no TypeScript toolchain.
COPY packages/protocol/package.json packages/protocol/
COPY packages/protocol/dist/ packages/protocol/dist/
COPY packages/store-core/package.json packages/store-core/
COPY packages/store-core/dist/ packages/store-core/dist/

# #8151 — the built dashboard, and ONLY the built dashboard: no node_modules,
# no TypeScript sources, no dev toolchain. http-routes.js resolves
# packages/dashboard/dist relative to packages/server/src at runtime, so this
# must land at exactly that path for `/dashboard` to serve it instead of 404ing.
COPY --from=dashboard-builder /app/packages/dashboard/dist packages/dashboard/dist

# Copy and prepare entrypoint
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Pinned, signature-verified claude CLI (#8145) — built and verified in the
# claude-cli stage above. Copied here, before USER chroxy, so it lands
# root:root 0755 like the rest of /usr/local/bin. Bare re-declare of the
# global ARG above the first FROM — see that declaration for why there is
# only one line in this file that assigns CLAUDE_CODE_VERSION a value.
ARG CLAUDE_CODE_VERSION
COPY --from=claude-cli --chown=root:root --chmod=0755 /claude-cli/claude /usr/local/bin/claude

# The image is immutable — a new claude version means a new image build, not
# an in-place update repointing the pinned, verified binary above.
ENV DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1
# Records the pinned version so the smoke test can read it (docker inspect)
# without parsing this file.
LABEL org.chroxy.claude-code.version=$CLAUDE_CODE_VERSION

# #8151 (owner decision) — this image supports exactly two things: the
# headless claude-sdk provider, and the web dashboard (copied in above). It
# does NOT support the embedded user-shell terminal or the claude-tui
# provider: both need node-pty, which has no prebuilt linux binary and whose
# native build this image deliberately skips (`npm ci --ignore-scripts`, no
# build-essential/python3 above — see the "System dependencies" comment).
# claude-tui also assumes an interactive login shell, which a container has
# none of. Both fail with a clear "node-pty is unavailable here
# [PTY_UNAVAILABLE] — use the claude-sdk provider instead" message rather than
# crashing or hanging — see
# claude-tui-session.js / user-shell-session.js's node-pty import catch, and
# docs/self-hosting-guide.md's Docker section.
#
# `config.js` maps `provider` from `CHROXY_PROVIDER` with the usual
# CLI > env > config-file > default precedence, so `docker run -e
# CHROXY_PROVIDER=claude-tui ...` still overrides this — it just won't work,
# for the reason above. Without this line the daemon's own default
# (DEFAULT_PROVIDER, currently claude-tui) would apply instead, which is
# exactly the "fails obscurely" case this issue is about.
ENV CHROXY_PROVIDER=claude-sdk

# Create non-root user with home directory for config
RUN useradd -m -s /bin/bash chroxy && \
    mkdir -p /home/chroxy/.chroxy /home/chroxy/.claude /workspace && \
    chown -R chroxy:chroxy /home/chroxy /workspace /app

USER chroxy
ENV HOME=/home/chroxy

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:${PORT:-8765}/ || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["start"]
