import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PageHeaderComponent } from './page-header.component';

@Component({
  selector: 'app-page-header-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeaderComponent],
  template: `
    <app-page-header title="Repositories" backLink="/repositories" backLabel="Back to repositories">
      <span pageHeaderMeta>meta</span>
      <button pageHeaderActions type="button">Add repository</button>
    </app-page-header>
  `,
})
class HostComponent {}

describe('PageHeaderComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PageHeaderComponent, HostComponent],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('renders title as h1', () => {
    const fixture = TestBed.createComponent(PageHeaderComponent);
    fixture.componentRef.setInput('title', 'Settings');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Settings');
  });

  it('subtitle optional', () => {
    const fixture = TestBed.createComponent(PageHeaderComponent);
    fixture.componentRef.setInput('title', 'Settings');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('p').length).toBe(0);
    fixture.componentRef.setInput('subtitle', 'GitHub and AI');
    fixture.detectChanges();
    expect(el.textContent).toContain('GitHub and AI');
  });

  it('back link renders with aria-label', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const link = (fixture.nativeElement as HTMLElement).querySelector('a');
    expect(link?.getAttribute('aria-label')).toBe('Back to repositories');
    expect(link?.getAttribute('href')).toBe('/repositories');
  });

  it('projects actions slot', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('button')?.textContent).toContain('Add repository');
    expect(el.textContent).toContain('meta');
  });
});
