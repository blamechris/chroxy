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
