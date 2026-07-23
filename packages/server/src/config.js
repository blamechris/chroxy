/**
 * Configuration schema validation and merging utilities.
 *
 * Config precedence (highest to lowest):
 * 1. CLI flags
 * 2. Environment variables
 * 3. Config file (~/.chroxy/config.json)
 * 4. Defaults
 */

import { readFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { writeFileRestricted } from './platform.js'
import { parseDuration } from './duration.js'
import { createLogger } from './logger.js'
// #5419: pure validation helpers for `providers.anthropicCompatible` —
// deliberately a dependency-free module so importing it here never pulls
// the BYOK/SDK machinery into the config-load path.
import { validateProvidersConfigBlock } from './anthropic-compatible-config.js'
// #6764: default cheap model + timeout for the one-shot semantic-title call.
// Imported from the pure title module (no provider/SDK deps) so config load stays
// lightweight.
import { DEFAULT_SEMANTIC_TITLE_MODEL, DEFAULT_SEMANTIC_TITLE_TIMEOUT_MS } from './session-title.js'

const log = createLogger('config')

/**
 * Known configuration keys and their expected types.
 */
const CONFIG_SCHEMA = {
  apiToken: 'string',
  port: 'number',
  // Bind address for the server socket. Default (unset) binds 0.0.0.0 so the
  // mobile app / LAN clients can reach it. Set to '127.0.0.1' for a
  // loopback-only bind that keeps auth enabled — opt-in defence-in-depth for
  // single-device setups. `--no-auth` always forces loopback regardless.
  host: 'string',
  cwd: 'string',
  model: 'string',
  allowedTools: 'array',
  noAuth: 'boolean',
  maxRestarts: 'number',
  // #6022: ms the supervisor serves a terminal `status:'down'` health response
  // (reason `supervisor_gave_up`) after exhausting its restart budget, before
  // exiting — long enough for a polling client to latch the terminal state.
  // 0 preserves the prior exit-immediately behaviour. Default 15000.
  terminalDownGraceMs: 'number',
  tunnel: 'string',
  tunnelName: 'string',
  tunnelHostname: 'string',
  tunnelConfig: 'object',
  legacyCli: 'boolean',
  // #4209 / #4246: server-wide default for the per-session
  // `skipPermissions` option. Honoured only by the claude-tui provider
  // (spawns claude with `--dangerously-skip-permissions` + elides
  // chroxy's permission hook). Wired from
  // `chroxy start --dangerously-skip-permissions`; can also be pinned
  // in config.json for headless deploys.
  //
  // #4246 — the canonical config-file key is now
  // `dangerouslySkipPermissions` (mirrors the CLI flag). The legacy
  // `skipPermissions` key is still honoured for backwards compatibility
  // but `resolveSkipPermissions()` emits a deprecation warning when only
  // the legacy key is set. Operators should rename the key in their
  // config.json — both keys remain in the schema so a config.json with
  // either key passes validation cleanly.
  dangerouslySkipPermissions: 'boolean',
  skipPermissions: 'boolean',
  provider: 'string',
  // Two accepted forms (#2950 / #5419):
  //   - array (legacy, written by `chroxy init`): provider ids the user
  //     opted into. Informational today — `provider` remains the
  //     authoritative runtime selector.
  //   - object: `providers.anthropicCompatible` is an array of
  //     config-driven Anthropic-compatible endpoint entries (Z.ai GLM,
  //     Moonshot Kimi, MiniMax, LM Studio, llama.cpp, vLLM, OpenRouter,
  //     custom proxies). Each entry registers a first-class provider at
  //     startup — see anthropic-compatible-config.js for the entry shape
  //     and validation rules. API keys are NEVER inlined here: entries
  //     name an env var (`apiKeyEnv`) or a ~/.chroxy/credentials.json
  //     field (`credentialsKey`).
  providers: 'array|object',
  // #5547: optional override for the one-shot session summarizer (the sidebar
  // "Summarize & start new session" action). `{ provider?: string, model?:
  // string }` — when set, the summarizer uses this (typically cheaper) model
  // instead of the target session's own model. `provider` is accepted for
  // forward-compat; the one-shot path currently runs through the SDK provider
  // and only threads the model id. Unset → summarize with the session's model.
  summarize: 'object',
  maxPayload: 'number',
  maxToolInput: 'number',
  noEncrypt: 'boolean',
  // #6564 — force E2E encryption on loopback connections too (disable the
  // localhost plaintext bypass unconditionally). Default off: the bypass is
  // already auto-disabled while a tunnel is active (see ws-history.js).
  encryptLocalhost: 'boolean',
  transforms: 'array',
  tokenExpiry: 'string',
  // #6598 — how long a paired device's session token stays valid without
  // reconnecting (sliding: each connect refreshes it). Duration string like
  // '30d' / '15d' / '12h'. Persisted across restarts. Default 30d + the 5min
  // floor are applied in server-cli when computing sessionTokenTtlMs; a malformed
  // or sub-floor value is warned about by validateConfig.
  sessionTokenTtl: 'string',
  sessionTimeout: 'string',
  costBudget: 'number',
  // #5665: monthly programmatic-credit budget meter config. Nested object:
  //   billing.creditTier             pro | max5x | max20x
  //   billing.monthlyCreditBudgetUsd raw USD cap (wins over the tier preset)
  //   billing.budgetWarningPercent   warn threshold 1-100 (default 80)
  billing: 'object',
  // #6481 (epic #6469): opt-in IDE feature surface. `features.ide: true` (or the
  // CHROXY_ENABLE_IDE=1 env override) reveals the IDE navigation/editing features;
  // off by default so it never risks the core offering. See isIdeFeatureEnabled().
  features: 'object',
  // #6691 (E-4): the orchestration engine's config block ({ roles, bash, diff,
  // maxParallelWorkers, ... } — consumed by OrchestrationManager via
  // buildOrchestrationManager). Declared here so a configured block doesn't
  // trip the misleading "Unknown config key ... (will be ignored)" warning —
  // mergeConfig passes unknown file keys through regardless, but the warning
  // suggested otherwise.
  orchestration: 'object',
  externalUrl: 'string',
  repos: 'array',
  // #5172 (Control Room v2): filesystem root the Host Status survey scans
  // for auto-discovered git repos. resolveRepoSet (control-room/repo-set.js)
  // unions any explicit `repos[]` entries with the immediate subdirectories
  // of this root that contain a `.git` entry. Defaults to ~/Projects when
  // unset. Mirrored by the CHROXY_CONTROL_ROOM_ROOT env var.
  controlRoomRoot: 'string',
  // #5253 (Control Room): filesystem root the self-hosted runner survey
  // (control-room/runners.js) scans for GitHub Actions runner installs (dirs
  // containing a `.runner` config). Defaults to ~/github-runners when unset.
  // Mirrored by the CHROXY_RUNNER_ROOT env var.
  controlRoomRunnerRoot: 'string',
  // #5260 (Control Room): whether the self-hosted runner survey enriches each
  // runner with GitHub's view via `gh api` (online/busy/labels). Defaults to
  // true. Set false for a faster local-only survey, or on hosts where `gh`
  // isn't authenticated. Mirrored by the CHROXY_RUNNER_INCLUDE_GITHUB env var.
  controlRoomRunnerIncludeGithub: 'boolean',
  // #6133 (Control Room): set false to skip the `docker stats` enrichment in the
  // containers survey (inventory-only, for a slow/socketless docker). Default true.
  controlRoomContainersIncludeStats: 'boolean',
  // #5499 (Control Room): explicit path to the `repo-memory` binary the
  // Integrations survey (control-room/integrations.js) shells out to for the
  // per-repo telemetry report. When unset, the survey probes the PATH with
  // `which repo-memory` once per snapshot — set this on hosts where the daemon
  // runs with a GUI/launchd PATH that misses npm globals. Mirrored by the
  // CHROXY_REPO_MEMORY_BIN env var.
  controlRoomRepoMemoryBin: 'string',
  maxSessions: 'number',
  maxHistory: 'number',
  maxMessages: 'number',
  showToken: 'boolean',
  logFormat: 'string',
  environments: 'object',
  // #5413: notification-sink settings. Currently one sub-block,
  // `notifications.discord`, carrying the Discord status-embed sink's
  // non-secret knobs: `botName` (string), `colors` (project → decimal
  // 24-bit RGB map for the embed sidebar), `defaultColor` /
  // `permissionColor` / `errorColor` (decimal RGB), `updateThrottleMs`
  // (min interval between same-state routine embed updates),
  // `heartbeatIntervalMs` (elapsed-time refresh; 0 disables) and
  // `pruneAfterMs` (state-store entry retention, #5429/#5434; 0 disables
  // pruning). The webhook
  // URL itself is a SECRET and deliberately NOT a config key — it lives in
  // CHROXY_DISCORD_WEBHOOK_URL or ~/.chroxy/credentials.json (0600); see
  // discord-credentials.js. Documented in CONFIG.md +
  // docs/guides/discord-notifications.md.
  notifications: 'object',
  // #5158: worktree garbage-collection. `{ autoReap: boolean }` — when true,
  // the server reclaims orphaned, dead-pid-locked agent worktrees on startup
  // (clean trees only, never --force). Defaults to off; the `chroxy worktree
  // gc` CLI is always available for manual/dry-run use.
  worktreeGc: 'object',
  sandbox: 'object',
  // Optional allowlist of absolute directory paths that sessions may use
  // as their working directory. When set (non-empty array), session
  // cwds MUST be within one of these realpath-resolved roots;
  // otherwise creation is rejected. When unset/empty, falls back to the
  // legacy "must be inside $HOME" check. Defense-in-depth (credential
  // directory deny-list) is active in BOTH modes — see validateCwdAllowed
  // in handler-utils.js. Added in the 2026-04-11 audit blocker 1 fix.
  workspaceRoots: 'array',
  // Gates the auto permission mode (bypass all permission checks). When
  // not explicitly set to true, clients that attempt to flip to auto
  // mode are rejected with AUTO_MODE_DISABLED_BY_CONFIG. Defaults to
  // undefined/false so fresh installs are secure-by-default. Operators
  // who want to run Claude unattended can opt in by editing their
  // config file on the dev machine (physical-access proxy for real
  // user confirmation). Added in the 2026-04-11 audit Adversary A5 fix.
  allowAutoPermissionMode: 'boolean',
  // #5985 (epic #5982): gate for the embedded user-shell terminal — a
  // `user-shell` session spawns the operator's `$SHELL` (arbitrary code
  // execution on the dev machine, reachable through the tunnel). Nested object
  // `{ enabled: boolean }`. Defaults to undefined/false so fresh installs are
  // secure-by-default: creating a `user-shell` session is rejected with
  // USER_SHELL_DISABLED unless `userShell.enabled === true`. Enabling is a
  // deliberate edit on the dev machine (physical-access proxy for confirmation),
  // matching `allowAutoPermissionMode`. The gate is enforced in
  // SessionManager.createSession so it covers every spawn path (WS create,
  // restore, internal callers) — see the swarm-audit C3 finding.
  userShell: 'object',
  // Allowlist of Docker image patterns that create_environment may use.
  // Each entry is either an exact image name or a prefix pattern like
  // `mcr.microsoft.com/devcontainers/*`. When set, client-supplied
  // images must match at least one entry; otherwise the request is
  // rejected with DOCKER_IMAGE_NOT_ALLOWED. When unset, falls back to
  // a built-in DEFAULT_ALLOWED_DOCKER_IMAGES list (see
  // docker-image-allowlist.js) covering common base images. Added in
  // the 2026-04-11 audit Adversary A7 fix to close the "register any
  // attacker-controlled image and run it" attack path.
  allowedDockerImages: 'array',
  // Per-session regex source string used by `shouldSkipEvaluator` to extend
  // the default continuation-pattern skip list. Wrapped in try/catch when
  // compiled — malformed sources are logged and ignored, the default
  // pattern still applies. Documented in CONFIG.md. Added in #3187.
  promptEvaluatorSkipPattern: 'string',
  // Per-skill byte cap and global skills-context budget (#3202). Skills
  // exceeding the per-skill cap are rejected; a merged set exceeding the
  // global cap is pruned by ascending priority then alphabetical name.
  // Defaults: 32768 (32KB) per skill, 262144 (256KB) total. Setting either
  // to 0 disables that cap. Documented in CONFIG.md.
  maxSkillBytes: 'number',
  maxTotalSkillBytes: 'number',
  // Per-provider skill allowlist (#3207). An object keyed by provider id
  // (e.g. `codex`, `gemini`) whose value is an array of skill names that
  // are permitted to load for that provider. When this map is omitted
  // entirely, the loader keeps the v1 permissive behaviour (every loaded
  // skill is eligible for every provider). When the map is present:
  //   - Claude-family providers (`claude-sdk`, `claude-cli`, `docker-*`)
  //     stay permissive — Claude has built-in tool gating so skills there
  //     are lower risk.
  //   - For non-Claude providers (`codex`, `gemini`, …) only the skills
  //     listed in the allowlist for that provider load. A missing key
  //     OR an empty array filters out ALL skills for that provider —
  //     fail-secure.
  // Documented in CONFIG.md.
  providerSkillAllowlist: 'object',
  // Skill content-hash mismatch mode (#3204). One of:
  //   - 'warn': a hash mismatch logs a sanitised warn and emits a
  //     `skill_changed` WS event but the skill still loads.
  //   - 'block': same warn + event, but the skill is filtered out of
  //     the active set until the operator explicitly re-trusts it.
  // Invalid values disable trust checking — the operator must
  // explicitly opt into 'warn' or 'block' to enable it. This was an
  // intentional design choice so the trust ledger is opt-in, not
  // implicit.
  // Documented in CONFIG.md.
  trustMismatchMode: 'string',
  // #6858: opt-in provenance verification for spawned provider binaries.
  // Nested object:
  //   binaryProvenance.mode           'off' (default) | 'warn' | 'block' —
  //     SHA-256 pin ledger. Pins each provider binary on first sight; a changed
  //     hash re-gates (warn surfaces + allows, block refuses the spawn).
  //   binaryProvenance.signatureGate  boolean (default false) — macOS `spctl`
  //     signature/notarization gate; hard-blocks un-notarized builds when on.
  // Both OFF by default so P1 (#6708) behaviour is unchanged. Env overrides:
  //   CHROXY_BINARY_PROVENANCE (off|warn|block), CHROXY_BINARY_SIGNATURE_GATE (1|0).
  // See resolveBinaryProvenanceMode() / isBinarySignatureGateEnabled() and
  // docs/security/spawned-binary-provenance.md.
  binaryProvenance: 'object',
  // #3749 / #3884 / #3899: SOFT-warning inactivity timeout (ms). When no
  // SDK / CLI event fires within this window, the server emits an
  // `inactivity_warning` event (and push notification) — the session
  // stays alive. Defaults to 1800000 (30 min). Was a hardcoded 5 min
  // before — too aggressive for legitimate slow tools (large fetches,
  // long Bash, extended thinking). Range: 30s minimum, 24h maximum —
  // validateConfig logs a warning for out-of-range values (warn-only,
  // not clamped); the runtime still applies whatever was set.
  // Operators should fix the warning rather than rely on silent
  // normalisation.
  resultTimeoutMs: 'number',
  // #3899: HARD-cap inactivity timeout (ms). When silence continues
  // for this long with no user check-in, the session is force-cleared
  // (the pre-#3899 kill path). Defaults to 7200000 (2h). Same range
  // semantics as resultTimeoutMs — operators can set this shorter if
  // they want tighter runaway-session protection, but it should always
  // be >= resultTimeoutMs (the soft warning fires first).
  hardTimeoutMs: 'number',
  // #4467: stream-stall recovery (ms). Resets on any stream activity from
  // the child; when silence reaches this window while busy, the session
  // emits a recoverable error (code: stream_stall), clears busy state,
  // and the dashboard can offer a retry. Default 300000 (5 min). Set to
  // 0 to disable (operators with legitimately long event gaps).
  streamStallTimeoutMs: 'number',
  // #5288: background-shell HARD-quiesce window (ms). A finished-but-never-
  // polled background shell is reaped after this much continuous output
  // silence so it stops pinning the session "running". Default 14400000 (4h);
  // set 0 to disable hard-reaping (advisory-only, #5247). The tradeoff: a
  // genuinely-silent-for-hours background compute could have its tracking
  // reaped — operators running such workloads should raise this (6-8h) or
  // disable it. Range: 60s minimum, 24h maximum (0 to disable).
  backgroundShellHardQuiesceMs: 'number',
  // #4601: per-provider override map for streamStallTimeoutMs. An object
  // keyed by provider id (e.g. 'codex', 'gemini', 'claude-sdk') whose
  // value is a stall window in ms. Same 5s-24h-or-0 validation as
  // `streamStallTimeoutMs` applies to each entry. When a session is
  // created for a provider that has an entry here, that entry wins over
  // the global `streamStallTimeoutMs`; otherwise the global value (or
  // BaseSession default) applies. Default behaviour is unchanged when
  // omitted — Codex/Gemini/long-running upstream APIs were the original
  // motivation but operators can override any provider id.
  providerStreamStallTimeoutMs: 'object',
  // #4482: per-call MCP tools/call timeout (ms). Forwarded to
  // byok-mcp-client.callTool's setTimeout via byok-session →
  // MCPFleet.callTool → MCPClient.callTool. Default 30000 (30s) at the
  // client layer matches DEFAULT_TOOL_CALL_TIMEOUT_MS. Range 1s-10min —
  // below 1s every realistic MCP server times out, above 10min the
  // model conversation is already lost.
  mcpToolCallTimeoutMs: 'number',
}

/**
 * Config keys that should be masked in verbose output and sanitized logs.
 * `pushToken` was a dead entry — it is never a CONFIG_SCHEMA key; push tokens
 * are runtime device registrations (`prefs.devices`), masked elsewhere. The
 * only real config secret is `apiToken`. (audit P2-12)
 */
const SENSITIVE_KEYS = ['apiToken']

/**
 * #5144: recognised values for `environments.backend`. 'docker' is the default
 * when the key is absent so existing single-node setups are unchanged.
 */
const ENVIRONMENT_BACKENDS = new Set(['docker', 'k8s', 'rancher'])

/** #5144: valid Kubernetes imagePullPolicy values (mirrors k8s.js). */
const VALID_K8S_PULL_POLICIES = new Set(['Always', 'IfNotPresent', 'Never'])

/** #5144: valid K8sBackend connectMode values (mirrors k8s.js). */
const VALID_K8S_CONNECT_MODES = new Set(['portforward', 'clusterip'])

/**
 * #5144: Rancher cluster-/project-ID formats. Kept in sync with the canonical
 * regexes in rancher.js (RANCHER_CLUSTER_ID / RANCHER_PROJECT_ID). Duplicated
 * here rather than imported to keep config.js free of any cluster-client
 * dependency (rancher.js eagerly imports @kubernetes/client-node), so loading
 * config never pulls in the kube SDK.
 */
const RANCHER_CLUSTER_ID_RE = /^c-[a-z0-9-]+$/
const RANCHER_PROJECT_ID_RE = /^p-[a-z0-9-]+$/

/**
 * #5878 (audit P2-6 part 2): warn on unrecognised keys in a config sub-block so
 * a typo (`billing.creditTeir`, `worktreeGc.autoRepa`, `k8s.imagePulPolicy`)
 * surfaces a non-fatal warning instead of being silently dropped. Factored from
 * the existing `notifications.discord` unknown-key loop (#5453).
 *
 * Iterates own enumerable keys; a key absent from `knownSet` pushes an
 * "Invalid value … unknown key" warning (the NON-fatal wording — the CLI layer
 * escalates only "Invalid type" prefixes, so a cosmetic typo can never fail
 * startup). The "supported:" hint lists `supportedKeys` (defaults to `knownSet`)
 * so a block whose known set includes allowed-but-not-advertised keys (e.g.
 * discord's secret keys, which get their own pointed warning) doesn't surface
 * them as suggestions.
 *
 * @param {object} obj - the sub-block (already known to be a plain object)
 * @param {Set<string>} knownSet - recognised keys (no warning)
 * @param {string} prefix - dotted path for the message (e.g. 'environments.k8s')
 * @param {string[]} warnings - accumulator
 * @param {Set<string>|string[]} [supportedKeys] - keys to list in the hint
 */
function warnUnknownKeys(obj, knownSet, prefix, warnings, supportedKeys = knownSet) {
  const hint = [...supportedKeys].join(', ')
  for (const key of Object.keys(obj)) {
    if (knownSet.has(key)) continue
    warnings.push(`Invalid value for '${prefix}.${key}': unknown key (supported: ${hint})`)
  }
}

// #5878: recognised keys per advanced/enterprise config sub-block. Each set is
// the UNION of what the validator checks AND what the wiring layer
// (createEnvironmentBackend / server-cli / the reaper) forwards to the consumer
// — a key the consumer reads but the validator omits would otherwise false-warn.
// Verified against the consumers: the K8sBackend wiring in
// createEnvironmentBackend (the `new K8sBackend({...})` field list) + the
// `workspace` sub-block (#4556); billing-budget.js + billing-canary (egressCheck
// / datacenterPrefixes via server-cli); worktree-reaper.js; rancher.js (the
// RancherBackend ctor) + resolveRancherToken (tokenEnv / tokenFile).
const K8S_SUPPORTED_KEYS = new Set([
  'namespace', 'inCluster', 'kubeconfigPath', 'sidecarImage', 'imagePullPolicy',
  'connectMode', 'namespaceQuota', 'namespaceLimitRange', 'workspace',
])
const BILLING_SUPPORTED_KEYS = new Set([
  'creditTier', 'monthlyCreditBudgetUsd', 'budgetWarningPercent', 'egressCheck', 'datacenterPrefixes',
])
const WORKTREE_GC_SUPPORTED_KEYS = new Set([
  'autoReap', 'reapIntervalMs', 'maxLockAgeMs',
])
const RANCHER_SUPPORTED_KEYS = new Set([
  'rancherUrl', 'clusterId', 'token', 'tokenEnv', 'tokenFile', 'caData', 'skipTLSVerify', 'defaultProjectId',
])

/**
 * #5144: validate the `environments.k8s` connection sub-block at config-load
 * time. The `workspace` sub-block has its own validation (#4556); this covers
 * the remaining fields the wiring layer forwards to `K8sBackend`. Every field
 * is optional — only the fields actually present are checked — so a partial
 * block (or one carrying only `workspace`) passes cleanly.
 *
 * Pushes human-readable warnings onto `warnings`; never throws.
 *
 * @param {object} k8s - The `environments.k8s` object (already known to be a plain object)
 * @param {string[]} warnings - Accumulator the caller logs/returns
 */
function validateK8sBlock(k8s, warnings) {
  const stringFields = ['namespace', 'kubeconfigPath', 'sidecarImage']
  for (const field of stringFields) {
    if (Object.prototype.hasOwnProperty.call(k8s, field) && typeof k8s[field] !== 'string') {
      warnings.push(
        `Invalid type for 'environments.k8s.${field}': expected string, got ${Array.isArray(k8s[field]) ? 'array' : typeof k8s[field]}`,
      )
    }
  }
  if (Object.prototype.hasOwnProperty.call(k8s, 'inCluster') && typeof k8s.inCluster !== 'boolean') {
    warnings.push(
      `Invalid type for 'environments.k8s.inCluster': expected boolean, got ${typeof k8s.inCluster}`,
    )
  }
  if (Object.prototype.hasOwnProperty.call(k8s, 'imagePullPolicy')) {
    const v = k8s.imagePullPolicy
    if (typeof v !== 'string' || !VALID_K8S_PULL_POLICIES.has(v)) {
      warnings.push(
        `Invalid value for 'environments.k8s.imagePullPolicy': '${v}' (must be one of: ${[...VALID_K8S_PULL_POLICIES].join(', ')})`,
      )
    }
  }
  if (Object.prototype.hasOwnProperty.call(k8s, 'connectMode')) {
    const v = k8s.connectMode
    if (typeof v !== 'string' || !VALID_K8S_CONNECT_MODES.has(v)) {
      warnings.push(
        `Invalid value for 'environments.k8s.connectMode': '${v}' (must be one of: ${[...VALID_K8S_CONNECT_MODES].join(', ')})`,
      )
    }
  }
  // #5878: typo-catch. `workspace` IS recognised (validated separately at the
  // call site, #4556), so it's in the known set — only genuine unknowns warn.
  warnUnknownKeys(k8s, K8S_SUPPORTED_KEYS, 'environments.k8s', warnings)
}

/**
 * #5144: validate the `environments.rancher` connection block at config-load
 * time. Mirrors `validateRancherOptions` in rancher.js (URL shape, cluster-ID
 * format, presence of a bearer token) so the operator sees the same error at
 * startup that RancherBackend's constructor would throw — without ever logging
 * the token value itself.
 *
 * Gated on `isRancherConfigured` semantics: a block missing any of rancherUrl /
 * clusterId / token is treated as "Rancher not yet configured" and only its
 * top-level shape (must be a plain object) is checked. This keeps a
 * half-filled-in block from spamming warnings during setup while still
 * catching a genuinely malformed complete config.
 *
 * Pushes human-readable warnings onto `warnings`; never throws. The token value
 * is never echoed into a warning.
 *
 * @param {*} rancher - The `environments.rancher` value (any type)
 * @param {string[]} warnings - Accumulator the caller logs/returns
 */
function validateRancherBlock(rancher, warnings) {
  if (typeof rancher !== 'object' || rancher === null || Array.isArray(rancher)) {
    warnings.push(
      `Invalid type for 'environments.rancher': expected object, got ${Array.isArray(rancher) ? 'array' : typeof rancher}`,
    )
    return
  }

  // #5878: typo-catch — runs BEFORE the "configured" gate below so an unknown
  // key warns even in a half-filled-in block.
  warnUnknownKeys(rancher, RANCHER_SUPPORTED_KEYS, 'environments.rancher', warnings)

  const { rancherUrl, clusterId, token, tokenEnv, tokenFile, caData, skipTLSVerify, defaultProjectId } = rancher

  // A token can come from any of three secret-friendly sources (resolved by
  // `resolveRancherToken` at construct time). Presence of ANY source counts
  // toward "configured" so a block using `tokenEnv` / `tokenFile` is still
  // validated here (Copilot review #5148) — not just inline `token`.
  const hasTokenSource = Boolean(token || tokenEnv || tokenFile)

  // Presence gate (mirrors isRancherConfigured): unless rancherUrl + clusterId
  // are present AND a token source is configured, treat the block as "not
  // configured yet" — only the top-level shape was checked above. This keeps a
  // half-filled-in block from spamming warnings during setup.
  const configured = Boolean(rancherUrl && clusterId && hasTokenSource)
  if (!configured) return

  if (typeof rancherUrl !== 'string' || rancherUrl.length === 0) {
    warnings.push(`Invalid value for 'environments.rancher.rancherUrl': must be a non-empty string`)
  } else {
    let parsed
    try {
      parsed = new URL(rancherUrl)
    } catch {
      parsed = null
      warnings.push(`Invalid URL format for 'environments.rancher.rancherUrl': ${rancherUrl}`)
    }
    if (parsed && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      warnings.push(
        `Invalid value for 'environments.rancher.rancherUrl': must use http:// or https://, got '${parsed.protocol}'`,
      )
    }
  }

  if (typeof clusterId !== 'string' || !RANCHER_CLUSTER_ID_RE.test(clusterId)) {
    warnings.push(
      `Invalid value for 'environments.rancher.clusterId': must match the Rancher cluster-ID format (c-...), got '${clusterId}'`,
    )
  }

  // Token sources. Validate the SHAPE of each provided source (never the value
  // — the token is never echoed). Only warn "missing token" when NO source is
  // present; an inline `token` is no longer required when `tokenEnv` /
  // `tokenFile` is set (Copilot review #5148).
  if (token != null && (typeof token !== 'string' || token.length === 0)) {
    warnings.push(`Invalid value for 'environments.rancher.token': when provided, must be a non-empty bearer token string`)
  }
  if (tokenEnv != null && (typeof tokenEnv !== 'string' || tokenEnv.length === 0)) {
    warnings.push(`Invalid value for 'environments.rancher.tokenEnv': when provided, must be a non-empty env-var name`)
  }
  if (tokenFile != null && (typeof tokenFile !== 'string' || tokenFile.length === 0)) {
    warnings.push(`Invalid value for 'environments.rancher.tokenFile': when provided, must be a non-empty file path`)
  }
  // NB: a "missing token" warning is unreachable here — the `configured` gate
  // above already requires at least one token source, so a block with no token
  // source short-circuits as "not configured yet" without warning (the intended
  // setup-friendly behaviour). The shape checks above only fire on a block that
  // is otherwise complete.

  if (caData != null && (typeof caData !== 'string' || caData.length === 0)) {
    warnings.push(
      `Invalid value for 'environments.rancher.caData': when provided, must be a non-empty base64-encoded PEM string`,
    )
  }

  if (skipTLSVerify != null && typeof skipTLSVerify !== 'boolean') {
    warnings.push(
      `Invalid type for 'environments.rancher.skipTLSVerify': expected boolean, got ${typeof skipTLSVerify}`,
    )
  }

  if (defaultProjectId != null && (typeof defaultProjectId !== 'string' || !RANCHER_PROJECT_ID_RE.test(defaultProjectId))) {
    warnings.push(
      `Invalid value for 'environments.rancher.defaultProjectId': must match the Rancher project-ID format (p-...), got '${defaultProjectId}'`,
    )
  }
}

/** #5413: decimal 24-bit RGB range for Discord embed sidebar colors. */
const MAX_DISCORD_COLOR = 16777215

// #5453: the recognised `notifications.discord` config knobs. The unknown-key
// check warns on anything outside this set so a typo (e.g. `botname`) or a
// test-injection seam (`resolveWebhookUrl`/`sleepImpl`/`now`, reachable via the
// `{ ...config.notifications.discord }` spread into the sink) surfaces instead of
// silently no-op'ing / failing the sink closed. Keep in sync with the per-key
// validation below. The webhook URL is a SECRET (its own warning) — not a knob.
const DISCORD_SUPPORTED_KEYS = new Set([
  'botName', 'billingAlerts', 'defaultColor', 'permissionColor', 'errorColor',
  'colors', 'updateThrottleMs', 'heartbeatIntervalMs', 'pruneAfterMs',
  // #5676 status-watchdog tunables — the sink reads these from the config spread
  // (discord-webhook-sink.js: staleAfterMs/offlineAfterMs, default 10m/30m), so
  // they are real config knobs, not test seams (PR #5845 review).
  'staleAfterMs', 'offlineAfterMs',
  // State-store paths: the caller (server-cli.js / supervisor.js) defaults these
  // then lets the config spread override them, and push.js honors them
  // (statePath → DiscordWebhookSink, billingStatePath → DiscordBillingSink). They
  // are string value knobs (override → works), unlike the function test seams, so
  // an operator relocating them must not warn as unknown (PR #5845 review).
  'statePath', 'billingStatePath',
])
const DISCORD_SECRET_KEYS = ['webhookUrl', 'webhook', 'url']

/**
 * #5413: validate the `notifications.discord` block (the Discord
 * status-embed sink's non-secret knobs). Every field is optional; only
 * fields actually present are checked. The webhook URL is a secret and
 * does NOT belong here — a `webhookUrl` key in this block gets a pointed
 * warning steering the operator to the credential paths.
 *
 * All warnings use the "Invalid value" wording so a cosmetic typo never
 * escalates to a fatal startup error (the CLI layer treats "Invalid type"
 * prefixes as fatal); the sink clamps bad values to defaults at runtime.
 *
 * @param {*} discord - The `notifications.discord` value
 * @param {string[]} warnings - Accumulator the caller logs/returns
 */
/**
 * #5665: validate the `billing` block (monthly programmatic-credit budget
 * meter). Per-FIELD problems (bad creditTier, out-of-range numbers) are
 * "Invalid value" warnings — non-fatal, the meter clamps/ignores at runtime.
 * A gross top-level non-object value additionally trips the generic
 * `billing: 'object'` schema check ("Invalid type", fatal), matching the
 * `notifications` / `environments` object blocks — a billing block that isn't
 * even an object is a real misconfiguration worth failing fast on.
 */
function validateBillingBlock(billing, warnings) {
  if (typeof billing !== 'object' || billing === null || Array.isArray(billing)) {
    warnings.push(`Invalid value for 'billing': expected object, got ${Array.isArray(billing) ? 'array' : typeof billing}`)
    return
  }
  const VALID_TIERS = ['pro', 'max5x', 'max20x']
  if (Object.prototype.hasOwnProperty.call(billing, 'creditTier')) {
    if (typeof billing.creditTier !== 'string' || !VALID_TIERS.includes(billing.creditTier)) {
      warnings.push(`Invalid value for 'billing.creditTier': expected one of ${VALID_TIERS.join(' | ')}, got ${JSON.stringify(billing.creditTier)}`)
    }
  }
  if (Object.prototype.hasOwnProperty.call(billing, 'monthlyCreditBudgetUsd')) {
    const v = billing.monthlyCreditBudgetUsd
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      warnings.push(`Invalid value for 'billing.monthlyCreditBudgetUsd': expected a number >= 0, got ${JSON.stringify(v)}`)
    }
  }
  if (Object.prototype.hasOwnProperty.call(billing, 'budgetWarningPercent')) {
    const v = billing.budgetWarningPercent
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100) {
      warnings.push(`Invalid value for 'billing.budgetWarningPercent': expected a number 1-100, got ${JSON.stringify(v)}`)
    }
  }
  // #5828: opt-in datacenter-egress check for the billing canary. Default OFF
  // (no field) — when enabled, the daemon makes a best-effort public-IP lookup
  // so it can warn when a subscription-billed provider runs from a cloud host
  // (a documented ban signal). Off by default because it's an outbound network
  // call the operator should consent to.
  if (Object.prototype.hasOwnProperty.call(billing, 'egressCheck')) {
    if (typeof billing.egressCheck !== 'boolean') {
      warnings.push(`Invalid value for 'billing.egressCheck': expected a boolean, got ${JSON.stringify(billing.egressCheck)}`)
    }
  }
  // #5828: operator-supplied extra IPv4 prefixes for the datacenter classifier
  // (merged with the conservative built-in list). Lets a user on a known cloud
  // add their provider's ranges without a code change.
  if (Object.prototype.hasOwnProperty.call(billing, 'datacenterPrefixes')) {
    const v = billing.datacenterPrefixes
    if (!Array.isArray(v) || !v.every((p) => typeof p === 'string' && p.length > 0)) {
      warnings.push(`Invalid value for 'billing.datacenterPrefixes': expected an array of non-empty strings, got ${JSON.stringify(v)}`)
    }
  }
  // #5878: typo-catch for the billing knobs.
  warnUnknownKeys(billing, BILLING_SUPPORTED_KEYS, 'billing', warnings)
}

