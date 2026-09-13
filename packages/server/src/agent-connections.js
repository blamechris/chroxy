import { spawnSync } from 'child_process'
import { AGENT_CONNECTION_VERSION } from '@chroxy/protocol'
import { buildSpawnEnv } from './utils/spawn-env.js'
import { resolveCredential } from './credential-store.js'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const ROUTES = new Set(['native', 'api', 'local', 'imported'])
const INFERENCE_LOCATIONS = new Set(['local', 'remote', 'unknown'])

export class AgentConnectionError extends Error {
  constructor(code, message, connectionId = null) {
    super(message)
    this.name = 'AgentConnectionError'
    this.code = code
    this.connectionId = connectionId
  }
}

function cleanString(value, max) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : null
}

export function validateAgentConnections(value, warnings = []) {
  if (!Array.isArray(value)) {
    warnings.push(`Invalid value for 'agentConnections': expected an array`)
    return []
  }
  const accepted = []
  const ids = new Set()
  for (let i = 0; i < value.length; i++) {
    const row = value[i]
    const path = `agentConnections[${i}]`
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      warnings.push(`Invalid value for '${path}': expected an object`)
      continue
    }
    if (['apiKey', 'token', 'credential', 'secret'].some((key) => Object.prototype.hasOwnProperty.call(row, key))) {
      warnings.push(`Invalid value for '${path}': inline credentials are forbidden; use credentialKey or the vendor's native credential store`)
      continue
    }
    const id = cleanString(row.id, 128)
    const runtime = cleanString(row.runtime, 256)
    const label = cleanString(row.label, 200)
    const authRoute = cleanString(row.authRoute, 32)
    if (!id || !ID_RE.test(id)) {
      warnings.push(`Invalid value for '${path}.id': expected 1-128 characters of [A-Za-z0-9._:-] beginning with an alphanumeric`)
      continue
    }
    if (ids.has(id)) {
      warnings.push(`Invalid value for '${path}.id': duplicate connection id '${id}'`)
      continue
    }
    if (!runtime) {
      warnings.push(`Invalid value for '${path}.runtime': expected a non-empty provider runtime id`)
      continue
    }
    if (!label) {
      warnings.push(`Invalid value for '${path}.label': expected a non-empty label`)
      continue
    }
    if (!ROUTES.has(authRoute)) {
      warnings.push(`Invalid value for '${path}.authRoute': expected native, api, local, or imported`)
      continue
    }
    const provider = cleanString(row.provider, 128) || runtime.replace(/^claude-.*/, 'claude')
    const accountRef = row.accountRef == null ? null : cleanString(row.accountRef, 512)
    const credentialKey = row.credentialKey == null ? null : cleanString(row.credentialKey, 128)
    const inferenceLocation = cleanString(row.inferenceLocation, 16) || (authRoute === 'local' ? 'local' : 'remote')
    if (!INFERENCE_LOCATIONS.has(inferenceLocation)) {
      warnings.push(`Invalid value for '${path}.inferenceLocation': expected local, remote, or unknown`)
      continue
    }
    if (row.accountRef != null && !accountRef) {
      warnings.push(`Invalid value for '${path}.accountRef': expected a non-empty string of at most 512 characters`)
      continue
    }
    if (row.credentialKey != null && !credentialKey) {
      warnings.push(`Invalid value for '${path}.credentialKey': expected a non-empty credential-store key name`)
      continue
    }
    ids.add(id)
    accepted.push(Object.freeze({ id, label, provider, runtime, authRoute, accountRef, credentialKey, inferenceLocation }))
  }
  return accepted
}

function supportsRoute(definition, ProviderClass) {
  // Route isolation is an adapter promise, not an inheritable capability.
  // A subclass that changes the transport or credential path must opt in
  // itself after proving the same guarantee.
  const declared = ProviderClass && Object.prototype.hasOwnProperty.call(ProviderClass, 'agentConnectionRoutes') && Array.isArray(ProviderClass.agentConnectionRoutes)
    ? ProviderClass.agentConnectionRoutes
    : []
  return declared.includes(definition.authRoute)
}

function declaredCredentialKey(ProviderClass) {
  if (!ProviderClass || !Object.prototype.hasOwnProperty.call(ProviderClass, 'agentConnectionCredentialKey')) return null
  return cleanString(ProviderClass.agentConnectionCredentialKey, 128)
}

function blocked(reasonCode, message, recoveryAction) {
  return { state: 'blocked', reasonCode, message, recoveryAction }
}

function unsupported(reasonCode, message) {
  return { state: 'unsupported', reasonCode, message, recoveryAction: null }
}

function unknown(message, reasonCode = 'READINESS_UNVERIFIED') {
  return { state: 'unknown', reasonCode, message, recoveryAction: null }
}

