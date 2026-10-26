// Ordinary builds and updates retain automatic native compatibility detection.
// The isolated bundled CI variant must execute its embedded, reviewed JavaScript.
module.exports = ({ config }) => {
  if (process.env.CHROXY_MAESTRO_RUNTIME_CACHE !== undefined ||
      process.env.CHROXY_MAESTRO_RUNTIME_VERSION !== undefined) {
    throw new Error('Maestro runtime reuse is retired; remove the old runtime inputs')
  }
  const mode = process.env.CHROXY_MAESTRO_BUILD_MODE
  if (mode === undefined) return config
  if (mode !== 'bundled' || !['1', 'true'].includes(process.env.CI)) {
    throw new Error('Bundled Maestro builds require explicit bundled mode and CI')
  }
  return { ...config, updates: { ...config.updates, checkAutomatically: 'NEVER' } }
}
