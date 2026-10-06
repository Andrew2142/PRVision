import { TestBed } from '@angular/core/testing';
import { StatusPillComponent } from './status-pill.component';
import { type PillKind, STATUS_PILL_MAP } from './status-pill.config';

describe('StatusPillComponent', () => {
  function render(inputs: Record<string, unknown>): HTMLElement {
    const fixture = TestBed.createComponent(StatusPillComponent);
    for (const [key, value] of Object.entries(inputs)) fixture.componentRef.setInput(key, value);
    fixture.detectChanges();
    const pill = (fixture.nativeElement as HTMLElement).querySelector('span');
    if (!pill) throw new Error('pill not rendered');
    return pill;
  }

  it('maps every kind/value to its dd-pill tone and label', () => {
    for (const [kind, table] of Object.entries(STATUS_PILL_MAP) as [PillKind, (typeof STATUS_PILL_MAP)[PillKind]][]) {
      for (const [value, spec] of Object.entries(table)) {
        const pill = render({ kind, value });
        expect(pill.className).withContext(`${kind}/${value}`).toBe(`dd-pill dd-pill--${spec.tone}`);
        expect(pill.textContent?.trim()).withContext(`${kind}/${value}`).toBe(spec.label);
      }
    }
  });

  it('live statuses render pulse dot', () => {
    expect(render({ kind: 'visualization', value: 'rendering' }).querySelector('.dd-pill__dot--pulse')).not.toBeNull();
    expect(render({ kind: 'visualization', value: 'completed' }).querySelector('.dd-pill__dot')).toBeNull();
  });

  it('unknown value → muted + title-cased label', () => {
    const pill = render({ kind: 'visualization', value: 'brand_new_state' });
    expect(pill.className).toBe('dd-pill dd-pill--muted');
    expect(pill.textContent?.trim()).toBe('Brand New State');
    expect(render({ kind: 'risk', value: null }).textContent?.trim()).toBe('—');
  });

  it('label override', () => {
    expect(render({ kind: 'source', value: 'github_pr', label: 'PR #42' }).textContent?.trim()).toBe('PR #42');
  });

  it('ariaPrefix builds aria-label', () => {
    expect(render({ kind: 'visualization', value: 'rendering', ariaPrefix: 'Status' }).getAttribute('aria-label')).toBe(
      'Status: Rendering',
    );
    expect(render({ kind: 'visualization', value: 'rendering' }).hasAttribute('aria-label')).toBeFalse();
  });
});
