import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  Linking,
  LayoutAnimation,
} from 'react-native';
import { ChatMessage } from '../store/types';
import { ICON_CHECK, ICON_CLOSE } from '../constants/icons';
import { COLORS } from '../constants/colors';
import { tokenize, SYNTAX_COLORS, Token } from '../utils/syntax';

// ---------------------------------------------------------------------------
// Syntax-highlighted code block
// ---------------------------------------------------------------------------

const MAX_CODE_PREVIEW = 500;

export function SyntaxHighlightedCode({
  code,
  language,
  maxLines,
}: {
  code: string;
  language: string;
  maxLines?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = code.split('\n');
  const limit = maxLines ?? 10;
  const needsTruncation = !expanded && lines.length > limit;
  const displayCode = needsTruncation ? lines.slice(0, limit).join('\n') : code;

  const tokens = tokenize(displayCode, language);

  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={styles.permDetailCode}>
          {tokens.map((t: Token, i: number) => (
            <Text key={i} style={{ color: SYNTAX_COLORS[t.type] }}>{t.text}</Text>
          ))}
        </Text>
      </ScrollView>
      {needsTruncation && (
        <TouchableOpacity
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setExpanded(true);
          }}
          style={styles.showMoreLink}
          accessibilityRole="button"
        >
          <Text style={styles.showMoreText}>Show all ({lines.length} lines)</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Inline diff (old_string -> new_string)
// ---------------------------------------------------------------------------

const MAX_DIFF_LINES = 20;

function InlineDiff({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const [expanded, setExpanded] = useState(false);
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const totalLines = oldLines.length + newLines.length;
  const needsTruncation = !expanded && totalLines > MAX_DIFF_LINES;

  // When truncated, show proportional lines from each side
  const maxOld = needsTruncation ? Math.max(1, Math.floor(MAX_DIFF_LINES * oldLines.length / totalLines)) : oldLines.length;
  const maxNew = needsTruncation ? Math.max(1, MAX_DIFF_LINES - maxOld) : newLines.length;
  const displayOld = oldLines.slice(0, maxOld);
  const displayNew = newLines.slice(0, maxNew);

  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          {displayOld.map((line, i) => (
            <Text key={`r${i}`} style={styles.lineRemoved} selectable>
              <Text style={styles.linePrefix}>-</Text>
              {line}
            </Text>
          ))}
          {displayNew.map((line, i) => (
            <Text key={`a${i}`} style={styles.lineAdded} selectable>
              <Text style={styles.linePrefix}>+</Text>
              {line}
            </Text>
          ))}
        </View>
      </ScrollView>
      {needsTruncation && (
        <TouchableOpacity
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setExpanded(true);
          }}
          style={styles.showMoreLink}
          accessibilityRole="button"
        >
          <Text style={styles.showMoreText}>Show all ({totalLines} lines)</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Helper: guess language from file extension
// ---------------------------------------------------------------------------

export function langFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  // Common mappings; getLanguage handles aliases internally
  return ext;
}

// ---------------------------------------------------------------------------
// Permission detail renderer
// ---------------------------------------------------------------------------

export function renderPermissionDetail(tool?: string, toolInput?: Record<string, unknown>): React.ReactElement | null {
  if (!toolInput || !tool) return null;

  const toolName = tool.toLowerCase();

  // Bash: syntax-highlighted command
  if (toolName === 'bash' && typeof toolInput.command === 'string') {
    return (
      <View style={styles.permDetailBlock}>
        <Text style={styles.permDetailLabel}>Command</Text>
        <SyntaxHighlightedCode code={toolInput.command} language="bash" maxLines={8} />
      </View>
    );
  }

  // Edit: file path + inline diff (old_string -> new_string)
  if (toolName === 'edit' && typeof toolInput.file_path === 'string') {
    const oldStr = typeof toolInput.old_string === 'string' ? toolInput.old_string : null;
    const newStr = typeof toolInput.new_string === 'string' ? toolInput.new_string : null;
    return (
      <View style={styles.permDetailBlock}>
        <Text style={styles.permDetailLabel}>File</Text>
        <Text selectable style={styles.permDetailCode}>{toolInput.file_path}</Text>
        {oldStr && newStr ? (
          <>
            <Text style={[styles.permDetailLabel, { marginTop: 6 }]}>Changes</Text>
            <InlineDiff oldStr={oldStr} newStr={newStr} />
          </>
        ) : newStr ? (
          <>
            <Text style={[styles.permDetailLabel, { marginTop: 6 }]}>New Content</Text>
            <SyntaxHighlightedCode
              code={newStr.slice(0, MAX_CODE_PREVIEW)}
              language={langFromPath(toolInput.file_path)}
              maxLines={6}
            />
          </>
        ) : null}
      </View>
    );
  }

  // Write: file path + content preview with syntax highlighting
  if (toolName === 'write' && typeof toolInput.file_path === 'string') {
    const content = typeof toolInput.content === 'string' ? toolInput.content : null;
    return (
      <View style={styles.permDetailBlock}>
        <Text style={styles.permDetailLabel}>File</Text>
        <Text selectable style={styles.permDetailCode}>{toolInput.file_path}</Text>
        {content && (
          <>
            <Text style={[styles.permDetailLabel, { marginTop: 6 }]}>Content</Text>
            <SyntaxHighlightedCode
              code={content.slice(0, MAX_CODE_PREVIEW)}
              language={langFromPath(toolInput.file_path)}
              maxLines={10}
            />
          </>
        )}
      </View>
    );
  }

  // NotebookEdit: notebook path + cell number + source preview
  if (toolName === 'notebookedit') {
    const nbPath = typeof toolInput.notebook_path === 'string' ? toolInput.notebook_path : null;
    const cellNum = toolInput.cell_number;
    const newSource = typeof toolInput.new_source === 'string' ? toolInput.new_source : null;
    return (
      <View style={styles.permDetailBlock}>
        {nbPath && (
          <>
            <Text style={styles.permDetailLabel}>Notebook</Text>
            <Text selectable style={styles.permDetailCode}>{nbPath}</Text>
          </>
        )}
        {cellNum != null && (
          <Text style={[styles.permDetailLabel, { marginTop: 6 }]}>Cell #{String(cellNum)}</Text>
        )}
        {newSource && (
          <>
            <Text style={[styles.permDetailLabel, { marginTop: 6 }]}>Source</Text>
            <SyntaxHighlightedCode code={newSource} language="python" maxLines={10} />
          </>
        )}
      </View>
    );
  }

  // WebFetch: URL + prompt
  if (toolName === 'webfetch') {
    const url = typeof toolInput.url === 'string' ? toolInput.url : null;
    const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : null;
    return (
      <View style={styles.permDetailBlock}>
        {url && (
          <>
            <Text style={styles.permDetailLabel}>URL</Text>
            <TouchableOpacity onPress={() => void Linking.openURL(url).catch(() => {})} accessibilityRole="link">
              <Text selectable style={[styles.permDetailCode, styles.linkText]}>{url}</Text>
            </TouchableOpacity>
          </>
        )}
        {prompt && (
          <>
            <Text style={[styles.permDetailLabel, { marginTop: 6 }]}>Prompt</Text>
            <Text selectable style={styles.permDetailCode}>{prompt}</Text>
          </>
        )}
      </View>
    );
  }

  // WebSearch: query + domain filters
  if (toolName === 'websearch') {
    const query = typeof toolInput.query === 'string' ? toolInput.query : null;
    const allowed = Array.isArray(toolInput.allowed_domains) ? toolInput.allowed_domains : null;
    const blocked = Array.isArray(toolInput.blocked_domains) ? toolInput.blocked_domains : null;
    return (
      <View style={styles.permDetailBlock}>
        {query && (
          <>
            <Text style={styles.permDetailLabel}>Query</Text>
            <Text selectable style={styles.permDetailCode}>{query}</Text>
          </>
        )}
        {allowed && (
          <>
            <Text style={[styles.permDetailLabel, { marginTop: 6 }]}>Allowed Domains</Text>
            <Text selectable style={styles.permDetailCode}>{allowed.join(', ')}</Text>
          </>
        )}
        {blocked && (
          <>
            <Text style={[styles.permDetailLabel, { marginTop: 6 }]}>Blocked Domains</Text>
            <Text selectable style={styles.permDetailCode}>{blocked.join(', ')}</Text>
          </>
        )}
      </View>
    );
  }

  // Task (subagent): show prompt
  if (toolName === 'task') {
    const prompt = typeof toolInput.prompt === 'string'
      ? toolInput.prompt
      : typeof toolInput.description === 'string'
        ? toolInput.description
        : null;
    return (
      <View style={styles.permDetailBlock}>
        <Text style={styles.permDetailLabel}>Task Prompt</Text>
        <Text selectable style={styles.permDetailCode} numberOfLines={8}>
          {prompt ? prompt.slice(0, MAX_CODE_PREVIEW) : JSON.stringify(toolInput, null, 2).slice(0, MAX_CODE_PREVIEW)}
        </Text>
      </View>
    );
  }

  // Read/Glob/Grep: show path or pattern with correct label
  if (toolName === 'read' || toolName === 'glob' || toolName === 'grep') {
    let target: string | null = null;
    let label = 'Path';
    if (typeof toolInput.file_path === 'string') {
      target = toolInput.file_path;
    } else if (typeof toolInput.pattern === 'string') {
      target = toolInput.pattern;
      label = 'Pattern';
    } else if (typeof toolInput.path === 'string') {
      target = toolInput.path;
    }
    if (target) {
      return (
        <View style={styles.permDetailBlock}>
          <Text style={styles.permDetailLabel}>{label}</Text>
          <Text selectable style={styles.permDetailCode}>{target}</Text>
        </View>
      );
    }
  }

  // Fallback: description or JSON dump of input
  const desc = typeof toolInput.description === 'string' ? toolInput.description : null;
  if (desc) {
    return (
      <View style={styles.permDetailBlock}>
        <Text selectable style={styles.permDetailCode}>{desc}</Text>
      </View>
    );
  }

  // Last resort: formatted JSON of the tool input
  const jsonStr = JSON.stringify(toolInput, null, 2);
  if (jsonStr && jsonStr !== '{}') {
    return (
      <View style={styles.permDetailBlock}>
        <Text style={styles.permDetailLabel}>Input</Text>
        <SyntaxHighlightedCode code={jsonStr.slice(0, MAX_CODE_PREVIEW)} language="json" maxLines={8} />
      </View>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// PermissionDetailOrFallback
// ---------------------------------------------------------------------------

export function PermissionDetailOrFallback({
  tool,
  toolInput,
  fallback,
}: {
  tool?: string;
  toolInput?: Record<string, unknown>;
  fallback: string;
}) {
  const detail = renderPermissionDetail(tool, toolInput);
  if (detail) return detail;
  return <Text selectable style={styles.messageText}>{fallback}</Text>;
}

// ---------------------------------------------------------------------------
// Permission countdown timer
// ---------------------------------------------------------------------------

export function PermissionCountdown({
  expiresAt,
  onExpire,
}: {
  expiresAt: number;
  onExpire?: () => void;
}) {
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    const initial = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    setRemaining(initial);
    if (initial <= 0) return;
    const id = setInterval(() => {
      const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) {
        clearInterval(id);
        onExpireRef.current?.();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (remaining <= 0) {
    return <Text style={styles.countdownExpired} accessibilityRole="timer">Timed out</Text>;
  }

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const label = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  const isUrgent = remaining <= 30;

  return (
    <Text
      style={[styles.countdownText, isUrgent && styles.countdownUrgent]}
      accessibilityRole="timer"
      accessibilityLabel={`Permission expires in ${minutes} minutes ${seconds} seconds`}
      accessibilityLiveRegion="polite"
    >
      {label}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Permission summary for compact pill / history list
// ---------------------------------------------------------------------------

export function getPermissionSummary(tool?: string, toolInput?: Record<string, unknown>): string {
  if (!tool) return 'Permission';
  const name = tool.toLowerCase();

  if (name === 'bash' && typeof toolInput?.command === 'string') {
    const cmd = toolInput.command.length > 40
      ? toolInput.command.slice(0, 40) + '...'
      : toolInput.command;
    return `Bash(${cmd})`;
  }
  if ((name === 'edit' || name === 'write' || name === 'read') && typeof toolInput?.file_path === 'string') {
    const parts = (toolInput.file_path as string).split('/');
    return `${tool}(${parts[parts.length - 1]})`;
  }
  if ((name === 'glob' || name === 'grep') && typeof toolInput?.pattern === 'string') {
    return `${tool}(${toolInput.pattern})`;
  }
  if (name === 'notebookedit') {
    const cell = toolInput?.cell_number;
    return cell != null ? `NotebookEdit(cell #${cell})` : 'NotebookEdit';
  }
  if (name === 'webfetch' && typeof toolInput?.url === 'string') {
    try {
      const domain = new URL(toolInput.url as string).hostname;
      return `WebFetch(${domain})`;
    } catch {
      return 'WebFetch';
    }
  }
  if (name === 'websearch' && typeof toolInput?.query === 'string') {
    const q = (toolInput.query as string).length > 30
      ? (toolInput.query as string).slice(0, 30) + '...'
      : toolInput.query as string;
    return `WebSearch(${q})`;
  }
  if (name === 'task') {
    const prompt = typeof toolInput?.prompt === 'string'
      ? toolInput.prompt as string
      : typeof toolInput?.description === 'string'
        ? toolInput.description as string
        : null;
    if (prompt) {
      const preview = prompt.length > 30 ? prompt.slice(0, 30) + '...' : prompt;
      return `Task(${preview})`;
    }
    return 'Task';
  }
  return tool;
}

// ---------------------------------------------------------------------------
// PermissionPill — compact collapsed view for answered prompts
// ---------------------------------------------------------------------------

export function PermissionPill({
  message,
  onExpand,
}: {
  message: ChatMessage;
  onExpand: () => void;
}) {
  const answer = message.answered || '';
  const isDenied = answer === 'deny';
  // Anything that isn't an explicit deny is shown as "Allowed" (#3078).
  // History-replay marks unresolved-on-replay prompts with the opaque value
  // '(resolved)' so the prompt collapses into a pill; treating that value as
  // "Allowed" keeps the label consistent with the live `permission_resolved`
  // path (decision: 'allow' | 'allowAlways' | 'allowSession') and matches the
  // dashboard's PermissionPrompt behavior. Without this, a single missed
  // permission_resolved during reconnect produces a stray "Resolved" pill in
  // a sequence that otherwise reads as "Allowed".
  const isAllowed = !isDenied;
  const summary = getPermissionSummary(message.tool, message.toolInput);

  const pillStyle = isAllowed ? styles.permissionPillAllowed : styles.permissionPillDenied;
  const textStyle = isAllowed ? styles.permissionPillTextAllowed : styles.permissionPillTextDenied;
  const icon = isAllowed ? ICON_CHECK : ICON_CLOSE;
  const statusLabel = isAllowed ? 'Allowed' : 'Denied';

  return (
    <TouchableOpacity
      onPress={onExpand}
      activeOpacity={0.7}
      style={[styles.permissionPill, pillStyle]}
      accessibilityRole="button"
      accessibilityLabel={`${statusLabel}: ${summary}. Tap to expand.`}
    >
      <Text style={textStyle}>{icon} {statusLabel}: {summary}</Text>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
  // Permission detail block
  permDetailBlock: {
    marginTop: 4,
  },
  permDetailLabel: {
    color: COLORS.accentOrange,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
  },
  permDetailCode: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontFamily: monoFont,
    backgroundColor: COLORS.backgroundTertiary,
    padding: 8,
    borderRadius: 6,
    overflow: 'hidden',
  },
  messageText: {
    color: COLORS.textPrimary,
    fontSize: 15,
    lineHeight: 22,
  },
  linkText: {
    color: COLORS.accentBlue,
    textDecorationLine: 'underline',
  },

  // Inline diff
  lineAdded: {
    color: COLORS.accentGreen,
    fontSize: 12,
    fontFamily: monoFont,
    lineHeight: 18,
    paddingHorizontal: 4,
    backgroundColor: COLORS.diffAddBackground,
  },
  lineRemoved: {
    color: COLORS.accentRed,
    fontSize: 12,
    fontFamily: monoFont,
    lineHeight: 18,
    paddingHorizontal: 4,
    backgroundColor: COLORS.diffRemoveBackground,
  },
  linePrefix: {
    fontWeight: '700',
  },

  // Expand/collapse
  showMoreLink: {
    marginTop: 4,
    minHeight: 44,
    justifyContent: 'center',
  },
  showMoreText: {
    color: COLORS.accentBlue,
    fontSize: 12,
    fontWeight: '600',
  },

  // Countdown
  countdownText: {
    color: COLORS.accentOrange,
    fontSize: 12,
    fontFamily: monoFont,
  },
  countdownUrgent: {
    color: COLORS.accentRed,
    fontWeight: 'bold',
  },
  countdownExpired: {
    color: COLORS.accentRed,
    fontSize: 12,
  },

  // Permission pill
  permissionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    marginBottom: 8,
    minHeight: 44,
    alignSelf: 'flex-start',
    borderWidth: 1,
  },
  permissionPillAllowed: {
    backgroundColor: COLORS.accentGreenLight,
    borderColor: COLORS.accentGreenBorder,
  },
  permissionPillDenied: {
    backgroundColor: COLORS.accentRedLight,
    borderColor: COLORS.accentRedBorder,
  },
  permissionPillTextAllowed: {
    color: COLORS.accentGreen,
    fontSize: 13,
    fontWeight: '600',
  },
  permissionPillTextDenied: {
    color: COLORS.accentRed,
    fontSize: 13,
    fontWeight: '600',
  },

  // Collapse link (used by ChatView for expanded pill)
  collapseLink: {
    marginTop: 8,
    alignSelf: 'flex-end',
    minHeight: 44,
    justifyContent: 'center',
  },
  collapseLinkText: {
    color: COLORS.textMuted,
    fontSize: 12,
  },

  // Info note
  permissionInfoNote: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
    marginTop: 8,
  },
});

// Re-export style references needed by ChatView for the expanded pill
export const permissionStyles = styles;
