# Docker/Rancher Environment Integration — Design Investigation

Investigation into adding container-based isolated development environments to Chroxy, enabling per-session or per-environment Docker containers that work like git worktrees for entire OS-level state.

**Status:** Investigation / Design Phase
**Date:** 2026-03-16

---

## Problem Statement

Today, all Chroxy sessions share the same host filesystem and process space. If Session A runs `rm -rf node_modules && npm install` or switches to a different git branch, it affects every other session working in the same directory. There's no isolation between concurrent sessions beyond separate conversation state.

**Goal:** Let users optionally run sessions inside isolated Docker containers — each with its own filesystem, dependencies, running services, and environment variables — that can be snapshotted, branched, and destroyed independently.

---

## Current Architecture (Relevant Parts)

### Session Management

`SessionManager` (`packages/server/src/session-manager.js`) manages session lifecycle:
- Creates sessions with a `cwd`, `model`, `permissionMode`, and `providerType`
- Each session is a provider instance (EventEmitter) created via the provider registry
- Sessions are stored in a Map: `sessionId → { session, name, cwd, createdAt }`
- State persisted to `~/.chroxy/session-state.json` (survives restarts)
- Max 5 concurrent sessions (configurable)

### Provider Registry

`providers.js` defines a clean plugin interface:
```js
registerProvider('my-provider', MySessionClass)
// Then: npx chroxy start --provider my-provider
```

All providers must:
- Extend EventEmitter (or BaseSession)
- Accept config: `{ cwd, model, permissionMode, port, apiToken, resumeSessionId, transforms }`
- Expose: `start()`, `destroy()`, `sendMessage()`, `setModel()`, `setPermissionMode()`
- Expose properties: `model`, `permissionMode`, `isRunning`, `resumeSessionId`
- Implement `static get capabilities()` returning feature flags
- Emit standard events: `ready`, `stream_start`, `stream_delta`, `stream_end`, `message`, `tool_start`, `result`, `error`, `user_question`, `agent_spawned`, `agent_completed`

Built-in providers: `claude-sdk` (Agent SDK), `claude-cli` (legacy CLI), `gemini`, `codex`

### Existing Docker Support

Chroxy already has a `Dockerfile` and `docker-compose.yml` for running the **server itself** in a container:
- Base image: `node:22-slim` with `cloudflared`, `git`, `curl`
- Non-root `chroxy` user
- Volumes: `~/.chroxy` (config), `~/.claude` (settings), `/workspace` (project)
- Healthcheck on port 8765

This is **server-level** containerization. The proposed integration is **session-level** containerization — a fundamentally different model.

### Checkpoint System

`CheckpointManager` (`packages/server/src/checkpoint-manager.js`) captures:
- SDK conversation ID (for resume)
- Git snapshot (commit object, not stash — safe for concurrent sessions)
- Metadata: timestamp, name, description, message count

Checkpoints enable "rewind" — creating a new session branched from a past point. Container environments would extend this concept to capture entire OS state.

### WebSocket Protocol

The WS protocol already supports session CRUD:
- `create_session { name?, cwd? }` → `session_created`
- `destroy_session { sessionId }` → `session_destroyed`
- `list_sessions` → `session_list`
- `switch_session { sessionId }` → `session_switched`

New environment messages would follow the same pattern.

### Configuration System

`config.js` merges: CLI flags > env vars > `~/.chroxy/config.json` > defaults

Key env vars: `CHROXY_PROVIDER`, `CHROXY_CWD`, `CHROXY_MODEL`, `CHROXY_MAX_SESSIONS`

---

## Proposed Architecture

### Concept Map

| Existing Concept | Container Equivalent |
|---|---|
| Session (SessionManager) | Session *inside* a container |
| Provider (providers.js) | `DockerProvider` — new backend |
| Checkpoint (CheckpointManager) | `docker commit` + git snapshot |
| CWD per session | Mounted worktree or cloned repo |
| Tunnel adapter (tunnel/registry.js) | Could route to remote containers |