function probeClaudeNative(ProviderClass, deps) {
  const binary = ProviderClass?.resolvedBinary
  if (!binary) return blocked('NATIVE_RUNTIME_MISSING', 'Claude Code is not installed.', 'Install Claude Code, then run `claude auth login`.')
  const result = deps.spawnSync(binary, ['auth', 'status', '--json'], {
    env: deps.buildSpawnEnv('claude'),
    encoding: 'utf8',
    timeout: 5_000,
  })
  if (result.status !== 0) {
    return blocked('NATIVE_LOGIN_REQUIRED', 'Claude Code native login is unavailable.', 'Run `claude auth login` on this host.')
  }
  try {
    const status = JSON.parse(result.stdout || '{}')
    const loggedIn = status.loggedIn === true || status.logged_in === true || status.authenticated === true
    return loggedIn
      ? { state: 'ready', reasonCode: null, message: 'Claude Code native login is available.', recoveryAction: null }
      : blocked('NATIVE_LOGIN_REQUIRED', 'Claude Code native login is unavailable.', 'Run `claude auth login` on this host.')
  } catch {
    return unknown('Claude Code auth status could not be interpreted; it will be checked when the session starts.')
  }
}

function descriptorFor(definition, ProviderClass, readiness, { source = 'configured', model = null, now }) {
  const requested = definition.authRoute
  const observed = readiness.state === 'ready'
    ? requested === 'native' ? 'native' : requested === 'api' ? 'api-key' : requested === 'local' ? 'local' : 'unknown'
    : 'unknown'
  const entitlementRoute = requested === 'api'
    ? 'api'
    : requested === 'local'
      ? 'local'
      : 'unknown'
  return {
    version: AGENT_CONNECTION_VERSION,
    id: definition.id,
    label: definition.label,
    provider: definition.provider,
    runtime: { id: definition.runtime, version: cleanString(ProviderClass?.runtimeVersion, 512) },
    accountRef: definition.accountRef,
    authentication: { requested, observed },
    entitlement: {
      route: entitlementRoute,
      status: entitlementRoute === 'api' || entitlementRoute === 'local'
        ? readiness.state === 'ready' ? 'available' : readiness.state === 'blocked' ? 'unavailable' : 'unknown'
        : 'unknown',
    },
    model: { requested: model, resolved: model },
    execution: {
      host: ProviderClass?.capabilities?.containerized ? 'container' : 'daemon',
      inference: definition.inferenceLocation,
    },
    readiness,
    provenance: { source, observedAt: now().toISOString(), expiresAt: null },
  }
}

export function createLegacyAgentConnection({ runtime, ProviderClass, model = null, authInfo = null, now = () => new Date() }) {
  const source = authInfo?.source === 'oauth' ? 'native' : authInfo?.source === 'env' ? 'api-key' : 'unknown'
  const route = source === 'api-key' ? 'api' : 'unknown'
  return {
    version: AGENT_CONNECTION_VERSION,
    id: `legacy:${runtime}`,
    label: `${runtime} (legacy automatic route)`,
    provider: runtime.replace(/^claude-.*/, 'claude'),
    runtime: { id: runtime, version: cleanString(ProviderClass?.runtimeVersion, 512) },
    accountRef: null,
    authentication: { requested: 'unknown', observed: source },
    entitlement: { route, status: route === 'api' ? 'available' : 'unknown' },
    model: { requested: model, resolved: model },
    execution: {
      host: ProviderClass?.capabilities?.containerized ? 'container' : 'daemon',
      inference: runtime === 'ollama' ? 'local' : 'unknown',
    },
    readiness: authInfo?.ready === false
      ? blocked('LEGACY_AUTH_UNAVAILABLE', authInfo.detail || 'Provider authentication is unavailable.', authInfo.hint || null)
      : unknown('Legacy provider selection does not guarantee an authentication or billing route.'),
    provenance: { source: 'legacy', observedAt: now().toISOString(), expiresAt: null },
  }
}

export class AgentConnectionRegistry {
  constructor({ definitions = [], getProvider, buildSpawnEnvFn = buildSpawnEnv, resolveCredentialFn = resolveCredential, spawnSyncFn = spawnSync, now = () => new Date() } = {}) {
    this._definitions = validateAgentConnections(definitions)
    this._getProvider = getProvider
    this._deps = { buildSpawnEnv: buildSpawnEnvFn, resolveCredential: resolveCredentialFn, spawnSync: spawnSyncFn }
    this._now = now
  }

  list() {
    return this._definitions.map((definition) => this._resolveDefinition(definition).descriptor)
  }

