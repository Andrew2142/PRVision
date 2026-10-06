import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';
import { ConfirmDialogService } from './confirm-dialog.service';

describe('ConfirmDialogService', () => {
  let service: ConfirmDialogService;
  let dialog: jasmine.SpyObj<MatDialog>;

  beforeEach(() => {
    dialog = jasmine.createSpyObj<MatDialog>('MatDialog', ['open']);
    TestBed.configureTestingModule({ providers: [{ provide: MatDialog, useValue: dialog }] });
    service = TestBed.inject(ConfirmDialogService);
  });

  function closeWith(value: unknown): void {
    dialog.open.and.returnValue({ afterClosed: () => of(value) } as ReturnType<MatDialog['open']>);
  }

  it('true result → true', () => {
    closeWith(true);
    let result: boolean | undefined;
    service.confirm({ title: 'Remove?', message: 'Sure?' }).subscribe((v) => (result = v));
    expect(result).toBeTrue();
  });

  it('undefined/false → false', () => {
    const results: boolean[] = [];
    closeWith(undefined);
    service.confirm({ title: 'Remove?', message: 'Sure?' }).subscribe((v) => results.push(v));
    closeWith(false);
    service.confirm({ title: 'Remove?', message: 'Sure?' }).subscribe((v) => results.push(v));
    expect(results).toEqual([false, false]);
  });

  it('passes dd-generic-popup-dialog panel class', () => {
    closeWith(true);
    const data = { title: 'Remove repository', message: 'Sure?', confirmColor: 'warn' as const };
    service.confirm(data).subscribe();
    const config = dialog.open.calls.mostRecent().args[1];
    expect(config?.panelClass).toBe('dd-generic-popup-dialog');
    expect(config?.hasBackdrop).toBeFalse();
    expect(config?.disableClose).toBeTrue();
    expect(config?.data).toEqual(data);
  });
});
