FROM node:22-slim

LABEL org.opencontainers.image.source=https://github.com/blamechris/chroxy

# Install claude-code globally so the sidecar can spawn it when K8sBackend
# sends a spawn frame.  This is the only external npm dependency the image
# needs at runtime; the rest (ws) lives in the sidecar package.json below.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy only the sidecar directory — the full chroxy server is not needed inside
# the pod image.
COPY package.json ./
RUN npm install --omit=dev

COPY agent.js ./

# WS server port — matches the default in agent.js.  K8sBackend connects here.
EXPOSE 7681

ENTRYPOINT ["node", "/app/agent.js"]
