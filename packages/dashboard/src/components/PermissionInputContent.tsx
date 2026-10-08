/**
 * The audit-record rendering of `permissionInputParts` (#8505): the safety-relevant
 * flags first, each in its own styled span, then the body. Everything is a TEXT
 * node. The flag is distinguished by weight and the token color together with its
 * literal `key: value` text, never by color alone. The one wrapper span keeps the
 * parts in a single inline flow, so the group line's `-webkit-box` clamp counts
 * them as lines of one block and not as separate stacked boxes.
 */
import { Fragment } from 'react'
import type { PermissionInputParts } from '../utils/permissionInputText'

export function PermissionInputContent({ parts }: { parts: PermissionInputParts }) {
  return (
    <span className="perm-input-text">
      {parts.safetyFlags.map((flag) => (
        <Fragment key={flag}>
          <span className="perm-input-flag" data-testid="perm-input-flag">{flag}</span>
          {'\n'}
        </Fragment>
      ))}
      {parts.body}
    </span>
  )
}