  resolve(connectionId, { provider = null, restoredSnapshot = null, model = null } = {}) {
    const definition = this._definitions.find((row) => row.id === connectionId)
    if (!definition) {
      throw new AgentConnectionError('AGENT_CONNECTION_NOT_FOUND', `Agent connection '${connectionId}' is not configured on this host.`, connectionId)
    }
    const resolved = this._resolveDefinition(definition, model)
    if (provider && provider !== definition.runtime) {
      throw new AgentConnectionError('AGENT_CONNECTION_RUNTIME_MISMATCH', `Connection '${connectionId}' uses runtime '${definition.runtime}', not '${provider}'.`, connectionId)
    }
    if (restoredSnapshot) {
      const same = restoredSnapshot.version === AGENT_CONNECTION_VERSION &&
        restoredSnapshot.id === definition.id &&
        restoredSnapshot.runtime?.id === definition.runtime &&
        restoredSnapshot.authentication?.requested === definition.authRoute
      if (!same) {
        throw new AgentConnectionError('AGENT_CONNECTION_MISMATCH', `Connection '${connectionId}' no longer matches the route persisted for this session.`, connectionId)
      }
    }
    if (resolved.descriptor.readiness.state === 'blocked' || resolved.descriptor.readiness.state === 'unsupported') {
      const r = resolved.descriptor.readiness
      throw new AgentConnectionError(r.reasonCode || 'AGENT_CONNECTION_UNAVAILABLE', r.message || `Connection '${connectionId}' is unavailable.`, connectionId)
    }
    return {
      ...resolved,
      descriptor: restoredSnapshot || resolved.descriptor,
    }
  }

  _resolveDefinition(definition, model = null) {
    const ProviderClass = this._getProvider?.(definition.runtime)
    if (!ProviderClass) {
      const readiness = unsupported('RUNTIME_UNAVAILABLE', `Runtime '${definition.runtime}' is not registered on this host.`)
      return { definition, ProviderClass, descriptor: descriptorFor(definition, ProviderClass, readiness, { model, now: this._now }), childEnv: null }
    }
    if (!supportsRoute(definition, ProviderClass)) {
      const code = definition.authRoute === 'imported' ? 'IMPORTED_AUTH_UNSUPPORTED' : 'AUTH_ROUTE_UNSUPPORTED'
      const readiness = unsupported(code, `Runtime '${definition.runtime}' does not support the '${definition.authRoute}' authentication route.`)
      return { definition, ProviderClass, descriptor: descriptorFor(definition, ProviderClass, readiness, { model, now: this._now }), childEnv: null }
    }

    let readiness
    let childEnv = null
    if (definition.authRoute === 'native' && definition.runtime === 'claude-tui') {
      readiness = probeClaudeNative(ProviderClass, this._deps)
    } else if (definition.authRoute === 'native') {
      childEnv = this._deps.buildSpawnEnv('codex')
      delete childEnv.OPENAI_API_KEY
      delete childEnv.OPENAI_BASE_URL
      delete childEnv.OPENAI_ORG_ID
      delete childEnv.OPENAI_ORGANIZATION
      delete childEnv.OPENAI_PROJECT
      delete childEnv.OPENAI_PROJECT_ID
      readiness = unknown('Native Codex login and entitlement will be verified by the selected runtime before a thread starts.')
    } else if (definition.authRoute === 'api') {
      const runtimeCredentialKey = declaredCredentialKey(ProviderClass)
      const credentialKey = definition.credentialKey || runtimeCredentialKey
      if (!runtimeCredentialKey || credentialKey !== runtimeCredentialKey) {
        readiness = unsupported(
          'CREDENTIAL_REFERENCE_UNSUPPORTED',
          `Runtime '${definition.runtime}' cannot apply credential reference '${credentialKey || 'unset'}' to an isolated API route.`,
        )
      } else {
        const credential = this._deps.resolveCredential(credentialKey)
        readiness = credential.value
          ? { state: 'ready', reasonCode: null, message: 'Configured API credential is available.', recoveryAction: null }
          : blocked('API_CREDENTIAL_MISSING', `Connection '${definition.id}' has no configured API credential.`, `Set ${credentialKey} in the environment or credential store.`)
        if (definition.runtime === 'codex') childEnv = this._deps.buildSpawnEnv('codex')
      }
    } else if (definition.authRoute === 'local') {
      readiness = unknown(
        'Local service availability is checked by the runtime when the session starts.',
        'LOCAL_SERVICE_UNVERIFIED',
      )
    } else {
      readiness = unsupported('IMPORTED_AUTH_UNSUPPORTED', 'Imported-agent authentication is owned by the agent protocol and is not selectable yet.')
    }

    return {
      definition,
      ProviderClass,
      descriptor: descriptorFor(definition, ProviderClass, readiness, { model, now: this._now }),
      childEnv,
    }
  }
}
