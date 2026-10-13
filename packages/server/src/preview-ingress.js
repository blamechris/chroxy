import { openSync, closeSync, fstatSync, readFileSync, lstatSync, constants } from 'node:fs'
import { open, lstat, unlink } from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'

const sameFile = (current, saved) => current.dev === saved.dev && current.ino === saved.ino && current.uid === saved.uid

/** The only ingress rule is the owned Unix origin, never a TCP fallback. */
export async function createPreviewIngress(socketPath, directory) {
  const path = join(dirname(socketPath), 'ingress.json')
  const bytes = JSON.stringify({ ingress: [{ service: `unix:${socketPath}` }] }) + '\n'
  const file = await open(path, 'wx', 0o600)
  let identity
  try {
    identity = await file.stat()
    await file.writeFile(bytes)
  } catch (error) {
    if (identity && sameFile(await lstat(path), identity)) await unlink(path)
    throw error
  } finally {
    await file.close()
  }
  let socket
  try {
    socket = await lstat(socketPath)
  } catch (error) {
    if (sameFile(await lstat(path), identity)) await unlink(path)
    throw error
  }
  return Object.freeze({ path, bytes, socketPath, file: Object.freeze({ dev: identity.dev, ino: identity.ino, uid: identity.uid }), directory: Object.freeze({ dev: directory.dev, ino: directory.ino, uid: directory.uid }), socket: Object.freeze({ dev: socket.dev, ino: socket.ino, uid: socket.uid }) })
}

/** Synchronous admission runs inside the actual cloudflared spawn path. */
export function assertPreviewIngress(saved) {
  if (!saved || !isAbsolute(saved.path || '') || !isAbsolute(saved.socketPath || '') || dirname(saved.path) !== dirname(saved.socketPath)) throw new Error('Preview requires a private Unix ingress configuration')
  const directory = lstatSync(dirname(saved.path))
  const socket = lstatSync(saved.socketPath)
  if (!sameFile(directory, saved.directory) || !directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o700 || !sameFile(socket, saved.socket) || !socket.isSocket() || socket.uid !== directory.uid) throw new Error('Preview origin ownership changed')
  const fd = openSync(saved.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const file = fstatSync(fd)
    const bytes = readFileSync(fd, 'utf8')
    const expected = JSON.stringify({ ingress: [{ service: `unix:${saved.socketPath}` }] }) + '\n'
    if (!sameFile(file, saved.file) || !file.isFile() || file.uid !== directory.uid || (file.mode & 0o777) !== 0o600 || saved.bytes !== expected || bytes !== expected) throw new Error('Preview ingress configuration changed')
  } finally {
    closeSync(fd)
  }
}

export async function removePreviewIngress(saved) {
  const file = await lstat(saved.path)
  if (!sameFile(file, saved.file) || !file.isFile()) throw new Error('Preview ingress identity changed; cleanup refused')
  await unlink(saved.path)
}
