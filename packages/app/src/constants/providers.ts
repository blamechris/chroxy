/**
 * Re-exports from @chroxy/store-core so existing app imports continue to work
 * without path changes.
 */
export {
  PROVIDER_LABELS,
  getProviderLabel,
  getProviderInfo,
} from '@chroxy/store-core';

export type {
  ProviderType,
  ProviderInfo,
} from '@chroxy/store-core';
