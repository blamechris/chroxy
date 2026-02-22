import { writeFileSync, chmodSync } from 'fs'

export const isWindows = process.platform === 'win32'
export const isMac = process.platform === 'darwin'
export const isLinux = process.platform === 'linux'

export function defaultShell() {
  if (isWindows) return process.env.COMSPEC || 'cmd.exe'
  return process.env.SHELL || '/bin/zsh'
}

export function writeFileRestricted(filePath, data) {
  if (isWindows) {
    writeFileSync(filePath, data)
  } else {
    writeFileSync(filePath, data, { mode: 0o600 })
    chmodSync(filePath, 0o600)
  }
}

export function forceKill(child) {
  if (isWindows) {
    child.kill('SIGKILL')
  } else {
    child.kill('SIGKILL')
  }
}
