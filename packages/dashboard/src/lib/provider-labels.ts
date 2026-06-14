/**
 * Re-exports from @chroxy/store-core so existing dashboard imports continue
 * to work without path changes.
 */
export {
  PROVIDER_LABELS,
  getProviderLabel,
  getProviderInfo,
  providerSupportsMultiQuestion,
  providerSupportsSingleMultiSelect,
} from '@chroxy/store-core'

export type {
  ProviderType,
  ProviderDisplayInfo,
} from '@chroxy/store-core'
