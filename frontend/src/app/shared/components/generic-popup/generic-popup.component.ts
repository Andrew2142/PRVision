import { A11yModule } from '@angular/cdk/a11y';
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  type OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

export interface PopupConfig {
  title: string;
  icon?: string;
  width?: string;
  fullscreen?: boolean;
  showCloseButton?: boolean;
  showFooter?: boolean;
  primaryButtonText?: string;
  secondaryButtonText?: string;
  primaryButtonDisabled?: boolean;
  primaryButtonColor?: 'primary' | 'warn';
  loading?: boolean;
  blurBackdrop?: boolean;
}

const POPUP_ANIMATION_MS = 300;
let nextPopupId = 0;
let bodyScrollLockCount = 0;
let previousBodyOverflow = '';
const popupStack: GenericPopupComponent[] = [];

/** Uply's dialog chrome: blurred backdrop, scale/translate transition, focus trap, Escape for the topmost popup. */
@Component({
  selector: 'app-generic-popup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [A11yModule, MatButtonModule, MatIconModule],
  host: { class: 'block', '(document:keydown.escape)': 'onEscape($event)' },
  template: `
    @if (rendered()) {
      <div class="fixed inset-0 z-50 overflow-y-auto">
        <div
          class="absolute inset-0 transition-opacity duration-300"
          aria-hidden="true"
          [class.backdrop-blur-sm]="blurBackdrop()"
          [class.opacity-0]="!isVisible()"
          [class.opacity-60]="isVisible()"
          [class.pointer-events-none]="!isVisible()"
          [class.pointer-events-auto]="isVisible()"
          (click)="onBackdropClick()"
        ></div>

        <div
          class="relative z-10 flex min-h-full w-full"
          [class.items-start]="!fullscreen()"
          [class.justify-center]="!fullscreen()"
          [class.p-4]="!fullscreen()"
          [class.pointer-events-none]="!isVisible()"
          [class.pointer-events-auto]="isVisible()"
        >
          <div
            class="relative transform transition-all duration-300"
            [class.mx-auto]="!fullscreen()"
            [class.w-full]="fullscreen()"
            [class.my-auto]="!fullscreen()"
            [class.h-full]="fullscreen()"
            [class.opacity-0]="!isVisible()"
            [class.opacity-100]="isVisible()"
            [class.scale-95]="!isVisible() && !fullscreen()"
            [class.scale-100]="isVisible() || fullscreen()"
            [class.translate-y-4]="!isVisible() && !fullscreen()"
            [class.translate-y-0]="isVisible() || fullscreen()"
            [style.width]="panelWidth()"
            [style.max-width]="panelMaxWidth()"
            [style.height]="fullscreen() ? '100dvh' : 'auto'"
            [style.max-height]="fullscreen() ? '100dvh' : 'calc(100dvh - 2rem)'"
          >
            <div
              #dialogPanel
              role="dialog"
              aria-modal="true"
              tabindex="-1"
              [cdkTrapFocus]="trapFocus()"
              [cdkTrapFocusAutoCapture]="trapFocus() && isVisible()"
              [attr.aria-labelledby]="titleId"
              class="grid min-h-0 overflow-hidden outline-none border border-[color:var(--color-border)] bg-[var(--color-surface,#fdfeff)] shadow-[var(--shadow-float,var(--shadow-xl,0_24px_48px_rgba(15,23,42,0.18)))]"
              [class.rounded-2xl]="!fullscreen()"
              [class.h-full]="fullscreen()"
              [style.max-height]="fullscreen() ? '100dvh' : 'calc(100dvh - 2rem)'"
              [style.grid-template-rows]="gridRows()"
            >
              <div class="border-b border-[color:var(--color-border)] px-6 py-4">
                <div class="flex items-center justify-between gap-4">
                  <div class="flex min-w-0 flex-1 items-center gap-3">
                    @if (config().icon) {
                      <div
                        class="flex h-10 w-10 items-center justify-center rounded-full bg-[color:var(--shell-accent-soft)]"
                      >
                        <mat-icon class="text-[var(--shell-accent)]" aria-hidden="true">{{ config().icon }}</mat-icon>
                      </div>
                    }
                    <div class="min-w-0 flex-1">
                      <h3 [id]="titleId" class="truncate text-lg font-semibold text-[var(--color-text-primary)]">
                        {{ config().title }}
                      </h3>
                    </div>
                    <ng-content select="[slot=header-extra]" />
                  </div>
                  @if (showCloseButton()) {
                    <button
                      type="button"
                      (click)="onClose()"
                      class="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-full text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--shell-accent-soft)] hover:text-[var(--color-text-primary)]"
                      aria-label="Close popup"
                    >
                      <mat-icon class="!m-0 !h-5 !w-5 !text-[20px] !leading-5" aria-hidden="true">close</mat-icon>
                    </button>
                  }
                </div>
              </div>

              <div class="min-h-0 overflow-y-auto px-6 py-6 overscroll-contain">
                <ng-content />
              </div>

              @if (showFooter()) {
                <div class="border-t border-[color:var(--color-border)] px-6 py-4">
                  <div class="flex flex-wrap gap-3">
                    @if (config().secondaryButtonText) {
                      <button mat-stroked-button type="button" (click)="onSecondaryAction()" class="flex-1 !rounded-xl">
                        {{ config().secondaryButtonText }}
                      </button>
                    }
                    @if (config().primaryButtonText) {
                      <button
                        mat-flat-button
                        [color]="primaryColor()"
                        type="button"
                        [disabled]="primaryDisabled()"
                        (click)="onPrimaryAction()"
                        class="flex-1 !rounded-xl"
                      >
                        @if (!config().loading) {
                          <span>{{ config().primaryButtonText }}</span>
                        } @else {
                          <span class="flex items-center justify-center">
                            <svg class="h-5 w-5 animate-spin" viewBox="0 0 24 24" aria-hidden="true">
                              <circle
                                class="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                stroke-width="4"
                                fill="none"
                              />
                              <path
                                class="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.37 0 0 5.37 0 12h4zm2 5.29A7.95 7.95 0 014 12H0c0 3.04 1.14 5.82 3 7.94l3-2.65z"
                              />
                            </svg>
                          </span>
                        }
                      </button>
                    }
                  </div>
                </div>
              }
            </div>
          </div>
        </div>
      </div>
    }
  `,
})
export class GenericPopupComponent implements OnDestroy {
  readonly config = input<PopupConfig>({ title: 'Popup', showCloseButton: true, showFooter: true });
  readonly shouldShow = input(false);
  readonly closeOnBackdrop = input(true);
  readonly closeOnEscape = input<boolean | null>(null);
  readonly trapFocus = input(true);

