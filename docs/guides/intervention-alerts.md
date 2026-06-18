# Intervention alerts

When the agent needs an **intervention** — a permission request, a question
(`AskUserQuestion`), or any blocked-on-input state — Chroxy alerts you on every
connected device so the session doesn't stall while you're heads-down on other
work. This page documents which surfaces alert you, when they fire, and how to
turn each one off.

## What counts as an intervention

- A **permission request** (a tool wants to run and needs allow / deny).
- A **question** the agent asked and is waiting on.
- Any prompt that blocks the turn until you respond.

These all surface to clients as a permission/question prompt with a `requestId`
and an expiry. Completion and error notifications are separate categories (see
the per-category toggles in **Settings → Notifications**).

## Which surfaces alert you

| Surface | Signal | Fires when |
| --- | --- | --- |
| **Web / desktop dashboard** | Audible ping (two-note chirp) | An intervention arrives, even if the tab is minimized or sitting idle in the background |
| **Web / desktop dashboard** | OS notification | An intervention arrives **and the window is not focused** |
| **Web / desktop dashboard** | Notifications widget (bell icon) | Always — a durable read/unread inbox of every intervention |
| **Mobile app** | Push notification with sound | An intervention arrives while the app is backgrounded or closed |
| **Mobile app** | In-app alert | An intervention arrives while the app is foregrounded |

All connected devices are alerted, not just the actively-focused one. The server
fans an intervention out to every client subscribed to (or viewing) the session
via `_broadcastToSession`, and to every registered push token via the push
manager. Push for the `permission` category bypasses rate limiting so a blocking
intervention always gets through.

### Why the dashboard has both a chirp and an OS notification

The OS notification only fires when the window is **unfocused**, and on many
desktop configurations it makes no sound. The audible chirp closes that gap: it
fires on **every** intervention regardless of focus, so a tab you've tabbed away
from (but not minimized) still pulls you back, and minimized/background tabs
still chirp as long as the page's JavaScript is running.

## Dedupe and throttle (no alert storm)

- Each intervention chirps **at most once**, keyed by its `requestId`. A
  re-render or reconnect replay of the same request never re-chirps.
- A burst of interventions arriving together (multiple sessions blocking at
  once, or a reconnect replaying several prompts) collapses into a **single**
  chirp via a short cooldown. New requests seen during the cooldown are still
  recorded so they never re-fire once it lifts.
- The same intervention reaching you on several devices alerts on each device
  independently — each surface is the right alert for that device's context.

## How to disable each surface

| Surface | Where to turn it off |
| --- | --- |
| Dashboard chirp | **Settings → Dashboard → "Play a sound when the agent needs input"** (per-device, persisted in this browser/tab's local storage). Defaults on. |
| Dashboard OS notification | Revoke the browser/OS notification permission for the dashboard origin. |
| Per-category push / in-app | **Settings → Notifications** — toggle the **Permission requests** / **Waiting for input** categories off. |
| Quiet hours | **Settings → Notifications → Quiet hours** — mutes pushes during a daily window. Operator-blocking categories (permission, session errors) bypass quiet hours by default; uncheck them in the bypass list to silence them at night too. |

### Accessibility / "reduce sound"

The dashboard chirp is synthesized with the Web Audio API (no bundled asset).
If the browser blocks autoplay, has no audio device, or the page hasn't yet
received a user gesture to resume the audio context, the chirp **fails soft** —
it simply doesn't sound, and the OS notification + Notifications widget remain
the durable signal. Mute the chirp entirely via the Settings toggle above if you
prefer a silent dashboard.

## Implementation pointers

- Dashboard audio ping: `packages/dashboard/src/hooks/useInterventionPing.ts`
  (dedupe + throttle + mute, fed the same derived prompt list as the OS
  notification hook).
- Dashboard OS notification: `packages/dashboard/src/hooks/usePermissionNotification.ts`.
- Mute toggle + persistence: **Settings → Dashboard** in
  `packages/dashboard/src/components/SettingsPanel.tsx`, persisted via
  `persistInterventionPing` / `loadPersistedInterventionPing` in
  `packages/dashboard/src/store/persistence.ts`.
- Server fan-out: `_broadcastToSession` in `packages/server/src/ws-server.js`;
  push in `packages/server/src/push.js` (the `permission` category bypasses rate
  limiting).
- Mobile push sound: `packages/app/src/notifications.ts`.
- Notification preferences (per-category mute, quiet hours):
  `packages/server/src/notification-prefs.js`.
