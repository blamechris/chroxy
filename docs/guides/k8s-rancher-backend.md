# Kubernetes & Rancher Backends

Chroxy's environment system runs each session's container environment through a
pluggable *backend*. Beyond the default Docker backend, two cluster-oriented
backends are available for remote / team deployments:

- **`K8sBackend`** — talks directly to a Kubernetes API server (in-cluster
  service account, or a kubeconfig file).
- **`RancherBackend`** — an *optional* adapter that runs the exact same K8s
  logic against a [Rancher](https://www.rancher.com/)-managed cluster, plus
  Rancher's org model (Projects) on top.

This guide covers when to pick each one and how to configure the Rancher
adapter.

> ⚠️ **Experimental until live-validated (#6275).** These backends are
> feature-complete + unit-tested but have not been exercised against a live
> cluster. Before relying on them, walk the
> [K8s backend validation runbook](./k8s-backend-validation.md) — a mostly-automated
> path (a dry-run preflight + a one-command kind integration test) ending in a
> short manual check against your own cluster.

## When to pick K8s vs Rancher

| Aspect | `K8sBackend` (plain K8s) | `RancherBackend` (optional adapter) |
|---|---|---|
| **Authentication** | In-cluster service account, or kubeconfig | Rancher bearer token, proxied through the Rancher server |
| **Connectivity** | Direct to the kube API server | Through `<rancher-url>/k8s/clusters/<clusterId>` |
| **Namespace model** | Plain namespaces — the backend creates Pods/Secrets in a namespace it assumes already exists (it does not create namespaces) | Adds `ensureProjectNamespace`, which creates a namespace bound to a Rancher Project |
| **RBAC / quotas** | Whatever you define directly in K8s | Inherits the Rancher **Project**'s RBAC + resource quotas |
| **Best for** | You run/operate the cluster directly, or use a managed kube control plane (EKS/GKE/AKS) and already manage kubeconfig/RBAC yourself | You self-host on Rancher and want org-level Projects, fleet management, and centralised RBAC without handing every operator raw kube credentials |

**Rule of thumb:** if you don't run Rancher, use `K8sBackend`. The Rancher
adapter is strictly additive and **opt-in** — when no Rancher connection is
configured, nothing about Rancher is touched and the plain K8s path is the
default.

## How the Rancher adapter works

Rancher is fundamentally an **auth/proxy layer in front of the Kubernetes API**.
It exposes every downstream cluster's kube API under a per-cluster path:

```
https://<rancher-server>/k8s/clusters/<clusterId>
```

authenticated with a Rancher bearer token. `RancherBackend` therefore:

1. Builds a standard `@kubernetes/client-node` client pointed at that proxy URL
   with the bearer token (and optional CA bundle) — see
   `buildRancherApi` in `packages/server/src/environments/backends/rancher.js`.
2. Hands that client to `K8sBackend` via its injection seam, so **100% of the
   pod / secret / exec logic is reused unchanged** — Rancher is transparent to
   the rest of the backend.
3. Adds `ensureProjectNamespace()`, which creates a namespace bound to a Rancher
   **Project** via the `field.cattle.io/projectId: <clusterId>:<projectId>`
   annotation. Rancher's controllers then apply the Project's RBAC and resource
   quotas to that namespace.

Because Project binding is expressed on a *standard* K8s Namespace annotation,
there is no separate Rancher REST API to call — everything flows through the
proxied kube API.

## Configuration

The Rancher connection is supplied as backend options:

| Option | Required | Description |
|---|---|---|
| `rancherUrl` | yes | Rancher server base URL, e.g. `https://rancher.example.com` |
| `clusterId` | yes | Downstream cluster ID, e.g. `c-m-abc123` (legacy `c-abcde` also accepted) |
| `token` | yes | Rancher API bearer token (treat as a secret; **never logged**) |
| `caData` | no | Base64-encoded PEM CA bundle for a self-signed Rancher server |
| `skipTLSVerify` | no | Disable TLS verification (default `false`; **discouraged** — prefer `caData`) |
| `defaultProjectId` | no | Default Rancher Project (`p-...`) for `ensureProjectNamespace` |

All of the standard `K8sBackend` options (`namespace`, `sidecarImage`,
`imagePullPolicy`, `connectMode`, …) are also accepted and forwarded.

### Obtaining `clusterId` and `token`

- **clusterId** — in the Rancher UI, open the cluster and copy the ID from the
  URL, or run `kubectl get clusters.management.cattle.io` against the Rancher
  local cluster. It looks like `c-m-abc123` or `c-abcde`.
- **token** — Rancher UI → *Account & API Keys* → *Create API Key*. Scope it to
  the cluster/project Chroxy needs. The token is shown once; store it in your
  secret manager.
- **projectId** — `kubectl get projects.management.cattle.io -n <clusterId>`, or
  copy from the Project's URL in the Rancher UI. It looks like `p-xyz789`.

## Security notes

- **The bearer token is never logged and never copied onto the backend
  instance.** It lives only inside the kube client's auth provider. Validation
  errors deliberately omit the token value.
- **TLS verification is on by default.** For a self-signed Rancher server,
  supply `caData` (a base64-encoded CA bundle) rather than setting
  `skipTLSVerify: true`. Disabling verification exposes the bearer token to
  man-in-the-middle interception.
- **Project-scoped namespaces inherit Rancher quotas/RBAC.** Prefer
  `ensureProjectNamespace` over creating bare namespaces so that org-level
  guardrails apply.
- The `hostPath` workspace warnings from `K8sBackend` apply equally here — use
  the PVC workspace strategy on shared/multi-tenant clusters.

## Fallback behaviour

The adapter degrades gracefully rather than failing hard:

- If Rancher is **not configured** (`isRancherConfigured` is false), the plain
  `K8sBackend` path is used — the default, unchanged behaviour.
- If `ensureProjectNamespace` is called with a `projectId` but no usable
  `clusterId` is available, it creates a **plain namespace without the project
  binding** (and logs the degradation) rather than forming a malformed
  annotation.
- A `409 Conflict` (namespace already exists) is treated as success, so the call
  is safe to retry.
