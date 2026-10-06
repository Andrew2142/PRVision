import { TestBed } from '@angular/core/testing';
import { type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { type Observable, of } from 'rxjs';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { type SettingsPageComponent } from './settings-page/settings-page.component';
import { settingsUnsavedChangesGuard } from './settings-unsaved-changes.guard';

describe('settingsUnsavedChangesGuard', () => {
  let confirm: jasmine.SpyObj<ConfirmDialogService>;

  beforeEach(() => {
    confirm = jasmine.createSpyObj<ConfirmDialogService>('ConfirmDialogService', ['confirm']);
    TestBed.configureTestingModule({ providers: [{ provide: ConfirmDialogService, useValue: confirm }] });
  });

  function run(hasChanges: boolean): unknown {
    const component = { hasChanges: () => hasChanges } as unknown as SettingsPageComponent;
    return TestBed.runInInjectionContext(() =>
      settingsUnsavedChangesGuard(
        component,
        {} as ActivatedRouteSnapshot,
        {} as RouterStateSnapshot,
        {} as RouterStateSnapshot,
      ),
    );
  }

  it('true when no changes', () => {
    expect(run(false)).toBeTrue();
    expect(confirm.confirm.calls.count()).toBe(0);
  });

  it('asks confirm when changes', () => {
    confirm.confirm.and.returnValue(of(false));
    run(true);
    const data = confirm.confirm.calls.mostRecent().args[0];
    expect(data.title).toBe('Discard unsaved changes?');
    expect(data.confirmText).toBe('Discard changes');
    expect(data.cancelText).toBe('Stay');
    expect(data.confirmColor).toBe('warn');
  });

  it('returns confirm result', () => {
    confirm.confirm.and.returnValue(of(true));
    let result: boolean | undefined;
    (run(true) as Observable<boolean>).subscribe((v) => (result = v));
    expect(result).toBeTrue();
  });
});
