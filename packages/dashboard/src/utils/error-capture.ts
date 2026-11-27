/**
 * #9235 — window-level error capture for the Diagnostics history.
 *
 * Installed once from main.tsx before the React root is created, so an error thrown during
 * the first render, in a timer or in a rejected promise is recorded. Render errors are
 * recorded by the ErrorBoundary instead (they carry a component stack). Standalone: no store.
 */
import { classifyErrorMessage } from './error-report'
import { recordDashboardError } from './error-history'

/** Register the listeners. Returns a function that removes them. */
export function installErrorCapture(target: Window = window): () => void {
  const onError = (event: ErrorEvent): void => {
    try {
      // A ResizeObserver loop notification arrives with no Error object, only a message.
      if (!(event.error instanceof Error) && typeof event.message === 'string'
        && classifyErrorMessage('Error', event.message).template === 'resize-observer-loop') return
      recordDashboardError({ category: 'window-error', error: event.error })
    } catch {
      // never let the capture path be a second failure
    }
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    try {
      recordDashboardError({ category: 'unhandled-rejection', error: event.reason })
    } catch {
      // see above
    }
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