const USER_SHELL_SUPPORTED_KEYS = new Set(['enabled', 'requireApproval'])

// #5985 (epic #5982): validate the `userShell` block. Only `enabled` (boolean)
// today; the security primitives (primary-token gate, audit, isolation) land in
// the #5985b slice. SUB-key checks here are warn-only "Invalid value" (never
// "Invalid type") so a mis-typed knob doesn't abort startup via
// loadAndMergeConfig's fatal-prefix — and isUserShellEnabled stays fail-closed
// for a bad `enabled` value. NOTE: the TOP-LEVEL shape (userShell must be an
// object) is enforced separately by the shared schema type-gate in
// validateConfig, which IS fatal for a non-object — same as billing /
// notifications / environments. That's the fail-safe choice for a security gate:
// a malformed block stops boot rather than silently disabling.
function validateUserShellBlock(userShell, warnings) {
  if (typeof userShell !== 'object' || userShell === null || Array.isArray(userShell)) {
    warnings.push(`Invalid value for 'userShell': expected object, got ${Array.isArray(userShell) ? 'array' : typeof userShell}`)
    return
  }
  if (Object.prototype.hasOwnProperty.call(userShell, 'enabled')) {
    if (typeof userShell.enabled !== 'boolean') {
      warnings.push(`Invalid value for 'userShell.enabled': expected a boolean, got ${JSON.stringify(userShell.enabled)}`)
    }
  }
  // #6277 — host-local per-spawn shell approval. Warn-only (never fatal) like
  // `enabled`; isUserShellApprovalRequired stays fail-closed for a bad value.
  if (Object.prototype.hasOwnProperty.call(userShell, 'requireApproval')) {
    if (typeof userShell.requireApproval !== 'boolean') {
      warnings.push(`Invalid value for 'userShell.requireApproval': expected a boolean, got ${JSON.stringify(userShell.requireApproval)}`)
    }
  }
  warnUnknownKeys(userShell, USER_SHELL_SUPPORTED_KEYS, 'userShell', warnings)
}

