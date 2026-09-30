FROM node:22-slim AS claude-cli

# Pinned, signature-verified Claude Code CLI for the final image (#8145). This
# stage downloads one exact release straight from Anthropic's release bucket
# and verifies it before the final stage ever sees it:
#   1. the GPG key that signs releases is fetched and its fingerprint is
#      checked against the pin below — an unpinned `gpg --import` would trust
#      whatever key the download happened to return;
#   2. the release manifest and its detached signature are downloaded and
#      `gpg --verify`d against that key;
#   3. the manifest's own `version` field must equal the pin (catches a
#      substituted or off-channel manifest slipping past a valid signature);
#   4. the platform binary is downloaded and checked against the manifest's
#      sha256 checksum.
# Every step fails the build on mismatch — no `|| true`, no silent fallback.
# curl/ca-certificates/gnupg are installed ONLY in this throwaway stage; the
# final image never gets a GPG toolchain.
#
# Docs: https://code.claude.com/docs/en/setup, "Binary integrity and code
# signing" — key URL, fingerprint and manifest/signature layout below are
# taken from there (confirmed 2026-09-30).
ARG CLAUDE_CODE_VERSION=2.1.280
ARG CLAUDE_CODE_SIGNING_KEY_FPR=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE

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

# Fetch the release signing key into a throwaway keyring and refuse to
# proceed unless its fingerprint is EXACTLY the pinned one.
ENV GNUPGHOME=/claude-cli/gnupg
RUN set -eu; \
    mkdir -p "$GNUPGHOME" && chmod 700 "$GNUPGHOME"; \
    curl -fsSL https://downloads.claude.ai/keys/claude-code.asc -o /claude-cli/claude-code.asc; \
    gpg --batch --import /claude-cli/claude-code.asc; \
    FPR="$(gpg --batch --with-colons --fingerprint security@anthropic.com \
      | awk -F: '/^fpr:/ { print $10; exit }')"; \
    if [ "$FPR" != "$CLAUDE_CODE_SIGNING_KEY_FPR" ]; then \
      echo "claude-cli: release key fingerprint mismatch: got '$FPR', expected '$CLAUDE_CODE_SIGNING_KEY_FPR'" >&2; \
      exit 1; \
    fi; \
    echo "claude-cli: key fingerprint OK: $FPR"

# Fetch the signed release manifest and verify it against that key.
RUN set -eu; \
    REPO=https://downloads.claude.ai/claude-code-releases; \
    curl -fsSL "$REPO/${CLAUDE_CODE_VERSION}/manifest.json" -o /claude-cli/manifest.json; \
    curl -fsSL "$REPO/${CLAUDE_CODE_VERSION}/manifest.json.sig" -o /claude-cli/manifest.json.sig; \
    gpg --batch --verify /claude-cli/manifest.json.sig /claude-cli/manifest.json

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
    curl -fsSL "$REPO/${CLAUDE_CODE_VERSION}/${PLATFORM}/claude" -o /claude-cli/claude; \
    CHECKSUM="$(node -e "console.log(JSON.parse(require('fs').readFileSync('/claude-cli/manifest.json','utf8')).platforms['$PLATFORM'].checksum)")"; \
    echo "${CHECKSUM}  /claude-cli/claude" | sha256sum -c -; \
    chmod 0755 /claude-cli/claude

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
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${ARCH}" \
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

# Copy and prepare entrypoint
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Pinned, signature-verified claude CLI (#8145) — built and verified in the
# claude-cli stage above. Copied here, before USER chroxy, so it lands
# root:root 0755 like the rest of /usr/local/bin.
ARG CLAUDE_CODE_VERSION=2.1.280
COPY --from=claude-cli --chown=root:root --chmod=0755 /claude-cli/claude /usr/local/bin/claude

# The image is immutable — a new claude version means a new image build, not
# an in-place update repointing the pinned, verified binary above.
ENV DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1
# Records the pinned version so the smoke test can read it (docker inspect)
# without parsing this file.
LABEL org.chroxy.claude-code.version=$CLAUDE_CODE_VERSION

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
