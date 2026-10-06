import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { GenericPopupComponent, type PopupConfig } from '../generic-popup/generic-popup.component';

export type ActionMessageDialogResult = 'action' | 'dismiss';

export interface ActionMessageDialogData {
  title?: string;
  message: string;
  /** Primary action (e.g. Retry, Open settings). */
  actionLabel: string;
  dismissText?: string;
}

@Component({
  selector: 'app-action-message-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GenericPopupComponent],
  template: `
    <app-generic-popup
      [shouldShow]="true"
      [config]="popupConfig"
      (closePopup)="close('dismiss')"
      (secondaryAction)="close('dismiss')"
      (primaryAction)="close('action')"
    >
      <p class="whitespace-pre-wrap">{{ data.message }}</p>
    </app-generic-popup>
  `,
})
export class ActionMessageDialogComponent {
  readonly data = inject<ActionMessageDialogData>(MAT_DIALOG_DATA);
  private readonly dialogRef =
    inject<MatDialogRef<ActionMessageDialogComponent, ActionMessageDialogResult>>(MatDialogRef);
  readonly popupConfig: PopupConfig = {
    title: this.data.title ?? 'Action required',
    icon: 'info',
    width: 'min(440px, calc(100vw - 32px))',
    primaryButtonText: this.data.actionLabel,
    secondaryButtonText: this.data.dismissText ?? 'Dismiss',
  };

  close(result: ActionMessageDialogResult): void {
    this.dialogRef.close(result);
  }
}