  readonly closeRequested = output();
  readonly primaryAction = output();
  readonly secondaryAction = output();
  readonly closePopup = output();
  readonly closed = output();

  private readonly document = inject(DOCUMENT);
  private readonly dialogPanel = viewChild<ElementRef<HTMLElement>>('dialogPanel');

  readonly titleId = `generic-popup-title-${String(++nextPopupId)}`;
  protected readonly rendered = signal(false);
  protected readonly isVisible = signal(false);

  protected readonly fullscreen = computed(() => this.config().fullscreen === true);
  protected readonly blurBackdrop = computed(() => this.config().blurBackdrop !== false);
  protected readonly showCloseButton = computed(() => this.config().showCloseButton !== false);
  protected readonly showFooter = computed(() => this.config().showFooter !== false);
  protected readonly primaryColor = computed(() => this.config().primaryButtonColor ?? 'primary');
  protected readonly primaryDisabled = computed(
    () => this.config().primaryButtonDisabled === true || this.config().loading === true,
  );
  protected readonly panelWidth = computed(() => (this.fullscreen() ? '100vw' : (this.config().width ?? 'auto')));
  protected readonly panelMaxWidth = computed(() => (this.fullscreen() ? 'none' : (this.config().width ?? '28rem')));
  protected readonly gridRows = computed(() =>
    this.showFooter() ? 'auto minmax(0, 1fr) auto' : 'auto minmax(0, 1fr)',
  );

