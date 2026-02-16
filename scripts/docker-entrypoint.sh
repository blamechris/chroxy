#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="$HOME/.chroxy"
CONFIG_FILE="$CONFIG_DIR/config.json"

# --- Helper: prepare config for server start ---
prepare_config() {
  # Validate ANTHROPIC_API_KEY
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "ERROR: ANTHROPIC_API_KEY is required."
    echo "  docker run -e ANTHROPIC_API_KEY=sk-ant-... chroxy"
    echo "  Or set it in your .env file."
    exit 1
  fi

  mkdir -p "$CONFIG_DIR"

  # Resolve API token: env var > existing config > generate new
  if [ -z "${API_TOKEN:-}" ]; then
    if [ -f "$CONFIG_FILE" ]; then
      # Preserve existing token across restarts
      API_TOKEN="$(node -e "const fs=require('fs');let c={};try{c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));}catch(e){}process.stdout.write(c.apiToken||'');" "$CONFIG_FILE")"
    fi
    if [ -z "${API_TOKEN:-}" ]; then
      API_TOKEN="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)"
      echo ""
      echo "================================================"
      echo "  Generated API token."
      echo "  Prefix: ${API_TOKEN:0:8}..."
      echo "  Full token stored in $CONFIG_FILE"
      echo "================================================"
      echo ""
    fi
  fi
  export API_TOKEN

  # Always write config from current env vars + resolved token
  node -e "
    const fs = require('fs');
    const config = {
      apiToken: process.env.API_TOKEN,
      port: parseInt(process.env.PORT || '8765', 10),
      shell: '/bin/bash'
    };
    fs.writeFileSync(process.argv[1], JSON.stringify(config, null, 2));
  " "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  echo "[entrypoint] Config written to $CONFIG_FILE"
}

# --- Route command ---
# If the first arg starts with '-', treat it as flags for the default 'start' command
if [ "${1:0:1}" = "-" ] 2>/dev/null; then
  CMD="start"
else
  CMD="${1:-start}"
  shift || true
fi

case "$CMD" in
  start)
    # Docker image is headless-only: no tmux, node-pty not compiled.
    # Fail fast if --terminal is requested.
    for arg in "$@"; do
      if [ "$arg" = "--terminal" ] || [ "$arg" = "-t" ]; then
        echo "ERROR: Terminal mode (--terminal) is not supported in Docker."
        echo "This container runs in headless mode only (no tmux/node-pty)."
        echo "Remove --terminal to use the default SDK mode."
        exit 1
      fi
    done
    prepare_config
    exec node /app/packages/server/src/cli.js start "$@"
    ;;
  doctor)
    exec node /app/packages/server/src/cli.js doctor "$@"
    ;;
  *)
    exec "$CMD" "$@"
    ;;
esac
