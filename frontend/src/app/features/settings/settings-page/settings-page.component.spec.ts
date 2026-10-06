import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { environment } from '../../../../environments/environment';
import { errorInterceptor } from '../../../core/interceptors/error.interceptor';
import { type SettingsView } from '../../../core/models/settings.model';
import { NotificationService } from '../../../core/services/notification.service';
import { type ThemeMode, ThemeService } from '../../../core/services/theme.service';
import { SettingsPageComponent } from './settings-page.component';

const BASE = environment.apiBaseUrl;

const SAVED: SettingsView = {
  hasGithubToken: true,
  githubLogin: null,
  aiProvider: 'anthropic_api',
  hasAnthropicApiKey: true,
  aiModel: 'claude-opus-5-5',
  aiHarnessEffort: 'high',
  aiSummaryEffort: 'medium',
};

describe('SettingsPageComponent', () => {
  let fixture: ComponentFixture<SettingsPageComponent>;
  let el: HTMLElement;
  let httpMock: HttpTestingController;
  let notifications: jasmine.SpyObj<NotificationService>;
  let theme: { mode: ReturnType<typeof signal<ThemeMode>>; setMode: jasmine.Spy };

  beforeEach(async () => {
    notifications = jasmine.createSpyObj<NotificationService>('NotificationService', [
      'success',
      'error',
      'info',
      'warn',
      'queued',
    ]);
    theme = { mode: signal<ThemeMode>('dark'), setMode: jasmine.createSpy('setMode') };
    await TestBed.configureTestingModule({
      imports: [SettingsPageComponent],
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: NotificationService, useValue: notifications },
        { provide: ThemeService, useValue: theme },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(SettingsPageComponent);
    el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  });

  afterEach(() => {
    httpMock.verify();
  });

  function load(view: SettingsView = SAVED): void {
    httpMock.expectOne(`${BASE}/settings`).flush({ status: 200, data: view });
    fixture.detectChanges();
  }

  function input(id: string): HTMLInputElement {
    const found = el.querySelector<HTMLInputElement>(`#${id}`);
    if (!found) throw new Error(`no #${id}`);
    return found;
  }

  function type(id: string, value: string): void {
    const field = input(id);
    field.value = value;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function button(text: string): HTMLButtonElement {
    const found = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === text,
    );
    if (!found) throw new Error(`no button "${text}"`);
    return found;
  }

  function maybeButton(text: string): HTMLButtonElement | undefined {
    return Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === text);
  }

  function byTestId(id: string): HTMLElement {
    const found = el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!found) throw new Error(`no [data-testid=${id}]`);
    return found;
  }

  /** Button text without its mat-icon ligature. */
  function buttonLabel(id: string): string {
    const clone = byTestId(id).cloneNode(true) as HTMLElement;
    clone.querySelectorAll('mat-icon').forEach((icon) => {
      icon.remove();
    });
    return clone.textContent?.trim() ?? '';
  }

  function text(): string {
    return el.textContent ?? '';
  }

  function save(): void {
    button('Save settings').click();
    fixture.detectChanges();
  }

  it('shows spinner then form', () => {
    expect(el.querySelector('app-loading-spinner')).not.toBeNull();
    expect(el.querySelector('form')).toBeNull();
    load();
    expect(el.querySelector('app-loading-spinner')).toBeNull();
    expect(el.querySelector('form')).not.toBeNull();
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Settings');
  });

  it('load error renders inline alert without toast', () => {
    httpMock
      .expectOne(`${BASE}/settings`)
      .flush({ status: 500, error: 'Database down', error_reason: 'internal_error' }, { status: 500, statusText: 'x' });
    fixture.detectChanges();
    expect(text()).toContain("Couldn't load settings");
    expect(text()).toContain('Database down');
    expect(notifications.error.calls.count()).toBe(0);
    button('Retry').click();
    load();
    expect(el.querySelector('form')).not.toBeNull();
  });

  it('Saved pill and placeholder when hasGithubToken', () => {
    load();
    const pills = Array.from(el.querySelectorAll('.dd-pill--success')).map((p) => p.textContent?.trim());
    expect(pills.filter((p) => p === 'Saved').length).toBe(2);
    expect(input('prvision-github-token').placeholder).toBe('Saved — leave blank to keep');
    expect(input('prvision-anthropic-key').placeholder).toBe('Saved — leave blank to keep');
    expect(input('prvision-github-token').autocomplete).toBe('new-password');
    expect(input('prvision-github-token').type).toBe('password');
  });

  it('secret input never receives a server value', () => {
    load();
    expect(input('prvision-github-token').value).toBe('');
    expect(input('prvision-anthropic-key').value).toBe('');
  });

  it('Remove sets pending clear, disables input, Undo restores', () => {
    load();
    el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      if (b.textContent?.trim() === 'Remove' && b.closest('mat-card')?.textContent?.includes('GitHub')) b.click();
    });
    fixture.detectChanges();
    expect(input('prvision-github-token').disabled).toBeTrue();
    expect(text()).toContain('The saved token will be removed when you save.');
    button('Undo').click();
    fixture.detectChanges();
    expect(input('prvision-github-token').disabled).toBeFalse();
    expect(text()).not.toContain('The saved token will be removed when you save.');
  });

  it('Remove hidden while a value is typed', () => {
    load({ ...SAVED, hasAnthropicApiKey: false });
    expect(maybeButton('Remove')).toBeDefined();
    type('prvision-github-token', 'github_pat_new');
    expect(maybeButton('Remove')).toBeUndefined();
  });

  it('Save disabled when no changes', () => {
    load();
    expect(button('Save settings').disabled).toBeTrue();
    expect(button('Discard changes').disabled).toBeTrue();
  });

  it('Save sends only pendingUpdate and resets secret fields', () => {
    load();
    type('prvision-github-token', 'github_pat_abc');
    save();
    const req = httpMock.expectOne(`${BASE}/settings`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ githubToken: 'github_pat_abc' });
    req.flush({ status: 200, data: SAVED });
    fixture.detectChanges();
    expect(input('prvision-github-token').value).toBe('');
    expect(notifications.success.calls.allArgs()).toEqual([['Settings saved']]);
    expect(button('Save settings').disabled).toBeTrue();
  });

  it('Remove + Save sends githubToken ""', () => {
    load();
    const githubCard = el.querySelector('mat-card');
    githubCard?.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      if (b.textContent?.trim() === 'Remove') b.click();
    });
    fixture.detectChanges();
    save();
    const req = httpMock.expectOne(`${BASE}/settings`);
    expect(req.request.body).toEqual({ githubToken: '' });
    req.flush({ status: 200, data: { ...SAVED, hasGithubToken: false } });
    fixture.detectChanges();
    expect(byTestId('github-status').textContent?.trim()).toBe('Not configured');
  });

  it('save error renders details', () => {
    load();
    type('prvision-github-token', 'github_pat_abc');
    save();
    httpMock
      .expectOne(`${BASE}/settings`)
      .flush(
        { status: 400, error: ['githubToken is invalid', 'aiModel is invalid'], error_reason: 'validation_failed' },
        { status: 400, statusText: 'Bad Request' },
      );
    fixture.detectChanges();
    expect(text()).toContain('Invalid input');
    expect(text()).toContain('githubToken is invalid');
    const items = Array.from(el.querySelectorAll('li')).map((li) => li.textContent?.trim());
    expect(items).toEqual(['aiModel is invalid']);
    expect(input('prvision-github-token').value).toBe('github_pat_abc');
    expect(notifications.error.calls.count()).toBe(0);
  });

  it('Test connection label becomes Save & test when token typed', () => {
    load();
    expect(buttonLabel('github-test')).toBe('Test connection');
    type('prvision-github-token', 'github_pat_abc');
    expect(buttonLabel('github-test')).toBe('Save & test');
  });

  it('Save & test saves then tests (one PUT, then one POST)', () => {
    load();
    type('prvision-github-token', 'github_pat_abc');
    byTestId('github-test').click();
    fixture.detectChanges();
    httpMock.expectNone(`${BASE}/settings/test-github`);
    const put = httpMock.expectOne({ method: 'PUT', url: `${BASE}/settings` });
    expect(put.request.body).toEqual({ githubToken: 'github_pat_abc' });
    put.flush({ status: 200, data: SAVED });
    const post = httpMock.expectOne({ method: 'POST', url: `${BASE}/settings/test-github` });
    post.flush({ status: 200, data: { login: 'octocat' } });
    fixture.detectChanges();
    expect(text()).toContain('Connected as @octocat.');
  });

  it('Save & test does not test when save fails', () => {
    load();
    type('prvision-github-token', 'github_pat_abc');
    byTestId('github-test').click();
    httpMock
      .expectOne({ method: 'PUT', url: `${BASE}/settings` })
      .flush({ status: 500, error: 'boom', error_reason: 'internal_error' }, { status: 500, statusText: 'x' });
    fixture.detectChanges();
    httpMock.expectNone(`${BASE}/settings/test-github`);
    expect(buttonLabel('github-test')).toBe('Save & test');
    expect(text()).toContain('boom');
  });

  it('GitHub test success shows Connected as @login and updates the status pill', () => {
    load();
    expect(byTestId('github-status').textContent?.trim()).toBe('Saved, not tested');
    byTestId('github-test').click();
    httpMock.expectOne(`${BASE}/settings/test-github`).flush({ status: 200, data: { login: 'octocat' } });
    fixture.detectChanges();
    expect(byTestId('github-status').textContent?.trim()).toBe('Connected as @octocat');
    expect(byTestId('github-status').classList).toContain('dd-pill--success');
    expect(text()).toContain('Connected as @octocat.');
  });

  it('github_unauthorized result shows error copy', () => {
    load();
    byTestId('github-test').click();
    httpMock
      .expectOne(`${BASE}/settings/test-github`)
      .flush(
        { status: 400, error: 'Bad credentials', error_reason: 'github_unauthorized' },
        { status: 400, statusText: 'x' },
      );
    fixture.detectChanges();
    expect(text()).toContain('GitHub rejected the token');
    expect(text()).toContain('The GitHub token was rejected.');
    expect(notifications.error.calls.count()).toBe(0);
  });

  it('offers no provider choice: only the Anthropic API key field', () => {
    load();
    expect(el.querySelector('#prvision-anthropic-key')).not.toBeNull();
    expect(el.querySelector('mat-radio-group')).toBeNull();
    expect(el.querySelector('[data-testid="legacy-provider"]')).toBeNull();
    expect(text()).not.toContain('Claude Code');
  });

  it('legacy claude_code with a saved key shows the note and saves the switch to anthropic_api', () => {
    load({ ...SAVED, aiProvider: 'claude_code' });
    expect(byTestId('legacy-provider').textContent).toContain('Claude Code is no longer supported.');
    expect(el.querySelector('#prvision-anthropic-key')).not.toBeNull();
    expect(el.querySelector('[data-testid="key-required"]')).toBeNull();
    save();
    const req = httpMock.expectOne(`${BASE}/settings`);
    expect(req.request.body).toEqual({ aiProvider: 'anthropic_api' });
    req.flush({ status: 200, data: SAVED });
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="legacy-provider"]')).toBeNull();
  });

  it('legacy claude_code with no saved key blocks Save with the key-required error', () => {
    load({ ...SAVED, aiProvider: 'claude_code', hasAnthropicApiKey: false });
    expect(byTestId('key-required').textContent).toContain('An API key is required for the Anthropic API provider.');
    expect(button('Save settings').disabled).toBeTrue();
    type('prvision-anthropic-key', 'sk-ant-123');
    expect(el.querySelector('[data-testid="key-required"]')).toBeNull();
    expect(button('Save settings').disabled).toBeFalse();
  });

  it('Test AI success shows model, provider label and latency from AiTestResultView', () => {
    load();
    expect(buttonLabel('ai-test')).toBe('Test AI');
    byTestId('ai-test').click();
    httpMock
      .expectOne(`${BASE}/settings/test-ai`)
      .flush({ status: 200, data: { provider: 'anthropic_api', model: 'claude-opus-5-5', latencyMs: 1234 } });
    fixture.detectChanges();
    expect(text()).toContain('claude-opus-5-5 via Anthropic API answered in 1.2 s.');
  });

  it('theme segmented control calls ThemeService.setMode', () => {
    load();
    const light = Array.from(el.querySelectorAll<HTMLButtonElement>('[aria-label="Theme"] button')).find((b) =>
      b.textContent?.includes('Light'),
    );
    light?.click();
    expect(theme.setMode.calls.allArgs()).toEqual([['light']]);
  });
});
