# Model overlay (`~/.chroxy/models.json`)

Add, relabel, or re-price a model **at runtime, with no Chroxy release** — by dropping a small JSON file next to your config. The overlay is Chroxy's lightest "serve a model the build doesn't know about yet" lever: edit the file and the change is picked up live (hot-reload), no restart.

> **Scope today:** the overlay applies to the **default Claude registry** only (`claude-sdk` / `claude-cli` / `claude-tui` / docker-wrapped Claude). Extending it to the other providers' registries (Gemini, Codex, DeepSeek, Ollama, config-driven endpoints) is tracked in [#6377](https://github.com/blamechris/chroxy/issues/6377). For those providers today, see [`providers.allowAnyModel`](../providers.md#serving-a-new-model-without-a-release-providersallowanymodel) (serve any API-valid id) and the config-driven [`models` / `modelDiscovery`](../providers.md#anthropic-compatible-endpoints-config-driven) blocks.

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
| `pricing` | Optional USD-per-MTok rates: `{ input, output, cacheRead, cacheWrite }`. Absent → cost reads `null` (not `$0`). |

### What an entry does

- **A new full id** (not already known) is **seeded like a built-in model**: it shows up in the dashboard/mobile picker, resolves by both its full and short id, and **lands in the allowlist** so `set_model` and session creation accept it — no release.
- **An existing id** has its `label` / `contextWindow` / `shortId` overridden (overlay wins over the static heuristic).
- **Pricing precedence:** overlay `pricing` (matched on the resolved full id) > the built-in pricing table > `null`. A missing `pricing` block does *not* shadow the built-in table.
- **Live SDK values still win** for the context window: when the Agent SDK reports a model, its values are consulted ahead of the overlay row, so the overlay never pins a stale window over fresh SDK data.

## Hot-reload

The overlay is watched and re-folded into the registry on change ([#5932](https://github.com/blamechris/chroxy/issues/5932)) — edit-and-save takes effect without a restart. Safety:

- **Malformed JSON** (or a non-object root) is rejected with a warning and the **last-good overlay is kept** — a typo mid-edit never wipes your overrides.
- **Deleting the file** legitimately **clears** the overlay (an explicit operator action).
- If the directory can't be watched, edits fall back to needing a restart (a warning says so).

## Notes & limits

- **Secrets never belong here** (same posture as `config.json`) — the overlay only carries model metadata.
- `claude-fable-5` is disallowed and **cannot be reintroduced** via the overlay ([#6219](https://github.com/blamechris/chroxy/issues/6219)).
- Claude-registry-scoped (see the scope note above).
- This complements, not replaces, the SDK's live `supportedModels()` push — a brand-new Claude model the SDK already knows about appears with no overlay at all; the overlay is for getting *ahead* of the build (or fixing a label/price) before the SDK or a release catches up.

## When to reach for which lever

| Goal | Use |
|------|-----|
| Surface/relabel/price a **Claude** model now | this overlay |
| Serve a new **Gemini/Codex/DeepSeek** model | [`providers.allowAnyModel`](../providers.md#serving-a-new-model-without-a-release-providersallowanymodel) |
| Add a model to a **config-driven endpoint** | the endpoint's `models` array or [`modelDiscovery`](../providers.md#model-discovery) |
| Use a new **Ollama** model | just `ollama pull` it — already unrestricted |
