# K8s / Rancher backend — validation runbook

The Kubernetes and Rancher environment backends are **feature-complete and
unit-tested, but Experimental until validated against a live cluster** (#6275).
The code paths (namespace isolation, ResourceQuota/LimitRange enforcement, the
sidecar round-trip) are covered by unit tests and a kind-based integration test,
but they have never been exercised against a managed or multi-node cluster.

This runbook is the guided path from "experimental" to "validated". Most of it is
automated — the only irreducibly-manual step is pointing it at a real cluster.

> For configuration, the Rancher adapter, security notes, and fallback behaviour,
> see [k8s-rancher-backend.md](./k8s-rancher-backend.md). This runbook is about
> **validating** that backend, not configuring it.

---

## TL;DR

```bash
# 1. Dry-run preflight — no cluster needed. Validates the namespace sanitizer
#    (tenant isolation) + the default resource quantities against the K8s rules.
node packages/server/scripts/k8s-preflight.mjs

# 2. Build the sidecar image.
docker build -t chroxy-pod-agent:latest packages/server/sidecar/

# 3a. Automated validation on a throwaway kind cluster (one command; it
#     bootstraps + tears down the cluster itself).
RUN_K8S_INTEGRATION=1 npm run test:integration:k8s   # from packages/server/

# 3b. Validate against YOUR cluster (kind / k3s / EKS / GKE / Rancher):
K8S_PREFLIGHT_LIVE=1 node packages/server/scripts/k8s-preflight.mjs
```

---

## Prerequisites

| Tool | Why | Notes |
|------|-----|-------|
| Docker | builds the sidecar image; `kind` runs on it | required for the kind path |
| [`kind`](https://kind.sigs.k8s.io/) | the automated integration test bootstraps a throwaway cluster | only for step 3a |
| Node 22 | running the server + the preflight/tests | `PATH="/opt/homebrew/opt/node@22/bin:$PATH"` on macOS |
| A kubeconfig | the live preflight + your-own-cluster checks | `~/.kube/config` or `$KUBECONFIG` |

For the **managed-cluster** path (3b) you also need a reachable cluster you can
create namespaces + ResourceQuotas in (EKS/GKE/AKS, k3s, or Rancher). For
**Rancher** specifically, set `RANCHER_URL`, `RANCHER_CLUSTER_ID`, `RANCHER_TOKEN`
(see [k8s-rancher-backend.md](./k8s-rancher-backend.md#obtaining-clusterid-and-token)).

---

## Step 1 — Preflight (dry-run, no cluster)

```bash
node packages/server/scripts/k8s-preflight.mjs
```

This runs **without touching any cluster**. It imports the real `k8s.js`
namespace sanitizer and the default resource quantities and checks them against
the rules the API server enforces:

- every tenant identity (incl. uppercase, `a/b` vs `a.b`, all-symbol, 200-char,
  and unicode inputs) maps to a **valid RFC 1123 DNS label** ≤ 63 chars;
- **tenant isolation holds** — distinct identities never collapse onto the same
  namespace (e.g. `alice` and `Alice` get different namespaces via a hash
  suffix), the mapping is deterministic, and the empty identity is rejected;
- the default CPU/memory requests + limits (`500m` / `512Mi` / `2` / `4Gi`) are
  valid Kubernetes quantity strings.

A regression in the sanitizer (the multi-tenant isolation boundary) fails here,
loudly, instead of silently sharing one tenant's Pods with another in production.
Exit 0 = pass; non-zero = a config/logic problem to fix before going further.

Add `K8S_PREFLIGHT_LIVE=1` to also load your default kubeconfig and **list
namespaces (read-only)** — a quick auth + reachability check that creates nothing.

---

## Step 2 — Build the sidecar image

The backend runs Claude in a `chroxy-pod-agent` sidecar container (protocol in
[`packages/server/sidecar/PROTOCOL.md`](../../packages/server/sidecar/PROTOCOL.md)).

```bash
docker build -t chroxy-pod-agent:latest packages/server/sidecar/
```

The default image tag is `chroxy-pod-agent:latest` (`DEFAULT_SIDECAR_IMAGE` in
`k8s.js`); override per-call with `opts.sidecarImage`. For a managed cluster,
push the image to a registry the cluster can pull from and pass that reference.

---

## Step 3a — Automated validation (throwaway kind cluster)

From `packages/server/`:

```bash
RUN_K8S_INTEGRATION=1 npm run test:integration:k8s
# or directly: RUN_K8S_INTEGRATION=1 node --import ./tests/_setup.mjs --test tests/integration/k8s-sidecar-roundtrip.test.js
```

This **bootstraps a `kind` cluster, loads the sidecar image, runs the round-trip,
and tears the cluster down** — no manual cluster setup. It is skipped silently if
`RUN_K8S_INTEGRATION` is unset or `kind` is not on `PATH`, so it never breaks a
normal test run.

This is the closest thing to a one-command validation. It proves the sidecar
spawn + stdio round-trip works end-to-end on a real (if local) cluster.

---

## Step 3b — Validate against your own cluster

The kind path proves the happy path locally; a managed cluster is where the
load-bearing isolation + quota controls actually get exercised. Against any
reachable cluster (k3s / EKS / GKE / AKS / Rancher):

1. **Connectivity + auth** — read-only, creates nothing:
   ```bash
   K8S_PREFLIGHT_LIVE=1 node packages/server/scripts/k8s-preflight.mjs
   ```
2. **Namespace isolation** — create two environments with distinct `userId`s and
   confirm a Pod in `chroxy-user-alice…` cannot list/read/delete Pods in
   `chroxy-user-bob…` (the namespace is the tenant boundary).
3. **ResourceQuota enforcement** — set a namespace ResourceQuota, fill it, and
   confirm an over-quota Pod creation is rejected with `403` (not silently
   scheduled). Confirm LimitRange defaults are applied to a Pod created without
   explicit resources.
4. **Rancher only** — confirm `ensureProjectNamespace` stamps the
   `field.cattle.io/projectId` annotation and that project-level quotas/RBAC are
   enforced.

> The integration-test scaffold for items 2–4 (env-gated behind
> `RUN_K8S_INTEGRATION` + `RANCHER_*`) is tracked as a sub-task of #6275; until it
> lands, run these checks manually with `kubectl` against your cluster.

---

## Step 4 — Enable the backend

Once validated, enable it in `~/.chroxy/config.json`:

```json
{ "environments": { "backend": "k8s" } }
```

(or `"rancher"`). See [k8s-rancher-backend.md](./k8s-rancher-backend.md) for the
full option set (`namespace`, `sidecarImage`, `resources`, Rancher `clusterId` /
`token`, fallback behaviour).

---

## What to report on #6275

To graduate the backend from Experimental, report:

- [ ] Preflight (step 1) exits 0.
- [ ] kind integration test (step 3a) passes.
- [ ] Live preflight (step 3b.1) authenticates + lists namespaces.
- [ ] Namespace isolation holds (3b.2) — cross-namespace reads blocked.
- [ ] ResourceQuota + LimitRange enforced (3b.3).
- [ ] (Rancher) project-namespace annotation + quotas enforced (3b.4).
- Cluster details: distribution + version, node count, CNI, and anything that
  behaved differently from the kind/local path.
