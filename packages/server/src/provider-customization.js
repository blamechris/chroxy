/** Adapter contracts for the provider-customization seam (#7835). */
import { DEFAULT_MAX_TOTAL_SKILL_BYTES } from './skills-budget.js'

export const PROJECT_INSTRUCTION_BUDGET_BYTES = 96 * 1024

const freezeDescriptor = (descriptor) => Object.freeze({
  ...descriptor,
  nativeDiscovery: Object.freeze({
    ...descriptor.nativeDiscovery,
    files: Object.freeze([...descriptor.nativeDiscovery.files]),
  }),
  chroxyChannels: Object.freeze(descriptor.chroxyChannels.map((channel) => Object.freeze({
    ...channel,
    content: Object.freeze([...channel.content]),
  }))),
  mcp: Object.freeze({ ...descriptor.mcp }),
  byteBudgets: Object.freeze({ ...descriptor.byteBudgets }),
})

const native = (state, files, delivery, precedence) => ({ state, files, delivery, precedence })
const budgets = (projectInstructions = 'unsupported') => ({
  nativeDocuments: 'unknown', chroxySkills: DEFAULT_MAX_TOTAL_SKILL_BYTES, projectInstructions,
})
const promptParts = ['session-preamble', 'context-hint', 'skills']
const skillContent = ['skills']
const NO_NATIVE_DISCOVERY = {
  state: false,
  files: [],
  delivery: 'none',
  precedence: 'none',
}

export const CLAUDE_CLI_CUSTOMIZATION = freezeDescriptor({
  nativeDiscovery: native('unknown', ['CLAUDE.md', 'CLAUDE.local.md'], 'user-message', 'global-project-subtree'),
  chroxyChannels: [
    { channel: 'system-append', lifetime: 'process-start', content: promptParts },
    { channel: 'first-user-turn', lifetime: 'first-turn', content: skillContent },
  ],
  nativeSkills: 'unknown',
  runtimeToggles: false,
  toolConstraints: 'chroxy-runtime',
  policyDecisions: true,
  memoryProjection: 'provider-native',
  mcp: { discovery: true, toolCalls: true },
  byteBudgets: budgets(),
  egress: 'cloud',
})

export const CLAUDE_SDK_CUSTOMIZATION = freezeDescriptor({
  nativeDiscovery: {
    state: true,
    files: ['CLAUDE.md', 'CLAUDE.local.md'],
    delivery: 'user-message',
    precedence: 'global-project-subtree',
  },
  chroxyChannels: [
    { channel: 'system-api', lifetime: 'each-turn', content: promptParts },
    { channel: 'first-user-turn', lifetime: 'first-turn', content: skillContent },
  ],
  nativeSkills: 'unknown',
  runtimeToggles: true,
  toolConstraints: 'chroxy-runtime',
  policyDecisions: true,
  memoryProjection: 'provider-native',
  mcp: { discovery: true, toolCalls: true },
  byteBudgets: budgets(),
  egress: 'cloud',
})

export const CLAUDE_TUI_CUSTOMIZATION = freezeDescriptor({
  nativeDiscovery: native('unknown', ['CLAUDE.md', 'CLAUDE.local.md'], 'user-message', 'global-project-subtree'),
  chroxyChannels: [
    { channel: 'system-append', lifetime: 'process-start', content: skillContent },
  ],
  nativeSkills: 'unknown',
  runtimeToggles: false,
  toolConstraints: 'chroxy-runtime',
  policyDecisions: true,
  memoryProjection: 'provider-native',
  mcp: { discovery: true, toolCalls: true },
  byteBudgets: budgets(),
  egress: 'cloud',
})

export const BYOK_CUSTOMIZATION = freezeDescriptor({
  nativeDiscovery: NO_NATIVE_DISCOVERY,
  chroxyChannels: [
    { channel: 'system-api', lifetime: 'each-turn', content: ['project-instructions', ...promptParts] },
    { channel: 'first-user-turn', lifetime: 'first-turn', content: skillContent },
  ],
  nativeSkills: false,
  runtimeToggles: true,
  toolConstraints: 'chroxy-runtime',
  policyDecisions: true,
  memoryProjection: 'chroxy-history',
  mcp: { discovery: true, toolCalls: true },
  byteBudgets: budgets(PROJECT_INSTRUCTION_BUDGET_BYTES),
  egress: 'cloud',
})

export const CODEX_EXEC_CUSTOMIZATION = freezeDescriptor({
  nativeDiscovery: native('unknown', ['AGENTS.override.md', 'AGENTS.md'], 'unknown', 'global-root-cwd'),
  chroxyChannels: [
    { channel: 'first-user-turn', lifetime: 'first-turn', content: skillContent },
  ],
  nativeSkills: 'unknown',
  runtimeToggles: false,
  toolConstraints: 'provider-runtime',
  policyDecisions: false,
  memoryProjection: 'provider-native',
  mcp: { discovery: 'unknown', toolCalls: 'unknown' },
  byteBudgets: budgets(),
  egress: 'cloud',
})

export const CODEX_APPSERVER_CUSTOMIZATION = freezeDescriptor({
  ...CODEX_EXEC_CUSTOMIZATION,
  policyDecisions: true,
  mcp: { discovery: 'unknown', toolCalls: 'unknown' },
})

export const GEMINI_CUSTOMIZATION = freezeDescriptor({
  nativeDiscovery: native('unknown', ['GEMINI.md'], 'provider-context', 'global-workspace-jit'),
  chroxyChannels: [
    { channel: 'first-user-turn', lifetime: 'first-turn', content: skillContent },
  ],
  nativeSkills: 'unknown',
  runtimeToggles: false,
  toolConstraints: 'provider-runtime',
  policyDecisions: false,
  memoryProjection: 'provider-native',
  mcp: { discovery: 'unknown', toolCalls: 'unknown' },
  byteBudgets: budgets(),
  egress: 'cloud',
})

export const ACP_CUSTOMIZATION = freezeDescriptor({
  nativeDiscovery: native('unknown', ['provider-defined'], 'unknown', 'provider-defined'),
  chroxyChannels: [
    { channel: 'first-user-turn', lifetime: 'first-turn', content: promptParts },
  ],
  nativeSkills: 'unknown',
  runtimeToggles: false,
  toolConstraints: 'chroxy-runtime',
  policyDecisions: false,
  memoryProjection: 'provider-native',
  mcp: { discovery: false, toolCalls: false },
  byteBudgets: budgets(),
  egress: 'unknown',
})

export const CLAUDE_CHANNEL_CUSTOMIZATION = freezeDescriptor({
  nativeDiscovery: native('unknown', ['CLAUDE.md', 'CLAUDE.local.md'], 'user-message', 'global-project-subtree'),
  chroxyChannels: [],
  nativeSkills: 'unknown',
  runtimeToggles: false,
  toolConstraints: 'unknown',
  policyDecisions: 'unknown',
  memoryProjection: 'unknown',
  mcp: { discovery: 'unknown', toolCalls: 'unknown' },
  byteBudgets: budgets(),
  egress: 'cloud',
})

export const USER_SHELL_CUSTOMIZATION = freezeDescriptor({
  nativeDiscovery: NO_NATIVE_DISCOVERY,
  chroxyChannels: [],
  nativeSkills: false,
  runtimeToggles: false,
  toolConstraints: 'none',
  policyDecisions: false,
  memoryProjection: 'none',
  mcp: { discovery: false, toolCalls: false },
  byteBudgets: budgets(),
  egress: 'unknown',
})

export function customizationWithEgress(descriptor, egress) {
  return freezeDescriptor({ ...descriptor, egress })
}
