import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'fs'
import { writeFileRestricted } from './platform.js'

function getConfigDir() {
  return process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
}

export function getConnectionInfoPath() {
  return join(getConfigDir(), 'connection.json')
}

export function writeConnectionInfo(info) {
  const configDir = getConfigDir()
  mkdirSync(configDir, { recursive: true })
  writeFileRestricted(join(configDir, 'connection.json'), JSON.stringify(info, null, 2))
}

export function readConnectionInfo() {
  const connFile = getConnectionInfoPath()
  if (!existsSync(connFile)) return null
  try {
    return JSON.parse(readFileSync(connFile, 'utf-8'))
  } catch {
    return null
  }
}

export function removeConnectionInfo() {
  try { unlinkSync(getConnectionInfoPath()) } catch {}
}
