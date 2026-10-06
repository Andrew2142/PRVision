import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { type VisualizationStatus } from '../models/domain-enums.model';
import { type VisualizationDetailView } from '../models/visualization.model';
import { NOTIFICATION_API, type NotificationApi, RunAlertService } from './run-alert.service';

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = jasmine.createSpy('requestPermission').and.resolveTo('granted');
  static created: FakeNotification[] = [];
  onclick: ((this: Notification, ev: Event) => unknown) | null = null;
  close = jasmine.createSpy('close');
  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {
    FakeNotification.created.push(this);
  }
}

function detail(
  status: VisualizationStatus,
  overrides: Partial<VisualizationDetailView> = {},
): VisualizationDetailView {
  return {
    id: 29,
    title: 'staging: 95b0890…3178270',
    status,
    componentCount: 58,
    changedCount: 7,
    errorMessage: null,
    ...overrides,
  } as VisualizationDetailView;
}

function onlyNotification(): FakeNotification {
  expect(FakeNotification.created.length).toBe(1);
  const n = FakeNotification.created[0];
  if (!n) throw new Error('expected a notification');
  return n;
}

describe('RunAlertService', () => {
  let service: RunAlertService;
  let title: Title;
  let doc: Document;
  let navigate: jasmine.Spy;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    FakeNotification.permission = 'granted';
    FakeNotification.created = [];
    FakeNotification.requestPermission.calls.reset();
    navigate = jasmine.createSpy('navigate').and.resolveTo(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: NOTIFICATION_API, useValue: FakeNotification as unknown as NotificationApi },
        { provide: Router, useValue: { navigate } },
      ],
    });
    doc = TestBed.inject(DOCUMENT);
    visibility = 'hidden';
    spyOnProperty(doc, 'visibilityState', 'get').and.callFake(() => visibility);
    title = TestBed.inject(Title);
    title.setTitle('staging: 95b0890…3178270 · PRVision');
    service = TestBed.inject(RunAlertService);
  });

  it('notifies and marks the tab when a background run completes', () => {
    service.statusChanged('summarizing', detail('completed'));

    expect(title.getTitle()).toBe('(✓) staging: 95b0890…3178270 · PRVision');
    expect(FakeNotification.created.length).toBe(1);
    const n = onlyNotification();
    expect(n.title).toBe('Visualization ready');
    expect(n.options?.body).toBe('staging: 95b0890…3178270: 7 of 58 components changed.');
    expect(n.options?.tag).toBe('prvision-visualization-29');
  });

  it('opens the run and closes the notification when it is clicked', () => {
    service.statusChanged('summarizing', detail('completed'));
    const n = onlyNotification();

    n.onclick?.call(n as unknown as Notification, new Event('click'));

    expect(navigate).toHaveBeenCalledWith(['/visualizations', 29]);
    expect(n.close).toHaveBeenCalled();
  });

  it('alerts on failure and on the component-limit pause', () => {
    service.statusChanged('rendering', detail('failed'));
    service.statusChanged('analyzing', detail('awaiting_confirmation', { id: 30 }));

    expect(FakeNotification.created.map((n) => n.title)).toEqual([
      'Visualization failed',
      'Visualization needs your choice',
    ]);
    expect(title.getTitle()).toBe('(?) staging: 95b0890…3178270 · PRVision');
  });

  it('stays quiet while the tab is visible', () => {
    visibility = 'visible';
    service.statusChanged('summarizing', detail('completed'));

    expect(FakeNotification.created.length).toBe(0);
    expect(title.getTitle()).toBe('staging: 95b0890…3178270 · PRVision');
  });

  it('stays quiet on first load, on cancel and between terminal statuses', () => {
    service.statusChanged(null, detail('completed'));
    service.statusChanged('rendering', detail('cancelled'));
    service.statusChanged('cancelled', detail('failed'));
    service.statusChanged('completed', detail('completed'));

    expect(FakeNotification.created.length).toBe(0);
    expect(title.getTitle()).toBe('staging: 95b0890…3178270 · PRVision');
  });

  it('still marks the tab when notifications are not allowed', () => {
    FakeNotification.permission = 'denied';
    service.statusChanged('summarizing', detail('completed'));

    expect(FakeNotification.created.length).toBe(0);
    expect(title.getTitle()).toBe('(✓) staging: 95b0890…3178270 · PRVision');
  });

  it('restores the title when the tab becomes visible', () => {
    service.statusChanged('summarizing', detail('completed'));
    visibility = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));

    expect(title.getTitle()).toBe('staging: 95b0890…3178270 · PRVision');
  });

  it('does not stack marks when two alerts arrive before the tab is seen', () => {
    service.statusChanged('analyzing', detail('awaiting_confirmation'));
    service.statusChanged('summarizing', detail('completed'));

    expect(title.getTitle()).toBe('(✓) staging: 95b0890…3178270 · PRVision');
  });

  it('asks for permission only while the browser has not decided', () => {
    FakeNotification.permission = 'default';
    service.requestPermission();
    FakeNotification.permission = 'denied';
    service.requestPermission();

    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });
});