### Three-Tier Design

#### Tier 1 — Container-per-Session (MVP)

Lightest integration. A new provider wraps the existing SdkSession but runs it inside a Docker container:

```
┌─────────────────────────────────────────────┐
│  Chroxy Server (host)                       │
│  ┌──────────────┐  ┌──────────────────────┐ │
│  │ SessionMgr   │  │ EnvironmentManager   │ │
│  │  session A ───┼──┤→ container A         │ │
│  │  session B ───┼──┤→ container B         │ │
│  └──────────────┘  └──────────────────────┘ │
│         ↕                    ↕               │
│     WsServer          Docker API / CLI       │
└─────────────────────────────────────────────┘
         ↕
   Cloudflare tunnel → App / Dashboard
```

**Flow:**
1. `create_session` with `{ environment: 'docker', image: 'node:22', repo: '.' }`
2. Server creates a git worktree (or `git clone --shared`) in a temp dir
3. Spins up a container mounting that worktree
4. Runs Claude Code inside the container via `docker exec` or sidecar process
5. All events proxied back through the existing EventEmitter interface
6. On session destroy → container + worktree cleaned up

**What you get:** Full filesystem isolation between sessions. Each session is a throwaway sandbox.

#### Tier 2 — Persistent Environments with DevContainer

Environments outlive sessions. You define them, they run, multiple sessions can connect.

```
┌─ Environment "backend-api" ──────────────────┐
│  Docker Compose stack:                       │
│    app: node:22 + project mounted            │
│    db:  postgres:16                          │
│    cache: redis:7                            │
│  ─────────────────────────────────────────── │
│  Session 1: "fix auth bug"   ← connected    │
│  Session 2: "add rate limit" ← connected    │
└──────────────────────────────────────────────┘
```

- Reads `.devcontainer/devcontainer.json` from repos (existing VS Code ecosystem)
- Environments can be **snapshotted** (`docker commit` + git checkpoint) and **restored**
- True time-travel: captures installed packages, compiled artifacts, running database state, env vars
- WS protocol extensions: `create_environment`, `list_environments`, `snapshot_environment`, `restore_environment`

#### Tier 3 — Rancher / K8s Orchestration

For running across machines or in the cloud:

- Each environment becomes a pod (or pod group)
- Rancher provides orchestration — resource limits, health checks, scaling
- Chroxy server talks to Kubernetes API instead of local Docker
- Enables remote development — phone controls a Claude session in a cloud container
- Natural fit with existing tunnel architecture (swap Cloudflare for k8s ingress)
- Self-hosting story: "Deploy Chroxy on Rancher, get isolated environments for your team with resource quotas"

---

## Implementation Details

### New Files

| File | Purpose |
|------|---------|
| `packages/server/src/environment-manager.js` | Container lifecycle CRUD |
| `packages/server/src/docker-session.js` | Docker provider (registered via providers.js) |
| `packages/server/src/handlers/environment-handlers.js` | WS message handlers for environment CRUD |

### `environment-manager.js` — Core API

```js
class EnvironmentManager extends EventEmitter {
  // Create a new container environment
  async create({ name, image, repo, branch, compose, devcontainer }) → envId

  // List active environments
  list() → [{ id, name, image, status, createdAt, sessions }]

  // Snapshot an environment (docker commit + git state)
  async snapshot(envId, { name, description }) → snapshotId

  // Restore from snapshot
  async restore(snapshotId) → envId

  // Destroy environment and cleanup
  async destroy(envId)

  // Get environment details
  get(envId) → { id, name, containerId, status, mounts, ports }
}
```

### `docker-session.js` — Provider

```js
class DockerSession extends BaseSession {
  static get capabilities() {
    return {
      permissions: true,
      inProcessPermissions: false,  // Runs in container, needs proxy
      modelSwitch: true,
      permissionModeSwitch: true,
      planMode: false,
      resume: true,
      terminal: true,
      thinkingLevel: true,
      containerized: true,         // New capability flag
    }
  }

  constructor({ cwd, model, permissionMode, environmentId, ...rest })
  start()     // docker exec claude in the container
  destroy()   // stop container process, optionally destroy container
  sendMessage(text, attachments, options)
}
```

