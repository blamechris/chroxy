FROM node:22-slim

LABEL org.opencontainers.image.source=https://github.com/blamechris/chroxy

# Version of @anthropic-ai/claude-code to install globally.  Pin to an exact
# version so image builds are reproducible.  Override at build time with:
#   docker build --build-arg CLAUDE_CODE_VERSION=x.y.z .
# Bump this ARG when upgrading claude-code; keep it in sync with the version
# used by the rest of the server package.
ARG CLAUDE_CODE_VERSION=2.1.128

# Install claude-code globally so the sidecar can spawn it when K8sBackend
# sends a spawn frame.  This is the only external npm dependency the image
# needs at runtime; the rest (ws) lives in the sidecar package.json below.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

WORKDIR /app

# Copy package manifest + lockfile and install with `npm ci` so the build is
# fully reproducible from package-lock.json (no fresh resolution).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY agent.js ./

# Give the unprivileged `node` user (already present in node:22-slim) ownership
# of /app, then drop root.  K8s deployments commonly set
# `securityContext.runAsNonRoot: true`, which would refuse admission otherwise.
RUN chown -R node:node /app
USER node

# WS server port — matches the default in agent.js.  K8sBackend connects here.
EXPOSE 7681

# Container-level health probe.  K8s readinessProbe is the source of truth for
# pod readiness, but this lets `docker ps` and non-K8s runtimes see status too.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7681/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/agent.js"]
