FROM node:22-slim

# System dependencies (no tmux, no build-essential — CLI headless mode only)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    bash \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install cloudflared (multi-arch)
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}" \
      -o /usr/local/bin/cloudflared && \
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

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:${PORT:-8765}/ || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["start"]
