/*
 * PRVision HttpBackend (static template, sheet 15d). Replaces the XHR/fetch backend so no request leaves the page.
 * Interceptors the harness registers still run in front of it.
 */
import { Injectable } from '@angular/core';
import { HttpBackend, HttpErrorResponse, HttpEvent, HttpHeaders, HttpRequest, HttpResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { PrvisionHttpFixture } from './harness-api';

declare global {
  interface Window { __PRVISION_HTTP_UNMATCHED__?: string[]; }
}

let fixtures: PrvisionHttpFixture[] = [];
export function setPrvisionHttpFixtures(list: PrvisionHttpFixture[] | undefined): void {
  fixtures = list ?? [];
}

@Injectable()
export class PrvisionHttpBackend implements HttpBackend {
  handle(req: HttpRequest<unknown>): Observable<HttpEvent<unknown>> {
    return new Observable<HttpEvent<unknown>>((observer) => {
      const url = req.urlWithParams;
      const match = fixtures.find((f) =>
        (f.method === undefined || f.method.toUpperCase() === req.method) &&
        (typeof f.url === 'string' ? url.includes(f.url) : f.url.test(url)));
      queueMicrotask(() => {                        // asynchronous like a real backend, but no timers
        if (match === undefined) {
          (window.__PRVISION_HTTP_UNMATCHED__ ??= []).push(`${req.method} ${url}`);
          observer.error(new HttpErrorResponse({ url, status: 404, statusText: 'Not Found (PRVision: no fixture)' }));
          return;
        }
        const status = match.status ?? 200;
        const headers = new HttpHeaders(match.headers ?? {});
        if (status >= 400) {
          observer.error(new HttpErrorResponse({ url, status, statusText: 'PRVision fixture', error: match.body ?? null, headers }));
          return;
        }
        observer.next(new HttpResponse({ url, status, body: match.body ?? null, headers }));
        observer.complete();
      });
    });
  }
}
