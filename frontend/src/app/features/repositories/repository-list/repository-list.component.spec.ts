import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { By } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter } from '@angular/router';
import { type ColDef, type ICellRendererParams } from 'ag-grid-community';
import { Subject, of } from 'rxjs';
import { ApiError } from '../../../core/models/api-error.model';
import { type RepositoryView } from '../../../core/models/repository.model';
import { ApiService } from '../../../core/services/api.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { NotificationService } from '../../../core/services/notification.service';
import { type ActionMenuCellRendererParams } from '../../../shared/components/data-grid/action-menu-cell-renderer.component';
import { DataGridComponent } from '../../../shared/components/data-grid/data-grid.component';
import { type AddRepositoryDialogResult } from '../components/add-repository-dialog/add-repository-dialog.component';
import { RepositoryListComponent } from './repository-list.component';

function repo(id: number, overrides: Partial<RepositoryView> = {}): RepositoryView {
  return {
    id,
    name: `repo-${String(id)}`,
    localPath: `/home/dev/projects/repo-${String(id)}`,
    githubOwner: 'acme',
    githubRepo: `repo-${String(id)}`,
    defaultBranch: 'main',
    framework: 'react_vite',
    appRoot: '.',
    angularProject: null,
    angularBuildConfiguration: null,
    renderViewport: 'desktop',
    libraryBuildMode: 'grow',
    stateAllowance: 3,
    packageManager: 'pnpm',
    viteConfigPath: 'vite.config.ts',
    tsconfigPath: 'tsconfig.json',
    entryFilePath: 'src/main.tsx',
    globalStylePaths: [],
    lastDetectedAt: '2026-10-03T10:00:00Z',
    createdAt: '2026-10-01T10:00:00Z',
    ...overrides,
  };
}