// #5985: single source of truth for "may a user-shell session be created?".
// Fail-closed — anything other than an explicit `userShell.enabled === true` is
// disabled. Used by SessionManager.createSession (the authoritative gate).
export function isUserShellEnabled(config) {
  return config?.userShell?.enabled === true
}

// #6481 (epic #6469): single source of truth for the OPT-IN IDE feature surface
// (file navigator, symbol navigation, go-to-definition, find-references,
// edit-in-place). Off by default so it never risks the core remote-cockpit
// offering. Enabled by an explicit `features.ide === true` in config OR the
// `CHROXY_ENABLE_IDE=1` env override (quick opt-in / dev). When on, the server
// registers the IDE WS handlers and advertises the `ide` capability so clients
// reveal the IDE UI; off ⇒ the IDE handlers are fail-closed no-ops (registered
// but gated per-call via isIdeFeatureEnabled, so a runtime flag flip needs no
// re-registration) and no `ide` capability is advertised — no reachable IDE
// surface, no IDE UI, core byte-identical.
// Fail-closed: anything but an explicit boolean true / the env "1" is off.
export function isIdeFeatureEnabled(config) {
  if (process.env.CHROXY_ENABLE_IDE === '1') return true
  return config?.features?.ide === true
}

// #6691 — the opt-in orchestration/delegation harness ("committee"). Fail-closed
// like isIdeFeatureEnabled: only an explicit env=1 or `features.orchestration
// === true` enables it. Gates the WS handler surface AND the `orchestration`
// capability advertised in auth_ok, so a client only reveals the Runs surface
// when the operator has opted in.
export function isOrchestrationEnabled(config) {
  if (process.env.CHROXY_ENABLE_ORCHESTRATION === '1') return true
  return config?.features?.orchestration === true
}

