import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { THEME_STORAGE_KEY, ThemeService } from './theme.service';

describe('ThemeService', () => {
  let service: ThemeService;
  let root: HTMLElement;
  let doc: Document;

  beforeEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    TestBed.configureTestingModule({});
    service = TestBed.inject(ThemeService);
    doc = TestBed.inject(DOCUMENT);
    root = doc.documentElement;
  });

  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    root.classList.remove('shell--tenant-light');
    root.classList.add('shell--tenant-dark');
    root.style.colorScheme = '';
  });

  it('init defaults to dark with empty storage', () => {
    service.init();
    expect(service.mode()).toBe('dark');
    expect(service.isDark()).toBeTrue();
    expect(root.classList).toContain('shell--tenant-dark');
    expect(root.classList).not.toContain('shell--tenant-light');
  });

  it('init reads light', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    service.init();
    expect(service.mode()).toBe('light');
    expect(root.classList).toContain('shell--tenant-light');
  });

  it('invalid stored value → dark', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    service.init();
    expect(service.mode()).toBe('dark');
  });

  it('getItem throwing → dark, no throw', () => {
    spyOn(Storage.prototype, 'getItem').and.throwError('SecurityError');
    expect(() => {
      service.init();
    }).not.toThrow();
    expect(service.mode()).toBe('dark');
  });

  it('setItem throwing → mode still applied', () => {
    spyOn(Storage.prototype, 'setItem').and.throwError('QuotaExceededError');
    expect(() => {
      service.setMode('light');
    }).not.toThrow();
    expect(service.mode()).toBe('light');
    expect(root.classList).toContain('shell--tenant-light');
  });

  it('toggle swaps html classes and color-scheme', () => {
    service.init();
    service.toggle();
    expect(root.classList).toContain('shell--tenant-light');
    expect(root.classList).not.toContain('shell--tenant-dark');
    expect(root.style.colorScheme).toBe('light');
    service.toggle();
    expect(root.classList).toContain('shell--tenant-dark');
    expect(root.style.colorScheme).toBe('dark');
  });

  it('toggle persists under prvision.theme', () => {
    service.init();
    service.toggle();
    expect(localStorage.getItem('prvision.theme')).toBe('light');
    service.toggle();
    expect(localStorage.getItem('prvision.theme')).toBe('dark');
  });

  it('updates meta theme-color', () => {
    service.setMode('light');
    const meta = doc.querySelector<HTMLMetaElement>("meta[name='theme-color']");
    expect(meta?.content).toBe('#466a73');
    service.setMode('dark');
    expect(meta?.content).toBe('#151515');
  });
});
