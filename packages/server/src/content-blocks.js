/**
 * Build a multimodal content array from prompt text and optional attachments.
 *
 * Used by both CliSession and SdkSession to construct the content blocks
 * sent to Claude Code via stream-json NDJSON or the Agent SDK.
 *
 * Each attachment has { type, mediaType, data (base64), name }.
 *
 * @param {string} prompt - Text prompt (may be empty)
 * @param {Array} [attachments] - Optional array of attachment objects
 * @returns {Array} Content blocks array
 */
export function buildContentBlocks(prompt, attachments) {
  const content = []
  if (prompt) {
    content.push({ type: 'text', text: prompt })
  }
  if (attachments?.length) {
    for (const att of attachments) {
      if (att.type === 'image') {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: att.mediaType, data: att.data },
        })
      } else if (att.mediaType === 'application/pdf') {
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: att.mediaType, data: att.data },
        })
      } else {
        // Text-based files: decode base64 and inline as text
        const text = Buffer.from(att.data, 'base64').toString('utf-8')
        content.push({ type: 'text', text: `--- ${att.name} ---\n${text}` })
      }
    }
  }
  // Ensure at least one content block
  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }
  return content
}
