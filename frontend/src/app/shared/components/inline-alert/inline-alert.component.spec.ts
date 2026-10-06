import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { InlineAlertComponent } from './inline-alert.component';

@Component({
  selector: 'app-inline-alert-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InlineAlertComponent],
  template: `
    <app-inline-alert tone="warning" title="GitHub token needed">
      Add a token in Settings.
      <button inlineAlertAction type="button">Retry</button>
    </app-inline-alert>
  `,
})
class HostComponent {}

describe('InlineAlertComponent', () => {
  function roleFor(tone: string): string | null | undefined {
    const fixture = TestBed.createComponent(InlineAlertComponent);
    fixture.componentRef.setInput('tone', tone);
    fixture.detectChanges();
    return (fixture.nativeElement as HTMLElement).querySelector('div')?.getAttribute('role');
  }

  it('error tone has role=alert', () => {
    expect(roleFor('error')).toBe('alert');
  });

  it('other tones role=status', () => {
    expect(roleFor('info')).toBe('status');
    expect(roleFor('success')).toBe('status');
    expect(roleFor('warning')).toBe('status');
  });

  it('renders title and projected action', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('GitHub token needed');
    expect(el.textContent).toContain('Add a token in Settings.');
    expect(el.querySelector('button')?.textContent).toContain('Retry');
    expect(el.querySelector('mat-icon')?.textContent?.trim()).toBe('warning');
  });
});
