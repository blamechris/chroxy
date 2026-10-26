const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins')

// Keep development tools available without placing a button over app controls.
module.exports = config => withAndroidManifest(config, config => {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults)
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(
    application, 'EXDevMenuShowFloatingActionButton', 'false'
  )
  return config
})
