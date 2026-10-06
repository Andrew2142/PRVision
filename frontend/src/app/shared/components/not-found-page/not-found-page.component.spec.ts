import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NotFoundPageComponent } from './not-found-page.component';

describe('NotFoundPageComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NotFoundPageComponent],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('default copy and link', () => {
    const fixture = TestBed.createComponent(NotFoundPageComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Page not found');
    expect(el.textContent).toContain("There's nothing at this address.");
    const link = el.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/repositories');
    expect(link?.textContent?.trim()).toBe('Go to repositories');
  });

  it('keeps defaults when the router binds undefined inputs', () => {
    const fixture = TestBed.createComponent(NotFoundPageComponent);
    fixture.componentRef.setInput('title', undefined);
    fixture.componentRef.setInput('backLink', undefined);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Page not found');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/repositories');
  });

  it('custom inputs', () => {
    const fixture = TestBed.createComponent(NotFoundPageComponent);
    fixture.componentRef.setInput('title', 'Visualization not found');
    fixture.componentRef.setInput('message', 'It may have been removed.');
    fixture.componentRef.setInput('backLink', '/visualizations');
    fixture.componentRef.setInput('backLabel', 'Back to visualizations');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Visualization not found');
    expect(el.textContent).toContain('It may have been removed.');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/visualizations');
    expect(el.querySelector('a')?.textContent?.trim()).toBe('Back to visualizations');
  });
});
