/**
 * ConnectionAnnouncer (#5581) — mobile parity for the dashboard's
 * connection-phase live region.
 *
 * Renders nothing; it simply drives `useConnectionAnnouncer`, which pushes
 * debounced settled-phase changes through `AccessibilityInfo`. Mount it once
 * at the app level so a single announcer exists regardless of which screen is
 * focused (see `App.tsx`).
 */
import {
  useConnectionAnnouncer,
  type UseConnectionAnnouncerOptions,
} from '../hooks/useConnectionAnnouncer';

export function ConnectionAnnouncer(
  props: UseConnectionAnnouncerOptions = {},
): null {
  useConnectionAnnouncer(props);
  return null;
}
