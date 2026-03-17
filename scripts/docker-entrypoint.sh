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

  # Security: block noAuth + tunnel combination.
  # Running without authentication while exposing a public tunnel URL would
  # allow anyone with the tunnel URL to execute arbitrary commands in the
  # mounted workspace. Refuse to start in this configuration.
  local tunnel_mode="${CHROXY_TUNNEL:-quick}"
  local no_auth="${CHROXY_NO_AUTH:-}"
  if [ "$no_auth" = "true" ] || [ "$no_auth" = "1" ]; then
    if [ "$tunnel_mode" != "none" ]; then
      echo "ERROR: Unsafe configuration — CHROXY_NO_AUTH=true cannot be combined with an active tunnel."
      echo "  Tunnel mode is '${tunnel_mode}'. A public tunnel with no authentication"
      echo "  exposes the server to anyone who discovers the URL."
      echo ""
      echo "  To fix: set CHROXY_TUNNEL=none, or remove CHROXY_NO_AUTH."
      exit 1
    fi
  fi

  # Security: reject WORKSPACE_PATH values that resolve to system directories.
  # Mounting /, /etc, /usr, etc. into the container would give Claude read/write
  # access to the host's critical filesystem paths via the workspace bind mount.
  local workspace_path="${WORKSPACE_PATH:-}"
  if [ -n "$workspace_path" ]; then
    local resolved_path
    resolved_path="$(realpath -m "$workspace_path" 2>/dev/null || echo "$workspace_path")"
    # Block system directories and any subdirectories of them
    local blocked_prefixes="/bin /boot /dev /etc /lib /lib64 /proc /root /run /sbin /sys /usr /var"
    if [ "$resolved_path" = "/" ]; then
      echo "ERROR: WORKSPACE_PATH resolves to /  — mounting the root filesystem is not allowed."
      exit 1
    fi
    for prefix in $blocked_prefixes; do
      if [ "$resolved_path" = "$prefix" ] || echo "$resolved_path" | grep -q "^${prefix}/"; then
        echo "ERROR: WORKSPACE_PATH resolves to a system directory: ${resolved_path}"
        echo "  Paths under ${prefix}/ are not allowed as workspace mounts."
        echo "  Set WORKSPACE_PATH to your project directory instead."
        exit 1
      fi
    done
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
