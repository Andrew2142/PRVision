import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { type StructuralChange } from '../../../../core/models/visualization.model';
import { StructuralDiffListComponent } from './structural-diff-list.component';

describe('StructuralDiffListComponent', () => {
  let fixture: ComponentFixture<StructuralDiffListComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [StructuralDiffListComponent] }).compileComponents();
    fixture = TestBed.createComponent(StructuralDiffListComponent);
    el = fixture.nativeElement as HTMLElement;
  });

  function render(changes: StructuralChange[]): HTMLLIElement[] {
    fixture.componentRef.setInput('changes', changes);
    fixture.detectChanges();
    return Array.from(el.querySelectorAll('li'));
  }

  it('one row per kind with correct pill tone and label', () => {
    const rows = render([
      { kind: 'element_added', path: 'div > span:nth-child(2)', tag: 'span' },
      { kind: 'element_removed', path: 'div > p', tag: 'p' },
      { kind: 'attribute_changed', path: 'div > a', tag: 'a', attribute: 'href', before: '/a', after: '/b' },
      { kind: 'text_changed', path: 'div > h2', before: 'Total', after: 'Order total' },
    ]);
    expect(el.textContent).toContain('DOM differences between the base and head renders.');
    const pills = rows.map((r) => r.querySelector('.dd-pill'));
    expect(pills.map((p) => p?.textContent)).toEqual(['Added', 'Removed', 'Attribute', 'Text']);
    expect(pills.map((p) => p?.className)).toEqual([
      'dd-pill dd-pill--success',
      'dd-pill dd-pill--danger',
      'dd-pill dd-pill--info',
      'dd-pill dd-pill--accent',
    ]);
    expect(rows[0]?.textContent).toContain('<span>');
    expect(rows[2]?.textContent).toContain('<a> href');
    expect(rows[2]?.textContent).toContain('− /a');
    expect(rows[2]?.textContent).toContain('+ /b');
    expect(rows[3]?.textContent).toContain('+ Order total');
  });

  it('null attribute values shown as ∅', () => {
    const rows = render([
      { kind: 'attribute_changed', path: 'button', tag: 'button', attribute: 'disabled', before: null, after: '' },
    ]);
    expect(rows[0]?.textContent).toContain('− ∅');
  });

  it('className change with tokensAdded/tokensRemoved shows token chips instead of before/after', () => {
    const rows = render([
      {
        kind: 'attribute_changed',
        path: 'button',
        tag: 'button',
        attribute: 'className',
        before: 'px-4 bg-red-500 rounded',
        after: 'px-4 bg-blue-500 rounded-lg',
        tokensAdded: ['bg-blue-500', 'rounded-lg'],
        tokensRemoved: ['bg-red-500', 'rounded'],
      },
    ]);
    const chips = Array.from(rows[0]?.querySelectorAll('.dd-pill.pv-code') ?? []).map((c) => c.textContent?.trim());
    expect(chips).toEqual(['− bg-red-500', '− rounded', '+ bg-blue-500', '+ rounded-lg']);
    expect(rows[0]?.textContent).not.toContain('px-4 bg-red-500 rounded');
  });

  it('long values truncated with title', () => {
    const long = 'x'.repeat(450);
    const rows = render([{ kind: 'text_changed', path: 'p', before: long, after: 'short' }]);
    const before = rows[0]?.querySelector('p[title]');
    expect(before?.getAttribute('title')).toBe(long);
    expect(before?.textContent?.trim()).toBe(`− ${'x'.repeat(300)}…`);
  });

  it('Show all after 200', () => {
    const many: StructuralChange[] = Array.from({ length: 230 }, (_, i) => ({
      kind: 'element_added',
      path: `div:nth-child(${String(i)})`,
      tag: 'div',
    }));
    expect(render(many).length).toBe(200);
    const button = el.querySelector('button');
    expect(button?.textContent?.trim()).toBe('Show all 230');
    button?.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('li').length).toBe(230);
  });

  it('Angular: template intro and control-flow paths as stored (15 §5.9.1)', () => {
    fixture.componentRef.setInput('framework', 'angular');
    const rows = render([
      { kind: 'element_added', path: 'section > @if', tag: '@if' },
      {
        kind: 'attribute_changed',
        path: 'section > @if > @else > ul > @for > li{key={order.id}} > div[1] > app-badge',
        tag: 'app-badge',
        attribute: '[size]',
        before: null,
        after: "{'lg'}",
      },
    ]);
    expect(el.textContent).toContain('Template differences between the base and head versions of the component.');
    expect(el.textContent).not.toContain('DOM differences');
    expect(rows[0]?.textContent).toContain('<@if>');
    expect(rows[1]?.textContent).toContain('<app-badge> [size]');
    expect(rows[1]?.textContent).toContain('@for > li{key={order.id}}');
  });
});
