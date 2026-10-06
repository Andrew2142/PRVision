import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EmptyStateComponent, formatEmptyStateMessage } from './empty-state.component';

@Component({
  selector: 'app-empty-state-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyStateComponent],
  template: `
    <app-empty-state title="No repositories" message="Add a local clone to start.">
      <button emptyStateAction type="button">Add repository</button>
    </app-empty-state>
  `,
})
class HostComponent {}

describe('EmptyStateComponent', () => {
  it('joins title and message with sentence punctuation', () => {
    expect(formatEmptyStateMessage('No data', 'Nothing yet.')).toBe('No data. Nothing yet.');
    expect(formatEmptyStateMessage('Done!', 'Nothing yet.')).toBe('Done! Nothing yet.');
    expect(formatEmptyStateMessage(null, 'Only message')).toBe('Only message');
    expect(formatEmptyStateMessage('Only title', '  ')).toBe('Only title');
    const fixture = TestBed.createComponent(EmptyStateComponent);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent?.trim()).toBe('No data. There is nothing here yet.');
  });

  it('renders action slot', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.dd-grid-empty-state')?.textContent).toContain(
      'No repositories. Add a local clone to start.',
    );
    expect(el.querySelector('button')?.textContent).toContain('Add repository');
  });
});
