import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isAbsolute, relative, sep } from 'node:path'

// Resume requires the contract observed with this installed binary; new fresh
// versions remain usable but do not claim verified native restart continuity.
export const NATIVE_RESUME_VERSION = '0.154.0'
export const NATIVE_RESUME_DRIVER = 'codex-app-server-v1'
export function nativeRestoreError(code, message) {
  const err = new Error(`Codex native restore: ${message}`)
  err.code = `CODEX_NATIVE_${code}`
  return err
}
const fail = (code, message) => { throw nativeRestoreError(code, message) }
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\x00-\x1f]/.test(v)
const object = v => v && typeof v === 'object' && !Array.isArray(v)
const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex')

// Stable OS identity only; never a hostname, copied config UUID or rotating key.
export function nativeMachineId() {
  try {
    if (process.platform === 'linux') return readFileSync('/etc/machine-id', 'utf8').trim()
    if (process.platform === 'darwin') {
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] || null
    }
  } catch { /* unverified ownership refuses resume */ }
  return null
}
function directoryBinding(path) {
  if (!text(path) || !isAbsolute(path)) fail('OWNERSHIP_UNKNOWN', 'directory ownership cannot be verified')
  try {
    const canonical = realpathSync(path), stat = statSync(canonical)
    if (!stat.isDirectory()) throw new Error('not directory')
    return { path: canonical, binding: digest([canonical, stat.dev, stat.ino, stat.uid]) }
  } catch { return fail('DIRECTORY_UNAVAILABLE', 'the original working directory or native store is unavailable') }
}
export function bindNativeOwnership({ cwd, codexHome, machineId = nativeMachineId(), ownerId = process.getuid?.() } = {}) {
  if (!text(machineId) || ownerId == null) fail('OWNERSHIP_UNKNOWN', 'stable machine and process owner identity could not be verified')
  const store = directoryBinding(codexHome), work = directoryBinding(cwd)
  return { hostBinding: digest(['chroxy-native-owner-v1', machineId, String(ownerId), store.binding]), storeBinding: store.binding, codexHome: store.path, cwdBinding: work.binding, cwd: work.path }
}
export function validNativePolicy(policy) {
  if (!object(policy)) return false
  const keys = Object.keys(policy)
  if (policy.type === 'dangerFullAccess') return keys.length === 1
  if (policy.type === 'readOnly') return keys.every(k => ['type', 'networkAccess'].includes(k)) && typeof policy.networkAccess === 'boolean'
  if (policy.type !== 'workspaceWrite') return false
  return keys.every(k => ['type', 'networkAccess', 'writableRoots', 'excludeSlashTmp', 'excludeTmpdirEnvVar'].includes(k)) &&
    ['networkAccess', 'excludeSlashTmp', 'excludeTmpdirEnvVar'].every(k => typeof policy[k] === 'boolean') &&
    Array.isArray(policy.writableRoots) && policy.writableRoots.length <= 128 && policy.writableRoots.every(p => text(p) && isAbsolute(p))
}
const within = (path, root) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) }
export function policyNoBroader(current, previous, cwd = null) {
  if (!validNativePolicy(current) || !validNativePolicy(previous)) return false
  if (previous.type === 'dangerFullAccess') return true
  if (current.type === 'dangerFullAccess') return false
  if (current.networkAccess && !previous.networkAccess) return false
  if (current.type === 'readOnly') return true
  if (previous.type !== 'workspaceWrite') return false
  if (!current.excludeSlashTmp && previous.excludeSlashTmp) return false
  if (!current.excludeTmpdirEnvVar && previous.excludeTmpdirEnvVar) return false
  try { return current.writableRoots.every(p => [...previous.writableRoots, ...(cwd ? [cwd] : [])].some(root => within(realpathSync(p), realpathSync(root)))) }
  catch { return false }
}
export function sandboxMode(policy) {
  return { readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' }[policy?.type] || null
}
export function writeBindings(policy, cwd, env) {
  if (policy.type !== 'workspaceWrite') return []
  const roots = [cwd, ...policy.writableRoots]
  if (!policy.excludeSlashTmp) roots.push('/tmp')
  if (!policy.excludeTmpdirEnvVar && env?.TMPDIR) roots.push(env.TMPDIR)
  return [...new Set(roots)].map(directoryBinding).sort((a, b) => a.path.localeCompare(b.path))
}
export function resumeParams(saved) {
  const policy = saved.sandboxPolicy
  if (!validNativePolicy(policy)) fail('POLICY_UNKNOWN', 'saved sandbox rights are not understood')
  return {
    threadId: saved.threadId, cwd: saved.cwd, excludeTurns: true,
    sandbox: sandboxMode(policy), approvalPolicy: saved.approvalPolicy, approvalsReviewer: saved.approvalsReviewer,
    ...(policy.type === 'workspaceWrite' ? { config: { sandbox_workspace_write: {
      writable_roots: [...policy.writableRoots], network_access: policy.networkAccess,
      exclude_slash_tmp: policy.excludeSlashTmp, exclude_tmpdir_env_var: policy.excludeTmpdirEnvVar,
    } } } : {}),
  }
}
export function validateLocator(saved, permissionMode) {
  if (!object(saved)) fail('LOCATOR_MISSING', 'this saved session has no native locator; create a new session explicitly')
  if (JSON.stringify(saved).length > 32 * 1024 || saved.schemaVersion !== 1 || saved.provider !== 'codex' || saved.driver !== NATIVE_RESUME_DRIVER || saved.binaryVersion !== NATIVE_RESUME_VERSION) fail('INCOMPATIBLE', 'saved provider, driver or version contract is incompatible')
  if (!text(saved.threadId) || !text(saved.cwd) || !text(saved.codexHome) || ![saved.hostBinding, saved.storeBinding, saved.cwdBinding].every(text)) fail('LOCATOR_INVALID', 'saved native identity is incomplete')
  if (saved.permissionMode !== permissionMode || !['approve', 'plan', 'acceptEdits'].includes(permissionMode) || saved.approvalPolicy !== 'on-request' || saved.approvalsReviewer !== 'user') fail('PERMISSION_MISMATCH', 'saved approval authority cannot be retained')
  if (!validNativePolicy(saved.sandboxPolicy) || sandboxMode(saved.sandboxPolicy) !== saved.sandboxMode) fail('POLICY_UNKNOWN', 'saved sandbox policy is unknown')
  if (!object(saved.model) || !text(saved.model.observed) || !text(saved.model.provider) || !(saved.model.requested === null || text(saved.model.requested)) || !object(saved.effort) || !(saved.effort.observed === null || text(saved.effort.observed)) || !(saved.effort.requested === null || text(saved.effort.requested))) fail('SETTINGS_UNKNOWN', 'saved model or reasoning effort is unknown')
  if (saved.settingsVerified !== true) fail('SETTINGS_UNKNOWN', 'a model or effort change was not observed by the native runtime before shutdown')
  if (typeof saved.skillsPrepended !== 'boolean' || !Array.isArray(saved.writeBindings)) fail('LOCATOR_INVALID', 'saved native admission or write ownership is incomplete')
  if (saved.threadTotals !== null && (!object(saved.threadTotals) || Object.values(saved.threadTotals).some(v => !Number.isSafeInteger(v) || v < 0))) fail('LOCATOR_INVALID', 'saved native usage baseline is invalid')
  return saved
}
export function validateEcho(echo) {
  if (!object(echo) || !object(echo.thread) || !text(echo.thread.id) || echo.thread.ephemeral !== false || !text(echo.cwd) || echo.thread.cwd !== echo.cwd || !text(echo.model) || !text(echo.modelProvider) || echo.thread.modelProvider !== echo.modelProvider || !Object.hasOwn(echo, 'reasoningEffort') || !(echo.reasoningEffort === null || text(echo.reasoningEffort)) || !validNativePolicy(echo.sandbox) || echo.approvalPolicy !== 'on-request' || echo.approvalsReviewer !== 'user') fail('ECHO_INVALID', 'native response did not verify identity, settings and approval policy')
  return echo
}