describe('RepositoryListComponent', () => {
  let fixture: ComponentFixture<RepositoryListComponent>;
  let el: HTMLElement;
  let api: jasmine.SpyObj<ApiService>;
  let dialog: jasmine.SpyObj<MatDialog>;
  let confirm: jasmine.SpyObj<ConfirmDialogService>;
  let notifications: jasmine.SpyObj<NotificationService>;
  let navigate: jasmine.Spy;
  let list$: Subject<RepositoryView[]>;

  beforeEach(async () => {
    list$ = new Subject<RepositoryView[]>();
    api = jasmine.createSpyObj<ApiService>('ApiService', [
      'listRepositories',
      'redetectRepository',
      'removeRepository',
    ]);
    api.listRepositories.and.returnValue(list$);
    dialog = jasmine.createSpyObj<MatDialog>('MatDialog', ['open']);
    confirm = jasmine.createSpyObj<ConfirmDialogService>('ConfirmDialogService', ['confirm']);
    notifications = jasmine.createSpyObj<NotificationService>('NotificationService', ['success', 'error', 'info']);
    await TestBed.configureTestingModule({
      imports: [RepositoryListComponent],
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        { provide: ApiService, useValue: api },
        { provide: MatDialog, useValue: dialog },
        { provide: ConfirmDialogService, useValue: confirm },
        { provide: NotificationService, useValue: notifications },
      ],
    }).compileComponents();
    navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    fixture = TestBed.createComponent(RepositoryListComponent);
    el = fixture.nativeElement as HTMLElement;
  });

  function load(repos: RepositoryView[]): void {
    fixture.detectChanges();
    list$.next(repos);
    list$.complete();
    fixture.detectChanges();
  }

  function columns(): ColDef<RepositoryView>[] {
    return (fixture.componentInstance as unknown as { columns: ColDef<RepositoryView>[] }).columns;
  }

  function render(colId: string, row: RepositoryView): string {
    const col = columns().find((c) => c.colId === colId);
    const renderer = col?.cellRenderer as (p: Partial<ICellRendererParams<RepositoryView>>) => string;
    return renderer({ data: row });
  }

  function menuParams(): ActionMenuCellRendererParams {
    return columns().find((c) => c.colId === 'menu')?.cellRendererParams as ActionMenuCellRendererParams;
  }

  function grid(): DataGridComponent {
    return fixture.debugElement.query(By.directive(DataGridComponent)).componentInstance as DataGridComponent;
  }

  function dialogCloses(result: AddRepositoryDialogResult | undefined): void {
    dialog.open.and.returnValue({ afterClosed: () => of(result) } as ReturnType<MatDialog['open']>);
  }

  it('renders grid with rows at rowHeight 56', () => {
    load([repo(1), repo(2), repo(3)]);
    expect(grid().rowHeight).toBe(56);
    expect(grid().rowData.length).toBe(3);
    expect(grid().pagination).toBeFalse();
    expect(el.textContent).toContain('3 repositories');
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Repositories');
  });

  it('package manager rendered raw (pnpm, not Pnpm)', () => {
    load([repo(1)]);
    const html = render('packageManager', repo(1));
    expect(html).toContain('>pnpm<');
    expect(html).not.toContain('Pnpm');
    expect(render('github', repo(1, { githubOwner: null, githubRepo: null }))).toContain('No GitHub remote');
    expect(render('name', repo(1))).toContain('/home/dev/projects/repo-1');
  });

  it('an app inside a clone shows its app root under the name', () => {
    const app = repo(2, { framework: 'angular', appRoot: 'src/tenant-frontend', angularProject: 'tenant-frontend' });
    load([app]);
    expect(render('name', app)).toContain('/home/dev/projects/repo-2/src/tenant-frontend');
  });

  it('Framework column: React + Vite, or Angular with its project', () => {
    const app = repo(2, { framework: 'angular', appRoot: 'src/tenant-frontend', angularProject: 'tenant-frontend' });
    load([repo(1), app]);
    expect(columns().map((c) => c.colId)).toContain('framework');
    expect(render('framework', repo(1))).toContain('React + Vite');
    const html = render('framework', app);
    expect(html).toContain('Angular');
    expect(html).toContain('project tenant-frontend');
  });

  it('empty state with Add button when none', () => {
    load([]);
    const card = el.querySelector('[data-testid="first-run"]');
    expect(card?.textContent).toContain('Add your first repository');
    expect(el.querySelector('app-data-grid')).toBeNull();
    dialogCloses(undefined);
    card?.querySelector('button')?.click();
    expect(dialog.open.calls.count()).toBe(1);
  });

  it('load error inline, no toast', () => {
    fixture.detectChanges();
    list$.error(new ApiError("Can't reach the API", 0, null));
    fixture.detectChanges();
    expect(el.textContent).toContain("Couldn't load repositories");
    expect(el.textContent).toContain("Can't reach the API");
    expect(notifications.error.calls.count()).toBe(0);
    expect(el.querySelector('app-data-grid')).toBeNull();
  });

  it('?add=1 opens dialog once', () => {
    dialogCloses(undefined);
    fixture.componentRef.setInput('add', '1');
    load([repo(1)]);
    fixture.detectChanges();
    expect(dialog.open.calls.count()).toBe(1);
    fixture.componentRef.setInput('add', '1');
    fixture.detectChanges();
    expect(dialog.open.calls.count()).toBe(1);
  });

  it('dialog result upserts created rows and navigates when openId set', () => {
    load([repo(1)]);
    dialogCloses({ created: [repo(1, { name: 'renamed' }), repo(2)], openId: 2 });
    el.querySelector<HTMLButtonElement>('app-page-header button')?.click();
    fixture.detectChanges();
    expect(grid().rowData.map((r) => (r as RepositoryView).name)).toEqual(['renamed', 'repo-2']);
    expect(navigate.calls.allArgs()).toEqual([[['/repositories', 2]]]);
  });

  it('remove asks confirm then deletes row', () => {
    load([repo(1), repo(2)]);
    confirm.confirm.and.returnValue(of(true));
    api.removeRepository.and.returnValue(of({ id: 1 }));
    menuParams().onAction?.('remove', repo(1));
    fixture.detectChanges();
    const data = confirm.confirm.calls.mostRecent().args[0];
    expect(data.title).toBe('Remove repository?');
    expect(data.message).toBe('PRVision will forget "repo-1". Your local clone is not touched.');
    expect(data.confirmColor).toBe('warn');
    expect(api.removeRepository.calls.allArgs()).toEqual([[1]]);
    expect(grid().rowData.map((r) => (r as RepositoryView).id)).toEqual([2]);
    expect(notifications.success.calls.allArgs()).toEqual([['Repository removed']]);
  });

  it('remove cancelled sends nothing', () => {
    load([repo(1)]);
    confirm.confirm.and.returnValue(of(false));
    menuParams().onAction?.('remove', repo(1));
    expect(api.removeRepository.calls.count()).toBe(0);
  });

  it('redetect replaces row', () => {
    load([repo(1), repo(2)]);
    const pending = new Subject<RepositoryView>();
    api.redetectRepository.and.returnValue(pending);
    menuParams().onAction?.('redetect', repo(2));
    const actions = menuParams().actions as (row: unknown) => { action: string; disabled?: boolean }[];
    expect(actions(repo(2)).find((a) => a.action === 'redetect')?.disabled).toBeTrue();
    pending.next(repo(2, { defaultBranch: 'develop' }));
    pending.complete();
    fixture.detectChanges();
    expect((grid().rowData[1] as RepositoryView).defaultBranch).toBe('develop');
    expect(notifications.success.calls.allArgs()).toEqual([['Re-detected repo-2']]);
    expect(actions(repo(2)).find((a) => a.action === 'redetect')?.disabled).toBeFalse();
  });
});
