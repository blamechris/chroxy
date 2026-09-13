/**
 * Provider-level permission-mode support.
 *
 * A provider that cannot route a mode through Chroxy's protected-path floor
 * declares `capabilities.autoPermissionMode = false`. Absence means unknown,
 * preserving forward compatibility for external providers.
 */

export class UnsupportedPermissionModeError extends Error {
  constructor(providerLabel, mode) {
    const label = providerLabel || 'This provider'
    super(`${label}: ${mode === 'auto' ? 'Auto' : mode} permission mode is unsupported because this adapter cannot guarantee protected-path and secret-read prompts reach Chroxy's permission floor.`)
    this.name = 'UnsupportedPermissionModeError'
    this.code = 'PERMISSION_MODE_UNSUPPORTED'
    this.permissionMode = mode
  }
}

export function getProviderPermissionModeSupport(ProviderClass, mode) {
  const capabilities = ProviderClass?.capabilities
  if (mode === 'auto' && capabilities?.autoPermissionMode === false) {
    return { supported: false, enforcement: 'unsupported' }
  }
  return {
    supported: true,
    enforcement: capabilities?.permissionFloor === true ? 'chroxy' : 'unknown',
  }
}

export function assertProviderPermissionModeSupported(ProviderClass, mode, providerLabel) {
  const support = getProviderPermissionModeSupport(ProviderClass, mode)
  if (!support.supported) throw new UnsupportedPermissionModeError(providerLabel, mode)
}