// #6858 — resolve the opt-in provider-binary provenance PIN-LEDGER mode. One of
// 'off' | 'warn' | 'block'. Fail-closed to 'off' (behaviour identical to the
// pre-#6858 spawn path) for anything but an explicit 'warn' / 'block'. Precedence:
//   CHROXY_BINARY_PROVENANCE env  >  config.binaryProvenance.mode  >  'off'.
// 'warn' pins on first sight and surfaces a later hash change while still
// spawning; 'block' refuses the spawn on a hash change until re-approved.
export function resolveBinaryProvenanceMode(config) {
  const env = typeof process.env.CHROXY_BINARY_PROVENANCE === 'string'
    ? process.env.CHROXY_BINARY_PROVENANCE.trim().toLowerCase()
    : ''
  if (env === 'warn' || env === 'block') return env
  if (env === 'off') return 'off'
  const cfg = config?.binaryProvenance && typeof config.binaryProvenance === 'object'
    ? config.binaryProvenance.mode
    : undefined
  return (cfg === 'warn' || cfg === 'block') ? cfg : 'off'
}

// #6858 — is the opt-in macOS signature/notarization gate (`spctl --assess`)
// enabled? Fail-closed to false (chroxy's own bundled providers are ad-hoc
// signed and would be rejected, so this can only ever be opt-in). Precedence:
//   CHROXY_BINARY_SIGNATURE_GATE env (1/0)  >  config.binaryProvenance.signatureGate  >  false.
export function isBinarySignatureGateEnabled(config) {
  const env = process.env.CHROXY_BINARY_SIGNATURE_GATE
  if (env === '1') return true
  if (env === '0') return false
  return config?.binaryProvenance?.signatureGate === true
}

// #6764 — opt-in semantic session titles. When on, the first user turn's sidebar
// label is upgraded from a raw truncation of the message to a short model-
// generated summary via a cheap one-shot (Haiku) call. Off by default; the
// truncation fallback is used when off, when the call fails, or when no model
// access is available. Enabled by `features.semanticTitles === true` OR the
// `CHROXY_SEMANTIC_TITLES=1` env override; `CHROXY_SEMANTIC_TITLES=0` force-
// disables (handy for tests / A-B without editing config).
export function isSemanticTitlesEnabled(config) {
  const env = process.env.CHROXY_SEMANTIC_TITLES
  if (env === '1') return true
  if (env === '0') return false
  return config?.features?.semanticTitles === true
}

// #6764 — resolve the model for the one-shot title call. Precedence:
//   CHROXY_SEMANTIC_TITLES_MODEL env  >  config.summarize.model  >  Haiku default.
// The `summarize.{model}` cheap-model override is reused (per #6764) so an
// operator who already tuned the summarizer's model gets the same for titles;
// the default stays a cheap Haiku alias so titles never burn a premium model.
export function resolveSemanticTitleModel(config) {
  const envModel = typeof process.env.CHROXY_SEMANTIC_TITLES_MODEL === 'string'
    && process.env.CHROXY_SEMANTIC_TITLES_MODEL.trim()
    ? process.env.CHROXY_SEMANTIC_TITLES_MODEL.trim()
    : null
  if (envModel) return envModel
  const summarizeModel = config?.summarize && typeof config.summarize === 'object'
    && typeof config.summarize.model === 'string' && config.summarize.model.trim()
    ? config.summarize.model.trim()
    : null
  return summarizeModel || DEFAULT_SEMANTIC_TITLE_MODEL
}

// #6764 — resolve the timeout (ms) for the one-shot title call. Precedence:
//   CHROXY_SEMANTIC_TITLES_TIMEOUT_MS env  >  config.summarize.titleTimeoutMs  >  default.
// The title call is fire-and-forget, so without a timeout a stalled provider
// connection leaves its promise pending forever (retaining the SessionManager +
// first message → an unbounded per-session leak) and never tears the one-shot
// subprocess down. The resolved value is passed to SessionManager, which turns it
// into an `AbortSignal.timeout(...)` so the call aborts and falls open to the
// truncation label. Invalid / non-positive values fall back to the default.
export function resolveSemanticTitleTimeoutMs(config) {
  const env = typeof process.env.CHROXY_SEMANTIC_TITLES_TIMEOUT_MS === 'string'
    ? process.env.CHROXY_SEMANTIC_TITLES_TIMEOUT_MS.trim()
    : ''
  if (env) {
    const n = Number(env)
    if (Number.isFinite(n) && n > 0) return n
  }
  const cfg = config?.summarize && typeof config.summarize === 'object'
    ? config.summarize.titleTimeoutMs
    : undefined
  if (typeof cfg === 'number' && Number.isFinite(cfg) && cfg > 0) return cfg
  return DEFAULT_SEMANTIC_TITLE_TIMEOUT_MS
}

// #6277: single source of truth for "does a user-shell spawn need host-local
// approval first?". Fail-closed — only an explicit `userShell.requireApproval
// === true` enables the gate. Independent of `enabled`: the gate only bites when
// shells are enabled (a disabled shell is already rejected upstream), so an
// operator opts into BOTH `enabled: true` and `requireApproval: true`.
export function isUserShellApprovalRequired(config) {
  return config?.userShell?.requireApproval === true
}

// #6378: which providers may serve a model id that is NOT in their static
// allowlist. The static-allowlist subprocess providers (gemini/codex/deepseek)
// otherwise hard-reject an unlisted-but-API-valid model, forcing a code release
// just to add one the upstream API already exposes. Opting a provider in here
// makes it behave like ollama (#5418 PROVIDER_MODELS_UNRESTRICTED): the id
// passes through verbatim and the upstream API becomes the validator. Returns a
// Set of provider-name strings; a missing/non-array value → empty Set (the
// default — OFF, so the misconfig-catching strictness is preserved unless an
// operator explicitly opts in). Only well-formed string entries are kept.
export function getAllowAnyModelProviders(config) {
  const raw = config?.providers?.allowAnyModel
  if (!Array.isArray(raw)) return new Set()
  return new Set(raw.filter((name) => typeof name === 'string' && name.length > 0))
}

// #6378: does `providerName` opt out of static model-allowlist validation?
// Fail-closed: anything other than an explicit entry in
// `config.providers.allowAnyModel` returns false.
export function isProviderModelUnrestricted(config, providerName) {
  if (!providerName) return false
  return getAllowAnyModelProviders(config).has(providerName)
}

