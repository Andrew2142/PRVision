import { MARKDOWN_MAX_CHARS } from '../../core/constants/ui.constants';
import { MarkdownPipe } from './markdown.pipe';

describe('MarkdownPipe', () => {
  const pipe = new MarkdownPipe();

  function dom(source: string): HTMLElement {
    const div = document.createElement('div');
    div.innerHTML = pipe.transform(source);
    return div;
  }

  it('renders headings, lists, code', () => {
    const el = dom('## Summary\n\n- one\n- two\n\n`inline`\n\n```\nblock()\n```');
    expect(el.querySelector('h2')?.textContent).toBe('Summary');
    expect(el.querySelectorAll('ul li').length).toBe(2);
    expect(el.querySelector('p code')?.textContent).toBe('inline');
    expect(el.querySelector('pre code')?.textContent).toContain('block()');
  });

  it('strips <script>', () => {
    const html = pipe.transform('hello <script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).toContain('hello');
  });

  it('strips onerror/onclick', () => {
    const html = pipe.transform('<p onclick="alert(1)">x</p><a href="https://a.dev" onmouseover="x()">a</a>');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onmouseover');
    expect(pipe.transform('<img src=x onerror="alert(1)">')).not.toContain('onerror');
  });

  it('drops javascript: href', () => {
    const link = dom('[click](javascript:alert(1))').querySelector('a');
    expect(link?.getAttribute('href') ?? null).toBeNull();
  });

  it('drops <img>', () => {
    expect(dom('![alt](https://example.com/x.png)').querySelector('img')).toBeNull();
  });

  it('adds target _blank + rel noopener', () => {
    const link = dom('[docs](https://example.com/docs)').querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/docs');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it("blank → ''", () => {
    expect(pipe.transform(null)).toBe('');
    expect(pipe.transform(undefined)).toBe('');
    expect(pipe.transform('   \n ')).toBe('');
  });

  it('truncates over MARKDOWN_MAX_CHARS', () => {
    const source = `${'a'.repeat(MARKDOWN_MAX_CHARS)}TAIL`;
    const html = pipe.transform(source);
    expect(html).not.toContain('TAIL');
    expect(html).toContain('…');
  });
});
