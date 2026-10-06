import { Injectable, inject } from '@angular/core';
import { MatDialog, type MatDialogConfig } from '@angular/material/dialog';
import { type Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  ConfirmDialogComponent,
  type ConfirmDialogData,
} from '../../shared/components/confirm-dialog/confirm-dialog.component';

/**
 * Uply's dialog hosting: a transparent fullscreen Material panel whose content is an `app-generic-popup`
 * (blur, focus trap, Escape). Reused by `NotificationService.promptAction` and 13's add-repository dialog.
 */
export const GENERIC_POPUP_DIALOG_CONFIG = {
  width: '100vw',
  maxWidth: '100vw',
  height: '100vh',
  hasBackdrop: false,
  disableClose: true,
  panelClass: 'dd-generic-popup-dialog',
  autoFocus: false,
} satisfies MatDialogConfig;

/**
 * Replaces `window.confirm` with a Material dialog. Inject in features that need destructive or
 * high-friction confirmation.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  private readonly dialog = inject(MatDialog);

  confirm(data: ConfirmDialogData): Observable<boolean> {
    return this.dialog
      .open<ConfirmDialogComponent, ConfirmDialogData, boolean>(ConfirmDialogComponent, {
        ...GENERIC_POPUP_DIALOG_CONFIG,
        data,
      })
      .afterClosed()
      .pipe(map((v) => v === true));
  }
}
