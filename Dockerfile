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

# Stub app package.json so npm workspace resolution succeeds
RUN mkdir -p packages/app && echo '{"name":"@chroxy/app","version":"0.1.0","private":true}' > packages/app/package.json

# Install server dependencies only (skip node-pty native compilation)
RUN npm ci --workspace=@chroxy/server --omit=dev --ignore-scripts

# Copy server source
COPY packages/server/ packages/server/

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