function validateDiscordNotificationsBlock(discord, warnings) {
  if (typeof discord !== 'object' || discord === null || Array.isArray(discord)) {
    warnings.push(`Invalid value for 'notifications.discord': expected object, got ${Array.isArray(discord) ? 'array' : typeof discord}`)
    return
  }

  // Secrets do not belong in config.json (not permission-restricted, echoed
  // in verbose output). Warn loudly and point at the right place.
  for (const key of DISCORD_SECRET_KEYS) {
    if (Object.prototype.hasOwnProperty.call(discord, key)) {
      warnings.push(
        `'notifications.discord.${key}' is not supported: the webhook URL is a secret — set CHROXY_DISCORD_WEBHOOK_URL or add "discordWebhookUrl" to ~/.chroxy/credentials.json (mode 0600) instead`,
      )
    }
  }

  if (Object.prototype.hasOwnProperty.call(discord, 'botName') && (typeof discord.botName !== 'string' || discord.botName.length === 0)) {
    warnings.push(`Invalid value for 'notifications.discord.botName': expected a non-empty string`)
  }

  // #5828: kill-switch for the Discord billing-alert sink. Default ON when a
  // webhook resolves; set false to keep billing alerts off Discord while the
  // status embed stays on.
  if (Object.prototype.hasOwnProperty.call(discord, 'billingAlerts') && typeof discord.billingAlerts !== 'boolean') {
    warnings.push(`Invalid value for 'notifications.discord.billingAlerts': expected a boolean, got ${JSON.stringify(discord.billingAlerts)}`)
  }

  const isValidColor = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_DISCORD_COLOR
  for (const key of ['defaultColor', 'permissionColor', 'errorColor']) {
    if (Object.prototype.hasOwnProperty.call(discord, key) && !isValidColor(discord[key])) {
      warnings.push(`Invalid value for 'notifications.discord.${key}': expected an integer 0-${MAX_DISCORD_COLOR} (decimal 24-bit RGB), got ${JSON.stringify(discord[key])}`)
    }
  }

  if (Object.prototype.hasOwnProperty.call(discord, 'colors')) {
    const colors = discord.colors
    if (typeof colors !== 'object' || colors === null || Array.isArray(colors)) {
      warnings.push(`Invalid value for 'notifications.discord.colors': expected an object mapping project name → decimal color`)
    } else {
      for (const [project, value] of Object.entries(colors)) {
        if (!isValidColor(value)) {
          warnings.push(`Invalid value for 'notifications.discord.colors.${project}': expected an integer 0-${MAX_DISCORD_COLOR} (decimal 24-bit RGB), got ${JSON.stringify(value)}`)
        }
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(discord, 'updateThrottleMs')) {
    const v = discord.updateThrottleMs
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      warnings.push(`Invalid value for 'notifications.discord.updateThrottleMs': expected a number >= 0, got ${JSON.stringify(v)}`)
    }
  }

  if (Object.prototype.hasOwnProperty.call(discord, 'heartbeatIntervalMs')) {
    const v = discord.heartbeatIntervalMs
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      warnings.push(`Invalid value for 'notifications.discord.heartbeatIntervalMs': expected a number >= 0 (0 disables), got ${JSON.stringify(v)}`)
    } else if (v !== 0 && v < 10_000) {
      warnings.push(`Invalid value for 'notifications.discord.heartbeatIntervalMs': ${v} (minimum 10000 / 10s; set 0 to disable — the sink falls back to its default)`)
    }
  }

  // #5429/#5434: state-store entry retention. 0 disables pruning; the sink
  // falls back to its 24h default on invalid values. #5457: values below 60s
  // get the same treatment — a retention shorter than the gap between events
  // prunes the messageId in between and turns the single status embed into
  // message-per-event spam (parity with the heartbeatIntervalMs floor).
  if (Object.prototype.hasOwnProperty.call(discord, 'pruneAfterMs')) {
    const v = discord.pruneAfterMs
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      warnings.push(`Invalid value for 'notifications.discord.pruneAfterMs': expected a number >= 0 (0 disables pruning), got ${JSON.stringify(v)}`)
    } else if (v !== 0 && v < 60_000) {
      warnings.push(`Invalid value for 'notifications.discord.pruneAfterMs': ${v} (minimum 60000 / 60s; set 0 to disable pruning — the sink falls back to its default)`)
    }
  }

  // #5676 status-watchdog tunables: the sink honors any finite >= 0 value, else
  // falls back to its default (10m stale / 30m offline). Validate to keep
  // DISCORD_SUPPORTED_KEYS in sync with the per-key checks (PR #5845 review).
  for (const key of ['staleAfterMs', 'offlineAfterMs']) {
    if (Object.prototype.hasOwnProperty.call(discord, key)) {
      const v = discord[key]
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        warnings.push(`Invalid value for 'notifications.discord.${key}': expected a number >= 0 (the sink falls back to its default), got ${JSON.stringify(v)}`)
      }
    }
  }

  // #5453: warn on any unrecognised key. A typo'd knob is silently ignored
  // (operator gets default behavior with no hint), and a test-seam key spread
  // into the sink constructor fails it closed — both silent foot-guns. The
  // secret keys are KNOWN (no unknown-key warning — they already got their
  // specific "it's a secret" warning above) but are NOT advertised in the
  // "supported:" hint, so warnUnknownKeys takes the union as the known set and
  // DISCORD_SUPPORTED_KEYS as the hint. #5878: factored onto the shared helper.
  warnUnknownKeys(
    discord,
    new Set([...DISCORD_SUPPORTED_KEYS, ...DISCORD_SECRET_KEYS]),
    'notifications.discord',
    warnings,
    DISCORD_SUPPORTED_KEYS,
  )
}

/**
 * Return a copy of config with sensitive fields replaced by '***'.
 * Use this whenever the config object is serialized to logs or debug output.
 *
 * @param {object} config - Config object to sanitize
 * @returns {object} Shallow copy with sensitive fields masked
 */
export function sanitizeConfig(config) {
  const safe = { ...config }
  for (const key of SENSITIVE_KEYS) {
    if (safe[key]) safe[key] = '***'
  }
  return safe
}

/**
 * The SINGLE source of the fatal-vs-warn config policy (audit P1-9). A config
 * problem is FATAL (the CLI exits 1) iff its warning is a schema TYPE mismatch
 * — wording prefix "Invalid type ..." — because a wrong-typed field is a real
 * misconfiguration the operator must fix. Everything else ("Invalid value ...",
 * "Unknown config key ...", range/format warnings) is non-fatal: the runtime
 * clamps/ignores it, so a cosmetic typo never blocks startup.
 *
 * This used to be inlined as `w.startsWith('Invalid type')` in cli/shared.js,
 * divorced from where the warnings are produced — so a new fatal/non-fatal
 * decision had no single home and a mis-prefixed message could silently flip
 * a field's severity. Centralizing it here (with the invariant test in
 * config.test.js asserting no "Invalid value" warning is ever fatal) keeps the
 * policy and the wording convention in lockstep.
 */
export const FATAL_CONFIG_WARNING_PREFIX = 'Invalid type'

/** True iff this validateConfig warning should abort startup. See FATAL_CONFIG_WARNING_PREFIX. */
export function isFatalConfigWarning(warning) {
  return typeof warning === 'string' && warning.startsWith(FATAL_CONFIG_WARNING_PREFIX)
}

/**
 * Declarative range checks for the simple numeric config fields (audit P2-6).
 * Each entry replaces a hand-rolled `if (Number.isFinite(value) ...)` block that
 * was copy-pasted ~6 times — a shape where a forgotten `Number.isFinite` guard,
 * a missed `allowZero`, or an inverted comparison silently flips validation.
 *
 * `belowMessage`/`aboveMessage` are the EXACT operator-facing suffixes (appended
 * after `${value} `); wording is per-field by design (different unit labels).
 * Only the `Invalid value` PREFIX is load-bearing — it must never become
 * `Invalid type`, which the CLI treats as fatal (see FATAL_CONFIG_WARNING_PREFIX).
 *
 * Fields with extra logic stay bespoke in validateConfig: `sessionTimeout`
 * (duration-string parse), `hardTimeoutMs` (cross-field vs resultTimeoutMs), and
 * `providerStreamStallTimeoutMs` (per-entry map iteration).
 */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
const NUMERIC_RANGE_CHECKS = [
  { key: 'port', min: 1, max: 65535, belowMessage: '(must be 1-65535)', aboveMessage: '(must be 1-65535)' },
  { key: 'maxSessions', min: 1, belowMessage: '(must be >= 1)' },
  { key: 'maxPayload', min: 1024, max: 100 * 1024 * 1024, belowMessage: '(minimum 1KB / 1024 bytes)', aboveMessage: '(maximum 100MB)' },
  { key: 'resultTimeoutMs', min: 30_000, max: TWENTY_FOUR_HOURS_MS, finiteOnly: true, belowMessage: '(minimum 30000 / 30s)', aboveMessage: '(maximum 86400000 / 24h)' },
  { key: 'streamStallTimeoutMs', min: 5_000, max: TWENTY_FOUR_HOURS_MS, allowZero: true, finiteOnly: true, belowMessage: '(minimum 5000 / 5s; set 0 to disable)', aboveMessage: '(maximum 86400000 / 24h)' },
  { key: 'backgroundShellHardQuiesceMs', min: 60_000, max: TWENTY_FOUR_HOURS_MS, allowZero: true, finiteOnly: true, belowMessage: '(minimum 60000 / 60s; set 0 to disable)', aboveMessage: '(maximum 86400000 / 24h)' },
]

/**
 * Push an `Invalid value` warning when numeric `value` falls outside [min, max].
 * Skips non-number / NaN (the type-check loop already warned). `allowZero` skips
 * an explicit 0 (the "disable" sentinel). `min`/`max` are each optional
 * (maxSessions has only a lower bound).
 *
 * `finiteOnly` selects the original per-field guard exactly: port/maxSessions/
 * maxPayload historically used `typeof === 'number'`, so a parseFloat'd env like
 * `PORT=Infinity` reaches the comparison and trips the bound — keep that. The
 * timeout fields used `Number.isFinite`, which skips Infinity entirely — keep
 * that too (finiteOnly: true).
 */
function validateRange(warnings, key, value, { min, max, allowZero = false, finiteOnly = false, belowMessage, aboveMessage }) {
  if (typeof value !== 'number' || Number.isNaN(value)) return
  if (finiteOnly && !Number.isFinite(value)) return
  if (allowZero && value === 0) return
  if (min != null && value < min) {
    warnings.push(`Invalid value for '${key}': ${value} ${belowMessage}`)
  } else if (max != null && value > max) {
    warnings.push(`Invalid value for '${key}': ${value} ${aboveMessage}`)
  }
}

/**
 * Validate config object against schema.
 * Logs warnings for unknown keys and type mismatches.
 *
 * @param {object} config - Config object to validate
 * @param {boolean} verbose - If true, log detailed validation info
 * @returns {object} Validation result { valid: boolean, warnings: string[] }
 */
