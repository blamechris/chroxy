/**
 * SessionLoadingSkeleton — shimmer loading placeholder for new/resumed sessions.
 *
 * Shows animated gray rectangles while a session is being created or
 * conversation history is loading from a resume.
 */

export interface SessionLoadingSkeletonProps {
  label?: string
  className?: string
}

export function SessionLoadingSkeleton({
  label = 'Loading session...',
  className,
}: SessionLoadingSkeletonProps) {
  return (
    <div
      className={`session-loading-skeleton${className ? ` ${className}` : ''}`}
      data-testid="session-loading-skeleton"
    >
      <p className="skeleton-label">{label}</p>
      <div className="skeleton-line skeleton-line-wide" />
      <div className="skeleton-line skeleton-line-medium" />
      <div className="skeleton-line skeleton-line-narrow" />
      <div className="skeleton-line skeleton-line-wide" />
      <div className="skeleton-line skeleton-line-medium" />
    </div>
  )
}
