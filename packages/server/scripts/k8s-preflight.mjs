#!/usr/bin/env node
/**
 * k8s-preflight.mjs — dry-run validation for the experimental K8s/Rancher
 * environment backend (#6275). Runs WITHOUT creating any cluster resources.
 *
 * Two layers:
 *   1. Pure-logic (always) — exercises the REAL k8s.js namespace sanitizer +
 *      the default resource quantities against the RFC 1123 DNS-label and
 *      Kubernetes-quantity rules the API server enforces. A regression in the
 *      sanitizer (e.g. a tenant-isolation collision) fails HERE, loudly, instead
 *      of silently in a live cluster.
 *   2. Live connectivity (opt-in, K8S_PREFLIGHT_LIVE=1) — loads the default
 *      kubeconfig and LISTS namespaces (read-only) to confirm auth + reachability.
 *      It never creates or deletes anything.
 *
 * Exit 0 if every attempted check passes; non-zero on any failure / config error.
 * Companion to the runbook: docs/guides/k8s-backend-validation.md.
 *
 *   node packages/server/scripts/k8s-preflight.mjs            # pure-logic only
 *   K8S_PREFLIGHT_LIVE=1 node .../k8s-preflight.mjs           # + live read-only check
 */
import { sanitizeNamespaceLabel, DEFAULT_RESOURCES } from '../src/environments/backends/k8s.js'

// The exact rule a Kubernetes namespace (a DNS-1123 label) must satisfy, re-stated
// here so the check is independent of k8s.js internals: a SANITIZER regression is
// caught by comparing its output against this canonical rule.
const RFC_1123_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const RFC_1123_MAX = 63
// A Kubernetes resource.Quantity in canonical form: a number with an optional
// decimal SI (m, k, M, G, …) or binary SI (Ki, Mi, Gi, …) suffix.
const K8S_QUANTITY = /^[0-9]+(\.[0-9]+)?(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/

const NS_PREFIX = 'chroxy-user-'
const NS_BUDGET = RFC_1123_MAX - NS_PREFIX.length

let failures = 0
const fail = (msg) => { console.error(`  ✗ ${msg}`); failures++ }
const ok = (msg) => console.log(`  ✓ ${msg}`)

// --- 1a. namespace sanitizer: RFC 1123 validity + tenant-isolation ---------
console.log('namespace sanitizer (real k8s.js logic):')
const identities = [
  'alice',
  'Alice',
  'user.name@example.com',
  'a/b',
  'a.b',
  'A_B',
  '---weird---',
  'x'.repeat(200),
  'Org/Team:Project#42',
]
const nsFor = (id) => `${NS_PREFIX}${sanitizeNamespaceLabel(id, { maxLength: NS_BUDGET })}`
const seen = new Map()
for (const id of identities) {
  let ns
  try {
    ns = nsFor(id)
  } catch (err) {
    fail(`sanitizeNamespaceLabel("${id}") threw: ${err.message}`)
    continue
  }
  if (ns.length > RFC_1123_MAX) {
    fail(`"${id}" -> "${ns}" exceeds the ${RFC_1123_MAX}-char limit (${ns.length})`)
  } else if (!RFC_1123_LABEL.test(ns)) {
    fail(`"${id}" -> "${ns}" is not a valid RFC 1123 DNS label`)
  } else {
    ok(`"${id.slice(0, 28)}" -> ${ns}`)
  }
  for (const [otherId, otherNs] of seen) {
    if (otherNs === ns && otherId !== id) {
      fail(`TENANT COLLISION: "${id}" and "${otherId}" both map to ${ns}`)
    }
  }
  seen.set(id, ns)
}
// The empty identity MUST be rejected (no silent fallback to a shared namespace).
try {
  sanitizeNamespaceLabel('')
  fail('empty identity was NOT rejected (silent shared-namespace risk)')
} catch {
  ok('empty identity rejected')
}
// Determinism — the same identity must always map to the same namespace.
if (sanitizeNamespaceLabel('alice') !== sanitizeNamespaceLabel('alice')) {
  fail('sanitizer is non-deterministic (same identity produced two namespaces)')
} else {
  ok('deterministic (same identity -> same namespace)')
}
// Case-distinct identities must NOT collapse (alice vs Alice would share Pods).
if (sanitizeNamespaceLabel('alice') === sanitizeNamespaceLabel('Alice')) {
  fail('"alice" and "Alice" collapse to one namespace (tenant-isolation break)')
} else {
  ok('case-distinct identities isolated (alice != Alice)')
}

// --- 1b. default resource quantities parse as valid K8s quantities ----------
console.log('default resource quantities (DEFAULT_RESOURCES):')
for (const [key, value] of Object.entries(DEFAULT_RESOURCES)) {
  if (K8S_QUANTITY.test(value)) {
    ok(`${key}=${value}`)
  } else {
    fail(`DEFAULT_RESOURCES.${key}="${value}" is not a valid Kubernetes quantity`)
  }
}

// --- 2. live cluster connectivity (opt-in, read-only) -----------------------
console.log('live cluster connectivity:')
if (process.env.K8S_PREFLIGHT_LIVE !== '1') {
  console.log('  ⊝ skipped — set K8S_PREFLIGHT_LIVE=1 with a reachable kubeconfig to run')
} else {
  try {
    const { KubeConfig, CoreV1Api } = await import('@kubernetes/client-node')
    const kc = new KubeConfig()
    kc.loadFromDefault()
    const api = kc.makeApiClient(CoreV1Api)
    const res = await api.listNamespace()
    const items = res?.items || res?.body?.items || []
    ok(`kubeconfig auth OK — listed ${items.length} namespaces (read-only; nothing created)`)
  } catch (err) {
    fail(`live connectivity failed: ${err.message}`)
  }
}

console.log('')
if (failures > 0) {
  console.error(`PREFLIGHT FAILED — ${failures} check(s) failed. See docs/guides/k8s-backend-validation.md.`)
  process.exit(1)
}
const liveNote = process.env.K8S_PREFLIGHT_LIVE === '1' ? 'live cluster reachable.' : 'live check skipped (set K8S_PREFLIGHT_LIVE=1 to include it).'
console.log(`PREFLIGHT OK — namespace sanitizer + resource quantities valid; ${liveNote}`)
