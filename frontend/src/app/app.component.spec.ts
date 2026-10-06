import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app.component';

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('renders the glow layer and a router outlet', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const glow = host.querySelector('.dd-glow-layer');
    expect(glow).not.toBeNull();
    expect(glow?.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('.dd-app-surface router-outlet')).not.toBeNull();
  });
});
