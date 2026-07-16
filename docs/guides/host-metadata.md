# Chroxy host metadata (`CHROXY_HOST_*`)

Every agent session launched by Chroxy — Claude, Codex, Gemini, and any future
provider — is given a small, non-sensitive **host identity** through environment
variables. This lets an agent answer *"what Chroxy build am I running in?"* from
inside a chat session instead of guessing from screenshots, the checked-out repo,
or app-bundle metadata (issue #6633).

## The variables

| Variable | Always present | Example | Meaning |
|---|---|---|---|
| `CHROXY_HOST_APP` | yes | `Chroxy` | Product name. |
| `CHROXY_HOST_VERSION` | yes | `0.10.0` | Running server package version. |
| `CHROXY_HOST_CHANNEL` | yes | `dev` / `release` | `dev` when launched from a git working tree, `release` from a packaged install. |
| `CHROXY_HOST_PLATFORM` | yes | `darwin` / `win32` / `linux` | `process.platform` of the host. |
| `CHROXY_HOST_NODE` | yes | `22.14.0` | Node.js version running the daemon. |
| `CHROXY_HOST_PID` | yes | `48213` | PID of the daemon process — pins the exact running host. |
| `CHROXY_HOST_GIT_SHA` | dev only | `4ebf6bf` | Short commit SHA (omitted for release builds). |
| `CHROXY_HOST_GIT_BRANCH` | dev only | `feat/6633-host-metadata` | Branch name (omitted when detached or unavailable). |

The values are **computed by the daemon** (version from its own `package.json`,
git identity via `git`) — never passed through from the operator's shell — so a
stray `CHROXY_HOST_*` export cannot spoof them.

## Reading it from a session

Any provider that can run shell commands reads them directly:

```bash
echo "$CHROXY_HOST_APP $CHROXY_HOST_VERSION ($CHROXY_HOST_CHANNEL) — $CHROXY_HOST_GIT_BRANCH@$CHROXY_HOST_GIT_SHA on $CHROXY_HOST_PLATFORM"
# Chroxy 0.10.0 (dev) — feat/6633-host-metadata@4ebf6bf on darwin
```

- **Subprocess providers** (Claude CLI/TUI, Codex, Gemini, …) receive the block
  via `buildSpawnEnv` — the single chokepoint that builds every child process's
  environment.
- **The in-process Claude SDK** and BYOK-family providers (DeepSeek, Ollama,
  Anthropic-/OpenAI-compatible) inherit it because the daemon publishes the same
  block into its own `process.env` at startup.
- **Containerized providers** (`docker-cli`, `docker-sdk`, `docker-byok`, and the
  k8s backend) forward the block across the container boundary, so an agent
  running *inside* an isolated container/pod sees the same host identity.

## Using it in a skill or agent prompt

A runtime skill (`~/.chroxy/skills/*.md`) or an agent prompt can instruct the
model to confirm its host before smoke-testing a freshly rebuilt branch, e.g.:

> Before verifying this change, run `echo "$CHROXY_HOST_VERSION $CHROXY_HOST_CHANNEL $CHROXY_HOST_GIT_SHA"`
> and confirm the branch/SHA matches the build under test.

This makes "am I talking to the build I just rebuilt?" a one-line check instead
of a screenshot comparison.