export function validateConfig(config, verbose = false) {
  const warnings = []

  // Check for unknown keys
  for (const key of Object.keys(config)) {
    if (!(key in CONFIG_SCHEMA)) {
      warnings.push(`Unknown config key: '${key}' (will be ignored)`)
    }
  }

  // Check types for known keys. A schema entry may be a union of types
  // separated by '|' (#5419 — `providers` accepts the legacy array OR the
  // object form); single-type entries keep the exact legacy wording.
  for (const [key, expectedType] of Object.entries(CONFIG_SCHEMA)) {
    if (key in config) {
      const value = config[key]
      const actualType = Array.isArray(value) ? 'array' : typeof value
      const expectedTypes = expectedType.split('|')

      if (!expectedTypes.includes(actualType)) {
        warnings.push(`Invalid type for '${key}': expected ${expectedTypes.join(' or ')}, got ${actualType}`)
      }
    }
  }

  // Range validation for the simple numeric fields (audit P2-6) — declarative
  // table + shared validateRange; the Number.isFinite guard skips fields whose
  // type the loop above already flagged. Duration/cross-field/map cases below
  // stay bespoke.
  for (const check of NUMERIC_RANGE_CHECKS) {
    validateRange(warnings, check.key, config[check.key], check)
  }

  if (typeof config.sessionTimeout === 'string' && config.sessionTimeout.length > 0) {
    const ms = parseDuration(config.sessionTimeout)
    if (ms == null) {
      warnings.push(`Invalid duration format for 'sessionTimeout': '${config.sessionTimeout}'`)
    } else if (ms < 30_000) {
      warnings.push(`Value for 'sessionTimeout' is too low: '${config.sessionTimeout}' (minimum 30s)`)
    }
  }

  // #6598: paired-session-token lifetime. Warn on a typo (which would silently
  // fall back to the 30d default) or a sub-floor value (floored to 5min at wiring).
  if (typeof config.sessionTokenTtl === 'string' && config.sessionTokenTtl.length > 0) {
    const ms = parseDuration(config.sessionTokenTtl)
    if (ms == null) {
      warnings.push(`Invalid duration format for 'sessionTokenTtl': '${config.sessionTokenTtl}'`)
    } else if (ms < 5 * 60_000) {
      warnings.push(`Value for 'sessionTokenTtl' is too low: '${config.sessionTokenTtl}' (minimum 5m)`)
    }
  }

  // #3899: hard-cap range. Same 30s / 24h bounds as resultTimeoutMs.
  // Additionally: warn if hardTimeoutMs < resultTimeoutMs — the soft
  // warning is supposed to fire first; an inverted config would fire
  // the kill before the warning ever surfaces. Warn-only (not clamped)
  // so operators can deliberately set them equal for tight kill
  // semantics if they really want.
  if (Number.isFinite(config.hardTimeoutMs)) {
    if (config.hardTimeoutMs < 30_000) {
      warnings.push(`Invalid value for 'hardTimeoutMs': ${config.hardTimeoutMs} (minimum 30000 / 30s)`)
    } else if (config.hardTimeoutMs > 24 * 60 * 60 * 1000) {
      warnings.push(`Invalid value for 'hardTimeoutMs': ${config.hardTimeoutMs} (maximum 86400000 / 24h)`)
    } else if (Number.isFinite(config.resultTimeoutMs) && config.hardTimeoutMs < config.resultTimeoutMs) {
      warnings.push(`'hardTimeoutMs' (${config.hardTimeoutMs}) is less than 'resultTimeoutMs' (${config.resultTimeoutMs}) — the soft warning will never fire before the hard kill`)
    }
  }

  // #4601: per-provider override map. Each entry follows the same
  // 5s-24h-or-0 range as the global `streamStallTimeoutMs`. Values that
  // pass type-of-map but fail per-entry validation produce a single warn
  // per offending entry; the runtime ignores those entries and falls
  // back to the global / default value (see SessionManager). The
  // top-level type check above (object) already rejects arrays via the
  // `actualType === 'array'` branch, so this block only runs on real
  // plain objects.
  if (
    config.providerStreamStallTimeoutMs &&
    typeof config.providerStreamStallTimeoutMs === 'object' &&
    !Array.isArray(config.providerStreamStallTimeoutMs)
  ) {
    for (const [providerId, value] of Object.entries(config.providerStreamStallTimeoutMs)) {
      const path = `providerStreamStallTimeoutMs.${providerId}`
      // NB: a bad per-entry value is an "Invalid value" warning (NOT
      // "Invalid type") even when the JS-level type mismatches the
      // expected number. The CLI layer (`cli/shared.js:loadAndMergeConfig`)
      // treats any warning whose prefix is "Invalid type" as a fatal
      // startup error — using that wording for a single mis-typed map
      // entry would prevent the whole server from booting, contradicting
      // the documented "drop bad entries, fall through to global" contract
      // (see PR #4745 Copilot review feedback).
      if (typeof value !== 'number') {
        warnings.push(`Invalid value for '${path}': expected number, got ${Array.isArray(value) ? 'array' : typeof value}`)
        continue
      }
      if (!Number.isFinite(value) || value < 0) {
        warnings.push(`Invalid value for '${path}': ${value} (must be 0 or a positive number)`)
        continue
      }
      if (value === 0) continue
      if (value < 5_000) {
        warnings.push(`Invalid value for '${path}': ${value} (minimum 5000 / 5s; set 0 to disable)`)
      } else if (value > 24 * 60 * 60 * 1000) {
        warnings.push(`Invalid value for '${path}': ${value} (maximum 86400000 / 24h)`)
      }
    }
  }

  // #4482: per-MCP-call timeout. 1s-10min. Unlike streamStallTimeoutMs,
  // 0 isn't meaningful here — a 0-ms callTool timeout fires immediately
  // and makes every MCP tool look broken — so any non-finite / non-
  // positive value gets a warning and the runtime falls back to the
  // client default (30s) instead of accepting it.
  if (Number.isFinite(config.mcpToolCallTimeoutMs)) {
    if (config.mcpToolCallTimeoutMs < 1_000) {
      warnings.push(`Invalid value for 'mcpToolCallTimeoutMs': ${config.mcpToolCallTimeoutMs} (minimum 1000 / 1s)`)
    } else if (config.mcpToolCallTimeoutMs > 10 * 60 * 1000) {
      warnings.push(`Invalid value for 'mcpToolCallTimeoutMs': ${config.mcpToolCallTimeoutMs} (maximum 600000 / 10min)`)
    }
  }

  // #4556: validate the optional environments.k8s.workspace block (operator
  // surface for the K8sBackend PVC strategy added in #4547 / #4548). Done at
  // config-load time so a typo (missing claimName, wrong type) surfaces at
  // startup rather than on the first environment-creation call. Shape mirrors
  // `K8sBackend.validateWorkspacePVC()` so an operator never sees a different
  // message at load-time vs runtime for the same malformed value.
  //
  // Only fires when the sub-block is present — the common case (Docker
  // operators without any k8s key, or with other k8s settings but no
  // workspace block) passes through untouched.
  if (config.environments && typeof config.environments === 'object' && !Array.isArray(config.environments)) {
    // #5144: backend selector. One of 'docker' (default) | 'k8s' | 'rancher'.
    // When absent the wiring layer falls back to Docker, so the common
    // single-node setup is unchanged. A bad value is warn-only (not fatal):
    // the wiring layer treats an unrecognised selector as Docker, mirroring
    // the "drop bad value, keep the safe default" contract used elsewhere.
    if (Object.prototype.hasOwnProperty.call(config.environments, 'backend')) {
      const backend = config.environments.backend
      if (typeof backend !== 'string') {
        // Deliberately an "Invalid value" (not "Invalid type") warning: the
        // wiring layer (`resolveEnvironmentBackend`) treats anything
        // unrecognised as Docker, so a typo must NOT be fatal.
        // `loadAndMergeConfig` escalates only "Invalid type" warnings to a hard
        // exit, which would contradict the documented "malformed → docker"
        // fallback (Copilot review #5148).
        warnings.push(
          `Invalid value for 'environments.backend': expected one of ${[...ENVIRONMENT_BACKENDS].join(', ')}, got ${Array.isArray(backend) ? 'array' : typeof backend}`,
        )
      } else if (!ENVIRONMENT_BACKENDS.has(backend)) {
        warnings.push(
          `Invalid value for 'environments.backend': '${backend}' (must be one of: ${[...ENVIRONMENT_BACKENDS].join(', ')})`,
        )
      }
    }

    const k8sBlock = config.environments.k8s
    if (k8sBlock && typeof k8sBlock === 'object' && !Array.isArray(k8sBlock)) {
      // #5144: validate the K8s connection sub-block (the `workspace` block
      // below already had its own validation from #4556). Only fields the
      // wiring layer actually forwards to K8sBackend are checked; each is
      // optional so a partial block (or just the workspace sub-block) passes.
      validateK8sBlock(k8sBlock, warnings)
      if (Object.prototype.hasOwnProperty.call(k8sBlock, 'workspace')) {
        const ws = k8sBlock.workspace
        if (typeof ws !== 'object' || ws === null || Array.isArray(ws)) {
          warnings.push(
            `Invalid 'environments.k8s.workspace': must be an object with a claimName property`,
          )
        } else {
          if (!Object.prototype.hasOwnProperty.call(ws, 'claimName')) {
            warnings.push(
              `Missing 'environments.k8s.workspace.claimName': required, non-empty string`,
            )
          } else if (typeof ws.claimName !== 'string') {
            warnings.push(
              `Invalid type for 'environments.k8s.workspace.claimName': expected string, got ${typeof ws.claimName}`,
            )
          } else if (ws.claimName.length === 0) {
            warnings.push(
              `Invalid value for 'environments.k8s.workspace.claimName': must be a non-empty string`,
            )
          }
          if (Object.prototype.hasOwnProperty.call(ws, 'mountPath') && typeof ws.mountPath !== 'string') {
            warnings.push(
              `Invalid type for 'environments.k8s.workspace.mountPath': expected string, got ${typeof ws.mountPath}`,
            )
          }
          if (Object.prototype.hasOwnProperty.call(ws, 'readOnly') && typeof ws.readOnly !== 'boolean') {
            warnings.push(
              `Invalid type for 'environments.k8s.workspace.readOnly': expected boolean, got ${typeof ws.readOnly}`,
            )
          }
        }
      }
    }

    // #5144: validate the Rancher connection block. Mirrors
    // `validateRancherOptions` in rancher.js so an operator never sees one
    // message at config-load time and a different one when RancherBackend is
    // constructed. Gated on `isRancherConfigured` (presence of rancherUrl +
    // clusterId + token): a block that does not yet carry a complete Rancher
    // config is treated as "Rancher not configured" and only its shape (object,
    // not array) is checked — partial blocks during setup don't spam warnings.
    const rancherBlock = config.environments.rancher
    if (rancherBlock !== undefined) {
      validateRancherBlock(rancherBlock, warnings)
    }
  }

  // #5158: worktree GC block. Only the shape (object, not array), the
  // `autoReap` boolean, and the `reapIntervalMs` positive number (#5326) are
  // checked; an unset block means "auto-reaper off".
  if (config.worktreeGc !== undefined) {
    if (typeof config.worktreeGc !== 'object' || config.worktreeGc === null || Array.isArray(config.worktreeGc)) {
      warnings.push(`Invalid type for 'worktreeGc': expected object, got ${Array.isArray(config.worktreeGc) ? 'array' : typeof config.worktreeGc}`)
    } else {
      if (
        Object.prototype.hasOwnProperty.call(config.worktreeGc, 'autoReap') &&
        typeof config.worktreeGc.autoReap !== 'boolean'
      ) {
        warnings.push(`Invalid type for 'worktreeGc.autoReap': expected boolean, got ${typeof config.worktreeGc.autoReap}`)
      }
      // #5326 (WP-5.4): periodic-reaper interval. Optional; when omitted the
      // reaper uses its built-in default. Must be a positive finite number.
      if (Object.prototype.hasOwnProperty.call(config.worktreeGc, 'reapIntervalMs')) {
        const v = config.worktreeGc.reapIntervalMs
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
          warnings.push(`Invalid value for 'worktreeGc.reapIntervalMs': expected a positive number, got ${typeof v === 'number' ? v : typeof v}`)
        }
      }
      // #5706: absolute-age fallback for the PID-liveness check. A non-negative
      // number of ms; 0 (the default) disables the fallback (pure PID liveness).
      // Negative / non-finite values WARN; they're not hard-rejected, but they
      // fail safe — planRepoGc treats any non-positive/NaN value as disabled, so
      // a typo can only ever turn the fallback OFF, never silently widen it.
      if (Object.prototype.hasOwnProperty.call(config.worktreeGc, 'maxLockAgeMs')) {
        const v = config.worktreeGc.maxLockAgeMs
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          warnings.push(`Invalid value for 'worktreeGc.maxLockAgeMs': expected a non-negative number (0 disables), got ${typeof v === 'number' ? v : typeof v}`)
        }
      }
      // #5878: typo-catch for the worktree-GC knobs.
      warnUnknownKeys(config.worktreeGc, WORKTREE_GC_SUPPORTED_KEYS, 'worktreeGc', warnings)
    }
  }

  // #5413: notifications block. Only `notifications.discord` is recognised
  // today. All warnings here are "Invalid value" (not "Invalid type") so a
  // typo in a cosmetic color can never become a fatal startup error via the
  // loadAndMergeConfig "Invalid type" escalation — the sink clamps bad
  // values to its defaults at runtime.
  // #5665: validate the `billing` block (monthly programmatic-credit meter).
  // Per-field typos are warn-only "Invalid value"; see validateBillingBlock.
  if (config.billing !== undefined) {
    validateBillingBlock(config.billing, warnings)
  }

  // #5985 (epic #5982): validate the user-shell gate block.
  if (config.userShell !== undefined) {
    validateUserShellBlock(config.userShell, warnings)
  }

  if (config.notifications !== undefined) {
    if (typeof config.notifications !== 'object' || config.notifications === null || Array.isArray(config.notifications)) {
      // "Invalid value", NOT "Invalid type" — loadAndMergeConfig escalates
      // the "Invalid type" prefix to a fatal startup error, and this block
      // is deliberately warn-only (a cosmetic-notifications typo must never
      // stop the daemon from booting).
      warnings.push(`Invalid value for 'notifications': expected an object, got ${Array.isArray(config.notifications) ? 'array' : typeof config.notifications}`)
    } else if (config.notifications.discord !== undefined) {
      validateDiscordNotificationsBlock(config.notifications.discord, warnings)
    }
  }

  // #5419: providers block. The legacy array form (chroxy init's
  // informational provider-id list) passes through unvalidated, as
  // before; the object form carries `providers.anthropicCompatible` —
  // config-driven Anthropic-compatible endpoint entries. All entry-level
  // warnings use "Invalid value" wording (never the "Invalid type"
  // prefix) so a malformed entry can't become a fatal startup error via
  // the loadAndMergeConfig escalation — bad entries are dropped at
  // registration (anthropic-compatible-session.js) and valid siblings
  // still register.
  if (
    config.providers !== undefined &&
    typeof config.providers === 'object' &&
    config.providers !== null &&
    !Array.isArray(config.providers)
  ) {
    validateProvidersConfigBlock(config.providers, warnings)
  }

  // Validate externalUrl format if provided
  if (config.externalUrl && typeof config.externalUrl === 'string') {
    try {
      const parsed = new URL(config.externalUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        warnings.push(`externalUrl should use http:// or https:// protocol, got '${parsed.protocol}'`)
      }
    } catch {
      warnings.push(`Invalid URL format for 'externalUrl': ${config.externalUrl}`)
    }
  }

  // Log warnings
  if (warnings.length > 0) {
    log.warn('Configuration warnings:')
    for (const warning of warnings) {
      log.warn(`  - ${warning}`)
    }
  }

  if (verbose && warnings.length === 0) {
    log.info('Configuration validated successfully')
  }

  return {
    valid: warnings.length === 0,
    warnings,
  }
}

