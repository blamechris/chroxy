/**
 * The 15 s watchdog on a Restart now / Postpone request (#8331): if the daemon never
 * answers, the banner's buttons are released with an error instead of staying
 * disabled for the life of the page.
 *
 * A module of its own because both `connection.ts` (which arms it, and clears it on
 * a drop or a new handshake) and `message-handler.ts` (which clears it when the
 * matching reply arrives) need it, and `connection.ts` already imports the handler.
 */

let timer: ReturnType<typeof setTimeout> | null = null

/** Arm the watchdog, replacing any earlier one. */
export function armDaemonUpdateWatchdog(ms: number, onExpire: () => void): void {
  clearDaemonUpdateWatchdog()
  timer = setTimeout(() => { timer = null; onExpire() }, ms)
}

/** Cancel it (a matching reply arrived, the socket dropped, or a new handshake began). */
export function clearDaemonUpdateWatchdog(): void {
  if (timer) { clearTimeout(timer); timer = null }
}

/** Test seam: is one armed? */
export function isDaemonUpdateWatchdogArmed(): boolean {
  return timer !== null
}
