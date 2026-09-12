# Model overlay (`~/.chroxy/models.json`)

Add, relabel, or re-price a model **at runtime, with no Chroxy release** — by dropping a small JSON file next to your config. The overlay is Chroxy's lightest "serve a model the build doesn't know about yet" lever: edit the file and the change is picked up live (hot-reload), no restart.

> **Scope:** by default an entry applies to the **Claude registry** (`claude-sdk` / `claude-cli` / `claude-tui` / docker-wrapped Claude). Since [#6377](https://github.com/blamechris/chroxy/issues/6377) an entry can carry a **`provider` field** to target any other provider's registry instead (Gemini, Codex, DeepSeek, Ollama, config-driven endpoints) — see [Targeting a specific provider](#targeting-a-specific-provider-non-claude). **Labels, context windows, and new-model seeding work for every provider.** Overlay **`pricing`** is honored wherever the provider reports per-token cost — Claude (always) and **DeepSeek** ([#6381](https://github.com/blamechris/chroxy/issues/6381)); Ollama is intentionally `$0`, config-driven endpoints price via their own `pricing` / discovery, and Gemini/Codex don't report token cost so pricing is moot there.

## Location

```
$CHROXY_CONFIG_DIR/models.json      # if CHROXY_CONFIG_DIR is set
~/.chroxy/models.json               # otherwise (default)
```

It sits next to `config.json` and the model cache. The file is optional — absent means "no overrides".

## Format

A JSON **object keyed by the model's full id**. Every field except the key is optional:

```json
{
  "claude-opus-5-20260601": {
    "shortId": "opus-5",
    "label": "Opus 5",
    "contextWindow": 200000,
    "pricing": { "input": 15, "output": 75, "cacheRead": 1.5, "cacheWrite": 18.75 }
  },
  "claude-sonnet-4-6": {
    "label": "Sonnet 4.6 (my relabel)"
  }
}
```

| Field | Meaning |
|-------|---------|
| *(key)* | The model's **full id** — what gets passed to the SDK/CLI. Required. |
| `fullId` | Optional override for the id; defaults to the key. |
| `shortId` | Optional alias (e.g. `opus-5`) the picker and `set_model` accept. Defaults to a derived short id. |
| `label` | Optional display name in the picker. Defaults to a humanized id. |
| `contextWindow` | Optional token window (positive number) for the context meter. |
| `pricing` | Optional USD-per-MTok rates: `{ input, output, cacheRead, cacheWrite }`. Absent → cost reads `null` (not `$0`). Honored for Claude and DeepSeek — see the scope note. |
| `provider` | Optional provider name (e.g. `"gemini"`, `"codex"`, `"deepseek"`) to target that provider's registry instead of Claude's. Omit for Claude models. |

### What an entry does

- **A new full id** (not already known) is **seeded like a built-in model**: it shows up in the dashboard/mobile picker, resolves by both its full and short id, and **lands in the allowlist** so `set_model` and session creation accept it — no release.
- **An existing id** has its `label` / `contextWindow` / `shortId` overridden (overlay wins over the static heuristic).
- **Pricing precedence:** overlay `pricing` (matched on the resolved full id) > the built-in pricing table > `null`. A missing `pricing` block does *not* shadow the built-in table.
- **Live SDK values still win** for the context window: when the Agent SDK reports a model, its values are consulted ahead of the overlay row, so the overlay never pins a stale window over fresh SDK data.

### Targeting a specific provider (non-Claude)

Add a `provider` field to route an entry to that provider's own registry instead of Claude's ([#6377](https://github.com/blamechris/chroxy/issues/6377)):

```json
{
  "gemini-3.0-pro": {
    "provider": "gemini",
    "label": "Gemini 3.0 Pro",
    "contextWindow": 2000000
  },
  "deepseek-v4": {
    "provider": "deepseek",
    "label": "DeepSeek V4"
  }
}
```

- A tagged entry seeds/overrides **that** provider's picker + allowlist and is **isolated** — a `gemini` entry never bleeds into Codex or Claude.
- Routing is by the field's **presence**, not by validating the name; a Claude provider name (or omitting the field) lands on the Claude registry, so just omit `provider` for Claude models.
- Tagged entries hot-reload like Claude ones, and since [#7733](https://github.com/blamechris/chroxy/issues/7733) the reload broadcast is **provider-tagged**: one `available_models` message per registry the reload touched, each carrying that provider's own roster, instead of a single message built from the Claude registry and hardcoded `provider: 'claude-sdk'`. Clients then keep **one roster per provider** and each session reads its own ([#7758](https://github.com/blamechris/chroxy/issues/7758)) — so a Claude roster can no longer hide a codex session's picker, and a codex session can no longer render Claude chips that would send a Claude id to codex.
- **Known residue:** the *default* (Claude) registry's reload broadcast is still tagged `claude-sdk`, which is not how every other `available_models` sender tags a `claude-tui` session — the repo's default provider. Since clients now file each roster under the provider it was tagged with, that reload lands in the `claude-sdk` slot and a `claude-tui` session keeps the roster it already had until it refetches. It no longer *hides* that session's picker (#7758 removed the global provider-match gate the dashboard used to apply); the edit simply may not appear until the next fetch or reconnect.
- **`pricing` applies wherever the provider reports per-token cost** — e.g. a `provider: "deepseek"` entry re-prices a DeepSeek model with no release ([#6381](https://github.com/blamechris/chroxy/issues/6381)), overriding the shipped static rate. Ollama is `$0` by design; Gemini/Codex don't report token cost; config-driven endpoints carry their own `pricing`.
- To *serve* (not just list) a new model on a static-allowlist provider (`gemini`, `deepseek`), you still want [`providers.allowAnyModel`](../providers.md#serving-a-new-model-without-a-release-providersallowanymodel) — the overlay makes it appear in the picker; `allowAnyModel` lets an unlisted id through validation. **Codex is no longer one of those** ([#7727](https://github.com/blamechris/chroxy/issues/7727)): **once the binary has answered `model/list`**, it validates against the ids that answer carried, so an overlay row for a model codex does not serve stays listed-but-unselectable rather than becoming servable. Before that answer arrives codex is **unrestricted** — a cold daemon, an unresolved probe, or a `codex` binary that cannot be reached — and in that window an overlay row for *any* id is servable, then stops being servable the moment a catalog lands. A host whose codex binary is permanently unreachable stays in that window permanently.
- **The codex stopgap works now, and you usually do not need it.** A `provider: "codex"` row used to be actively counterproductive: the hot-reload broadcast was Claude-tagged, so the row never reached the codex client *and* the mismatched tag hid that session's picker outright. Since [#7733](https://github.com/blamechris/chroxy/issues/7733)/[#7758](https://github.com/blamechris/chroxy/issues/7758) it does what the guide always said it did. It is also rarely the lever you want, and its reach is narrower than the Claude case: codex's roster is the installed binary's own `model/list` answer, and an overlay row is only merged for a `fullId` that roster does not already carry ([#7777](https://github.com/blamechris/chroxy/issues/7777)). So it is the lever for a picker entry on a host whose binary **cannot be asked** — not for relabelling or re-windowing a model codex already reports, where the binary's own values win.

## Hot-reload

The overlay is watched and re-folded into the registry on change ([#5932](https://github.com/blamechris/chroxy/issues/5932)) — edit-and-save takes effect without a restart. Safety:

- **Malformed JSON** (or a non-object root) is rejected with a warning and the **last-good overlay is kept** — a typo mid-edit never wipes your overrides.
- **Deleting the file** legitimately **clears** the overlay (an explicit operator action).
- If the directory can't be watched, edits fall back to needing a restart (a warning says so).

## Notes & limits

- **Secrets never belong here** (same posture as `config.json`) — the overlay only carries model metadata.
- `claude-fable-5` (Fable) is GA and selectable — it was banned as a preview in [#6219](https://github.com/blamechris/chroxy/issues/6219) and re-enabled once it shipped generally. The `DISALLOWED_MODEL_IDS` mechanism is retained (empty) so a future model can be excluded the same way.
- Untagged entries are Claude-registry-scoped; use a `provider` field for other providers (see [Targeting a specific provider](#targeting-a-specific-provider-non-claude)). `pricing` overrides apply to Claude and DeepSeek (the providers that report per-token cost).
- This complements, not replaces, the SDK's live `supportedModels()` push — a brand-new Claude model the SDK already knows about appears with no overlay at all; the overlay is for getting *ahead* of the build (or fixing a label/price) before the SDK or a release catches up.

## When to reach for which lever

| Goal | Use |
|------|-----|
| Surface/relabel/price a **Claude** model now | this overlay |
| Serve a new **Gemini/DeepSeek** model | [`providers.allowAnyModel`](../providers.md#serving-a-new-model-without-a-release-providersallowanymodel) |
| Serve a new **Codex** model | nothing — the binary's own `model/list` is the allowlist *once it has one* ([#7727](https://github.com/blamechris/chroxy/issues/7727)); until then codex accepts any id. See [where the codex list comes from](../providers.md#where-the-model-list-comes-from-modellist) |
| Get a **Codex** picker entry on a host whose binary can't be asked | this overlay, with `"provider": "codex"` — but it only adds ids the binary's own roster lacks ([#7777](https://github.com/blamechris/chroxy/issues/7777)) |
| Add a model to a **config-driven endpoint** | the endpoint's `models` array or [`modelDiscovery`](../providers.md#model-discovery) |
| Use a new **Ollama** model | just `ollama pull` it — already unrestricted |
