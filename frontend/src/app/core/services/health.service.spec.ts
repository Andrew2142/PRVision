import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, discardPeriodicTasks, fakeAsync, tick } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { environment } from '../../../environments/environment';
import { HEALTH_POLL_MS } from '../constants/polling.constants';
import { errorInterceptor } from '../interceptors/error.interceptor';
import { type HealthView } from '../models/api.model';
import { ApiService } from './api.service';
import { HealthService } from './health.service';
import { NotificationService } from './notification.service';

const OK: HealthView = { status: 'ok', database: true, redis: true, version: '0.1.0' };

describe('HealthService', () => {
  describe('with a stubbed ApiService', () => {
    let getHealth: jasmine.Spy<ApiService['getHealth']>;
    let service: HealthService;

    beforeEach(() => {
      getHealth = jasmine.createSpy<ApiService['getHealth']>('getHealth');
      TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: { getHealth } }] });
      service = TestBed.inject(HealthService);
    });

    it("online after {status:'ok'}", fakeAsync(() => {
      getHealth.and.returnValue(of(OK));
      expect(service.status()).toBe('unknown');
      service.start();
      tick(0);
      expect(service.status()).toBe('online');
      discardPeriodicTasks();
    }));

    it("degraded after {status:'degraded'}", fakeAsync(() => {
      getHealth.and.returnValue(of({ ...OK, status: 'degraded', redis: false }));
      service.start();
      tick(0);
      expect(service.status()).toBe('degraded');
      discardPeriodicTasks();
    }));

    it('polls every HEALTH_POLL_MS', fakeAsync(() => {
      getHealth.and.returnValue(of(OK));
      service.start();
      tick(0);
      expect(getHealth).toHaveBeenCalledTimes(1);
      tick(HEALTH_POLL_MS - 1);
      expect(getHealth).toHaveBeenCalledTimes(1);
      tick(1);
      expect(getHealth).toHaveBeenCalledTimes(2);
      tick(HEALTH_POLL_MS);
      expect(getHealth).toHaveBeenCalledTimes(3);
      discardPeriodicTasks();
    }));

    it('a slow request is not overlapped by the next tick (exhaustMap)', fakeAsync(() => {
      const slow = new Subject<HealthView>();
      let calls = 0;
      getHealth.and.callFake(() => (++calls === 1 ? slow : of(OK)));
      service.start();
      tick(HEALTH_POLL_MS * 3);
      expect(getHealth).toHaveBeenCalledTimes(1);
      slow.next(OK);
      slow.complete();
      expect(service.status()).toBe('online');
      tick(HEALTH_POLL_MS);
      expect(getHealth).toHaveBeenCalledTimes(2);
      discardPeriodicTasks();
    }));

    it('start is idempotent', fakeAsync(() => {
      getHealth.and.returnValue(of(OK));
      service.start();
      service.start();
      tick(0);
      expect(getHealth).toHaveBeenCalledTimes(1);
      discardPeriodicTasks();
    }));
  });

  it('offline after error without toast', fakeAsync(() => {
    const notifyError = jasmine.createSpy('error');
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: NotificationService, useValue: { error: notifyError } },
      ],
    });
    const service = TestBed.inject(HealthService);
    const http = TestBed.inject(HttpTestingController);
    service.start();
    tick(0);
    http
      .expectOne(`${environment.apiBaseUrl}/health`)
      .error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
    expect(service.status()).toBe('offline');
    expect(notifyError).not.toHaveBeenCalled();
    discardPeriodicTasks();
    http.verify();
  }));
});
