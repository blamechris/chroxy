import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'fs'
import { writeFileRestricted } from './platform.js'

// #6277 — discovery for the host-local user-shell approval listener.
//
// The approval API runs on a SEPARATE HTTP server bound to 127.0.0.1 on an
// ephemeral port that the Cloudflare tunnel never forwards (cloudflared only
// proxies the main port). That separate, never-tunnelled listener is what makes
// the approval channel genuinely host-local — a main-port loopback check is
// defeated because tunnel traffic arrives as 127.0.0.1 via cloudflared.
//
// The port is only known once the listener binds (after the supervisor already
// wrote connection.json), so it lives in its OWN 0600 file here rather than in
// connection.json. The `chroxy shell approve` CLI reads this for the port and
// connection.json for the primary token.

function getConfigDir() {
  return process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
}

export function getShellApprovalInfoPath() {
  return join(getConfigDir(), 'shell-approval.json')
}

export function writeShellApprovalInfo(info) {
  const dir = getConfigDir()
  mkdirSync(dir, { recursive: true })
  writeFileRestricted(getShellApprovalInfoPath(), JSON.stringify(info, null, 2))
}

export function readShellApprovalInfo() {
  const p = getShellApprovalInfoPath()
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return null
  }
}

export function removeShellApprovalInfo() {
  try { unlinkSync(getShellApprovalInfoPath()) } catch { /* already gone */ }
}
