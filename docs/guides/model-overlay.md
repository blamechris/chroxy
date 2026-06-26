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
- Tagged entries hot-reload like Claude ones — already-running provider sessions pick up the change on the next models fetch.
- **`pricing` applies wherever the provider reports per-token cost** — e.g. a `provider: "deepseek"` entry re-prices a DeepSeek model with no release ([#6381](https://github.com/blamechris/chroxy/issues/6381)), overriding the shipped static rate. Ollama is `$0` by design; Gemini/Codex don't report token cost; config-driven endpoints carry their own `pricing`.
- To *serve* (not just list) a new model on a static-allowlist provider, you still want [`providers.allowAnyModel`](../providers.md#serving-a-new-model-without-a-release-providersallowanymodel) — the overlay makes it appear in the picker; `allowAnyModel` lets an unlisted id through validation.

## Hot-reload

The overlay is watched and re-folded into the registry on change ([#5932](https://github.com/blamechris/chroxy/issues/5932)) — edit-and-save takes effect without a restart. Safety:

- **Malformed JSON** (or a non-object root) is rejected with a warning and the **last-good overlay is kept** — a typo mid-edit never wipes your overrides.
- **Deleting the file** legitimately **clears** the overlay (an explicit operator action).
- If the directory can't be watched, edits fall back to needing a restart (a warning says so).

## Notes & limits

- **Secrets never belong here** (same posture as `config.json`) — the overlay only carries model metadata.
- `claude-fable-5` is disallowed and **cannot be reintroduced** via the overlay ([#6219](https://github.com/blamechris/chroxy/issues/6219)).
- Untagged entries are Claude-registry-scoped; use a `provider` field for other providers (see [Targeting a specific provider](#targeting-a-specific-provider-non-claude)). `pricing` overrides apply to Claude and DeepSeek (the providers that report per-token cost).
- This complements, not replaces, the SDK's live `supportedModels()` push — a brand-new Claude model the SDK already knows about appears with no overlay at all; the overlay is for getting *ahead* of the build (or fixing a label/price) before the SDK or a release catches up.

## When to reach for which lever

| Goal | Use |
|------|-----|
| Surface/relabel/price a **Claude** model now | this overlay |
| Serve a new **Gemini/Codex/DeepSeek** model | [`providers.allowAnyModel`](../providers.md#serving-a-new-model-without-a-release-providersallowanymodel) |
| Add a model to a **config-driven endpoint** | the endpoint's `models` array or [`modelDiscovery`](../providers.md#model-discovery) |
| Use a new **Ollama** model | just `ollama pull` it — already unrestricted |
