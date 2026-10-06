import { Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, type MatSnackBarConfig } from '@angular/material/snack-bar';
import { type Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  ActionMessageDialogComponent,
  type ActionMessageDialogData,
  type ActionMessageDialogResult,
} from '../../shared/components/action-message-dialog/action-message-dialog.component';
import { GENERIC_POPUP_DIALOG_CONFIG } from './confirm-dialog.service';

/** Visual style for toasts (maps to classes in `styles.scss`). */
export type ToastVariant = 'default' | 'success' | 'error' | 'warn' | 'info';

/**
 * App-wide transient messages. Use this instead of `window.alert`, raw `MatSnackBar`, or third-party toasts
 * so copy, duration, and styling stay consistent.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);

  private static readonly toastPosition = {
    horizontalPosition: 'end' as const,
    verticalPosition: 'bottom' as const,
  };

  private panelClasses(variant: ToastVariant): string[] {
    const base = ['dd-app-toast'];
    switch (variant) {
      case 'success':
        return [...base, 'snackbar-success'];
      case 'error':
        return [...base, 'snackbar-error'];
      case 'warn':
        return [...base, 'snackbar-warn'];
      case 'info':
        return [...base, 'snackbar-info'];
      default:
        return [...base, 'snackbar-default'];
    }
  }

  /**
   * General-purpose toast (bottom-right). Prefer `success` / `error` / `info` / `warn` when the tone is clear.
   * For a message that needs a **primary action** (not just dismiss), use {@link promptAction} instead (centered dialog + blurred backdrop).
   */
  show(
    message: string,
    options?: {
      duration?: number;
      variant?: ToastVariant;
      panelClass?: string[];
    },
  ): void {
    const variant = options?.variant ?? 'default';
    const panelClass = [...this.panelClasses(variant), ...(options?.panelClass ?? [])];
    const config: MatSnackBarConfig = {
      duration: options?.duration ?? 4000,
      ...NotificationService.toastPosition,
      panelClass,
    };
    this.snackBar.open(message, undefined, config);
  }

  /**
   * Centered modal with blurred backdrop when the user must choose a **primary action** or dismiss.
   * Returns `true` if the primary action was chosen.
   */
  promptAction(data: ActionMessageDialogData): Observable<boolean> {
    return this.dialog
      .open<ActionMessageDialogComponent, ActionMessageDialogData, ActionMessageDialogResult>(
        ActionMessageDialogComponent,
        { ...GENERIC_POPUP_DIALOG_CONFIG, data },
      )
      .afterClosed()
      .pipe(map((v) => v === 'action'));
  }

  success(message: string, duration = 3000): void {
    this.show(message, { variant: 'success', duration });
  }

  error(message: string, duration = 5000): void {
    this.show(message, { variant: 'error', duration });
  }

  info(message: string, duration = 4000): void {
    this.show(message, { variant: 'info', duration });
  }

  warn(message: string, duration = 5000): void {
    this.show(message, { variant: 'warn', duration });
  }

  /** Longer message for "Visualization queued" feedback (bottom-right, wide surface). Uply's `runStarted()`. */
  queued(message: string): void {
    this.snackBar.open(message, undefined, {
      duration: 14000,
      ...NotificationService.toastPosition,
      panelClass: [...this.panelClasses('default'), 'snackbar-run-started'],
    });
  }
}
