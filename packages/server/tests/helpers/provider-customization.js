/** Conservative customization contract for synthetic provider fixtures. */
export function getUnknownCustomization() {
  return {
    nativeDiscovery: {
      state: false,
      files: [],
      delivery: 'none',
      precedence: 'none',
    },
    chroxyChannels: [],
    nativeSkills: 'unknown',
    runtimeToggles: 'unknown',
    toolConstraints: 'unknown',
    policyDecisions: 'unknown',
    memoryProjection: 'unknown',
    mcp: { discovery: 'unknown', toolCalls: 'unknown' },
    byteBudgets: {
      nativeDocuments: 'unknown',
      chroxySkills: 'unknown',
      projectInstructions: 'unknown',
    },
    egress: 'unknown',
  }
}

export function declareUnknownCustomization(...ProviderClasses) {
  for (const ProviderClass of ProviderClasses) {
    Object.defineProperty(ProviderClass, 'customizationDescriptor', {
      configurable: true,
      value: getUnknownCustomization(),
    })
  }
}
