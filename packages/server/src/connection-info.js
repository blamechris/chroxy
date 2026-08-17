import { join } from 'path'
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'fs'
import { writeFileRestricted } from './platform.js'
import { configDir, configPath } from './config-dir.js'

export function getConnectionInfoPath() {
  return configPath('connection.json')
}

export function writeConnectionInfo(info) {
  const dir = configDir()
  mkdirSync(dir, { recursive: true })
  writeFileRestricted(join(dir, 'connection.json'), JSON.stringify(info, null, 2))
}

export function readConnectionInfo() {
  const connFile = getConnectionInfoPath()
  if (!existsSync(connFile)) return null
  try {
    const info = JSON.parse(readFileSync(connFile, 'utf-8'))
    if (info && info.pid) {
      try {
        process.kill(info.pid, 0) // signal 0 = existence check
      } catch {
        // Process is dead — stale file
        removeConnectionInfo()
        return null
      }
    }
    return info
  } catch {
    return null
  }
}

export function removeConnectionInfo() {
  try { unlinkSync(getConnectionInfoPath()) } catch {}
}
