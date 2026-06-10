# Discord Notifications

Chroxy can maintain a live **status embed** in a Discord channel — one message
per project that updates in place as sessions work, go idle, hit errors, or
wait for permission approval. No mobile app or Expo dev build required: a
Discord webhook URL is the only setup.

This is the Discord webhook notification sink from epic #5413 (Phase 2), a
port of the `claude-code-notify` status-embed behavior into the chroxy daemon.

## How it behaves

The sink keeps a single status message per project and updates it in place:

| Event | Embed state | Discord action |
|-------|-------------|----------------|
| Session finishes a turn / goes idle | 🦀 Ready for input | **Delete + re-post** (pings, moves to channel bottom) |
| Permission needed / question asked | 🔐 Needs Approval | **Delete + re-post** (pings) |
| Session error | ❗ Session Error | Edit in place (no ping) |
| Agent quiet for a long while | ⏳ Quiet for a while | Edit in place (no ping) |

Ping-worthy states (idle, needs-approval) delete the old message and post a
fresh one so Discord re-notifies you; routine updates just edit the existing
embed. If the message gets deleted by hand, the sink notices (the edit 404s)
and posts a fresh one. A background refresh keeps the embed footer's elapsed
time current (one in-process timer, every 5 minutes by default).

Notifications still flow through chroxy's shared pipeline first — category
preferences, quiet hours, and rate limits apply to Discord exactly as they do
to mobile push.

## Setup

### 1. Create a webhook in Discord

In your Discord server: **Channel settings → Integrations → Webhooks → New
Webhook**, pick the channel, copy the webhook URL.

### 2. Give chroxy the URL

The webhook URL is a **secret** — anyone holding it can post to (and delete
the sink's messages from) your channel. Treat it like an API key. Two options:

**Environment variable** (wins when both are set):

```bash
export CHROXY_DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/<id>/<token>"
```

**Credentials file** — add to `~/.chroxy/credentials.json` (the same file
that holds BYOK API keys):

```json
{
  "discordWebhookUrl": "https://discord.com/api/webhooks/<id>/<token>"
}
```

The file **must be mode 0600** — chroxy refuses to read it otherwise:

```bash
chmod 600 ~/.chroxy/credentials.json
```

Do NOT put the URL in `config.json` — it isn't permission-restricted and gets
echoed in verbose output. Chroxy warns at startup if it finds a `webhookUrl`
key in the config block. Log output redacts Discord webhook URLs as a second
layer of defence.

That's it. The sink is off by default and switches on the moment a webhook
URL resolves — restart the daemon after adding it.

### 3. (Optional) Colors and tuning

The non-secret knobs live in `~/.chroxy/config.json` under
`notifications.discord`:

```json
{
  "notifications": {
    "discord": {
      "botName": "Chroxy",
      "colors": {
        "chroxy": 1752220,
        "my-other-project": 10181046
      },
      "defaultColor": 5793266,
      "permissionColor": 16753920,
      "errorColor": 15158332,
      "updateThrottleMs": 15000,
      "heartbeatIntervalMs": 300000
    }
  }
}
```

- **`colors`** — per-project embed sidebar colors, keyed by project name,
  values are decimal 24-bit RGB (`0`–`16777215`). Convert hex → decimal with
  any color tool. Handy values (same palette as claude-code-notify's
  `colors.conf.example`):

  | Color | Hex | Decimal |
  |-------|-----|---------|
  | Teal | `#1ABC9C` | `1752220` |
  | Purple | `#9B59B6` | `10181046` |
  | Blue | `#3498DB` | `3447003` |
  | Green | `#2ECC71` | `3066993` |
  | Orange | `#E67E22` | `15105570` |
  | Red | `#E74C3C` | `15158332` |
  | Grey | `#95A5A6` | `9807270` |
  | Blurple (default) | `#5865F2` | `5793266` |

- **`updateThrottleMs`** — minimum gap between same-state routine edits per
  project (state *changes* always go out immediately).
- **`heartbeatIntervalMs`** — how often the elapsed-time footer refreshes.
  `0` disables the refresh; minimum `10000`.

See [packages/server/CONFIG.md](../../packages/server/CONFIG.md#discord-notifications-notificationsdiscord)
for the full key reference.

## Where state lives

Status-message bookkeeping (message id, current state, timestamps per
project) persists in `~/.chroxy/discord-webhook-state.json`, written
atomically. Deleting the file is safe — the next event posts a fresh status
message.

## Scope and roadmap

Phase 2 reflects **chroxy-launched sessions** (the events chroxy's own
notification pipeline emits). Claude Code sessions started outside chroxy
flow in with the event-ingest endpoint (Phase 3) and the hooks package
(Phase 4), which also moves subagent counting server-side. See epic #5413.

## Troubleshooting

- **Nothing posts** — check the daemon log for `discord` entries; confirm the
  URL resolves (`CHROXY_DISCORD_WEBHOOK_URL` set in the daemon's environment,
  or `credentials.json` is mode 0600 with a `discordWebhookUrl` field), and
  that the URL matches `https://discord.com/api/webhooks/<id>/<token>`.
- **Posts but never pings** — pings come from the delete + re-post on idle /
  needs-approval; check your Discord notification settings for the channel.
- **Rate limited** — the sink honours Discord's `retry_after` on 429s and
  backs off; sustained 429s resolve as delivery failure and retry on the next
  session event.
