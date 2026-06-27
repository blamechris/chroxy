import { Alert, Linking } from 'react-native';
import { openURL } from '../MarkdownRenderer';

/**
 * #6447 — markdown links come from the server (Claude responses / tool output),
 * which a malicious server or MITM could inject. openURL must confirm + show the
 * full destination URL before navigating, not open silently.
 */
describe('MarkdownRenderer openURL link confirmation (#6447)', () => {
  beforeEach(() => {
    jest.clearAllMocks(); // RN mocks Linking.openURL as a shared jest.fn — clear leaked calls
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('confirms with the full URL before opening; opens only on the Open action', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const openSpy = jest.spyOn(Linking, 'openURL').mockImplementation(() => Promise.resolve());

    openURL('http://evil.example.com/phish');

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled(); // not opened until the user confirms
    const call = alertSpy.mock.calls[0] as unknown as [string, string, Array<{ text: string; onPress?: () => void }>];
    expect(call[0]).toMatch(/open link/i);
    expect(call[1]).toBe('http://evil.example.com/phish'); // full URL shown for phishing-spotting

    call[2].find((b) => b.text === 'Open')?.onPress?.();
    expect(openSpy).toHaveBeenCalledWith('http://evil.example.com/phish');
  });

  it('strips trailing punctuation before confirming', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    openURL('https://example.com/page).');
    expect((alertSpy.mock.calls[0] as unknown[])[1]).toBe('https://example.com/page');
  });

  it('rejects a non-http(s) scheme without prompting or opening', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const openSpy = jest.spyOn(Linking, 'openURL').mockImplementation(() => Promise.resolve());
    openURL('javascript:alert(1)');
    expect(alertSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });
});
