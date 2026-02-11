import { buildXtermHtml } from '../../components/xterm-html';

describe('buildXtermHtml', () => {
  let html: string;

  beforeAll(() => {
    html = buildXtermHtml();
  });

  it('returns a valid HTML string', () => {
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  it('does not reference any CDN URLs', () => {
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).not.toContain('unpkg.com');
    expect(html).not.toContain('cdnjs.cloudflare.com');
  });

  it('does not contain the CDN error fallback div', () => {
    expect(html).not.toContain('id="error"');
    expect(html).not.toContain('Terminal renderer unavailable');
  });

  it('does not contain the CDN load guard', () => {
    expect(html).not.toContain("typeof Terminal === 'undefined'");
    expect(html).not.toContain("typeof FitAddon === 'undefined'");
  });

  it('inlines xterm.js code', () => {
    // xterm.js source contains Terminal constructor
    expect(html).toContain('new Terminal(');
    // The bundled xterm library code should be present (check for xterm copyright)
    expect(html).toContain('xterm.js authors');
  });

  it('inlines FitAddon code', () => {
    expect(html).toContain('FitAddon');
  });

  it('inlines xterm CSS', () => {
    // xterm.css contains the terminal class styling
    expect(html).toContain('.xterm');
  });

  it('contains the bridge protocol (ready/resize postMessage)', () => {
    expect(html).toContain("type: 'ready'");
    expect(html).toContain("type: 'resize'");
    expect(html).toContain('ReactNativeWebView.postMessage');
  });

  it('has no external stylesheet links', () => {
    expect(html).not.toMatch(/<link[^>]*rel="stylesheet"[^>]*href="http/);
  });

  it('has no external script src tags', () => {
    expect(html).not.toMatch(/<script[^>]*src="http/);
  });
});
