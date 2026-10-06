import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';

export type ThemeMode = 'dark' | 'light';
export const THEME_STORAGE_KEY = 'prvision.theme';
const SHELL_CLASS: Record<ThemeMode, string> = { dark: 'shell--tenant-dark', light: 'shell--tenant-light' };
const META_THEME_COLOR: Record<ThemeMode, string> = { dark: '#151515', light: '#466a73' };

/** Dark (default) / light shell. Only the mode is stored in localStorage; the service never throws. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly modeSignal = signal<ThemeMode>('dark');
  readonly mode = this.modeSignal.asReadonly();
  readonly isDark = computed(() => this.modeSignal() === 'dark');

  /** Called once from provideAppInitializer. Reads storage and applies the class before first render. */
  init(): void {
    this.apply(this.readStoredMode());
  }

  toggle(): void {
    this.setMode(this.modeSignal() === 'dark' ? 'light' : 'dark');
  }

  setMode(mode: ThemeMode): void {
    this.apply(mode);
    this.persist(mode);
  }

  private apply(mode: ThemeMode): void {
    const root = this.document.documentElement;
    root.classList.remove(SHELL_CLASS.dark, SHELL_CLASS.light);
    root.classList.add(SHELL_CLASS[mode]);
    root.style.colorScheme = mode;
    this.ensureMetaThemeColor().content = META_THEME_COLOR[mode];
    this.modeSignal.set(mode);
  }

  private readStoredMode(): ThemeMode {
    try {
      return this.document.defaultView?.localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark'; // storage blocked (privacy mode, file://) — fall back silently
    }
  }

  private persist(mode: ThemeMode): void {
    try {
      this.document.defaultView?.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // ignore: the choice still applies for this session
    }
  }

  private ensureMetaThemeColor(): HTMLMetaElement {
    let meta = this.document.querySelector<HTMLMetaElement>("meta[name='theme-color']");
    if (!meta) {
      meta = this.document.createElement('meta');
      meta.name = 'theme-color';
      this.document.head.appendChild(meta);
    }
    return meta;
  }
}
