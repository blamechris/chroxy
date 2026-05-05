# Integration Tests

This directory contains two kinds of integration tests:

- **Always-on** (e.g. `encrypted-roundtrip.test.js`, `ws-roundtrip.test.js`,
  `permission-whitelist.test.js`) — pure in-process roundtrips that need no external
  infrastructure. They run as part of the default `npm test` command.
- **Infrastructure-dependent / opt-in** (e.g. `docker-sdk-roundtrip.test.js`,
  `k8s-sidecar-roundtrip.test.js`) — boot real Docker containers or Kubernetes
  clusters. They are gated on an environment variable and/or a tool-availability
  check. If the gate is not satisfied the file prints a skip message and exits
  cleanly (zero tests registered, zero failures), so they are safe to leave in the
  default test glob.

The remainder of this document covers the opt-in suites and how to run them locally.

---

## K8s Sidecar Roundtrip (`k8s-sidecar-roundtrip.test.js`)

End-to-end test for the `K8sBackend` + `chroxy-pod-agent` sidecar bridge.

### What it asserts

1. `K8sBackend.createEnvironment` creates a Pod that reaches `Running` phase.
2. `K8sBackend.execInEnvironment` runs `echo hello` inside the Pod and receives `hello`
   back through the WebSocket bridge (not via `kubectl exec` — the full portforward
   path is exercised).
3. `K8sBackend.streamCliInEnvironment` streams `{ type: "mock-event", value: 42 }` from
   a `node -e` one-liner; the parsed frame arrives on `proc.stdout`, confirming the
   NDJSON-over-WS bridge works end-to-end.
4. `K8sBackend.destroyEnvironment` deletes the Pod (verified by a subsequent
   `getEnvironmentStatus` call that should throw).

### Prerequisites

| Tool | Install |
|------|---------|
| [kind](https://kind.sigs.k8s.io/) | `brew install kind` or see https://kind.sigs.k8s.io/docs/user/quick-start/#installation |
| Docker daemon | Running locally — `docker info` must succeed |
| Node 22 | `PATH="/opt/homebrew/opt/node@22/bin:$PATH"` |

kind writes a kubeconfig entry to `~/.kube/config`; no extra setup is needed.

### Running locally

```bash
# Convenience script — sets RUN_K8S_INTEGRATION=1 and runs only this file
RUN_K8S_INTEGRATION=1 npm run test:integration:k8s

# Or run the file directly with Node
RUN_K8S_INTEGRATION=1 \
  PATH="/opt/homebrew/opt/node@22/bin:$PATH" \
  node --test packages/server/tests/integration/k8s-sidecar-roundtrip.test.js
```

### Expected runtime

~2–3 minutes total, broken down as:

| Phase | Time |
|-------|------|
| `kind create cluster` | 30–90 s (image pull on first run; cached thereafter) |
| `docker build` sidecar | 10–30 s |
| `kind load docker-image` | 5–15 s |
| Pod schedule + readiness probes | 10–30 s |
| exec + stream assertions | < 10 s |
| `kind delete cluster` | 5–15 s |

### Environment variable contract

| Variable | Required | Description |
|----------|----------|-------------|
| `RUN_K8S_INTEGRATION` | **yes** (must be `1`) | Gates the entire test file |

`kind` must also be on `PATH`. If either condition is unmet the file prints:

```
[k8s-integration] Skipped — set RUN_K8S_INTEGRATION=1 and install kind to run
```

### Cleanup guarantees

A kind cluster named `chroxy-test-<pid>` is created at `before` and deleted at `after`.
Cleanup runs unconditionally — even if an assertion fails mid-suite — via a `try/finally`
pattern inside `after`. A `SIGINT` handler (`Ctrl-C`) also triggers cleanup so an
interrupted test run does not leave a stale cluster behind.

If a cluster is accidentally orphaned (process killed with `SIGKILL`, power loss, etc.),
clean it up manually:

```bash
kind get clusters          # list all clusters
kind delete cluster --name chroxy-test-<pid>
```

### Why this test is opt-in

- Requires Docker daemon and kind — not available in the default GitHub Actions runner
  without additional setup (DinD or a privileged node).
- Takes 2–3 minutes — too slow for the default `npm test` suite.
- Cluster bootstrap is non-deterministic in CI environments.

Wiring this into GitHub Actions nightly CI is tracked separately.

---

## Other integration suites

| File | Gate variable | What it tests |
|------|--------------|---------------|
| `docker-sdk-roundtrip.test.js` | `DOCKER_TESTS=1` | `DockerSdkSession` container lifecycle |
| `encrypted-roundtrip.test.js` | *(auto)* | WS encryption roundtrip |
| `permission-whitelist.test.js` | *(auto)* | Permission whitelist behavior |
| `ws-roundtrip.test.js` | *(auto)* | WS auth + message roundtrip |
