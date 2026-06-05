/**
 * useInterventionPing (#4891) — play a short audible ping in the dashboard
 * when an intervention (permission request / question / blocked-on-input)
 * arrives, so the operator gets pulled back in while heads-down on other
 * work — even when the dashboard tab is minimized or sitting idle in the
 * background.
 *
 * Companion to `usePermissionNotification` (which fires the OS notification
 * when the window is unfocused). This hook owns the *audio* surface, which
 * the OS notification path never carried — the dashboard previously relied
 * purely on the OS default notification sound, which is silent on many
 * desktop configurations and never fires at all when the page is focused
 * but the operator's attention is elsewhere.
 *
 * Design notes:
 *   - **No bundled asset.** The ping is synthesized with the Web Audio API
 *     (a short two-note oscillator chirp). This keeps the bundle lean and
 *     sidesteps `<audio>` autoplay restrictions in the messiest way
 *     possible: Web Audio still requires a user gesture to *resume* a
 *     suspended `AudioContext`, but we fail soft — if the context can't
 *     start (autoplay blocked, no audio device, unsupported browser) the
 *     hook silently no-ops rather than throwing. The OS notification +
 *     in-app NotificationsWidget remain the durable signal.
 *   - **Mute respect.** `enabled === false` short-circuits before any audio
 *     work. The caller persists this in localStorage (see App.tsx) and
 *     exposes a toggle in Settings → Dashboard.
 *   - **Dedupe.** Each intervention is pinged at most once, keyed by
 *     `requestId`. Stale ids (prompt answered/expired/removed) are pruned
 *     so a re-request of the same id can ping again — mirrors
 *     `usePermissionNotification`'s `notifiedRef` contract.
 *   - **Throttle.** A single audio ping covers a *batch* of new
 *     interventions arriving in the same tick (e.g. several sessions
 *     blocking at once, or the same intervention echoed across reconnect).
 *     A short cooldown (`THROTTLE_MS`) collapses rapid-fire arrivals into
 *     one chirp so a broadcasting fleet of sessions can't trigger an alert
 *     storm. New ids are still recorded as "pinged" during the cooldown so
 *     they don't re-fire once it lifts.
 */
import { useEffect, useRef } from 'react'
import type { PermissionPromptInfo } from './usePermissionNotification'

/**
 * Minimum gap between audible pings. Multiple interventions landing inside
 * this window collapse into a single chirp. 3s is long enough to dedupe a
 * burst (multi-session block, reconnect replay) without feeling like the
 * alert was dropped for genuinely separate events.
 */
export const THROTTLE_MS = 3000

/** Total chirp duration — two short notes. Kept brief + non-annoying. */
const NOTE_MS = 120

export interface UseInterventionPingOptions {
  /** When false, the hook never plays audio (operator muted it). */
  enabled: boolean
}

/**
 * Lazily-created shared AudioContext. Created on first ping (inside the
 * effect, i.e. after React commit, never during module eval) so we don't
 * spin one up for users who keep the ping muted. Reused across pings so we
 * don't leak a context per intervention.
 */
let sharedContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  // Safari historically exposed only the prefixed constructor.
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (sharedContext === null) {
    try {
      sharedContext = new Ctor()
    } catch {
      return null
    }
  }
  return sharedContext
}

/**
 * Synthesize and play a short two-note chirp. Fully defensive: any failure
 * (suspended/blocked context, no audio device, GC'd nodes) is swallowed so
 * a missing sound never breaks the intervention flow.
 */
function playChirp(): void {
  const ctx = getAudioContext()
  if (!ctx) return
  try {
    // Browsers suspend the context until a user gesture. Attempt to resume;
    // if it stays suspended (autoplay policy) the scheduled notes simply
    // never sound — no throw, no console spam.
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {})
    }
    const now = ctx.currentTime
    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    // Gentle envelope so the notes don't click on/off.
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.01)

    const noteSec = NOTE_MS / 1000
    // Two ascending notes (A5 → E6) — recognizable "attention" interval
    // without being alarming.
    const freqs = [880, 1318.51]
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, now + i * noteSec)
      osc.connect(gain)
      osc.start(now + i * noteSec)
      osc.stop(now + (i + 1) * noteSec)
    })
    // Fade the shared gain out at the end of the second note so the next
    // chirp re-ramps from silence.
    gain.gain.setValueAtTime(0.15, now + freqs.length * noteSec - 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + freqs.length * noteSec)
  } catch {
    // Audio unavailable — fail soft.
  }
}

export function useInterventionPing(
  prompts: PermissionPromptInfo[],
  options: UseInterventionPingOptions,
): void {
  const { enabled } = options
  const pingedRef = useRef(new Set<string>())
  const lastPingAtRef = useRef(0)

  useEffect(() => {
    // Always prune stale ids so a re-requested intervention can ping again,
    // even while muted (keeps the dedupe set bounded + correct for the
    // moment the operator unmutes mid-session).
    const activeIds = new Set(prompts.map(p => p.requestId))
    for (const id of pingedRef.current) {
      if (!activeIds.has(id)) pingedRef.current.delete(id)
    }

    if (!enabled) return

    const now = Date.now()
    let hasNewIntervention = false

    for (const prompt of prompts) {
      // Skip answered / expired prompts — they no longer need the operator.
      // `expiresAt` is wall-clock at receipt time (see
      // usePermissionNotification for the clock-domain rationale).
      if (prompt.answered) continue
      if (prompt.expiresAt <= now) continue
      // Dedupe: already pinged this intervention.
      if (pingedRef.current.has(prompt.requestId)) continue

      // Record every genuinely-new intervention so it never re-fires, even
      // if the throttle cooldown swallows the audible chirp this tick.
      pingedRef.current.add(prompt.requestId)
      hasNewIntervention = true
    }

    if (!hasNewIntervention) return

    // Throttle: collapse a burst of new interventions into a single chirp.
    if (now - lastPingAtRef.current < THROTTLE_MS) return
    lastPingAtRef.current = now
    playChirp()
  }, [prompts, enabled])
}

/**
 * Test-only escape hatch to drop the shared AudioContext between cases so a
 * mocked constructor from one test doesn't leak into the next. Not used in
 * production code paths.
 */
export function __resetInterventionPingAudioContextForTests(): void {
  sharedContext = null
}