/**
 * Merge configuration from multiple sources with proper precedence.
 *
 * Precedence order (highest to lowest):
 * 1. CLI options (provided via cli.js commands)
 * 2. Environment variables
 * 3. Config file
 * 4. Defaults
 *
 * @param {object} options - Options object from CLI
 * @param {object} options.fileConfig - Config loaded from file
 * @param {object} options.cliOverrides - CLI flag overrides
 * @param {object} options.defaults - Default values
 * @param {boolean} options.verbose - Log source of each config value
 * @returns {object} Merged config object
 */
export function mergeConfig({ fileConfig = {}, cliOverrides = {}, defaults = {}, verbose = false }) {
  const merged = {}
  const sources = {}

  // Helper to set value and track source
  const setValue = (key, value, source) => {
    merged[key] = value
    sources[key] = source
  }

  // Get all possible keys from defaults, fileConfig, cliOverrides, AND known schema keys with env vars
  const allKeys = new Set([
    ...Object.keys(defaults),
    ...Object.keys(fileConfig),
    ...Object.keys(cliOverrides),
    ...Object.keys(CONFIG_SCHEMA),
  ])

  // Apply precedence for each key
  for (const key of allKeys) {
    if (cliOverrides[key] !== undefined) {
      setValue(key, cliOverrides[key], 'CLI')
    } else {
      const envKey = envKeyForConfig(key)
      if (process.env[envKey] !== undefined) {
        const envValue = parseEnvValue(key, process.env[envKey])
        setValue(key, envValue, 'ENV')
      } else if (fileConfig[key] !== undefined) {
        setValue(key, fileConfig[key], 'config file')
      } else if (defaults[key] !== undefined) {
        setValue(key, defaults[key], 'default')
      }
    }
  }

  // Map legacy legacyCli flag to provider if no explicit provider set
  if (merged.legacyCli && !merged.provider) {
    merged.provider = 'claude-cli'
    sources.provider = 'legacyCli mapping'
  }

  // Log sources in verbose mode (after mapping so provider is included)
  if (verbose) {
    const safe = sanitizeConfig(merged)
    log.info('Configuration sources:')
    for (const [key, source] of Object.entries(sources)) {
      log.info(`  ${key.padEnd(16)} = ${JSON.stringify(safe[key]).padEnd(24)} (${source})`)
    }
  }

  return merged
}

/**
 * Convert config key to corresponding environment variable name.
 * @param {string} key - Config key
 * @returns {string} Environment variable name
 */
function envKeyForConfig(key) {
  const envMap = {
    apiToken: 'API_TOKEN',
    port: 'PORT',
    host: 'CHROXY_HOST',
    cwd: 'CHROXY_CWD',
    model: 'CHROXY_MODEL',
    allowedTools: 'CHROXY_ALLOWED_TOOLS',
    noAuth: 'CHROXY_NO_AUTH',
    maxRestarts: 'CHROXY_MAX_RESTARTS',
    terminalDownGraceMs: 'CHROXY_TERMINAL_DOWN_GRACE_MS',
    tunnel: 'CHROXY_TUNNEL',
    tunnelName: 'CHROXY_TUNNEL_NAME',
    tunnelHostname: 'CHROXY_TUNNEL_HOSTNAME',
    tunnelConfig: 'CHROXY_TUNNEL_CONFIG',
    legacyCli: 'CHROXY_LEGACY_CLI',
    provider: 'CHROXY_PROVIDER',
    providers: 'CHROXY_PROVIDERS',
    maxPayload: 'CHROXY_MAX_PAYLOAD',
    maxToolInput: 'CHROXY_MAX_TOOL_INPUT',
    noEncrypt: 'CHROXY_NO_ENCRYPT',
    encryptLocalhost: 'CHROXY_ENCRYPT_LOCALHOST',
    transforms: 'CHROXY_TRANSFORMS',
    tokenExpiry: 'CHROXY_TOKEN_EXPIRY',
    sessionTokenTtl: 'CHROXY_SESSION_TOKEN_TTL',
    sessionTimeout: 'CHROXY_SESSION_TIMEOUT',
    costBudget: 'CHROXY_COST_BUDGET',
    externalUrl: 'CHROXY_EXTERNAL_URL',
    maxSessions: 'CHROXY_MAX_SESSIONS',
    maxHistory: 'CHROXY_MAX_HISTORY',
    maxMessages: 'CHROXY_MAX_MESSAGES',
    showToken: 'CHROXY_SHOW_TOKEN',
    repos: 'CHROXY_REPOS',
    // #5172: discovery root for the Control Room Host Status repo survey.
    controlRoomRoot: 'CHROXY_CONTROL_ROOM_ROOT',
    // #5253: discovery root for the Control Room self-hosted runner survey.
    controlRoomRunnerRoot: 'CHROXY_RUNNER_ROOT',
    // #5260: toggle gh enrichment of the runner survey.
    controlRoomRunnerIncludeGithub: 'CHROXY_RUNNER_INCLUDE_GITHUB',
    controlRoomContainersIncludeStats: 'CHROXY_CONTAINERS_INCLUDE_STATS',
    // #5499: explicit repo-memory binary path for the Integrations survey.
    controlRoomRepoMemoryBin: 'CHROXY_REPO_MEMORY_BIN',
    logFormat: 'CHROXY_LOG_FORMAT',
    sandbox: 'CHROXY_SANDBOX',
    resultTimeoutMs: 'CHROXY_RESULT_TIMEOUT_MS',
    hardTimeoutMs: 'CHROXY_HARD_TIMEOUT_MS',
    streamStallTimeoutMs: 'CHROXY_STREAM_STALL_TIMEOUT_MS',
    backgroundShellHardQuiesceMs: 'CHROXY_BACKGROUND_SHELL_HARD_QUIESCE_MS',
    // #4601: JSON-encoded provider→ms map (e.g.
    // `CHROXY_PROVIDER_STREAM_STALL_TIMEOUT_MS='{"codex":900000}'`).
    // parseEnvValue dispatches on CONFIG_SCHEMA's `'object'` type and
    // runs JSON.parse, falling back to the raw string on parse error so
    // validateConfig can surface the eventual type mismatch.
    providerStreamStallTimeoutMs: 'CHROXY_PROVIDER_STREAM_STALL_TIMEOUT_MS',
    mcpToolCallTimeoutMs: 'CHROXY_MCP_TOOL_CALL_TIMEOUT_MS',
    // #4384 — canonical env var for the #4246 rename. Without this entry
    // the fallback was `key.toUpperCase()` (DANGEROUSLYSKIPPERMISSIONS,
    // no underscores) which is not what we document or what operators
    // would guess. `resolveSkipPermissions()` is still the single read
    // site that decides effective behaviour and surfaces the deprecation
    // warning for the legacy alias below.
    dangerouslySkipPermissions: 'CHROXY_DANGEROUSLY_SKIP_PERMISSIONS',
    // #4384 — legacy env-var alias mirroring the legacy config-file
    // key. mergeConfig is the dumb plumbing layer: it just lands the
    // value under the legacy `skipPermissions` config key so
    // resolveSkipPermissions sees it on the same code path as a
    // file-side legacy key (and therefore emits the same deprecation
    // warning). Operators should migrate to
    // `CHROXY_DANGEROUSLY_SKIP_PERMISSIONS`.
    skipPermissions: 'CHROXY_SKIP_PERMISSIONS',
    // #6691 (E-4): explicit mapping so the fallback doesn't become the very
    // generic `ORCHESTRATION` (key.toUpperCase()), which an unrelated
    // environment could plausibly set and have silently honored as config.
    orchestration: 'CHROXY_ORCHESTRATION',
  }
  return envMap[key] || key.toUpperCase()
}

/**
 * Parse environment variable value to appropriate type.
 * @param {string} key - Config key
 * @param {string} value - Raw env var value
 * @returns {*} Parsed value
 */
function parseEnvValue(key, value) {
  const expectedType = CONFIG_SCHEMA[key]

  // #5419: union-typed keys (currently only `providers`: 'array|object').
  // JSON-looking values parse as JSON (the object form); anything else
  // keeps the legacy comma-split array semantics of CHROXY_PROVIDERS.
  if (expectedType === 'array|object') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed)
      } catch {
        // A JSON-looking value with a typo must not silently degrade into
        // the comma-split legacy array — that would discard an intended
        // `providers.anthropicCompatible` block without a trace. Warn
        // loudly and still fall through so startup proceeds on the legacy
        // semantics. Deliberately no err.message / value echo: Node's
        // SyntaxError messages quote a snippet of the source, and a
        // pasted env value could carry a secret.
        log.warn(
          `${envKeyForConfig(key)} looks like JSON but failed to parse — falling back to the legacy comma-split list; fix the JSON if you meant the object form`,
        )
      }
    }
    return value.split(',').map(s => s.trim())
  }

  if (expectedType === 'number') {
    const num = parseFloat(value)
    return isNaN(num) ? value : num
  }

  if (expectedType === 'boolean') {
    return value === 'true' || value === '1'
  }

  if (expectedType === 'array') {
    return value.split(',').map(s => s.trim())
  }

  if (expectedType === 'object') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }

  return value
}