  private activeElementBeforeOpen: HTMLElement | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollLocked = false;

  constructor() {
    effect(() => {
      const show = this.shouldShow();
      untracked(() => {
        if (show) this.showPopup();
        else if (this.rendered()) this.hidePopup();
      });
    });
  }

  onClose(): void {
    this.closeRequested.emit();
    this.closePopup.emit();
  }

  onBackdropClick(): void {
    if (this.closeOnBackdrop()) {
      this.onClose();
    }
  }

  onPrimaryAction(): void {
    this.primaryAction.emit();
  }

  onSecondaryAction(): void {
    this.secondaryAction.emit();
  }

  ngOnDestroy(): void {
    this.clearTimers();
    this.removeFromPopupStack();
    this.unlockBodyScroll();
  }

  onEscape(event: Event): void {
    if (!this.isTopmostPopup()) return;
    if (!this.rendered() || !this.isVisible() || !this.effectiveCloseOnEscape()) return;
    event.preventDefault();
    event.stopPropagation();
    this.onClose();
  }

  private showPopup(): void {
    this.clearCloseTimer();
    if (!this.rendered()) {
      this.rendered.set(true);
      const active = this.document.activeElement;
      this.activeElementBeforeOpen = active instanceof HTMLElement ? active : null;
      this.lockBodyScroll();
      this.addToPopupStack();
    }

    this.clearOpenTimer();
    this.openTimer = setTimeout(() => {
      this.isVisible.set(true);
      this.focusDialogPanel();
      this.openTimer = null;
    }, 10);
  }

  private hidePopup(): void {
    this.clearOpenTimer();
    this.isVisible.set(false);
    this.clearCloseTimer();
    this.closeTimer = setTimeout(() => {
      this.rendered.set(false);
      this.closeTimer = null;
      this.removeFromPopupStack();
      this.unlockBodyScroll();
      this.restoreFocus();
      this.closed.emit();
    }, POPUP_ANIMATION_MS);
  }

  private effectiveCloseOnEscape(): boolean {
    return this.closeOnEscape() ?? this.closeOnBackdrop();
  }

  /** Focuses the first `[cdkFocusInitial]` element in the panel when present, otherwise the panel itself. */
  private focusDialogPanel(): void {
    if (!this.trapFocus()) return;
    setTimeout(() => {
      const panel = this.dialogPanel()?.nativeElement;
      if (!panel) return;
      const initial = panel.querySelector<HTMLElement>('[cdkFocusInitial]');
      (initial ?? panel).focus({ preventScroll: true });
    }, 0);
  }

  private restoreFocus(): void {
    const element = this.activeElementBeforeOpen;
    this.activeElementBeforeOpen = null;
    if (!element || !this.document.contains(element)) return;
    element.focus({ preventScroll: true });
  }

  private lockBodyScroll(): void {
    if (this.scrollLocked) return;
    if (bodyScrollLockCount === 0) {
      previousBodyOverflow = this.document.body.style.overflow;
      this.document.body.style.overflow = 'hidden';
    }
    bodyScrollLockCount += 1;
    this.scrollLocked = true;
  }

  private unlockBodyScroll(): void {
    if (!this.scrollLocked) return;
    bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
    if (bodyScrollLockCount === 0) {
      this.document.body.style.overflow = previousBodyOverflow;
      previousBodyOverflow = '';
    }
    this.scrollLocked = false;
  }

  private addToPopupStack(): void {
    this.removeFromPopupStack();
    popupStack.push(this);
  }

  private removeFromPopupStack(): void {
    const index = popupStack.indexOf(this);
    if (index >= 0) popupStack.splice(index, 1);
  }

  private isTopmostPopup(): boolean {
    return popupStack.at(-1) === this;
  }

  private clearTimers(): void {
    this.clearOpenTimer();
    this.clearCloseTimer();
  }

  private clearOpenTimer(): void {
    if (!this.openTimer) return;
    clearTimeout(this.openTimer);
    this.openTimer = null;
  }

  private clearCloseTimer(): void {
    if (!this.closeTimer) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }
}