### WS Protocol Extensions

**Client → Server:**

| Type | Payload | Purpose |
|------|---------|---------|
| `create_environment` | `{ name, image?, repo?, branch?, compose?, devcontainer? }` | Create new container environment |
| `list_environments` | `{}` | List active environments |
| `destroy_environment` | `{ environmentId }` | Destroy environment and cleanup |
| `snapshot_environment` | `{ environmentId, name?, description? }` | Snapshot current state |
| `restore_environment` | `{ snapshotId }` | Restore from snapshot |

**Server → Client:**

| Type | Payload | Purpose |
|------|---------|---------|
| `environment_created` | `{ environmentId, name, image, status }` | Environment ready |
| `environment_list` | `{ environments: [...] }` | Active environments |
| `environment_destroyed` | `{ environmentId }` | Environment removed |
| `environment_snapshot` | `{ environmentId, snapshotId, name }` | Snapshot created |
| `environment_restored` | `{ environmentId, snapshotId }` | Environment restored |
| `environment_error` | `{ environmentId?, error }` | Operation failed |

**Modified `create_session`:** Add optional `environmentId` field:
```json
{ "type": "create_session", "name": "fix auth", "environmentId": "env_abc123" }
```

### Communication with Container

Two approaches, phased:

**Phase 1 — `docker exec` + pipes (MVP):**
- Shell into container, run `claude -p --output-format stream-json`
- Pipe stdin/stdout like CliSession already does
- Simple, works immediately
- Limitation: one Claude process per exec, no persistent daemon

**Phase 2 — WebSocket sidecar (Persistent Environments):**
- Run a tiny WS bridge process inside the container
- Chroxy server connects to it as a client
- More robust for long-lived environments
- Enables multiple sessions per environment
- Better for Tier 2/3

### Worktree vs Clone Strategy

| Method | Speed | Disk | Cross-Volume | Remote K8s |
|--------|-------|------|-------------|------------|
| `git worktree add` | Fast | Shared objects | No | No |
| `git clone --shared` | Fast | Shared objects + local index | Yes (same FS) | No |
| `git clone` (full) | Slower | Full copy | Yes | Yes |

**Decision:** Use git worktrees for local Docker (Tier 1), full clones for Rancher/K8s (Tier 3).

---

## Configuration & Feature Gating

### Core Requirement: Opt-in Only

Docker/Rancher integration must be entirely optional. Users without Docker installed, or who simply don't want it, should never see errors or degraded behavior.

### Config Schema Extensions

```json
{
  "environments": {
    "enabled": false,
    "backend": "docker",
    "docker": {
      "socketPath": "/var/run/docker.sock",
      "defaultImage": "node:22-slim",
      "resourceLimits": {
        "memory": "2g",
        "cpus": "2"
      },
      "autoCleanup": true,
      "worktreeDir": "~/.chroxy/worktrees",
      "snapshotDir": "~/.chroxy/snapshots"
    },
    "rancher": {
      "apiUrl": null,
      "namespace": "chroxy",
      "kubeconfig": null,
      "defaultResources": {
        "requests": { "memory": "1Gi", "cpu": "1" },
        "limits": { "memory": "4Gi", "cpu": "4" }
      }
    }
  }
}
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CHROXY_ENVIRONMENTS` | `false` | Enable environment feature |
| `CHROXY_ENV_BACKEND` | `docker` | Backend: `docker` or `rancher` |
| `CHROXY_DOCKER_IMAGE` | `node:22-slim` | Default container image |
| `CHROXY_DOCKER_MEMORY` | `2g` | Memory limit per container |
| `CHROXY_DOCKER_CPUS` | `2` | CPU limit per container |
| `CHROXY_RANCHER_API` | — | Rancher API URL |
| `CHROXY_RANCHER_NS` | `chroxy` | Kubernetes namespace |

