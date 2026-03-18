# Container Isolation Guide

Chroxy supports three levels of session isolation, from lightweight sandboxing to full Docker containers. This guide covers when to use each mode, how to configure them, and how to troubleshoot common issues.

## Isolation Modes

### Sandbox (Lightweight, No Docker)

Sandbox mode uses the Agent SDK's built-in isolation. It restricts file system access and network operations without requiring Docker. This is the simplest option and suitable for most use cases where you want to limit what Claude can access on the host.

**When to use:** You want basic isolation (restricted paths, network controls) without the overhead of Docker.

### Container (Full Docker Isolation)

Container mode runs Claude Code inside a Docker container. The project directory is bind-mounted into the container at `/workspace`. Each session gets its own container with configurable resource limits (memory, CPU, PIDs). Two container providers are available:

- **`docker`** (DockerSession) -- CLI-based, extends CliSession. Runs `claude -p` via `docker exec`.
- **`docker-sdk`** (DockerSdkSession) -- SDK-based, extends SdkSession. Uses the Agent SDK's `spawnClaudeCodeProcess` callback to run the CLI process inside a container while the SDK manages the conversation loop in-process.

**When to use:** You need strong isolation -- untrusted code execution, multi-tenant environments, or strict resource limits.

### Combined (Sandbox + Container)

You can enable both sandbox and container isolation simultaneously. The SDK sandbox settings apply inside the container, giving defense-in-depth: the container restricts host access while the sandbox further restricts what Claude can do within the container.

**When to use:** Maximum security. The container prevents host access; the sandbox limits behavior inside the container.

## Provider Comparison

| Feature | `docker` (DockerSession) | `docker-sdk` (DockerSdkSession) |
|---|---|---|
| Base class | CliSession | SdkSession |
| Claude invocation | `docker exec -i <id> claude -p` | SDK `spawnClaudeCodeProcess` callback |
| Permission handling | HTTP hook (routed to host) | In-process via SDK `canUseTool` |
| Live model switch | Requires respawn | In-place (no restart) |
| Live permission mode switch | Requires respawn | In-place (no restart) |
| Conversation resume | No | Yes |
| Container user | root | Non-root (`chroxy` by default) |
| Claude Code install | Must exist in image (not auto-installed) | Auto-installed on container start |
| Plan mode | Yes | No (SDK limitation) |

Both providers share the same container lifecycle and security defaults:

- **Image:** `node:22-slim`
- **Memory limit:** 2 GB
- **CPU limit:** 2 cores
- **PID limit:** 512
- **Capabilities:** All dropped (`--cap-drop ALL`)
- **Privilege escalation:** Blocked (`--security-opt no-new-privileges`)
- **Workspace:** Host project directory mounted at `/workspace`

## Configuration

### Enabling Docker Providers

Docker providers are opt-in. You must enable environments *and* have Docker available on the host.

**CLI flag:**

```bash
npx chroxy start --environments --provider docker-sdk
```

**Config file** (`~/.chroxy/config.json`):

```json
{
  "environments": { "enabled": true },
  "provider": "docker-sdk"
}
```

**Environment variable:**

```bash
CHROXY_PROVIDER=docker-sdk npx chroxy start --environments
```

The `--environments` flag triggers Docker availability detection at startup. If `docker info` fails, the docker providers are silently skipped and the server falls back to the default provider.

### Configuring Sandbox Mode

Sandbox settings are passed directly to the Agent SDK. No Docker required.

**Config file:**

```json
{
  "sandbox": {
    "type": "container",
    "network": false,
    "writePaths": ["/tmp"],
    "readPaths": ["/home/user/project"]
  }
}
```

**Environment variable:**

```bash
CHROXY_SANDBOX='{"type":"container","network":false}' npx chroxy start
```

### Per-Session Provider Selection

When creating a session via the WebSocket protocol, you can specify the provider per session:

```json
{
  "type": "create_session",
  "name": "Isolated Session",
  "cwd": "/home/user/project",
  "provider": "docker-sdk"
}
```

This lets you run some sessions with full Docker isolation and others with the default in-process provider, all on the same server.

### Per-Session Sandbox Settings

Sandbox settings can also be specified per session at creation time:

```json
{
  "type": "create_session",
  "name": "Sandboxed Session",
  "sandbox": { "type": "container", "network": false }
}
```

## Resource Limits

Default container resource limits are set in the provider constructors. To customize, pass options when constructing the provider programmatically:

| Setting | Default | Description |
|---|---|---|
| `image` | `node:22-slim` | Docker image |
| `memoryLimit` | `2g` | Container memory limit |
| `cpuLimit` | `2` | CPU core limit |
| PID limit | 512 | Max processes in container |

