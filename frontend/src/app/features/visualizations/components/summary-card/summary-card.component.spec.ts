import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { type VisualizationStatus } from '../../../../core/models/domain-enums.model';
import { SummaryCardComponent } from './summary-card.component';

describe('SummaryCardComponent', () => {
  let fixture: ComponentFixture<SummaryCardComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [SummaryCardComponent] }).compileComponents();
    fixture = TestBed.createComponent(SummaryCardComponent);
    el = fixture.nativeElement as HTMLElement;
  });

  function render(markdown: string | null, status: VisualizationStatus): void {
    fixture.componentRef.setInput('markdown', markdown);
    fixture.componentRef.setInput('status', status);
    fixture.componentRef.setInput('aiModel', 'claude-opus-5-5');
    fixture.detectChanges();
  }

  it('renders markdown headings/lists', () => {
    render('## What changed\n\n- CartSummary total now wraps\n- `Badge` colour\n', 'completed');
    const prose = el.querySelector('.pv-prose');
    expect(prose?.querySelector('h2')?.textContent).toBe('What changed');
    expect(prose?.querySelectorAll('li').length).toBe(2);
    expect(prose?.querySelector('code')?.textContent).toBe('Badge');
    expect(el.textContent).toContain(
      'Written by AI (claude-opus-5-5), which can make mistakes. Check it against the screenshots.',
    );
  });

  it('fixed no-changes summary has no AI label or disclaimer', () => {
    fixture.componentRef.setInput('byAi', false);
    render('PRVision rendered 2 component(s) and found no visual differences.', 'completed');
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Summary');
    expect(el.textContent).not.toContain('AI-generated');
    expect(el.textContent).not.toContain('Written by AI');
  });

  it('strips script and img from summary', () => {
    render('Hello <img src=x onerror="alert(1)"> <script>alert(2)</script> **bold**', 'completed');
    const prose = el.querySelector('.pv-prose');
    expect(prose?.querySelector('img')).toBeNull();
    expect(prose?.querySelector('script')).toBeNull();
    expect(prose?.innerHTML).not.toContain('onerror');
    expect(prose?.querySelector('strong')?.textContent).toBe('bold');
  });

  it('skeleton while running and null', () => {
    render(null, 'rendering');
    expect(el.querySelectorAll('.animate-pulse').length).toBe(3);
    expect(el.textContent).toContain('The summary is written after rendering and diffing finish.');
  });

  it('empty copy when completed and null', () => {
    render(null, 'completed');
    expect(el.querySelector('app-empty-state')?.textContent).toContain(
      'The AI did not produce a summary for this run.',
    );
  });

  it('empty copy when failed', () => {
    render(null, 'failed');
    expect(el.querySelector('app-empty-state')?.textContent).toContain('The run stopped before the summary step.');
  });
});
