// Production builds and updates keep automatic native compatibility detection.
// Only the immutable Maestro Metro session may reuse its verified installed hash.
module.exports = ({ config }) => {
  const marker = process.env.CHROXY_MAESTRO_RUNTIME_CACHE
  const runtimeVersion = process.env.CHROXY_MAESTRO_RUNTIME_VERSION
  if (marker === undefined && runtimeVersion === undefined) return config

  if (marker !== '1' || !['1', 'true'].includes(process.env.CI)) {
    throw new Error('Maestro runtime reuse requires its explicit marker and CI mode')
  }
  if (!/^[0-9a-f]{40}$/.test(runtimeVersion || '')) {
    throw new Error('Maestro runtime reuse requires a verified 40-character fingerprint')
  }
  return { ...config, ios: { ...config.ios, runtimeVersion } }
}