/**
 * Resolve the effective `dangerouslySkipPermissions` value from a merged
 * config object (#4246).
 *
 * Precedence:
 *   1. `dangerouslySkipPermissions` (canonical, mirrors the CLI flag name)
 *   2. `skipPermissions` (legacy alias from #4209 — kept for one
 *      deprecation window; emits a warning that the resolver returns so
 *      the caller can surface it once at boot).
 *
 * The resolver does NOT log directly — it returns a `deprecationWarning`
 * string so the caller decides when/where to surface it (server-cli logs
 * it once at startup; tests assert on the value). When the canonical key
 * is set the legacy key is ignored as a value-source but its mere
 * presence still triggers the warning (to nudge cleanup of stale
 * duplicates).
 *
 * @param {object | null | undefined} config
 * @returns {{
 *   enabled: boolean,
 *   source: 'dangerouslySkipPermissions' | 'skipPermissions' | null,
 *   deprecationWarning: string | null,
 * }}
 */
export function resolveSkipPermissions(config) {
  const c = config || {}
  const canonical = c.dangerouslySkipPermissions
  const legacy = c.skipPermissions
  const legacyPresent = Object.prototype.hasOwnProperty.call(c, 'skipPermissions')

  const deprecationWarning = legacyPresent
    ? "config key 'skipPermissions' is deprecated — rename it to 'dangerouslySkipPermissions' to match the CLI flag name. Both keys are honoured for now; the legacy key will be removed in a future release."
    : null

  if (typeof canonical === 'boolean') {
    return {
      enabled: canonical,
      source: 'dangerouslySkipPermissions',
      // Even when the canonical key wins, surface the warning if the
      // legacy key is also set — operators should clean up the duplicate.
      deprecationWarning,
    }
  }

  if (typeof legacy === 'boolean') {
    return {
      enabled: legacy,
      source: 'skipPermissions',
      deprecationWarning,
    }
  }

  return {
    enabled: false,
    source: null,
    deprecationWarning: null,
  }
}

/**
 * #5144: resolve the selected environment backend from a merged config object.
 *
 * Returns 'docker' for an absent, malformed, or unrecognised
 * `environments.backend` (validateConfig already surfaces the warning), so the
 * wiring layer never crashes on a typo and the default single-node path is
 * preserved. Pure — no side effects, no logging.
 *
 * @param {object|null|undefined} config - Merged config
 * @returns {'docker'|'k8s'|'rancher'}
 */
export function resolveEnvironmentBackend(config) {
  const selected = config?.environments?.backend
  if (typeof selected === 'string' && ENVIRONMENT_BACKENDS.has(selected)) {
    return selected
  }
  return 'docker'
}

/**
 * #5144: resolve a Rancher bearer token from a secret-friendly source.
 *
 * Precedence (highest first):
 *   1. `tokenEnv` — name of an env var holding the token (e.g. RANCHER_TOKEN).
 *      Keeps the secret out of the on-disk config file.
 *   2. `tokenFile` — path to a file whose trimmed contents are the token
 *      (e.g. a mounted secret).
 *   3. `token` — inline token (discouraged but supported for parity with
 *      validateRancherOptions).
 *
 * The resolved value is never logged. Returns `undefined` when none resolve so
 * the caller / RancherBackend constructor produces the canonical "token must be
 * a non-empty bearer token string" error.
 *
 * @param {object} rancher - The `environments.rancher` block
 * @returns {string|undefined}
 */
export function resolveRancherToken(rancher = {}) {
  if (typeof rancher.tokenEnv === 'string' && rancher.tokenEnv.length > 0) {
    const fromEnv = process.env[rancher.tokenEnv]
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  }
  if (typeof rancher.tokenFile === 'string' && rancher.tokenFile.length > 0) {
    try {
      const fromFile = readFileSync(rancher.tokenFile, 'utf-8').trim()
      if (fromFile.length > 0) return fromFile
    } catch {
      // Fall through to inline token / undefined. Do not log the path's
      // contents; the eventual "token required" error is enough signal.
    }
  }
  if (typeof rancher.token === 'string' && rancher.token.length > 0) return rancher.token
  return undefined
}

/**
 * #5144: construct the environment backend selected by config.
 *
 * - 'docker' (default): `new DockerBackend({ _execFile })` — unchanged behaviour.
 * - 'k8s'             : `new K8sBackend({ ...environments.k8s })`.
 * - 'rancher'         : `new RancherBackend({ ...environments.k8s, ...rancher })`
 *                       with the token resolved from a secret-friendly source.
 *
 * Backend modules are imported lazily so loading config never eagerly pulls in
 * `@kubernetes/client-node` (only the K8s/Rancher paths need it). The selected
 * backend's construction validates its own options and throws on a malformed
 * block — the caller (server-cli) surfaces that as a fatal startup error.
 *
 * @param {object} config - Merged config
 * @param {object} [deps] - Injection seam for testing
 * @param {Function} [deps._execFile] - Forwarded to DockerBackend
 * @param {Function} [deps._loadBackends] - Override the lazy module loader
 *   (returns `{ DockerBackend, K8sBackend, RancherBackend }`). Lets unit tests
 *   assert which class is instantiated with which options without importing the
 *   kube SDK.
 * @returns {Promise<{ backend: object, type: 'docker'|'k8s'|'rancher' }>}
 */
export async function buildEnvironmentBackend(config, { _execFile, _loadBackends } = {}) {
  const type = resolveEnvironmentBackend(config)
  const envs = config?.environments || {}

  const loadBackends = _loadBackends || (async () => {
    if (type === 'docker') {
      const { DockerBackend } = await import('./environments/backends/docker.js')
      return { DockerBackend }
    }
    if (type === 'k8s') {
      const { K8sBackend } = await import('./environments/backends/k8s.js')
      return { K8sBackend }
    }
    const { RancherBackend } = await import('./environments/backends/rancher.js')
    return { RancherBackend }
  })

  const mods = await loadBackends()

  if (type === 'k8s') {
    const k8s = (envs.k8s && typeof envs.k8s === 'object' && !Array.isArray(envs.k8s)) ? envs.k8s : {}
    const backend = new mods.K8sBackend({
      namespace: k8s.namespace,
      inCluster: k8s.inCluster,
      kubeconfigPath: k8s.kubeconfigPath,
      sidecarImage: k8s.sidecarImage,
      imagePullPolicy: k8s.imagePullPolicy,
      connectMode: k8s.connectMode,
      // Per-tenant namespace-level guardrails (#5142). Both opt-in; the backend
      // validates the quantity strings and throws on a malformed block.
      namespaceQuota: k8s.namespaceQuota,
      namespaceLimitRange: k8s.namespaceLimitRange,
    })
    return { backend, type }
  }

  if (type === 'rancher') {
    const k8s = (envs.k8s && typeof envs.k8s === 'object' && !Array.isArray(envs.k8s)) ? envs.k8s : {}
    const rancher = (envs.rancher && typeof envs.rancher === 'object' && !Array.isArray(envs.rancher)) ? envs.rancher : {}
    const token = resolveRancherToken(rancher)
    const backend = new mods.RancherBackend({
      // K8s connection/runtime knobs shared with the plain K8s path.
      namespace: k8s.namespace,
      inCluster: k8s.inCluster,
      kubeconfigPath: k8s.kubeconfigPath,
      sidecarImage: k8s.sidecarImage,
      imagePullPolicy: k8s.imagePullPolicy,
      connectMode: k8s.connectMode,
      // Per-tenant namespace-level guardrails (#5142), shared with the plain K8s path.
      namespaceQuota: k8s.namespaceQuota,
      namespaceLimitRange: k8s.namespaceLimitRange,
      // Rancher connection block. Token is resolved from a secret-friendly
      // source and never logged.
      rancherUrl: rancher.rancherUrl,
      clusterId: rancher.clusterId,
      token,
      caData: rancher.caData,
      skipTLSVerify: rancher.skipTLSVerify,
      defaultProjectId: rancher.defaultProjectId,
    })
    return { backend, type }
  }

  const backend = new mods.DockerBackend({ _execFile })
  return { backend, type }
}

const DEFAULT_CONFIG_PATH = join(homedir(), '.chroxy', 'config.json')

/**
 * Read the repos array from a config file.
 * @param {string} [configPath] - Path to config.json. Defaults to ~/.chroxy/config.json.
 * @returns {Array<{ path: string, name?: string }>} Repos array, or [] if missing/invalid.
 */
export function readReposFromConfig(configPath = DEFAULT_CONFIG_PATH) {
  try {
    if (!existsSync(configPath)) return []
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    return Array.isArray(raw.repos) ? raw.repos : []
  } catch {
    return []
  }
}

/**
 * Write the repos array to a config file, preserving other fields.
 * @param {Array<{ path: string, name?: string }>} repos - Repos array to write.
 * @param {string} [configPath] - Path to config.json. Defaults to ~/.chroxy/config.json.
 */
export function writeReposToConfig(repos, configPath = DEFAULT_CONFIG_PATH) {
  let existing = {}
  try {
    if (existsSync(configPath)) {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'))
    }
  } catch {
    // Start fresh if parse fails
  }
  existing.repos = repos
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  writeFileRestricted(configPath, JSON.stringify(existing, null, 2))
}

/**
 * Write (or clear) the daemon-side session-preset override for a repo path
 * (#5553). The override lives on the matching `repos[]` entry's `sessionPreset`
 * key. When `preset` is null the key is removed (revert to repo-local file /
 * no preset). When the repo path has no `repos[]` entry yet, one is created so
 * the operator can configure an override for a repo that isn't otherwise
 * registered. Other config fields and repo entries are preserved.
 *
 * @param {string} repoPath - The repo path to key the override by.
 * @param {object|null} preset - The preset object ({ preamble?, seed?, enabled? }) or null to clear.
 * @param {string} [configPath] - Path to config.json. Defaults to ~/.chroxy/config.json.
 */
export function writeSessionPresetOverrideToConfig(repoPath, preset, configPath = DEFAULT_CONFIG_PATH) {
  let existing = {}
  try {
    if (existsSync(configPath)) {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'))
    }
  } catch {
    // Start fresh if parse fails
  }
  if (!existing || typeof existing !== 'object') existing = {}
  if (!Array.isArray(existing.repos)) existing.repos = []

  const idx = existing.repos.findIndex(
    r => r && typeof r === 'object' && typeof r.path === 'string' && r.path === repoPath,
  )
  if (idx === -1) {
    if (preset === null) {
      // Nothing to clear and no entry exists — no-op write avoided.
      return
    }
    existing.repos.push({ path: repoPath, sessionPreset: preset })
  } else {
    const entry = existing.repos[idx]
    if (preset === null) {
      delete entry.sessionPreset
    } else {
      entry.sessionPreset = preset
    }
  }

  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  writeFileRestricted(configPath, JSON.stringify(existing, null, 2))
}

/**
 * Read the Control Room discovery root from a config file (#5172).
 * @param {string} [configPath] - Path to config.json. Defaults to ~/.chroxy/config.json.
 * @returns {string|undefined} The configured root, or undefined if missing/invalid.
 */
export function readControlRoomRootFromConfig(configPath = DEFAULT_CONFIG_PATH) {
  try {
    if (!existsSync(configPath)) return undefined
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    return typeof raw.controlRoomRoot === 'string' ? raw.controlRoomRoot : undefined
  } catch {
    return undefined
  }
}

/**
 * Write the Control Room discovery root to a config file, preserving other
 * fields (#5172).
 * @param {string} root - Absolute path to the discovery root.
 * @param {string} [configPath] - Path to config.json. Defaults to ~/.chroxy/config.json.
 */
export function writeControlRoomRootToConfig(root, configPath = DEFAULT_CONFIG_PATH) {
  let existing = {}
  try {
    if (existsSync(configPath)) {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'))
    }
  } catch {
    // Start fresh if parse fails
  }
  existing.controlRoomRoot = root
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  writeFileRestricted(configPath, JSON.stringify(existing, null, 2))
}

