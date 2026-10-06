import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { type VisualizationStatus } from '../../../../core/models/domain-enums.model';
import { PipelineStepperComponent } from './pipeline-stepper.component';

describe('PipelineStepperComponent', () => {
  let fixture: ComponentFixture<PipelineStepperComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PipelineStepperComponent] }).compileComponents();
    fixture = TestBed.createComponent(PipelineStepperComponent);
  });

  function render(status: VisualizationStatus, stopped = 0): HTMLLIElement[] {
    fixture.componentRef.setInput('status', status);
    fixture.componentRef.setInput('stoppedStageIndex', stopped);
    fixture.detectChanges();
    return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('li'));
  }

  /** The hidden state text of each step, e.g. "(done)". */
  function states(items: HTMLLIElement[]): string[] {
    return items.map((li) => li.querySelector('.sr-only')?.textContent?.trim() ?? '');
  }

  it('rendering: first four done, rendering current (aria-current=step), rest pending', () => {
    const items = render('rendering');
    expect(items.length).toBe(7);
    expect(states(items)).toEqual(['(done)', '(done)', '(done)', '(done)', '(in progress)', '(pending)', '(pending)']);
    expect(items[4]?.getAttribute('aria-current')).toBe('step');
    expect(items.filter((li) => li.hasAttribute('aria-current')).length).toBe(1);
    expect(items[0]?.textContent).toContain('check');
  });

  it('completed: all done', () => {
    expect(states(render('completed')).every((s) => s === '(done)')).toBeTrue();
  });

  it('failed at index 3: 0–2 done, 3 failed, rest pending', () => {
    const items = render('failed', 3);
    expect(states(items)).toEqual([
      '(done)',
      '(done)',
      '(done)',
      '(failed here)',
      '(pending)',
      '(pending)',
      '(pending)',
    ]);
    const circle = items[3]?.querySelector('span');
    expect(circle?.className).toContain('bg-[var(--color-error)]');
    expect(items[3]?.textContent).toContain('close');
    expect(items.some((li) => li.hasAttribute('aria-current'))).toBeFalse();
  });

  it('cancelled marks stop stage cancelled', () => {
    const items = render('cancelled', 4);
    expect(states(items)[4]).toBe('(cancelled here)');
    expect(items[4]?.querySelector('span')?.className).toContain('bg-[var(--color-warning)]');
    expect(items[4]?.textContent).toContain('block');
  });

  it('queued: first current', () => {
    const items = render('queued');
    expect(states(items)[0]).toBe('(in progress)');
    expect(
      states(items)
        .slice(1)
        .every((s) => s === '(pending)'),
    ).toBeTrue();
  });

  it('hidden state text present for each step', () => {
    const items = render('diffing');
    expect(items.every((li) => !!li.querySelector('.sr-only')?.textContent?.trim())).toBeTrue();
    expect((fixture.nativeElement as HTMLElement).querySelector('ol')?.getAttribute('aria-label')).toBe(
      'Pipeline progress',
    );
  });

  it('icons have a line box equal to their size so the glyph sits centred in the circle', () => {
    for (const li of render('completed')) {
      const icon = li.querySelector('mat-icon')!;
      const style = getComputedStyle(icon);
      expect(style.lineHeight).toBe(style.fontSize);
      expect(style.height).toBe(style.fontSize);
    }
  });
});
