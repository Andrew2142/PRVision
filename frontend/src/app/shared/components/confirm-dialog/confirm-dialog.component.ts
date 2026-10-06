import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { GenericPopupComponent, type PopupConfig } from '../generic-popup/generic-popup.component';

export interface ConfirmDialogData {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** Destructive actions should use `warn` (red/warn button). */
  confirmColor?: 'primary' | 'warn';
}

@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GenericPopupComponent],
  template: `
    <app-generic-popup
      [shouldShow]="true"
      [config]="popupConfig"
      (closePopup)="close(false)"
      (secondaryAction)="close(false)"
      (primaryAction)="close(true)"
    >
      <p class="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-text-secondary)]">{{ data.message }}</p>
    </app-generic-popup>
  `,
})
export class ConfirmDialogComponent {
  readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
  private readonly dialogRef = inject<MatDialogRef<ConfirmDialogComponent, boolean>>(MatDialogRef);
  readonly popupConfig: PopupConfig = {
    title: this.data.title,
    icon: this.data.confirmColor === 'warn' ? 'warning' : 'help',
    width: 'min(440px, calc(100vw - 32px))',
    primaryButtonText: this.data.confirmText ?? 'OK',
    secondaryButtonText: this.data.cancelText ?? 'Cancel',
    primaryButtonColor: this.data.confirmColor ?? 'primary',
  };

  close(result: boolean): void {
    this.dialogRef.close(result);
  }
}
