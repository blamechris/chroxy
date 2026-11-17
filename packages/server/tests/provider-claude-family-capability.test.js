/**
 * #9175 / #9191 — the dashboard's session-defaults migration notice decides
 * whether a cleared Claude model pin is relevant from
 * `capabilities.thinkingLevelLegacyFallback` on each `provider_list` entry
 * (packages/dashboard CreateSessionModal `sessionDefaultsNoticeApplies`). That
 * flag is derived from the provider class's `claudeFamily`. This pins the
 * coupling on the server side: change a class's family and the notice's
 * signal changes with it, so this goes red here rather than silently in the UI.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerProvider, listProviders } from '../src/providers.js'
import { DockerSession } from '../src/docker-session.js'
import { DockerSdkSession } from '../src/docker-sdk-session.js'
import { DockerByokSession } from '../src/docker-byok-session.js'
import { registerAnthropicCompatibleProviders } from '../src/anthropic-compatible-session.js'
import { registerOpenAiCompatibleProviders } from '../src/openai-compatible-session.js'

registerProvider('docker-cli', DockerSession)
registerProvider('docker-sdk', DockerSdkSession)
registerProvider('docker-byok', DockerByokSession)
registerAnthropicCompatibleProviders({
  providers: { anthropicCompatible: [{ id: 'pin-anthropic-compat', baseUrl: 'https://api.example.test/anthropic', defaultModel: 'm1' }] },
})
registerOpenAiCompatibleProviders({
  providers: { openaiCompatible: [{ id: 'pin-openai-compat', baseUrl: 'https://api.example.test/v1', defaultModel: 'm1' }] },
})

const flags = () => new Map(listProviders().map(p => [p.name, p.capabilities.thinkingLevelLegacyFallback]))

describe('thinkingLevelLegacyFallback tracks the Claude family (#9175)', () => {
  it('is true for every Claude-family provider', () => {
    const f = flags()
    for (const name of ['claude-sdk', 'claude-cli', 'claude-tui', 'claude-channel', 'claude-byok', 'docker-cli', 'docker-sdk', 'docker-byok']) {
      assert.ok(f.has(name), `${name} is listed`)
      assert.equal(f.get(name), true, name)
    }
  })

  it('is false for providers that cannot run Claude model ids', () => {
    const f = flags()
    for (const name of ['codex', 'gemini', 'ollama', 'deepseek', 'pin-anthropic-compat', 'pin-openai-compat']) {
      assert.ok(f.has(name), `${name} is listed`)
      assert.equal(f.get(name), false, name)
    }
  })
})
