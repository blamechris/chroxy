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

  # Generate config.json if it doesn't exist
  if [ ! -f "$CONFIG_FILE" ]; then
    mkdir -p "$CONFIG_DIR"

    # Generate or use provided API token
    if [ -z "${API_TOKEN:-}" ]; then
      API_TOKEN="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)"
      echo ""
      echo "================================================"
      echo "  Generated API token (save this for your app):"
      echo "  $API_TOKEN"
      echo "================================================"
      echo ""
    fi

    # Build config JSON (use node to safely serialize values)
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
  fi
}

# --- Route command ---
CMD="${1:-start}"
shift || true

case "$CMD" in
  start)
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
