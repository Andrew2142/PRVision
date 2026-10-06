/*
 * PRVision Angular harness API (static template, sheet 15d).
 * AI-written harness modules import ONLY definePrvisionHarness/types from this file plus application code.
 */
import type { EnvironmentProviders, Provider, Type } from '@angular/core';

/** One canned HTTP response. The first matching fixture wins; unmatched requests get a 404 HttpErrorResponse. */
export interface PrvisionHttpFixture {
  method?: string;                 // default: any method
  url: string | RegExp;            // string = substring of the full request URL (with params)
  status?: number;                 // default 200; >= 400 → HttpErrorResponse with `body` as `error`
  body?: unknown;
  headers?: Record<string, string>;
}

export interface PrvisionAngularHarness<T = unknown> {
  /** The component under test (exact import from <target>), or a standalone host component declared in the harness. */
  component: Type<T>;
  /** Set with ComponentRef.setInput (decorator and signal inputs). Keys are public input names. */
  inputs?: Record<string, unknown>;
  /** Application-level providers: DI fakes, tokens, importProvidersFrom(SomeNgModule). */
  providers?: Array<Provider | EnvironmentProviders>;
  /** Canned HTTP responses served by PRVision's HttpBackend. */
  http?: PrvisionHttpFixture[];
  /** Inline CSS for the wrapper element the component is mounted into. */
  hostStyle?: Record<string, string>;
  /** Runs before bootstrapApplication: document attributes, storage seeds. */
  setup?: () => void | Promise<void>;
}

export function definePrvisionHarness<T>(harness: PrvisionAngularHarness<T>): PrvisionAngularHarness<T> {
  return harness;
}
