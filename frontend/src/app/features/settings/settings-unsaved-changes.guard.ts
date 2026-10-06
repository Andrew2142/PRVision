import { inject } from '@angular/core';
import { type CanDeactivateFn } from '@angular/router';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { type SettingsPageComponent } from './settings-page/settings-page.component';

/** Asks before leaving Settings with unsaved changes (13 §5.4.5). Tab close is handled by `beforeunload`. */
export const settingsUnsavedChangesGuard: CanDeactivateFn<SettingsPageComponent> = (component) =>
  !component.hasChanges()
    ? true
    : inject(ConfirmDialogService).confirm({
        title: 'Discard unsaved changes?',
        message: 'You have settings changes that are not saved. Leave this page and discard them?',
        confirmText: 'Discard changes',
        cancelText: 'Stay',
        confirmColor: 'warn',
      });
