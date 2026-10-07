import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed, fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { environment } from '../../../../../environments/environment';
import { errorInterceptor } from '../../../../core/interceptors/error.interceptor';
import { type RepositoryView } from '../../../../core/models/repository.model';
import { NotificationService } from '../../../../core/services/notification.service';
import { repositoryView } from '../../testing/library-fixtures';
import { RepositorySettingsCardComponent, allowanceSavedText } from './repository-settings-card.component';

const URL = `${environment.apiBaseUrl}/repositories/3`;

describe('RepositorySettingsCardComponent', () => {
  let fixture: ComponentFixture<RepositorySettingsCardComponent>;
  let el: HTMLElement;
  let httpMock: HttpTestingController;
  let notifications: jasmine.SpyObj<NotificationService>;
  let saved: RepositoryView[];

  beforeEach(async () => {
    notifications = jasmine.createSpyObj<NotificationService>('NotificationService', ['success', 'error', 'info']);
    await TestBed.configureTestingModule({
      imports: [RepositorySettingsCardComponent],
      providers: [
        provideNoopAnimations(),
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: NotificationService, useValue: notifications },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(RepositorySettingsCardComponent);
    el = fixture.nativeElement as HTMLElement;
    saved = [];
    fixture.componentInstance.saved.subscribe((r) => saved.push(r));
  });

  afterEach(() => {
    httpMock.verify();
  });

  function render(repo: RepositoryView = repositoryView()): void {
    fixture.componentRef.setInput('repository', repo);
    fixture.detectChanges();
    flushMicrotasks(); // mat-select picks up its initial value in a microtask
    fixture.detectChanges();
  }
  function select(): HTMLElement {
    const s = el.querySelector<HTMLElement>('[data-testid="settings-state-allowance"]');
    if (!s) throw new Error('no select');
    return s;
  }
  function save(): HTMLButtonElement {
    const b = el.querySelector<HTMLButtonElement>('[data-testid="settings-save"]');
    if (!b) throw new Error('no save');
    return b;
  }
  /** Moves the closed select with the arrow keys. */
  function step(times: number): void {
    for (let i = 0; i < Math.abs(times); i++) {
      const down = times > 0;
      const event = new KeyboardEvent('keydown', { key: down ? 'ArrowDown' : 'ArrowUp', bubbles: true });
      Object.defineProperty(event, 'keyCode', { get: () => (down ? 40 : 38) });
      select().dispatchEvent(event);
      fixture.detectChanges();
    }
  }

  it('shows the repository allowance; Save is enabled only when it changed', fakeAsync(() => {
    render(repositoryView({ stateAllowance: 3 }));
    expect(el.textContent).toContain('States per component');
    expect(select().textContent?.trim()).toBe('3');
    expect(save().disabled).toBeTrue();
    step(1);
    expect(select().textContent?.trim()).toBe('4');
    expect(save().disabled).toBeFalse();
    step(-1);
    expect(save().disabled).toBeTrue();
  }));

  it('Save patches stateAllowance, emits the repository and explains grow repositories', fakeAsync(() => {
    render(repositoryView({ stateAllowance: 3, libraryBuildMode: 'grow' }));
    step(-2);
    save().click();
    fixture.detectChanges();
    expect(save().disabled).toBeTrue();
    const req = httpMock.expectOne(URL);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ stateAllowance: 1 });
    const updated = repositoryView({ stateAllowance: 1 });
    req.flush({ status: 200, data: updated });
    fixture.detectChanges();
    expect(saved).toEqual([updated]);
    expect(el.querySelector('[data-testid="settings-saved"]')?.textContent?.trim()).toBe(
      'New harnesses use 1 state from now on.',
    );
  }));

  it('scan repositories are told to Rescan', fakeAsync(() => {
    render(repositoryView({ stateAllowance: 3, libraryBuildMode: 'scan' }));
    step(2);
    save().click();
    httpMock
      .expectOne(URL)
      .flush({ status: 200, data: repositoryView({ stateAllowance: 5, libraryBuildMode: 'scan' }) });
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="settings-saved"]')?.textContent?.trim()).toBe(
      'Rescan from the Harness library card to rewrite every harness with 5 states.',
    );
  }));

  it('a failed save is toasted by the interceptor, keeps the pick and emits nothing', fakeAsync(() => {
    render();
    step(1);
    save().click();
    httpMock
      .expectOne(URL)
      .flush(
        { status: 400, error: 'stateAllowance must be 1–5', error_reason: 'validation_failed' },
        { status: 400, statusText: 'x' },
      );
    fixture.detectChanges();
    expect(notifications.error.calls.count()).toBe(1);
    expect(saved).toEqual([]);
    expect(select().textContent?.trim()).toBe('4');
    expect(save().disabled).toBeFalse();
    expect(el.querySelector('[data-testid="settings-saved"]')).toBeNull();
  }));

  it('allowanceSavedText', () => {
    expect(allowanceSavedText({ libraryBuildMode: 'grow', stateAllowance: 2 })).toBe(
      'New harnesses use 2 states from now on.',
    );
    expect(allowanceSavedText({ libraryBuildMode: 'scan', stateAllowance: 3 })).toBe(
      'Rescan from the Harness library card to rewrite every harness with 3 states.',
    );
  });
});
