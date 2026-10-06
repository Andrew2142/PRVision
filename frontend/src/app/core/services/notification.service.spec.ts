import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, type MatSnackBarConfig } from '@angular/material/snack-bar';
import { of } from 'rxjs';
import { NotificationService } from './notification.service';

describe('NotificationService', () => {
  let service: NotificationService;
  let snackBar: jasmine.SpyObj<MatSnackBar>;
  let dialog: jasmine.SpyObj<MatDialog>;

  beforeEach(() => {
    snackBar = jasmine.createSpyObj<MatSnackBar>('MatSnackBar', ['open']);
    dialog = jasmine.createSpyObj<MatDialog>('MatDialog', ['open']);
    TestBed.configureTestingModule({
      providers: [
        { provide: MatSnackBar, useValue: snackBar },
        { provide: MatDialog, useValue: dialog },
      ],
    });
    service = TestBed.inject(NotificationService);
  });

  function lastConfig(): MatSnackBarConfig {
    const config = snackBar.open.calls.mostRecent().args[2];
    if (!config) throw new Error('no config');
    return config;
  }

  it('success/error/info/warn use dd-app-toast + variant class and durations', () => {
    const cases: [() => void, string, number][] = [
      [
        () => {
          service.success('ok');
        },
        'snackbar-success',
        3000,
      ],
      [
        () => {
          service.error('bad');
        },
        'snackbar-error',
        5000,
      ],
      [
        () => {
          service.info('fyi');
        },
        'snackbar-info',
        4000,
      ],
      [
        () => {
          service.warn('hmm');
        },
        'snackbar-warn',
        5000,
      ],
    ];
    for (const [call, variant, duration] of cases) {
      call();
      const config = lastConfig();
      expect(config.panelClass).toEqual(['dd-app-toast', variant]);
      expect(config.duration).toBe(duration);
      expect(config.horizontalPosition).toBe('end');
      expect(config.verticalPosition).toBe('bottom');
    }
    expect(snackBar.open.calls.mostRecent().args[0]).toBe('hmm');
  });

  it('queued uses snackbar-run-started and 14 s', () => {
    service.queued('Visualization queued');
    expect(snackBar.open.calls.mostRecent().args[0]).toBe('Visualization queued');
    const config = lastConfig();
    expect(config.panelClass).toEqual(['dd-app-toast', 'snackbar-default', 'snackbar-run-started']);
    expect(config.duration).toBe(14000);
  });

  it("promptAction maps 'action' to true", () => {
    dialog.open.and.returnValues(
      { afterClosed: () => of('action') } as ReturnType<MatDialog['open']>,
      { afterClosed: () => of('dismiss') } as ReturnType<MatDialog['open']>,
    );
    const results: boolean[] = [];
    service.promptAction({ message: 'Retry?', actionLabel: 'Retry' }).subscribe((v) => results.push(v));
    service.promptAction({ message: 'Retry?', actionLabel: 'Retry' }).subscribe((v) => results.push(v));
    expect(results).toEqual([true, false]);
    expect(dialog.open.calls.mostRecent().args[1]?.panelClass).toBe('dd-generic-popup-dialog');
  });
});
