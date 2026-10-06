import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { CodeDiffComponent } from './code-diff.component';

const DIFF = [
  'diff --git a/src/A.tsx b/src/A.tsx',
  '--- a/src/A.tsx',
  '+++ b/src/A.tsx',
  '@@ -1,3 +1,3 @@',
  ' const keep = 1;',
  '-const old = "<script>alert(1)</script>";',
  '+const next = 2;',
].join('\n');

describe('CodeDiffComponent', () => {
  let fixture: ComponentFixture<CodeDiffComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [CodeDiffComponent] }).compileComponents();
    fixture = TestBed.createComponent(CodeDiffComponent);
    el = fixture.nativeElement as HTMLElement;
  });

  function render(diff: string): HTMLElement[] {
    fixture.componentRef.setInput('diff', diff);
    fixture.detectChanges();
    return Array.from(el.querySelectorAll<HTMLElement>('code > span.pv-diff-line'));
  }

  it('applies line classes', () => {
    const rows = render(DIFF);
    expect(rows.map((r) => r.className.replace('pv-diff-line ', ''))).toEqual([
      'pv-diff-line--meta',
      'pv-diff-line--meta',
      'pv-diff-line--meta',
      'pv-diff-line--hunk',
      'pv-diff-line--context',
      'pv-diff-line--del',
      'pv-diff-line--add',
    ]);
    const nums = rows[6]?.querySelectorAll('.pv-diff-line__num');
    expect(nums?.[0]?.textContent).toBe('');
    expect(nums?.[1]?.textContent).toBe('2');
  });

  it('keeps +/- prefix visible', () => {
    const rows = render(DIFF);
    expect(rows[5]?.lastElementChild?.textContent).toBe('-const old = "<script>alert(1)</script>";');
    expect(rows[6]?.lastElementChild?.textContent).toBe('+const next = 2;');
    expect(rows[4]?.lastElementChild?.textContent).toBe(' const keep = 1;');
  });

  it('renders <script> text literally', () => {
    render(DIFF);
    expect(el.querySelector('script')).toBeNull();
    expect(el.textContent).toContain('<script>alert(1)</script>');
  });

  it('limits to 2000 lines with Show all', () => {
    const body = Array.from({ length: 2100 }, (_, i) => `+line ${String(i)}`);
    const rows = render(['@@ -0,0 +1,2100 @@', ...body].join('\n'));
    expect(rows.length).toBe(2000);
    const button = el.querySelector('button');
    expect(button?.textContent?.trim()).toBe('Show all 2101 lines');
    button?.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('code > span.pv-diff-line').length).toBe(2101);
    expect(el.querySelector('button')).toBeNull();
  });
});
