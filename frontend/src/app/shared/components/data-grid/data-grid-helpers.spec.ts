import {
  escapeHtml,
  extractGridAction,
  renderActionButton,
  renderStackedText,
  renderStatusPillHtml,
} from './data-grid-helpers';

describe('data-grid-helpers', () => {
  it('escapeHtml escapes &<>"\'', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });

  it('renderStatusPillHtml escapes label and uses tone class', () => {
    expect(renderStatusPillHtml('visualization', 'failed')).toBe('<span class="dd-pill dd-pill--danger">Failed</span>');
    const html = renderStatusPillHtml('source', 'github_pr', '<b>PR</b>');
    expect(html).toContain('dd-pill--info');
    expect(html).toContain('&lt;b&gt;PR&lt;/b&gt;');
    expect(html).not.toContain('<b>');
    expect(renderStatusPillHtml('visualization', 'rendering')).toContain('dd-pill__dot--pulse');
  });

  it('renderStackedText escapes both lines', () => {
    const html = renderStackedText('<img src=x onerror=alert(1)>', 'a & b');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).not.toContain('<img');
    expect(renderStackedText('')).toContain('—');
  });

  it('extractGridAction finds data-grid-action', () => {
    const host = document.createElement('div');
    host.innerHTML = renderActionButton('open', 'Open <now>', 'primary');
    const button = host.querySelector('button');
    expect(button?.textContent).toBe('Open <now>');
    const inner = document.createElement('span');
    button?.appendChild(inner);
    expect(extractGridAction(inner)).toBe('open');
    expect(extractGridAction(new MouseEvent('click'))).toBeNull();
    expect(extractGridAction(host)).toBeNull();
  });
});
