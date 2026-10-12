import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'

const PROBE_TIMEOUT_MS = 5000
const PROBE_OUTPUT_MAX_BYTES = 64 * 1024
const WINDOWS_FINAL_PATH_SCRIPT = String.raw`
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class ChroxyOpenedFilePath {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetFinalPathNameByHandle(IntPtr hFile, StringBuilder path, uint chars, uint flags);
  public static string Read() {
    IntPtr handle = GetStdHandle(-10);
    if (handle == IntPtr.Zero || handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    var path = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
    if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    if (length >= (uint)path.Capacity) throw new InvalidOperationException("opened-file path exceeds helper bound");
    return path.ToString();
  }
}
'@
[Console]::Out.Write([ChroxyOpenedFilePath]::Read())
`

function probeError(message, code = 'EOPENEDPATH') {
  return Object.assign(new Error(`opened-file identity probe: ${message}`), { code })
}

function runBoundedProbe(command, args, options, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnProcess(command, args, options)
    } catch (err) {
      reject(probeError(`helper could not start (${err.code || err.message})`))
      return
    }
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let failure = null
    let settled = false
    let forceTimer = null
    let timer = null
    const finish = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      if (err) reject(err)
      else resolve(value)
    }
    const stop = (err) => {
      if (failure) return
      failure = err
      try { child.kill() } catch { /* best-effort */ }
      forceTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* best-effort */ }
        finish(failure)
      }, 250)
      forceTimer.unref?.()
    }
    const collect = (chunks, kind) => (chunk) => {
      const bytes = Buffer.byteLength(chunk)
      if (kind === 'stdout') stdoutBytes += bytes
      else stderrBytes += bytes
      if (stdoutBytes > PROBE_OUTPUT_MAX_BYTES || stderrBytes > PROBE_OUTPUT_MAX_BYTES) {
        stop(probeError('helper output exceeded its bound'))
        return
      }
      chunks.push(Buffer.from(chunk))
    }
    if (!child.stdout || !child.stderr) {
      stop(probeError('helper pipes were unavailable'))
    } else {
      child.stdout.on('data', collect(stdout, 'stdout'))
      child.stderr.on('data', collect(stderr, 'stderr'))
    }
    child.once('error', err => finish(probeError(`helper failed (${err.code || err.message})`)))
    child.once('close', (code, signal) => {
      if (failure) return finish(failure)
      if (code !== 0 || signal) return finish(probeError(`helper exited unsuccessfully (${signal || code})`))
      finish(null, {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    timer = setTimeout(() => stop(probeError('helper timed out')), PROBE_TIMEOUT_MS)
    timer.unref?.()
  })
}

export function parseLsofOpenedFilePath(stdout, { pid, fd }) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > PROBE_OUTPUT_MAX_BYTES) {
    throw probeError('lsof returned invalid or oversized output')
  }
  const fields = stdout.split(/[\0\r\n]+/).filter(Boolean)
  if (fields.length !== 3) throw probeError('lsof returned malformed fields')
  if (fields[0] !== `p${pid}`) throw probeError('lsof returned the wrong process')
  if (fields[1] !== `f${fd}`) throw probeError('lsof returned the wrong descriptor')
  if (!fields[2].startsWith('n') || fields[2].length === 1 || fields[2].includes('\0')) {
    throw probeError('lsof returned an invalid path field')
  }
  const path = fields[2].slice(1)
  if (!posix.isAbsolute(path)) throw probeError('lsof returned a non-absolute path')
  return path
}

export function normalizeWindowsFinalPath(path) {
  if (typeof path !== 'string' || !path) throw probeError('Windows helper returned an empty path')
  let normalized = path
  if (normalized.slice(0, 8).toLowerCase() === '\\\\?\\unc\\') normalized = `\\\\${normalized.slice(8)}`
  else if (normalized.startsWith('\\\\?\\')) normalized = normalized.slice(4)
  if (!win32.isAbsolute(normalized)) throw probeError('Windows helper returned a non-absolute path')
  return win32.normalize(normalized)
}

export async function resolveOpenedFilePath(fd, {
  platform = process.platform,
  pid = process.pid,
  realpathFile = realpath,
  runProbe = runBoundedProbe,
  spawnProcess = spawn,
  systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
} = {}) {
  if (!Number.isSafeInteger(fd) || fd < 0) throw probeError('descriptor must be a non-negative safe integer')
  if (platform === 'linux') {
    try {
      return await realpathFile(`/proc/self/fd/${fd}`)
    } catch (err) {
      throw probeError(`procfs query failed (${err.code || err.message})`)
    }
  }
  if (platform === 'darwin') {
    const result = await runProbe(
      '/usr/sbin/lsof',
      ['-a', '-p', String(pid), '-d', String(fd), '-Fpnf0'],
      { env: { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] },
      spawnProcess,
    )
    return parseLsofOpenedFilePath(result.stdout, { pid, fd })
  }
  if (platform === 'win32') {
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const result = await runProbe(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_FINAL_PATH_SCRIPT],
      {
        env: { SystemRoot: systemRoot, WINDIR: systemRoot, LANG: 'en_US.UTF-8' },
        windowsHide: true,
        stdio: [fd, 'pipe', 'pipe'],
      },
      spawnProcess,
    )
    return normalizeWindowsFinalPath(result.stdout)
  }
  throw probeError(`platform '${platform}' has no supported opened-file path query`, 'ENOSYS')
}