### Feature Detection & Graceful Degradation

On server startup (when `environments.enabled = true`):

1. **Check Docker availability:** `docker info` — if fails, log warning, disable feature, continue normally
2. **Check Docker socket permissions:** verify the chroxy user can access the socket
3. **Check available disk space** for worktrees/snapshots
4. **Report capabilities in `auth_ok`:** `{ features: { environments: true/false } }`

The app/dashboard checks `features.environments` and only shows environment UI when available.

### CLI Flags

```bash
# Enable environments
npx chroxy start --environments

# With specific backend
npx chroxy start --environments --env-backend rancher --rancher-api https://...

# Override image
npx chroxy start --environments --docker-image myorg/dev-env:latest
```

### Settings Screen / Dashboard

When environments are enabled, the settings UI should show:
- **Backend:** Docker / Rancher (read-only, set by config)
- **Default image:** configurable
- **Resource limits:** memory, CPU
- **Auto-cleanup:** toggle (destroy containers on session end)
- **Active environments count** and disk usage

---

## Use Cases

### 1. Parallel Branch Exploration
Create two environments from the same repo, each on a different branch. Tell Claude "try approach A" in one and "try approach B" in the other. Compare results. Destroy the loser.

### 2. Safe Dependency Experimentation
"Upgrade React to v19 and fix whatever breaks" — in an isolated container that can't affect your working tree. If it goes sideways, destroy and start fresh.

### 3. Full-Stack Sandboxes
DevContainer spec with postgres + redis + the app. Claude can run migrations, seed data, run tests — all in an isolated stack. Destroy when done, no cleanup needed.

### 4. Team Self-Hosting
Deploy Chroxy on Rancher. Each team member gets isolated environments with resource quotas. No cross-contamination between developers' experiments.

### 5. Checkpoint on Steroids
Regular checkpoints capture git state + conversation. Container snapshots capture everything: installed packages, compiled artifacts, database state, environment variables. True time-travel.

---

## Open Questions

1. **API key handling in containers:** Should the container inherit the host's `ANTHROPIC_API_KEY`? Or should there be a key-per-environment model for cost tracking?

2. **Networking between environments:** Should environments be able to talk to each other? (e.g., microservice testing across containers)

3. **GPU passthrough:** For ML workloads, should containers get GPU access? How does this interact with resource limits?

4. **Image registry:** Should Chroxy maintain a curated set of base images? Or rely entirely on user-specified images?

5. **DevContainer spec coverage:** Which parts of the devcontainer spec to support? Full spec is large (features, lifecycle hooks, port forwarding, etc.)

6. **Cost allocation:** Per-environment cost tracking vs per-session? Environments may host multiple sessions.

7. **Concurrent container limit:** Should there be a separate limit from `maxSessions`? Containers are heavier than in-process sessions.

8. **Snapshot storage:** Local disk? Docker registry? Cloud storage for Rancher deployments?

---

## Implementation Phases

### Phase 1 — Docker Provider (MVP)
- `docker-session.js` provider (~200-300 lines)
- `environment-manager.js` (~300-400 lines)
- Register in `providers.js`
- Config schema additions for `environments` section
- Feature detection (Docker availability check)
- `--environments` CLI flag
- Git worktree creation for isolation
- Container lifecycle: create, exec, destroy
- No UI changes — sessions just run in containers

### Phase 2 — WS Protocol & UI
- Environment CRUD message handlers
- Dashboard: environment management panel
- App: environment picker in session creation modal
- Snapshot/restore for environments
- DevContainer spec support (basic: image, features, mounts)

### Phase 3 — Rancher / K8s Backend
- Kubernetes client integration
- Pod-based environments
- Rancher API adapter
- Remote clone (full git clone instead of worktree)
- Resource quotas and namespace isolation

---

*This document captures the investigation as of 2026-03-16. Implementation has not begun.*
