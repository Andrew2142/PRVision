import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { RouterOutlet } from '@angular/router';
import { BootIntroComponent } from './shared/components/boot-intro/boot-intro.component';
import { GenericPopupComponent, type PopupConfig } from './shared/components/generic-popup/generic-popup.component';

/** The boot intro plays once per browser session. */
export const BOOT_INTRO_SESSION_KEY = 'prvision.bootIntroShown';
/** Bump the version to ask everyone again after the notice changes. */
export const ALPHA_NOTICE_STORAGE_KEY = 'prvision.alphaNotice.v1';

/** Uply's root shell: fixed glow layer behind the routed surface, plus the boot intro and the alpha notice. */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, BootIntroComponent, GenericPopupComponent, MatCheckboxModule],
  host: { class: 'block min-h-full' },
  template: `
    <div class="dd-app-root min-h-full">
      <div class="dd-glow-layer" aria-hidden="true"></div>
      <div class="dd-app-surface relative z-[1] min-h-full">
        <router-outlet />
      </div>
    </div>
    @if (showIntro()) {
      <app-boot-intro (finished)="onIntroFinished()" />
    }
    <app-generic-popup
      [config]="noticeConfig()"
      [shouldShow]="showNotice()"
      [closeOnBackdrop]="false"
      [closeOnEscape]="false"
      (primaryAction)="acceptNotice()"
    >
      <div class="flex flex-col gap-4 text-sm leading-relaxed text-[var(--color-text-secondary)]">
        <p>
          PRVision is <span class="font-semibold text-[var(--color-text-primary)]">alpha software</span>. Expect rough
          edges, missing features and the occasional broken render.
        </p>
        <p>
          Claude writes the render harnesses and the review summaries.
          <span class="font-semibold text-[var(--color-text-primary)]">AI can make mistakes</span>: a screenshot or
          summary can be wrong or miss a change, so check important results in the code itself.
        </p>
        <mat-checkbox [checked]="noticeChecked()" (change)="noticeChecked.set($event.checked)">
          I understand and agree
        </mat-checkbox>
      </div>
    </app-generic-popup>
  `,
})
export class AppComponent {
  private readonly window = inject(DOCUMENT).defaultView;

  protected readonly showIntro = signal(!this.readFlag('session', BOOT_INTRO_SESSION_KEY));
  protected readonly showNotice = signal(!this.showIntro() && !this.readFlag('local', ALPHA_NOTICE_STORAGE_KEY));
  protected readonly noticeChecked = signal(false);
  protected readonly noticeConfig = computed<PopupConfig>(() => ({
    title: 'Before you start',
    icon: 'science',
    width: '480px',
    showCloseButton: false,
    showFooter: true,
    primaryButtonText: 'Continue',
    primaryButtonDisabled: !this.noticeChecked(),
    blurBackdrop: true,
  }));

  protected onIntroFinished(): void {
    this.writeFlag('session', BOOT_INTRO_SESSION_KEY);
    this.showIntro.set(false);
    this.showNotice.set(!this.readFlag('local', ALPHA_NOTICE_STORAGE_KEY));
  }

  protected acceptNotice(): void {
    if (!this.noticeChecked()) return;
    this.writeFlag('local', ALPHA_NOTICE_STORAGE_KEY);
    this.showNotice.set(false);
  }

  /** Storage can be missing or throw (private mode); then the intro and notice simply show again next time. */
  private readFlag(kind: 'session' | 'local', key: string): boolean {
    try {
      const storage = kind === 'session' ? this.window?.sessionStorage : this.window?.localStorage;
      return storage?.getItem(key) === '1';
    } catch {
      return false;
    }
  }

  private writeFlag(kind: 'session' | 'local', key: string): void {
    try {
      const storage = kind === 'session' ? this.window?.sessionStorage : this.window?.localStorage;
      storage?.setItem(key, '1');
    } catch {
      // Not persisted: the intro or notice shows again next time.
    }
  }
}