These are currently set at the provider level. To change defaults, modify the constructor defaults in `docker-session.js` or `docker-sdk-session.js`.

## Security Details

### Environment Variable Forwarding

Containers receive only an explicit allowlist of environment variables. The full host environment is never forwarded.

**DockerSession** forwards:
`ANTHROPIC_API_KEY`, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, `CHROXY_PORT`, `CHROXY_HOOK_SECRET`, `CHROXY_PERMISSION_MODE`, `CLAUDE_HEADLESS`, `HOME`, `PATH`, and conditionally `CHROXY_HOST` (set to `host.docker.internal` when the permission hook port is configured)

**DockerSdkSession** forwards:
`ANTHROPIC_API_KEY`, `NODE_ENV`, plus hardcoded overrides: `HOME=/home/<containerUser>` and a fixed `PATH` for the container environment (these are not forwarded from the host)

### Permission Hook Routing (DockerSession only)

DockerSession uses the CLI's HTTP permission hook, which must reach the Chroxy server on the host. The container sets `CHROXY_HOST=host.docker.internal` so the hook can call back to the host. On Linux, `--add-host host.docker.internal:host-gateway` is added automatically.

DockerSdkSession does not need this -- permissions are handled in-process by the SDK's `canUseTool` callback.

### Non-Root Execution (DockerSdkSession)

DockerSdkSession creates a non-root user (`chroxy` by default) inside the container. Claude Code refuses `--dangerously-skip-permissions` when running as root, so the non-root user is required. The username is configurable via the `containerUser` option and must be a valid POSIX username.

## Troubleshooting

### Docker Not Available

**Symptom:** Server starts but docker/docker-sdk providers are not listed.

**Check:**
```bash
docker info
```

If Docker is not running or not installed, the `registerDockerProvider()` call silently skips registration. The server log will show:

```
[providers] Docker not available — docker providers disabled
```

**Fix:** Install and start Docker, then restart the server with `--environments`.

### Container Startup Failure

**Symptom:** Session creation fails with "Failed to start Docker container".

**Common causes:**
- Docker image not pulled yet (first run may take time -- 120s timeout)
- Insufficient disk space for the image
- Docker resource limits exceeded on the host

**Check:**
```bash
docker pull node:22-slim
docker run --rm node:22-slim echo ok
```

### Claude Not Found in Container (docker provider only)

**Symptom:** Session starts but immediately errors with "claude: not found" or similar.

The `docker` provider (DockerSession) does **not** auto-install Claude Code -- it expects the `claude` CLI to already exist in the container image. The default `node:22-slim` image does not include it.

**Fix:** Use a custom image with Claude Code pre-installed, or install it in the container image:
```dockerfile
FROM node:22-slim
RUN npm install -g @anthropic-ai/claude-code
```

Then set the custom image in your config:
```json
{ "environments": { "enabled": true, "image": "your-custom-image:latest" } }
```

> **Note:** The `docker-sdk` provider auto-installs Claude Code on each container start, so this issue does not apply to it.

### Claude Code Installation Failure (docker-sdk only)

**Symptom:** "Failed to install Claude Code in container"

DockerSdkSession installs `@anthropic-ai/claude-code` globally via npm inside the container on each start. This requires network access from the container to the npm registry.

**Check:**
```bash
docker run --rm node:22-slim npm ping
```

### Path Mapping Issues

**Symptom:** Claude cannot find files or writes to unexpected locations.

The project directory is mounted at `/workspace` inside the container. DockerSdkSession remaps the host's absolute paths to `/workspace`-relative paths automatically. If the SDK passes a path outside the mounted directory, it falls back to `/workspace`.

**Verify the mount:**
```bash
docker inspect <container-id> --format '{{json .Mounts}}'
```

### Permission Hook Unreachable (docker provider only)

**Symptom:** Permission requests time out or are auto-denied.

The `docker` provider (DockerSession) routes permission hooks to `host.docker.internal`. On Linux, this requires the `--add-host` flag (added automatically). On macOS/Windows, `host.docker.internal` resolves natively.

**Test connectivity from inside a container:**
```bash
docker run --rm --add-host host.docker.internal:host-gateway \
  node:22-slim curl -s http://host.docker.internal:<PORT>/
```

Replace `<PORT>` with the Chroxy server port (default: 3000).

### Container Cleanup

Containers are created with `--rm` and cleaned up on session destroy. If the server crashes without calling `destroy()`, orphaned containers may remain.

**Find orphaned containers:**
```bash
docker ps -a --filter ancestor=node:22-slim
```

**Clean up:**
```bash
docker rm -f <container-id>
```
