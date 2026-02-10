import { formatElapsed } from '../../components/SettingsBar';
import { formatTranscript } from '../../screens/SessionScreen';
import type { ChatMessage } from '../../store/connection';

// -- formatElapsed --

describe('formatElapsed', () => {
  it('formats seconds only', () => {
    const now = 1000000;
    expect(formatElapsed(now - 45000, now)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    const now = 1000000;
    expect(formatElapsed(now - 125000, now)).toBe('2m 05s');
  });

  it('handles zero elapsed time', () => {
    const now = 1000000;
    expect(formatElapsed(now, now)).toBe('0s');
  });

  it('pads seconds with leading zero', () => {
    const now = 1000000;
    expect(formatElapsed(now - 63000, now)).toBe('1m 03s');
  });

  it('handles sub-second elapsed (rounds to 0s)', () => {
    const now = 1000000;
    expect(formatElapsed(now - 500, now)).toBe('0s');
  });

  it('clamps negative elapsed to 0s', () => {
    const now = 1000000;
    // startedAt in the future (clock skew)
    expect(formatElapsed(now + 5000, now)).toBe('0s');
  });
});

// -- formatTranscript --

describe('formatTranscript', () => {
  const mkMsg = (overrides: Partial<ChatMessage>): ChatMessage => ({
    id: 'test',
    type: 'response',
    content: 'default',
    timestamp: Date.now(),
    ...overrides,
  });

  it('labels user messages as "You"', () => {
    const result = formatTranscript([mkMsg({ type: 'user_input', content: 'hello' })]);
    expect(result).toBe('[You] hello');
  });

  it('labels tool_use with tool name', () => {
    const result = formatTranscript([mkMsg({ type: 'tool_use', tool: 'Read', content: '/file' })]);
    expect(result).toBe('[Tool: Read] /file');
  });

  it('labels tool_use without tool name as unknown', () => {
    const result = formatTranscript([mkMsg({ type: 'tool_use', content: 'data' })]);
    expect(result).toBe('[Tool: unknown] data');
  });

  it('labels response messages as "Claude"', () => {
    const result = formatTranscript([mkMsg({ type: 'response', content: 'answer' })]);
    expect(result).toBe('[Claude] answer');
  });

  it('filters out thinking messages', () => {
    const messages = [
      mkMsg({ type: 'user_input', content: 'hi' }),
      mkMsg({ type: 'thinking', content: '' }),
      mkMsg({ type: 'response', content: 'hey' }),
    ];
    const result = formatTranscript(messages);
    expect(result).toBe('[You] hi\n\n[Claude] hey');
    expect(result).not.toContain('thinking');
  });

  it('joins messages with double newlines', () => {
    const messages = [
      mkMsg({ type: 'user_input', content: 'a' }),
      mkMsg({ type: 'response', content: 'b' }),
    ];
    expect(formatTranscript(messages)).toBe('[You] a\n\n[Claude] b');
  });

  it('trims content whitespace', () => {
    const result = formatTranscript([mkMsg({ content: '  spaced  ' })]);
    expect(result).toBe('[Claude] spaced');
  });

  it('handles error and system message types', () => {
    const messages = [
      mkMsg({ type: 'error', content: 'oops' }),
      mkMsg({ type: 'system', content: 'info' }),
    ];
    const result = formatTranscript(messages);
    expect(result).toContain('[Error] oops');
    expect(result).toContain('[System] info');
  });
});
