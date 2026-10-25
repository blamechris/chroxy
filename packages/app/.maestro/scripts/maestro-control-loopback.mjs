// Restrict the mock's host-side control endpoint to an exact local peer.
export function isMaestroControlPeer(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}
