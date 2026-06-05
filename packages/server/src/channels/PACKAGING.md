# `chroxy-channel` — plugin-packaging plan

> **Status: plan only.** Nothing here is published yet. This document scopes
> what shipping `chroxy-channel` as an Anthropic-marketplace **Claude plugin**
> would entail, so that users eventually no longer need
> `--dangerously-load-development-channels`. It is the packaging deliverable of
> [#3956](https://github.com/blamechris/chroxy/issues/3956) (parent
> [#3951](https://github.com/blamechris/chroxy/issues/3951)).

## Why package at all?

During the research preview, a custom (non-allowlisted) channel can only be
loaded with `--dangerously-load-development-channels` — the flag bypasses
Anthropic's approved-channels allowlist. The spike
([`docs/architecture/claude-channels-provider-spike.md`](../../../../docs/architecture/claude-channels-provider-spike.md))
verified, against the installed CLI, the allowlist gate string:

```
… is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)
```

and the matching warning:

```
--dangerously-load-development-channels is for local channel development only.
Do not use this option to run channels you have downloaded off the internet.
```

Asking chroxy users to pass a deliberately-alarming flag is the main ergonomics
liability of the channel provider (spike risk **R2**). Getting `chroxy-channel`
onto an approved marketplace removes that requirement: an approved plugin loads
via `/plugin install` + `plugin:<name>@<marketplace>` with no dev flag.

## Claude-plugin package layout

A Claude plugin that provides a channel is a directory with a manifest plus the
channel server. Sketch (the exact `plugin.json` schema is defined by the Claude
plugin docs — verify against
[code.claude.com/docs/en/channels-reference#package-as-a-plugin](https://code.claude.com/docs/en/channels-reference#package-as-a-plugin)
before authoring, since the preview schema may change):

```
chroxy-channel/
├── plugin.json              # plugin manifest: name, version, description,
│                            #   declared channel(s), entry command
├── README.md                # what it does, security note, support link
└── server/                  # the stdio MCP channel server
    └── chroxy-channel-server.js
```

- **`plugin.json`** — declares the plugin `name` (`chroxy-channel`), `version`,
  `description`, and the channel it provides (name + the `command`/`args` Claude
  uses to spawn the stdio MCP server). The channel name in the manifest is what
  users reference as `plugin:chroxy-channel@<marketplace>`.
- **Marketplace metadata** — a marketplace is itself a manifest (commonly a
  `marketplace.json` / repo index) listing the plugins it offers, with the
  fields Anthropic's marketplace format requires (display name, author,
  homepage, source). chroxy's own marketplace would be a small repo that lists
  exactly this one plugin; submitting to a shared marketplace means adding our
  entry to theirs.
- **Channel server** — the in-tree
  [`chroxy-channel-server.js`](./chroxy-channel-server.js) prototype is the
  starting point. The packaged copy must be self-contained (its
  `@modelcontextprotocol/sdk` dependency bundled or declared) so it runs when
  Claude spawns it from the installed plugin directory rather than from the
  chroxy checkout. This is the crux of the embedded-vs-separate-package open
  question below.

> The fields above are described from the public reference, not yet exercised by
> a real submission — treat the exact manifest keys as **unverified** until we
> author a real `plugin.json` and a marketplace listing actually loads it.

## Marketplace decision: chroxy's own vs `claude-plugins-official`

Two routes, each with trade-offs:

| | chroxy-owned marketplace | `claude-plugins-official` |
|---|---|---|
| Control | Full — we own the repo, version on our schedule | Anthropic-gated; PR + review to land changes |
| Trust signal | Users add a third-party marketplace | First-party, highest trust |
| Removes dev flag? | Yes, if the marketplace is allowlisted / the org allows it | Yes — approved, default-allowed on Console |
| Review burden | Self-managed; we are the reviewers | Anthropic security review (see below) |
| Discovery | Users must know to add it | Discoverable in the official catalog |

**Recommendation (plan):** pursue the **official** marketplace
([`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official),
where the upstream Telegram/Discord/iMessage/fakechat channel plugins live) as
the end state — it is the only route that removes the dev flag for the broadest
set of users without each of them trusting a chroxy-owned marketplace, and it
default-allows on Console. Stand up a **chroxy-owned marketplace as an interim
step** if we want approved-plugin ergonomics before the official review clears,
accepting that users must add it explicitly. Defer the final call until the
channel protocol graduates out of preview (the contract may shift on the way to
GA, and resubmitting a moving target is wasted review cycles).

## Anthropic security-review expectations

Anthropic reviews channel plugins before approving them for a marketplace
listing (a channel can inject into and reply on behalf of a live Claude
session, and can relay permission verdicts, so the bar is high). Anticipated
expectations to satisfy before submitting:

- **No arbitrary remote code / no network egress beyond what's documented.** The
  channel server should not phone home or pull executable content off the
  internet — exactly the threat the dev-flag warning calls out.
- **Permission-relay gating.** If the plugin declares
  `claude/channel/permission`, it must gate who can submit verdicts — anyone who
  can reply can approve tool use (spike R8). chroxy's bridge drives the socket
  from a single trusted writer (`ClaudeChannelSession`); the packaged plugin
  must preserve that property and not expose an open control surface.
- **Minimal, declared dependencies.** Bundle or pin `@modelcontextprotocol/sdk`
  and avoid a long transitive tree that widens the review surface.
- **Clear provenance and support.** Author, source repo, and a security-contact
  path in the manifest/README.
- **Reproducible behaviour.** The reviewer should be able to run the channel and
  see it behave as documented.

> These are reasonable expectations inferred from the dev-flag warning and the
> permission-relay contract; the **exact** review checklist Anthropic applies is
> not published and is therefore **unverified**. Confirm the current process
> before submitting.

## How approval removes `--dangerously-load-development-channels`

The dev flag exists solely to bypass the approved-channels allowlist during
local development. Once `chroxy-channel` is an approved plugin on a marketplace
the user (or their org) trusts:

```bash
# One-time install of the approved plugin
/plugin install chroxy-channel@chroxy        # or @claude-plugins-official

# chroxy then spawns claude with the plugin-tagged channel, no dev flag:
claude --channels plugin:chroxy-channel@chroxy
```

`ClaudeChannelSession` would select the `plugin:<name>@<marketplace>` tag form
(allowlist-enforced) instead of the `server:<name>` +
`--dangerously-load-development-channels` form it must use during the preview.
Until then, the dev flag stays — documented in
[`CONFIG.md`](../../CONFIG.md#claude-channel-research-preview) and
[`docs/providers.md`](../../../../docs/providers.md#claude-channel-research-preview)
with a clear explanation of *why* it's needed and that it bypasses only the
allowlist, not org policy (`channelsEnabled`, `allowedChannelPlugins`).

## Open question: separate npm package vs embedded in `@chroxy/server`

Today the channel server lives at
[`packages/server/src/channels/chroxy-channel-server.js`](./chroxy-channel-server.js),
inside `@chroxy/server`. For the packaged plugin, Claude spawns the server from
the **installed plugin directory**, not from the chroxy checkout — so the
packaged copy must stand alone.

- **Embedded in `@chroxy/server` (status quo + a copy step).** Keep the source
  in-tree; the plugin build copies/bundles it into the plugin directory. Pro:
  one source of truth, no version-skew between the bridge and the channel
  server. Con: the plugin build must bundle `@modelcontextprotocol/sdk` and any
  shared helpers, and we ship the same code twice (in the npm package and in the
  plugin).
- **Separate npm package (e.g. `@chroxy/channel-server`).** Extract the channel
  server into its own published package that both `@chroxy/server` and the
  plugin depend on. Pro: a clean, independently-versioned artifact that the
  plugin can `npm install`; clearer security-review surface (reviewers audit one
  small package). Con: a new package to publish and version; the bridge and the
  channel server can drift if not released together.

**Leaning (not decided):** keep it **embedded** until the bridge (#3954) and
permission relay (#3955) stabilise the channel server's surface, then extract to
a separate package **if and when** we actually submit to a marketplace — at that
point an independently-versioned, minimal-dependency artifact is the easier
thing to get through security review. Decide alongside the marketplace decision
above, after the protocol leaves preview.

## References

- Spike (verified protocol + go/no-go): [`docs/architecture/claude-channels-provider-spike.md`](../../../../docs/architecture/claude-channels-provider-spike.md)
- Channel server prototype + run instructions: [`README.md`](./README.md)
- Channels — Package as a plugin: https://code.claude.com/docs/en/channels-reference#package-as-a-plugin
- Official channel plugins (Telegram/Discord/iMessage/fakechat): https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins
- Provider scaffold: [`packages/server/src/claude-channel-session.js`](../claude-channel-session.js)
- User-facing docs: [`CONFIG.md`](../../CONFIG.md#claude-channel-research-preview), [`docs/providers.md`](../../../../docs/providers.md#claude-channel-research-preview)
